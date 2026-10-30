import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import { applyCaptureDiscountAdjustment } from "./discountAdjustment.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
after(async () => {
  await pool.end();
});

test("a zero-discount capture followed by a positive one is adjusted once across replays", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 275, 1250) RETURNING id`,
    [`Discount New ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 1000, 1000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = t.rows[0]!.id;
  const addEvent = (type: string, fee: number, at: string) =>
    pool.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
       VALUES ($1, $2, 100, 'system', $3, $4)`,
      [transactionId, type, JSON.stringify({ feeFils: fee }), at],
    );

  await addEvent("partially_captured", 0, "2026-01-01T00:00:00Z");
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await addEvent("captured", 17, "2026-01-02T00:00:00Z");
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const r = await pool.query(
    `SELECT 1 FROM ledger_entries WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'`,
    [transactionId],
  );
  assert.equal(r.rows.length, 2);
});
