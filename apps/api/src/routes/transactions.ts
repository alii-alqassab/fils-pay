import { requireValidCard } from "../payments/cardValidation.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey } from "../apiKeys/verify.js";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, type AuthorizeInput } from "../payments/authorize.js";
import { MAX_AUTHORIZE_FILS } from "../payments/limits.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import { voidTransaction } from "../payments/void.js";
import { buildTransactionsExportCsv } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { UUID_PATH_RE, parseAmountFils, parseLimitParam, parseOptionalInstant } from "../lib/queryParams.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface AuthorizeBody {
  amountFils?: number;
  card?: SimulatedCardInput;
  reference?: string;
}


interface CaptureBody {
  amountFils?: number;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

const MAX_TRANSACTION_EXPORT_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;

/** Transaction export is assembled in memory, so require a bounded window. */
function parseTransactionExportWindow(query: ExportQuery): { from: Date; to: Date } {
  if (!query.from || !query.to) {
    throw new BadRequestError("export_date_range_required", "from and to are required for transaction export");
  }

  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new BadRequestError(
      "invalid_export_date_range",
      "from and to must be valid ISO-8601 instants with from < to",
    );
  }
  if (to.getTime() - from.getTime() > MAX_TRANSACTION_EXPORT_RANGE_MS) {
    throw new BadRequestError("export_date_range_too_large", "transaction export range cannot exceed 31 days");
  }

  return { from, to };
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/** A non-UUID id can never match a row; answer 404 like any unknown id instead of a Postgres cast 500. */
function assertTransactionId(id: string): void {
  if (!UUID_PATH_RE.test(id)) {
    throw new NotFoundError("transaction_not_found");
  }
}

/**
 * Reads the Idempotency-Key header. Required on authorize and capture;
 * void is naturally idempotent and does not call this. Keys are scoped per
 * merchant + endpoint (see payments/idempotency.ts), so the same key may be
 * reused across endpoints without colliding.
 */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card: rawCard, reference } = request.body ?? {};
      if (amountFils === undefined || !rawCard) {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }
      const { card } = requireValidCard(rawCard);

      // Validated before any idempotency claim or acquirer call. The upper bound is the
      // settlement scheme_export_lines NUMERIC(10,2) ceiling; above it settlement would overflow.
      const authorizedFils = parseAmountFils(amountFils);
      if (authorizedFils <= 0) {
        throw new BadRequestError("invalid_amount", "amountFils must be greater than 0");
      }
      if (authorizedFils > MAX_AUTHORIZE_FILS) {
        throw new BadRequestError("amount_too_large", `amountFils cannot exceed ${MAX_AUTHORIZE_FILS}`);
      }

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: authorizedFils,
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
      };
      const result = await authorizeTransaction(app.db, app.acquirer, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // am: requireMerchantAuth lets impersonation through here too? an admin impersonating can capture
    // MK: impersonation is read-only, enforced in requireMerchantAuth. fine
    // MK: confirmed — ADMIN.md says grants are support-level read only
    "/:id/capture",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertTransactionId(request.params.id);
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? parseAmountFils(amountFils) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      // discount applied after capture commits, separate txn. on a replayed 200 this runs again
      // but the count guard makes it a no-op — MK 2026-06
      // am: and if this throws, the capture is committed but the discount never lands? retry = replay = ...
      if (result.statusCode === 200) {
        await applyCaptureDiscountAdjustment(app.db, {
          merchantId: request.merchantAuth!.merchantId,
          transactionId: request.params.id,
        });
      }
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    // Sessions need owner/finance (support is read-only); API keys keep full authority (requireMerchantRole).
    "/:id/void",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertTransactionId(request.params.id);
      const result = await voidTransaction(app.db, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimitParam(q.limit);

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: parseOptionalInstant("from", q.from),
        to: parseOptionalInstant("to", q.to),
        search: q.search,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const window = parseTransactionExportWindow(q);
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      const csv = await buildTransactionsExportCsv(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: window.from,
        to: window.to,
        status,
      });

      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"')
        .send(csv);
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertTransactionId(request.params.id);
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertTransactionId(request.params.id);
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}
