import { applyRateFils, subtractFils, toFils } from "@filspay/money";

/**
 * Estimated fee for a single capture, in integer fils. Mirrors the Go
 * settlement service's ComputeSettlementFee (the reference): the negotiated
 * discount comes off the amount first, then the MDR rate is applied, both
 * rounding half-to-even through `applyRateFils`.
 */
export function estimateFeeFils(amountFils: number, mdrBps: number, discountBps: number): number {
  const amount = toFils(amountFils);
  const discounted = subtractFils(amount, applyRateFils(amount, discountBps));
  return applyRateFils(discounted, mdrBps);
}
