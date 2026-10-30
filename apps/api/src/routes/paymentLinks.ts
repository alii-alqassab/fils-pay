import { requireValidCard } from "../payments/cardValidation.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { getPublicPaymentLink } from "../paymentLinks/read.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { listPaymentLinks } from "../paymentLinks/query.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { UUID_PATH_RE, parseLimitParam } from "../lib/queryParams.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface MerchantIdParams {
  merchantId: string;
}

interface MerchantLinkIdParams extends MerchantIdParams {
  id: string;
}

interface TokenParams {
  token: string;
}

interface CreatePaymentLinkBody {
  amountFils?: number;
  reference?: string;
  description?: string;
  expiresAt?: string;
}

/** card: simulated card input. submittedAt is only trusted from the linked
 * merchant's authenticated API key, for offline-terminal submissions. */
interface PayPaymentLinkBody {
  card?: SimulatedCardInput;
  submittedAt?: string;
}

interface ListPaymentLinksQuery {
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

/** Validates the path scope; individual resource queries also check ownership. */
function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.merchantAuth || request.merchantAuth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

/** Same rule as routes/transactions.ts: header required, no server-generated fallback. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Merchant-authenticated payment-link routes: create, cancel, list.
 * Registered with prefix '/v1/merchants' — a *separate* registration from
 * `paymentLinkPublicRoutes` below, so there is no ambiguity in app.ts
 * between what requires `requireMerchantAuth` and what is deliberately
 * public.
 */
export async function paymentLinkMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: CreatePaymentLinkBody }>(
    "/:merchantId/payment-links",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const { amountFils, reference, description, expiresAt } = request.body ?? {};
      if (amountFils === undefined || !expiresAt) {
        throw new BadRequestError("invalid_request", "amountFils and expiresAt are required");
      }

      // A company that is not approved yet cannot take payments.
      const company = await app.db.query<{ onboarding_status: string }>(
        `SELECT onboarding_status FROM merchants WHERE id = $1`,
        [request.params.merchantId],
      );
      if (company.rows[0]?.onboarding_status !== "approved") {
        throw new ForbiddenError("merchant_not_approved", "Your company must be approved before you can create payment links");
      }

      const writer = requireMerchantWriterActor(request.merchantAuth!);
      const link = await createPaymentLink(app.db, app.config, {
        merchantId: request.params.merchantId,
        amountFils,
        reference,
        description,
        expiresAt,
        createdByType: writer.type,
        createdById: writer.id,
      });
      reply.code(201).send(link);
    },
  );

  app.delete<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      if (!UUID_PATH_RE.test(request.params.id)) {
        throw new NotFoundError("payment_link_not_found");
      }
      const result = await cancelPaymentLink(app.db, {
        id: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
      });
      if (result.outcome === "canceled") {
        reply.code(204).send();
        return;
      }
      if (result.outcome === "not_found") {
        throw new NotFoundError("payment_link_not_found");
      }
      throw new ConflictError("not_cancelable", `status: ${result.status}`);
    },
  );

  app.get<{ Params: MerchantIdParams; Querystring: ListPaymentLinksQuery }>(
    "/:merchantId/payment-links",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimitParam(q.limit);

      return listPaymentLinks(app.db, app.config, {
        merchantId: request.params.merchantId,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );
}

/**
 * Public, unauthenticated payment-link routes: read, pay. Registered with
 * prefix '/v1/payment-links'.
 */
export async function paymentLinkPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: TokenParams }>("/:token", async (request) => {
    const link = await getPublicPaymentLink(
      app.db,
      request.params.token,
      app.config.paymentLinkReservationTimeoutSeconds,
    );
    if (!link) {
      throw new NotFoundError("payment_link_not_found");
    }
    return link;
  });

  app.post<{ Params: TokenParams; Body: PayPaymentLinkBody }>("/:token/pay", async (request, reply) => {
    const idempotencyKey = getIdempotencyKey(request);
    const { card: rawCard, submittedAt } = request.body ?? {};
    if (!rawCard) {
      throw new BadRequestError("invalid_request", "card is required");
    }
    // Reject impossible cards (bad number checksum, expired, wrong code length...) before the link
    // is reserved or any acquirer call is made, and never pass unvalidated fields onwards.
    const { card } = requireValidCard(rawCard);

    // Public checkout must use server time: a caller-controlled submittedAt
    // would let anyone backdate payment and bypass link expiry. Preserve the
    // documented offline-terminal flow only for a valid API key belonging to
    // the merchant that owns this link.
    let trustedSubmittedAt: string | undefined;
    if (submittedAt !== undefined) {
      const authorization = request.headers.authorization;
      if (authorization?.startsWith("Bearer ")) {
        const apiKey = await verifyApiKey(app.db, authorization.slice("Bearer ".length));
        if (apiKey) {
          const owner = await app.db.query<{ merchant_id: string }>(
            `SELECT merchant_id FROM payment_links WHERE token = $1`,
            [request.params.token],
          );
          if (owner.rows[0]?.merchant_id === apiKey.merchantId) {
            trustedSubmittedAt = submittedAt;
          }
        }
      }
    }

    const result = await payPaymentLink(
      app.db,
      app.acquirer,
      { paymentLinkReservationTimeoutSeconds: app.config.paymentLinkReservationTimeoutSeconds },
      { token: request.params.token, card, idempotencyKey, submittedAt: trustedSubmittedAt },
    );
    reply.code(result.statusCode).send(result.body);
  });
}
