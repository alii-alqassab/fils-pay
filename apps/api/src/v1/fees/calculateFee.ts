import { applyRateFils, toFils } from "@filspay/money";

/**
 * v1's merchant-discount-rate fee calculation. Kept as a thin wrapper over
 * `applyRateFils` (packages/money) so it rounds half-to-even like capture.ts
 * and the Go settlement service; it used to round half up, which disagreed
 * on an exact tie.
 */
export function calculateMdrFeeV1(amountFils: number, rateBasisPoints: number): number {
  if (!Number.isInteger(amountFils) || amountFils < 0) {
    throw new RangeError(`calculateMdrFeeV1: amountFils must be a non-negative integer, got ${amountFils}`);
  }
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new RangeError(`calculateMdrFeeV1: rateBasisPoints must be a non-negative integer, got ${rateBasisPoints}`);
  }
  return applyRateFils(toFils(amountFils), rateBasisPoints);
}
