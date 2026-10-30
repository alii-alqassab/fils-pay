import type { FastifyPluginAsync } from "fastify";
import { requireMerchantAuth, requireMerchantRole } from "../../auth/requireMerchantAuth.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { calculateMdrFeeV1 } from "../fees/calculateFee.js";

interface CaptureParams {
  id: string;
}

interface CaptureBody {
  amountFils?: number;
}

/**
 * v1 transaction routes: a capture fee preview. Not registered by app.ts
 * (routes/transactions.ts serves the live /v1/transactions capture). It reports
 * the fee and moves no money, but it is authenticated and merchant-scoped like
 * the live route so registering it can never leak another merchant's data.
 */
export const transactionRoutesV1: FastifyPluginAsync = async (app) => {
  app.post<{ Params: CaptureParams; Body: CaptureBody }>(
    "/:id/capture",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await app.db.query<{ id: string; amount_fils: string; mdr_bps: number }>(
        `SELECT t.id, t.amount_fils, m.mdr_bps
           FROM transactions t
           JOIN merchants m ON m.id = t.merchant_id
          WHERE t.id = $1 AND t.merchant_id = $2`,
        [request.params.id, request.merchantAuth!.merchantId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError("transaction_not_found", "transaction not found");

      const authorized = Number(row.amount_fils);
      const capturedFils = request.body?.amountFils ?? authorized;
      if (!Number.isSafeInteger(capturedFils) || capturedFils <= 0 || capturedFils > authorized) {
        throw new BadRequestError("invalid_amount", "amountFils must be a positive integer up to the authorized amount");
      }
      reply.send({
        id: row.id,
        capturedFils,
        feeFils: calculateMdrFeeV1(capturedFils, row.mdr_bps),
      });
    },
  );
};
