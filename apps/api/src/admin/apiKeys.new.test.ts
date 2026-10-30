import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { rotateApiKeyAsAdmin } from "./apiKeys.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("apiKeys.new.test.ts requires a migrated DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function fixture() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Rotation ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  const a = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'T', 'finance') RETURNING id`,
    [`a-${randomUUID()}@admin.test`],
  );
  return { merchantId, ownerUserId: u.rows[0]!.id, adminUserId: a.rows[0]!.id };
}

test("admin rotation keeps the previous key alive for the grace window, then it stops authenticating", async () => {
  const { merchantId, ownerUserId, adminUserId } = await fixture();
  const original = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId });
  assert.ok(await verifyApiKey(pool, original.rawKey));

  const rotated = await rotateApiKeyAsAdmin(pool, config, { merchantId, apiKeyId: original.id, adminUserId });

  assert.ok(await verifyApiKey(pool, original.rawKey), "old key still works during the overlap window");
  assert.ok(await verifyApiKey(pool, rotated.rawKey));
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${original.rawKey}` },
  });
  assert.equal(res.statusCode, 200);

  // Once the window has passed the old key is dead.
  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 second' WHERE id = $1`, [original.id]);
  assert.equal(await verifyApiKey(pool, original.rawKey), null, "old key must be dead after the grace window");
  assert.ok(await verifyApiKey(pool, rotated.rawKey));

  const rows = await pool.query<{ id: string; key_hash: string; revoke_after: Date | null; rotated_from_key_id: string | null }>(
    `SELECT id, key_hash, revoke_after, rotated_from_key_id FROM api_keys WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(rows.rowCount, 2);
  const newRow = rows.rows.find((r) => r.id === rotated.id)!;
  assert.equal(newRow.rotated_from_key_id, original.id);
  for (const r of rows.rows) assert.notEqual(r.key_hash, rotated.rawKey, "raw key must not be stored");
  const audit = await pool.query(`SELECT 1 FROM admin_audit_log WHERE admin_user_id=$1 AND action='api_key_rotate'`, [adminUserId]);
  assert.equal(audit.rowCount, 1);
});
