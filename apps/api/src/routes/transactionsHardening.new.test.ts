/**
 * Regression tests for DISC S-1 (capture/void role gate) and S-13 (bad input
 * must be 400/404, not 500). Requires DATABASE_URL to point at a migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { hashPassword } from "../auth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("transactionsHardening.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const PW = "pw-12345678-x";
let pwHash: string | null = null;

async function merchantWithKey() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Hardening ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@h.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "h" });
  return { merchantId, rawKey: issued.rawKey };
}

/** Logs a user of `role` in (password + OTP) and returns the ROTATED session cookie value. */
async function sessionFor(merchantId: string, role: "owner" | "finance" | "support"): Promise<string> {
  pwHash ??= await hashPassword(PW, config);
  const email = `${role}-${randomUUID()}@h.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, $3, $4)`,
    [merchantId, email, role, pwHash],
  );
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PW } });
  assert.equal(login.statusCode, 200, login.body);
  const pending = login.cookies.find((c) => c.name === config.cookieName)!.value;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: pending },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.cookies.find((c) => c.name === config.cookieName)!.value;
}

async function authorizeTxn(rawKey: string, amountFils = 10_000): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

function captureAs(auth: { cookie?: string; rawKey?: string }, id: string, body: unknown = {}) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { "idempotency-key": randomUUID(), ...(auth.rawKey ? { authorization: `Bearer ${auth.rawKey}` } : {}) },
    cookies: auth.cookie ? { [config.cookieName]: auth.cookie } : undefined,
    payload: body as object,
  });
}
function voidAs(auth: { cookie?: string; rawKey?: string }, id: string) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/void`,
    headers: auth.rawKey ? { authorization: `Bearer ${auth.rawKey}` } : {},
    cookies: auth.cookie ? { [config.cookieName]: auth.cookie } : undefined,
  });
}

test("S-1: support session cannot capture or void (403); txn untouched", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const support = await sessionFor(merchantId, "support");
  const id = await authorizeTxn(rawKey);
  assert.equal((await captureAs({ cookie: support }, id)).statusCode, 403);
  assert.equal((await voidAs({ cookie: support }, id)).statusCode, 403);
  const st = await pool.query(`SELECT status FROM transactions WHERE id = $1`, [id]);
  assert.equal(st.rows[0].status, "authorized");
});

test("S-1: owner and finance sessions can capture / void; API key still can", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const owner = await sessionFor(merchantId, "owner");
  const finance = await sessionFor(merchantId, "finance");
  const a = await authorizeTxn(rawKey);
  const b = await authorizeTxn(rawKey);
  const c = await authorizeTxn(rawKey);
  const d = await authorizeTxn(rawKey);
  assert.equal((await captureAs({ cookie: owner }, a)).statusCode, 200);
  assert.equal((await captureAs({ cookie: finance }, b)).statusCode, 200);
  assert.equal((await voidAs({ cookie: finance }, c)).statusCode, 200);
  assert.equal((await voidAs({ rawKey }, d)).statusCode, 200);
  const e = await authorizeTxn(rawKey);
  assert.equal((await captureAs({ rawKey }, e)).statusCode, 200);
});

test("S-13: bad amounts on authorize and capture are 400", async () => {
  const { rawKey } = await merchantWithKey();
  for (const amountFils of [1.5, -5, "100", null, {}, 1e30]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils, card: VALID_CARD },
    });
    assert.equal(res.statusCode, 400, `authorize ${JSON.stringify(amountFils)}: ${res.body}`);
  }
  const missing = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { card: VALID_CARD },
  });
  assert.equal(missing.statusCode, 400);
  const id = await authorizeTxn(rawKey);
  for (const amountFils of [1.5, -5, "100", null]) {
    const res = await captureAs({ rawKey }, id, { amountFils });
    assert.equal(res.statusCode, 400, `capture ${JSON.stringify(amountFils)}: ${res.body}`);
  }
});

test("S-13: non-UUID ids are 404", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const h = { authorization: `Bearer ${rawKey}` };
  assert.equal((await app.inject({ method: "GET", url: "/v1/transactions/not-a-uuid", headers: h })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/transactions/not-a-uuid/events", headers: h })).statusCode, 404);
  assert.equal((await captureAs({ rawKey }, "not-a-uuid")).statusCode, 404);
  assert.equal((await voidAs({ rawKey }, "not-a-uuid")).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/settlement/batches/zzz", headers: h })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/settlement/batches/zzz/transactions", headers: h })).statusCode, 404);
  const owner = await sessionFor(merchantId, "owner");
  const del = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/payment-links/not-a-uuid`,
    cookies: { [config.cookieName]: owner },
  });
  assert.equal(del.statusCode, 404, del.body);
});

