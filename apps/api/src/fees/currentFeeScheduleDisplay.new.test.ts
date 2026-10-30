/**
 * Effective-date selection for the admin "current negotiated rate" lookup,
 * against a real, migrated Postgres (no DB mocking).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getCurrentFeeScheduleForDisplay } from "./currentFeeScheduleDisplay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "currentFeeScheduleDisplay.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function insertMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Current Fee Schedule New Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function insertSchedule(
  merchantId: string,
  mdrBps: number,
  effectiveFrom: string,
  createdAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1, $2, $3, $4)`,
    [merchantId, mdrBps, effectiveFrom, createdAt],
  );
}

test("ignores a future-dated schedule", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 200, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
  await insertSchedule(merchantId, 150, "2099-01-01T00:00:00Z", "2026-04-01T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 200);
});

test("a backdated correction entered later does not supersede a later effective_from", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 225, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
  await insertSchedule(merchantId, 245, "2026-03-01T00:00:00Z", "2026-08-15T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 225);
});

test("ties on effective_from are broken by created_at DESC", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 210, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
  await insertSchedule(merchantId, 205, "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z");

  const current = await getCurrentFeeScheduleForDisplay(pool, merchantId);
  assert.equal(current?.mdrBps, 205);
});

test("returns null when only future-dated schedules exist", async () => {
  const merchantId = await insertMerchant();
  await insertSchedule(merchantId, 150, "2099-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
  assert.equal(await getCurrentFeeScheduleForDisplay(pool, merchantId), null);
});
