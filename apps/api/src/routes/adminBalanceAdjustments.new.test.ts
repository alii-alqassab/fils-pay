/**
 * Route-level tests for the admin "Adjust balance" tool, via
 * `app.inject(...)` against a real, migrated Postgres (run `npm run migrate`
 * first). No test doubles — this route crosses no process boundary.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminBalanceAdjustments.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type AdminRole = "support" | "finance" | "super_admin";

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedAdminPasswordHash: string | null = null;

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) {
      return header.split(";")[0] as string;
    }
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: AdminRole): Promise<{ id: string; cookie: string }> {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `bal-adj-route-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `Test ${role}`, role],
  );

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { devOtpCode?: string };
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  // verify may rotate the session cookie; use the newest one if present
  const rotated = verifyRes.headers["set-cookie"];
  return { id: inserted.rows[0]!.id, cookie: rotated ? parseCookie(rotated, config.adminCookieName) : cookie };
}

async function createMerchant(withBalanceFils: number | null): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`Bal Adj Route ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  if (withBalanceFils !== null) {
    await pool.query(
      `INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, $2)`,
      [merchantId, withBalanceFils],
    );
  }
  return merchantId;
}

const PATH = (merchantId: string) => `/v1/admin/merchants/${merchantId}/balance-adjustments`;

/** Same SQL as ledger.RebuildMerchantBalance (apps/settlement/internal/ledger/rebuild.go). */
async function rebuiltBalance(merchantId: string): Promise<number> {
  const r = await pool.query<{ b: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS b
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return Number(r.rows[0]!.b);
}

async function rebuildCache(merchantId: string): Promise<void> {
  await pool.query(`UPDATE merchant_balances SET cached_payable_fils = $2 WHERE merchant_id = $1`, [
    merchantId,
    await rebuiltBalance(merchantId),
  ]);
}

async function cached(merchantId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT cached_payable_fils::text AS c FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(r.rows[0]!.c);
}

for (const delta of [50_000, -25_000]) {
  test(`ADM-2: an adjustment of ${delta} survives a ledger rebuild`, async () => {
    const admin = await signedInAdmin("finance");
    const merchantId = await createMerchant(0);

    const res = await app.inject({
      method: "POST",
      url: PATH(merchantId),
      headers: { cookie: admin.cookie },
      payload: { deltaFils: delta, reason: "adm-2 regression" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await cached(merchantId), delta);

    await rebuildCache(merchantId);
    assert.equal(await cached(merchantId), delta, "adjustment lost on rebuild");

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE target_id = $1`,
      [merchantId],
    );
    assert.equal(audit.rows.length, 1);
  });
}

test("ADM-2: out-of-safe-range delta is a 400, not a 500, and writes nothing", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(1_000);
  for (const deltaFils of [Number.MAX_SAFE_INTEGER + 2, -(Number.MAX_SAFE_INTEGER + 2), 1e300]) {
    const res = await app.inject({
      method: "POST",
      url: PATH(merchantId),
      headers: { cookie: admin.cookie },
      payload: { deltaFils, reason: "overflow" },
    });
    assert.equal(res.statusCode, 400, res.body);
  }
  assert.equal(await cached(merchantId), 1_000);
  assert.equal(await rebuiltBalance(merchantId), 0);
});

test("ADM-2: a result beyond the safe range is rejected and rolled back", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(Number.MAX_SAFE_INTEGER - 10);
  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie },
    payload: { deltaFils: 100, reason: "would overflow" },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(await cached(merchantId), Number.MAX_SAFE_INTEGER - 10);
  assert.equal(await rebuiltBalance(merchantId), 0);
});
