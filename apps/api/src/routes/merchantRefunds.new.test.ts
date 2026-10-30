/**
 * POST /v1/merchants/:merchantId/refunds: full and partial refunds, scope, idempotency, validation.
 * Requires DATABASE_URL (migrated).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("merchantRefunds.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => { await app.close(); await pool.end(); });

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2035, cvv: "123" };

async function merchant() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Refund ${randomUUID().slice(0, 8)}`]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1,$2,'owner','x') RETURNING id`, [merchantId, `o-${randomUUID()}@example.test`]);
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, auth: { authorization: `Bearer ${rawKey}` } };
}
async function capturedTxn(auth: Record<string, string>, amount = 10_000) {
  const a = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...auth, "idempotency-key": randomUUID() }, payload: { amountFils: amount, card: CARD } });
  assert.equal(a.statusCode, 201, a.body);
  const id = a.json().id as string;
  const c = await app.inject({ method: "POST", url: `/v1/transactions/${id}/capture`, headers: { ...auth, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}
const refund = (merchantId: string, auth: Record<string, string>, body: unknown, key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/refunds`, headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) }, payload: body as object });

test("full refund works and the transaction becomes refunded", async () => {
  const { merchantId, auth } = await merchant();
  const id = await capturedTxn(auth);
  const res = await refund(merchantId, auth, { transactionId: id });
  assert.ok(res.statusCode === 200 || res.statusCode === 201, res.body);
  const t = await pool.query(`SELECT status, refunded_fils FROM transactions WHERE id = $1`, [id]);
  assert.equal(t.rows[0].status, "refunded");
  assert.equal(Number(t.rows[0].refunded_fils), 10_000);
});

test("partial refund, then the rest; a refund above what is left is refused", async () => {
  const { merchantId, auth } = await merchant();
  const id = await capturedTxn(auth);
  const first = await refund(merchantId, auth, { transactionId: id, amountFils: 4_000 });
  assert.ok(first.statusCode < 300, first.body);
  assert.equal((await pool.query(`SELECT status FROM transactions WHERE id=$1`, [id])).rows[0].status, "partially_refunded");
  const tooMuch = await refund(merchantId, auth, { transactionId: id, amountFils: 7_000 });
  assert.ok(tooMuch.statusCode >= 400 && tooMuch.statusCode < 500, tooMuch.body);
  const rest = await refund(merchantId, auth, { transactionId: id });
  assert.ok(rest.statusCode < 300, rest.body);
  const t = await pool.query(`SELECT status, refunded_fils FROM transactions WHERE id=$1`, [id]);
  assert.equal(t.rows[0].status, "refunded");
  assert.equal(Number(t.rows[0].refunded_fils), 10_000);
});

test("the same Idempotency-Key refunds once", async () => {
  const { merchantId, auth } = await merchant();
  const id = await capturedTxn(auth);
  const key = randomUUID();
  const a = await refund(merchantId, auth, { transactionId: id, amountFils: 3_000 }, key);
  const b = await refund(merchantId, auth, { transactionId: id, amountFils: 3_000 }, key);
  assert.equal(a.statusCode, b.statusCode);
  const t = await pool.query(`SELECT refunded_fils FROM transactions WHERE id=$1`, [id]);
  assert.equal(Number(t.rows[0].refunded_fils), 3_000);
});

test("validation and scope: key required, bad ids, bad amounts, someone else's merchant or transaction", async () => {
  const mine = await merchant();
  const other = await merchant();
  const id = await capturedTxn(mine.auth);
  assert.equal((await refund(mine.merchantId, mine.auth, { transactionId: id }, null)).statusCode, 400);
  assert.equal((await refund(mine.merchantId, mine.auth, { transactionId: "nope" })).statusCode, 400);
  assert.equal((await refund(mine.merchantId, mine.auth, { transactionId: id, amountFils: 0 })).statusCode, 400);
  assert.equal((await refund(mine.merchantId, mine.auth, { transactionId: id, amountFils: 1.5 })).statusCode, 400);
  assert.equal((await refund(other.merchantId, mine.auth, { transactionId: id })).statusCode, 403, "another merchant's path is forbidden");
  assert.equal((await refund(other.merchantId, other.auth, { transactionId: id })).statusCode, 404, "another merchant's transaction is not found");
  assert.equal((await app.inject({ method: "POST", url: `/v1/merchants/${mine.merchantId}/refunds`, headers: { "idempotency-key": randomUUID() }, payload: { transactionId: id } })).statusCode, 401);
  const t = await pool.query(`SELECT refunded_fils FROM transactions WHERE id=$1`, [id]);
  assert.equal(Number(t.rows[0].refunded_fils), 0, "nothing was refunded by any refused request");
});

test("an authorized-only (not captured) transaction cannot be refunded", async () => {
  const { merchantId, auth } = await merchant();
  const a = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...auth, "idempotency-key": randomUUID() }, payload: { amountFils: 5_000, card: CARD } });
  const res = await refund(merchantId, auth, { transactionId: a.json().id });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, res.body);
});
