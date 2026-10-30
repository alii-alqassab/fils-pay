import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's currently-in-effect negotiated fee schedule for
 * display on the admin merchant-detail page: the row with the greatest
 * effective_from that has already arrived, ties broken by created_at DESC —
 * the same selection getEffectiveMdrBps uses at capture/settlement time, so
 * the page never shows a rate that is not (yet) the one being charged.
 * Returns null when no row has taken effect yet (none on file, or only
 * future-dated ones); the merchant's own merchants.mdr_bps is then what
 * applies, as in feeSchedule.ts, and callers show that instead.
 */
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
