/**
 * Sign-in codes are emailed for real (OTP_DELIVERY=email): the code is in the
 * email, never in the API response or the log; missing mail settings fail
 * loudly instead of falling back to showing the code. Also: staff who are not
 * active cannot sign in. Requires DATABASE_URL (migrated).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { setMailTransportForTests, type MailMessage } from "../lib/mail.js";
import { hashPassword } from "./passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("otpEmailDelivery.new.test.ts requires DATABASE_URL");

const baseEnv = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  OTP_DELIVERY: "email", // the production-style path, even under NODE_ENV=test
  OTP_DEV_EXPOSE: "false",
  RESEND_API_KEY: "re_test_key",
  OTP_FROM_EMAIL: "FilsPay <noreply@example.test>",
};
const config = loadConfig(baseEnv);
const unconfigured = loadConfig({ ...baseEnv, RESEND_API_KEY: "", OTP_FROM_EMAIL: "" });
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);
const appNoMail = buildApp(unconfigured, pool);

test.after(async () => {
  await app.close();
  await appNoMail.close();
  await pool.end();
});
afterEach(() => setMailTransportForTests(null));

function capture(): MailMessage[] {
  const box: MailMessage[] = [];
  setMailTransportForTests(async (m) => void box.push(m));
  return box;
}
function cookieOf(res: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return res.cookies.find((x) => x.name === name)?.value;
}
function codeFrom(message: MailMessage): string {
  const m = /\b(\d{6})\b/.exec(message.text);
  assert.ok(m, "expected a 6-digit code in the email");
  return m[1]!;
}

async function makeMerchantUser(status = "active", role = "owner") {
  const suffix = randomUUID();
  const email = `otp-${suffix}@otp.test`;
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`OTP ${suffix.slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [merchant.rows[0]!.id, email, await hashPassword("pw-12345678", config), role, status],
  );
  return { email, merchantId: merchant.rows[0]!.id, userId: user.rows[0]!.id };
}

test("merchant sign-in: the code is emailed, not returned, and works", async () => {
  const box = capture();
  const u = await makeMerchantUser();
  const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().devOtpCode, undefined, "the code must not be in the response");
  assert.equal(box.length, 1);
  assert.equal(box[0]!.to, u.email);
  const code = codeFrom(box[0]!);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookieOf(login, config.cookieName)! },
    payload: { code },
  });
  assert.equal(verify.statusCode, 200);
});

test("merchant sign-in: the emailed code is not written to the log", async () => {
  const lines: string[] = [];
  const box = capture();
  const u = await makeMerchantUser();
  const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 200);
  // The Fastify logger is on stdout; assert through the code path instead: the
  // notifier logs {channel:'otp'} without a `code` field when it emails.
  const { sendOtpCode } = await import("./notifier.js");
  await sendOtpCode({ info: (o) => void lines.push(JSON.stringify(o)) }, config, { merchantUserId: u.userId, email: u.email }, "654321");
  assert.ok(lines.every((l) => !l.includes("654321")));
  assert.equal(box.at(-1)!.to, u.email);
});

test("merchant sign-in: with no mail settings it fails with 503, revokes the session and sets no cookie", async () => {
  setMailTransportForTests(null);
  const u = await makeMerchantUser();
  const login = await appNoMail.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 503);
  assert.equal(login.json().error, "otp_delivery_unavailable");
  assert.equal(login.json().devOtpCode, undefined);
  assert.equal(cookieOf(login, config.cookieName), undefined);
  const open = await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE merchant_user_id = $1 AND revoked_at IS NULL`, [u.userId]);
  assert.equal(open.rows[0].n, 0);
});

test("admin sign-in: emailed, not returned", async () => {
  const box = capture();
  const email = `otp-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'A', 'finance')`, [
    email,
    await hashPassword("pw-12345678", config),
  ]);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().devOtpCode, undefined);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.to, email);
  assert.match(box[0]!.text, /admin console/);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [config.adminCookieName]: cookieOf(login, config.adminCookieName)! },
    payload: { code: codeFrom(box[0]!) },
  });
  assert.equal(verify.statusCode, 200);
});

test("admin sign-in: with no mail settings it fails with 503", async () => {
  setMailTransportForTests(null);
  const email = `otp-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'A', 'finance')`, [
    email,
    await hashPassword("pw-12345678", config),
  ]);
  const login = await appNoMail.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 503);
  assert.equal(login.json().error, "otp_delivery_unavailable");
});

test("log delivery (tests / explicit local use) still returns the code", async () => {
  const logCfg = loadConfig({ ...baseEnv, OTP_DELIVERY: "log", OTP_DEV_EXPOSE: "" });
  const logApp = buildApp(logCfg, pool);
  try {
    const u = await makeMerchantUser();
    const login = await logApp.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
    assert.equal(login.statusCode, 200);
    assert.match(login.json().devOtpCode, /^\d{6}$/);
  } finally {
    await logApp.close();
  }
});

test("staff waiting for the owner cannot sign in (403) and get no session or email", async () => {
  const box = capture();
  const u = await makeMerchantUser("pending_owner_approval", "support");
  const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
  assert.equal(login.statusCode, 403);
  assert.equal(login.json().error, "account_pending_owner_approval");
  assert.equal(box.length, 0);
  assert.equal(cookieOf(login, config.cookieName), undefined);
});

test("a wrong password never reveals the account status", async () => {
  const u = await makeMerchantUser("pending_owner_approval", "support");
  const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "wrong-password-1" } });
  assert.equal(login.statusCode, 401);
  assert.equal(login.json().error, "invalid_credentials");
});

test("rejected and disabled staff cannot sign in", async () => {
  for (const status of ["rejected", "disabled"]) {
    const u = await makeMerchantUser(status, "support");
    const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
    assert.equal(login.statusCode, 403, status);
    assert.equal(login.json().error, "account_disabled", status);
  }
});

test("an existing session stops working the moment the person is disabled", async () => {
  const box = capture();
  const u = await makeMerchantUser("active", "support");
  const login = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: u.email, password: "pw-12345678" } });
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookieOf(login, config.cookieName)! },
    payload: { code: codeFrom(box[0]!) },
  });
  const token = cookieOf(verify, config.cookieName) ?? cookieOf(login, config.cookieName)!;
  const before = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [config.cookieName]: token } });
  assert.equal(before.statusCode, 200);
  await pool.query(`UPDATE merchant_users SET status = 'disabled' WHERE id = $1`, [u.userId]);
  const after = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [config.cookieName]: token } });
  assert.equal(after.statusCode, 401);
});
