/**
 * RPT-1: two concurrent writer transactions where the lower outbox id
 * commits AFTER the higher id has already been consumed. The late event must
 * still be applied exactly once (no skip, no double count).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("concurrentCommit.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };
test.after(async () => {
  await pool.end();
});

test("late-committing lower outbox id is applied exactly once after a higher id was consumed", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`rpt1 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const payload = (n: number) => ({ merchantId, amountCapturedFils: n, feeFils: 0, newStatus: "captured", capturedTotalFils: n });

  // Drain anything pending so the watermark is past unrelated rows.
  while ((await runConsumerPass(pool, config)).processedCount > 0);

  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    const lo = await enqueueEvent(a, { eventType: "transaction.captured", aggregateType: "transaction", aggregateId: randomUUID(), payload: payload(1_000) });
    const hi = await enqueueEvent(b, { eventType: "transaction.captured", aggregateType: "transaction", aggregateId: randomUUID(), payload: payload(2_000) });
    assert.ok(BigInt(lo.id) < BigInt(hi.id), "first insert must hold the lower id");

    await b.query("COMMIT"); // higher id commits first
    assert.equal((await runConsumerPass(pool, config)).processedCount, 1);

    await a.query("COMMIT"); // lower id commits late
    assert.equal((await runConsumerPass(pool, config)).processedCount, 1, "late lower id must not be skipped");
    assert.equal((await runConsumerPass(pool, config)).processedCount, 0, "no replay");

    const v = await pool.query<{ c: number; g: string }>(
      `SELECT sum(captured_count)::int AS c, sum(captured_gross_fils)::text AS g FROM merchant_daily_volume WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(v.rows[0]!.c, 2);
    assert.equal(v.rows[0]!.g, "3000");
  } finally {
    a.release();
    b.release();
  }
});
