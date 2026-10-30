/**
 * Tests for the refund processor against a real, migrated Postgres (no DB
 * mocking). Requires `DATABASE_URL` (run `npm run migrate` first).
 *
 * There is no route to `inject` against yet — `POST /v1/refunds` is still a
 * 501 stub — so these call `processRefund()` directly. The transactions they
 * refund are set up through the real authorize/capture routes, so the ledger
 * and fee state under test is the state capture actually produces.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerOutcome, AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "processRefund.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** An acquirer whose refund outcome is fixed, so a decline or a transport
 *  error is exercised without depending on the simulator's RNG. */
function fixedAcquirer(outcome: AcquirerOutcome): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("fixedAcquirer: authorize is not used by these tests");
    },
    capture() {
      throw new Error("fixedAcquirer: capture is not used by these tests");
    },
    refund(req): Promise<AcquirerRefundResult> {
      return Promise.resolve({ outcome, acquirerReference: req.acquirerReference, latencyMs: 0 });
    },
  };
}

const approvingAcquirer = fixedAcquirer("approved");

async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Merchant ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = userResult.rows[0]!.id;

  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });

  return { merchantId, ownerUserId, rawKey: issued.rawKey };
}

/** Authorizes `amountFils` and captures `captureFils` (everything, by
 *  default) through the real routes, returning the transaction id. */
async function capturedTransaction(
  rawKey: string,
  amountFils: number,
  captureFils?: number,
): Promise<{ id: string }> {
  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-test" },
  });
  assert.equal(authorizeRes.statusCode, 201, authorizeRes.body);
  const txn = authorizeRes.json() as { id: string };

  const captureRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(captureRes.statusCode, 200, captureRes.body);

  return { id: txn.id };
}

/** The api key these tests already hold, as a writer actor — the same shape
 *  `requireMerchantWriterActor()` hands the route layer. */
async function apiKeyActor(merchantId: string): Promise<{ type: "merchant_api_key"; id: string }> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("apiKeyActor: no api key for merchant");
  return { type: "merchant_api_key", id: row.id };
}

async function reasonsFor(txnId: string): Promise<(string | null)[]> {
  const r = await pool.query<{ reason: string | null }>(
    `SELECT reason FROM refunds WHERE transaction_id = $1 ORDER BY created_at`, [txnId]);
  return r.rows.map((x) => x.reason);
}

test("omitting reason stores the migration-0070 default instead of violating the NOT NULL check", async () => {
  const m = await createApprovedMerchantWithApiKey("reason-default");
  const txn = await capturedTransaction(m.rawKey, 10_000);
  const res = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id, merchantId: m.merchantId, amountFils: toFils(1_000),
    idempotencyKey: randomUUID(), actor: await apiKeyActor(m.merchantId),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(await reasonsFor(txn.id), ["unspecified"]);
});

test("a supplied reason is stored (trimmed); blank falls back to the default", async () => {
  const m = await createApprovedMerchantWithApiKey("reason-given");
  const txn = await capturedTransaction(m.rawKey, 10_000);
  const actor = await apiKeyActor(m.merchantId);
  for (const reason of ["  damaged goods ", "   "]) {
    const res = await processRefund(pool, approvingAcquirer, {
      transactionId: txn.id, merchantId: m.merchantId, amountFils: toFils(1_000),
      idempotencyKey: randomUUID(), actor, reason,
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  }
  assert.deepEqual(await reasonsFor(txn.id), ["damaged goods", "unspecified"]);
});

test("processRefund refuses another merchant's transaction and writes nothing", async () => {
  const a = await createApprovedMerchantWithApiKey("owner");
  const b = await createApprovedMerchantWithApiKey("intruder");
  const txn = await capturedTransaction(a.rawKey, 10_000);
  const res = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id, merchantId: b.merchantId, amountFils: toFils(1_000),
    idempotencyKey: randomUUID(), actor: await apiKeyActor(b.merchantId),
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(await reasonsFor(txn.id), []);
  const l = await pool.query(`SELECT 1 FROM ledger_entries WHERE transaction_id = $1 AND description LIKE 'refund:%'`, [txn.id]);
  assert.equal(l.rowCount, 0);
});

test("concurrent refunds with different keys never exceed the captured amount", async () => {
  const m = await createApprovedMerchantWithApiKey("concurrent");
  const txn = await capturedTransaction(m.rawKey, 10_000);
  const actor = await apiKeyActor(m.merchantId);
  const results = await Promise.all([1, 2, 3].map(() => processRefund(pool, approvingAcquirer, {
    transactionId: txn.id, merchantId: m.merchantId, amountFils: toFils(6_000),
    idempotencyKey: randomUUID(), actor,
  })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  const t = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txn.id]);
  assert.equal(Number(t.rows[0]!.refunded_fils), 6_000);
});
