/** A merchant whose review is already decided cannot be approved a second time. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("adminKycReview.new.test.ts requires DATABASE_URL to point at a migrated Postgres");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "admin-test-password-9000!";

async function adminCookie(): Promise<string> {
  const email = `kyc-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'T', 'finance')`, [
    email,
    await hashPassword(PASSWORD, config),
  ]);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

test("approving a merchant twice is a 409 and writes no second review row", async () => {
  const cookie = await adminCookie();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Kyc twice ${randomUUID()}`],
  );
  const id = merchant.rows[0]!.id;
  const approve = () =>
    app.inject({ method: "POST", url: `/v1/admin/merchants/${id}/kyc-reviews`, headers: { cookie }, payload: { outcome: "approved" } });

  assert.equal((await approve()).statusCode, 200);
  const second = await approve();
  assert.equal(second.statusCode, 409, second.body);
  const rows = await pool.query(`SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = $1`, [id]);
  assert.equal(rows.rowCount, 1);
});
