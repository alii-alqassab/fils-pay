import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { getPublicPaymentLink } from "./read.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
test.after(() => pool.end());

test("public payment link read never exposes api key hash", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name) VALUES ('S3 Merchant') RETURNING id`);
  const merchantId = m.rows[0]!.id;
  const hash = createHash("sha256").update(randomBytes(8)).digest("hex");
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1,$2,'owner','x') RETURNING id`,
    [merchantId, `o-${randomBytes(6).toString("hex")}@example.test`]);
  await pool.query(
    `INSERT INTO api_keys (merchant_id, key_prefix, key_hash, created_by) VALUES ($1,'fp_s3test0000000',$2,$3)`,
    [merchantId, hash, u.rows[0]!.id]);
  const token = "s3tok_" + randomBytes(6).toString("hex");
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, currency, expires_at, created_by_type, created_by_id)
     VALUES ($1,$2,1000,'BHD', now() + interval '1 day', 'merchant_session', $3)`, [merchantId, token, u.rows[0]!.id]);
  const dto = await getPublicPaymentLink(pool, token, 600);
  assert.ok(dto);
  assert.notEqual(dto.merchantIntegrationId, hash);
  assert.ok(!JSON.stringify(dto).includes(hash));
});
