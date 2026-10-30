/**
 * Realistic card checks on the public payment route and the authorize route: bad cards are refused
 * with field reasons BEFORE the link is reserved or any acquirer call is made; good cards still pay;
 * the stored idempotency hash does not cover the security code. Requires DATABASE_URL (migrated).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { recordKycReview } from "../onboarding/review.js";
import { issueApiKeyInTx } from "../apiKeys/issue.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { authorizeTransaction } from "../payments/authorize.js";
import { toFils } from "@filspay/money";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("cardCheckout.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_FAILURE_RATE: "0",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);
test.after(async () => { await app.close(); await pool.end(); });

const GOOD = { pan: "4242 4242 4242 4242", expiryMonth: 12, expiryYear: 2035, cvv: "123", cardholderName: "Ali Al-Qassab" };

async function makeLink() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Card ${randomUUID().slice(0, 8)}`]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1,$2,'owner','x') RETURNING id`, [merchantId, `o-${randomUUID()}@example.test`]);
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = randomUUID();
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id) VALUES ($1,$2,4750, now() + interval '1 day','merchant_session',$3)`,
    [merchantId, token, u.rows[0]!.id],
  );
  return { merchantId, token, userId: u.rows[0]!.id };
}
const pay = (token: string, card: unknown, key = randomUUID()) =>
  app.inject({ method: "POST", url: `/v1/payment-links/${token}/pay`, headers: { "idempotency-key": key }, payload: { card } });
const linkStatus = async (token: string) => (await pool.query(`SELECT status, reserved_at FROM payment_links WHERE token = $1`, [token])).rows[0];

test("an impossible card is refused with field reasons, the link is NOT reserved and nothing is created", async () => {
  const { merchantId, token } = await makeLink();
  const res = await pay(token, { ...GOOD, pan: "4242 4242 4242 4241", expiryYear: 2020, cvv: "9" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_card");
  assert.deepEqual(res.json().fields, { pan: "luhn", expiry: "expired", cvv: "invalid_cvv" });
  assert.ok(!res.body.includes("4241"), "the response must not echo the card number");
  const l = await linkStatus(token);
  assert.equal(l.status, "active");
  assert.equal(l.reserved_at, null);
  const n = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(n.rows[0].n, 0);
  const k = await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE merchant_id = $1`, [merchantId]);
  assert.equal(k.rows[0].n, 0, "no idempotency record may be created for an invalid card");
});

test("each problem is refused: bad name, missing expiry, letters in the number", async () => {
  const { token } = await makeLink();
  for (const [card, field] of [
    [{ ...GOOD, cardholderName: "<b>x</b>" }, "cardholderName"],
    [{ pan: GOOD.pan, cvv: "123" }, "expiry"],
    [{ ...GOOD, pan: "4242 4242 4242 42ab" }, "pan"],
  ] as const) {
    const res = await pay(token, card);
    assert.equal(res.statusCode, 400, field);
    assert.ok(field in res.json().fields, field);
  }
  assert.equal((await linkStatus(token)).status, "active");
});

test("a good card (written with spaces) pays, and the response carries no card data", async () => {
  const { token } = await makeLink();
  const res = await pay(token, GOOD);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "paid");
  assert.ok(!res.body.includes("4242"));
  assert.ok(!res.body.includes("123"), "no security code in the response");
  assert.equal((await linkStatus(token)).status, "paid");
});

test("the demo cards still behave: ...0002 declines, 4111... approves", async () => {
  const a = await makeLink();
  const declined = await pay(a.token, { ...GOOD, pan: "4000000000000002" });
  assert.equal(declined.statusCode, 402);
  const b = await makeLink();
  assert.equal((await pay(b.token, { ...GOOD, pan: "4111111111111111" })).statusCode, 200);
});

test("the idempotency hash ignores the security code but still tells different cards apart (PCI: never keep CVV, even hashed)", async () => {
  const { merchantId } = await makeLink();
  const acquirer = createAcquirerSimulator(config);
  const card = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2035, cvv: "123" };
  const input = (c: typeof card) => ({ merchantId, amountFils: toFils(4750), card: c, idempotencyKey: "same-key-1", actor: { type: "system" as const } });

  const first = await authorizeTransaction(pool, acquirer, input(card));
  assert.equal(first.statusCode, 201);
  // Same number + expiry, different security code: the SAME request -> a replay of the first answer.
  const replay = await authorizeTransaction(pool, acquirer, input({ ...card, cvv: "999" }));
  assert.equal(replay.statusCode, 201);
  assert.deepEqual((replay.body as { id: string }).id, (first.body as { id: string }).id);
  // A different number under the same key is a different request -> refused.
  await assert.rejects(() => authorizeTransaction(pool, acquirer, input({ ...card, pan: "4111111111111111" })), /idempotency_key_reused/);

  const stored = await pool.query<{ request_hash: string }>(`SELECT request_hash FROM idempotency_keys WHERE merchant_id = $1`, [merchantId]);
  assert.equal(stored.rows.length, 1);
  assert.match(stored.rows[0]!.request_hash, /^[0-9a-f]{64}$/);
});

test("the merchant API route (POST /v1/transactions) applies the same card rules", async () => {
  const { merchantId, userId } = await makeLink();
  const client = await pool.connect();
  const issued = await issueApiKeyInTx(client, config, { merchantId, createdBy: userId }).finally(() => client.release());
  const bad = await app.inject({
    method: "POST", url: "/v1/transactions",
    headers: { authorization: `Bearer ${issued.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 1000, card: { ...GOOD, pan: "1234 5678 1234 5678" } },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_card");
  const ok = await app.inject({
    method: "POST", url: "/v1/transactions",
    headers: { authorization: `Bearer ${issued.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 1000, card: GOOD },
  });
  assert.equal(ok.statusCode, 201, ok.body);
});
