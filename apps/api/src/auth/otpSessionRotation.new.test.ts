/**
 * Regression tests for AUTH-1: OTP codes come from a CSPRNG, and the pending
 * session token is rotated at OTP success (merchant + admin) so the pre-OTP
 * cookie never becomes the authenticated credential.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";
import { randomDigits } from "../lib/random.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("otpSessionRotation.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  OTP_DEV_EXPOSE: "true",
  ROTATE_SESSION_ON_OTP_VERIFY: "true",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  assert.ok(c, `expected Set-Cookie ${name}`);
  return c.value;
}

test("randomDigits is zero-padded, correct length, digits only, and not Math.random-driven", () => {
  const orig = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used");
  };
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const d = randomDigits(6);
      assert.match(d, /^\d{6}$/);
      seen.add(d);
    }
    assert.ok(seen.size > 250);
    assert.match(randomDigits(1), /^\d$/);
  } finally {
    Math.random = orig;
  }
});

test("merchant OTP verify issues a NEW session token; the pending token is dead", async () => {
  const suffix = randomUUID();
  const email = `rot-${suffix}@rot.test`;
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Rot ${suffix.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')`,
    [merchant.rows[0]!.id, email, await hashPassword("pw-12345678", config)],
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: merchant.rows[0]!.id, email, password: "pw-12345678" },
  });
  assert.equal(login.statusCode, 200);
  const pendingToken = cookieOf(login, config.cookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: pendingToken },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  const newToken = cookieOf(verify, config.cookieName);
  assert.notEqual(newToken, pendingToken);

  const old = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [config.cookieName]: pendingToken } });
  assert.equal(old.statusCode, 401);
  const fresh = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [config.cookieName]: newToken } });
  assert.equal(fresh.statusCode, 200);
});

test("admin OTP verify issues a NEW session token; the pending token is dead", async () => {
  const email = `rot-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Rot', 'finance')`,
    [email, await hashPassword("pw-12345678", config)],
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: "pw-12345678" },
  });
  assert.equal(login.statusCode, 200);
  const pendingToken = cookieOf(login, config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [config.adminCookieName]: pendingToken },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  const newToken = cookieOf(verify, config.adminCookieName);
  assert.notEqual(newToken, pendingToken);

  const old = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: { [config.adminCookieName]: pendingToken } });
  assert.equal(old.statusCode, 401);
  const fresh = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: { [config.adminCookieName]: newToken } });
  assert.equal(fresh.statusCode, 200);
});
