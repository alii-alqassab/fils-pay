import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";
import { UUID_PATH_RE, parseAmountFils } from "../lib/queryParams.js";

interface RefundParams {
  merchantId: string;
}

interface RefundBody {
  transactionId?: string;
  /** Omit to refund everything still refundable. */
  amountFils?: number;
  reason?: string;
}

const MAX_REASON_LENGTH = 200;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/merchants': `POST /v1/merchants/:merchantId/refunds`.
 * The refund target is in the body. Sessions need owner/finance (support is
 * read-only); API keys keep full authority. The old `POST /v1/refunds` stub is
 * left untouched.
 */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: RefundParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      assertRefundRequestScope(auth, request.params.merchantId);
      const idempotencyKey = getIdempotencyKey(request);

      const { transactionId, amountFils, reason } = request.body ?? {};
      if (typeof transactionId !== "string" || !UUID_PATH_RE.test(transactionId)) {
        throw new BadRequestError("invalid_request", "transactionId is required");
      }
      let amount;
      if (amountFils !== undefined) {
        amount = parseAmountFils(amountFils);
        if (amount <= 0) {
          throw new BadRequestError("invalid_amount", "amountFils must be greater than 0");
        }
      }
      if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
        throw new BadRequestError("invalid_reason", `reason must be text of at most ${MAX_REASON_LENGTH} characters`);
      }

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId,
        amountFils: amount,
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason: reason?.trim() || undefined,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
