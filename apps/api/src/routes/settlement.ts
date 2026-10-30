import type { FastifyInstance } from "fastify";
import { requireMerchantAuth, requireMerchantRole } from "../auth/requireMerchantAuth.js";
import { NotFoundError, BadRequestError } from "../lib/errors.js";
import { UUID_PATH_RE, assertBusinessDate, parseLimitParam, parseOptionalInstant } from "../lib/queryParams.js";
import {
  getReconciliationReport,
  getSettlementBatch,
  getSettlementSummary,
  listBatchTransactions,
  listSettlementBatches,
} from "../settlement/query.js";

interface BatchIdParams {
  id: string;
}

interface ListBatchesQuery {
  from?: string;
  to?: string;
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

/** Business dates, YYYY-MM-DD. Both required (400 otherwise); `to` is exclusive. */
interface ReconciliationQuery {
  from?: string;
  to?: string;
}

function assertBatchId(id: string): void {
  if (!UUID_PATH_RE.test(id)) {
    throw new NotFoundError("settlement_batch_not_found");
  }
}

/**
 * Read-only settlement report/reconciliation endpoints, registered with
 * prefix '/v1/settlement'. All routes use `requireMerchantAuth` (session or
 * API key), scoped by `request.merchantAuth.merchantId` — never a
 * merchantId from the path/query. Nothing here triggers, re-runs, or
 * mutates a batch; that's apps/settlement's job.
 */
export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListBatchesQuery }>(
    "/batches",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimitParam(q.limit);

      return listSettlementBatches(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: parseOptionalInstant("from", q.from),
        to: parseOptionalInstant("to", q.to),
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  // Registered BEFORE "/batches/:id" so the literal "reconciliation"
  // segment never gets swallowed by the ":id" param route.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/reconciliation",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = request.query;
      if (!from || !to) {
        throw new BadRequestError("invalid_request", "from and to (YYYY-MM-DD) are required");
      }

      return getReconciliationReport(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: assertBusinessDate("from", from),
        to: assertBusinessDate("to", to),
      });
    },
  );

  // Same static-segment-before-":id" reasoning as "/reconciliation" above.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/summary",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = request.query;
      if (!from || !to) {
        throw new BadRequestError("invalid_request", "from and to (YYYY-MM-DD) are required");
      }

      return getSettlementSummary(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: assertBusinessDate("from", from),
        to: assertBusinessDate("to", to),
      });
    },
  );

  app.get<{ Params: BatchIdParams }>(
    "/batches/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertBatchId(request.params.id);
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      return batch;
    },
  );

  app.get<{ Params: BatchIdParams }>(
    "/batches/:id/transactions",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertBatchId(request.params.id);
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent batch isn't found/owned) before reading its
      // transactions.
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      const transactions = await listBatchTransactions(app.db, request.params.id);
      return { transactions };
    },
  );
}
