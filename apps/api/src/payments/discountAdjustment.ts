import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { applyRateFils, parseBhdToFils, subtractFils, toFils } from "@filspay/money";
import { getEffectiveMdrBps } from "../fees/feeSchedule.js";
import { getVolumeTierBonusBps } from "../fees/platformVolumeTier.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError } from "../lib/errors.js";


/**
 * Parses a promotional discount amount (BD string from the merchant
 * pricing dashboard) into fils for the ledger adjustment.
 */
export function parsePromotionalDiscountFils(raw: string): number {
  try {
    const fils = parseBhdToFils(raw);
    if (fils < 0) throw new RangeError("negative");
    return fils;
  } catch {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
}

/** Deterministic entry_group_id for the adjustment belonging to one capture event. */
function adjustmentGroupId(captureEventId: string): string {
  const h = createHash("sha256").update(`capture-discount-adjustment:${captureEventId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Applies a merchant's negotiated processing discount to a capture. The
 * discount is taken off the captured amount before MDR, matching the
 * settlement service's ComputeSettlementFee (discounted_fee.go), the
 * reference for fee calculations (ARCHITECTURE.md, settlement-v2 design
 * §4). capture.ts's own response doesn't carry the fee it just charged, so
 * this reads it back from the transaction_events row capture.ts already
 * wrote (its `metadata.feeFils` and `amount_fils`), then reverses the
 * difference between that fee and the discounted fee via a same-day
 * ledger adjustment.
 *
 * A merchant with negotiated_discount_bps = 0 (the default for anyone
 * without a negotiated rate) is a no-op: this
 * function reads the merchant row, sees a zero discount rate, and inserts
 * nothing.
 */
export async function applyCaptureDiscountAdjustment(
  pool: Pool,
  input: { merchantId: string; transactionId: string },
): Promise<void> {
  return withTransaction(pool, async (client) => {
    const merchantRow = await client.query<{ negotiated_discount_bps: number }>(
      `SELECT negotiated_discount_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const discountBps = merchantRow.rows[0]?.negotiated_discount_bps ?? 0;
    if (discountBps === 0) return;

    // Exactly one adjustment per capture event. A replayed (idempotent)
    // capture returns its cached 200 without writing a new
    // transaction_events row, so the caller re-enters this path with
    // nothing new to adjust — reversing the same fee a second time would
    // credit the merchant twice for one capture. The guard is keyed on the
    // specific latest capture event (its id seeds a deterministic
    // entry_group_id), not on row counts: a count comparison is thrown off by
    // captures whose discount rounded to zero and so never wrote an
    // adjustment. The row lock serializes this check against a concurrent
    // capture's own adjustment.
    await client.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [input.transactionId]);
    const eventRow = await client.query<{
      id: string;
      metadata: { feeFils?: number };
      amount_fils: string | number;
      occurred_at: Date;
    }>(
      `SELECT id, metadata, amount_fils, occurred_at FROM transaction_events
        WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [input.transactionId],
    );
    const latestEvent = eventRow.rows[0];
    if (!latestEvent) return;

    const entryGroupId = adjustmentGroupId(latestEvent.id);
    const existing = await client.query(
      `SELECT 1 FROM ledger_entries WHERE entry_group_id = $1 LIMIT 1`,
      [entryGroupId],
    );
    if (existing.rows.length > 0) return;

    const feeBeforeDiscount = toFils(latestEvent.metadata?.feeFils ?? 0);
    if (feeBeforeDiscount <= 0) return;

    // Same rate resolution as capture.ts, then Go's order: discount the
    // amount, then charge MDR on what is left.
    const capturedFils = toFils(Number(latestEvent.amount_fils));
    const merchantMdr = await client.query<{ mdr_bps: number }>(
      `SELECT mdr_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const effectiveMdrBps = await getEffectiveMdrBps(
      client,
      input.merchantId,
      latestEvent.occurred_at,
      merchantMdr.rows[0]?.mdr_bps ?? 0,
    );
    const mdrBps = Math.max(0, effectiveMdrBps - (await getVolumeTierBonusBps(client)));
    const discountedAmount = subtractFils(capturedFils, applyRateFils(capturedFils, discountBps));
    const discountFils = subtractFils(feeBeforeDiscount, applyRateFils(discountedAmount, mdrBps));
    if (discountFils <= 0) return;

    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'capture: negotiated discount adjustment'),
         ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'capture: negotiated discount adjustment')`,
      [entryGroupId, input.merchantId, input.transactionId, discountFils],
    );
  });
}