test("S-13: limit=abc falls back to default; bad cursors and dates are 400", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const h = { authorization: `Bearer ${rawKey}` };
  const owner = await sessionFor(merchantId, "owner");
  const cookies = { [config.cookieName]: owner };
  for (const url of ["/v1/transactions?limit=abc", "/v1/settlement/batches?limit=abc"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: h })).statusCode, 200, url);
  }
  assert.equal(
    (await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links?limit=abc`, cookies })).statusCode,
    200,
  );
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const badCursors = [
    "!!!", b64("nopipe"), b64("garbage|garbage"),
    b64(`2026-13-45 00:00:00+00|${randomUUID()}`), b64(`2026-02-31 00:00:00+00|${randomUUID()}`),
    b64("2026-01-01 00:00:00+00|not-a-uuid"),
  ];
  for (const cursor of badCursors) {
    for (const url of [
      `/v1/transactions?cursor=${cursor}`,
      `/v1/settlement/batches?cursor=${cursor}`,
    ]) {
      const r = await app.inject({ method: "GET", url, headers: h });
      assert.equal(r.statusCode, 400, `${url}: ${r.body}`);
    }
    const r = await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links?cursor=${cursor}`, cookies });
    assert.equal(r.statusCode, 400, `payment-links ${cursor}: ${r.body}`);
  }
  for (const url of [
    "/v1/transactions?from=nope",
    "/v1/transactions?to=nope",
    "/v1/settlement/batches?from=nope",
  ]) {
    assert.equal((await app.inject({ method: "GET", url, headers: h })).statusCode, 400, url);
  }
  for (const url of [
    "/v1/settlement/reconciliation?from=bad&to=2026-01-02",
    "/v1/settlement/summary?from=2026-01-01&to=2026-02-31",
  ]) {
    const r = await app.inject({ method: "GET", url, cookies });
    assert.equal(r.statusCode, 400, `${url}: ${r.body}`);
  }
});

test("valid pagination cursors still work", async () => {
  const { rawKey } = await merchantWithKey();
  const h = { authorization: `Bearer ${rawKey}` };
  await authorizeTxn(rawKey);
  await authorizeTxn(rawKey);
  const first = await app.inject({ method: "GET", url: "/v1/transactions?limit=1", headers: h });
  assert.equal(first.statusCode, 200);
  const next = first.json().nextCursor as string;
  assert.ok(next);
  const second = await app.inject({ method: "GET", url: `/v1/transactions?limit=1&cursor=${next}`, headers: h });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().transactions.length, 1);
  assert.notEqual(second.json().transactions[0].id, first.json().transactions[0].id);
});

test("F-2/F-5: authorize rejects 0 and above-ceiling amounts with 400; boundary accepted by validation", async () => {
  const { rawKey } = await merchantWithKey();
  const post = (amountFils: number) =>
    app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils, card: VALID_CARD },
    });
  const zero = await post(0);
  assert.equal(zero.statusCode, 400, zero.body);
  assert.equal(zero.json().error, "invalid_amount");
  const big = await post(99_999_999_991);
  assert.equal(big.statusCode, 400, big.body);
  assert.equal(big.json().error, "amount_too_large");
  const huge = await post(Number.MAX_SAFE_INTEGER);
  assert.equal(huge.statusCode, 400, huge.body);
});
