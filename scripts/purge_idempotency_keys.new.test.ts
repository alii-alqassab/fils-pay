import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { purgeIdempotencyKeys } from "./purge_idempotency_keys.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("purge_idempotency_keys.new.test.ts requires DATABASE_URL");

test("purges only finished keys older than the window", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const merchant = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`purge ${randomUUID()}`],
    );
    const merchantId = merchant.rows[0]!.id;
    const insert = (key: string, status: string, ageDays: number) =>
      client.query(
        `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status, created_at)
         VALUES ($1, 'authorize', $2, 'h', $3, now() - make_interval(days => $4::int))`,
        [merchantId, key, status, ageDays],
      );
    await insert("old-done", "completed", 40);
    await insert("old-failed", "failed", 40);
    await insert("old-running", "in_progress", 40);
    await insert("new-done", "completed", 1);

    await purgeIdempotencyKeys(client);
    const left = await client.query<{ key: string }>(`SELECT key FROM idempotency_keys WHERE merchant_id = $1 ORDER BY key`, [merchantId]);
    assert.deepEqual(left.rows.map((r) => r.key), ["new-done", "old-running"]);
  } finally {
    await client.end();
  }
});
