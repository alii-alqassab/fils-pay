/**
 * W3-B regression tests (DISC-F-3, DISC-F-5): stable acquirer idempotency keys
 * for authorize/capture and amount validation before the acquirer call.
 * Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { loadConfig } from "../config.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator, AcquirerOutcome } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("authorizeCapture.new.test.ts requires DATABASE_URL");
loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test", INTERNAL_API_TOKEN: "t", WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=" });
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => { await pool.end(); });

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function recorder(script: { authorize: AcquirerOutcome[]; capture: AcquirerOutcome[] }) {
  const authKeys: string[] = [];
  const capKeys: string[] = [];
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      authKeys.push(req.idempotencyKey);
      return { outcome: script.authorize.shift() ?? "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      capKeys.push(req.idempotencyKey);
      return { outcome: script.capture.shift() ?? "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund() { throw new Error("unused"); },
  };
  return { acquirer, authKeys, capKeys };
}

async function merchant() {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`W3B ${randomUUID()}`]);
  const merchantId = r.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return merchantId;
}

test("authorize: acquirer key is stable across error+retry, differs for a different client key", async () => {
  const merchantId = await merchant();
  const { acquirer, authKeys } = recorder({ authorize: ["error", "approved", "approved"], capture: [] });
  const base = { merchantId, amountFils: toFils(5_000), card: CARD };
  const k = randomUUID();
  const first = await authorizeTransaction(pool, acquirer, { ...base, idempotencyKey: k });
  assert.equal(first.statusCode, 502);
  const retry = await authorizeTransaction(pool, acquirer, { ...base, idempotencyKey: k });
  assert.equal(retry.statusCode, 201);
  assert.equal(authKeys.length, 2);
  assert.equal(authKeys[0], authKeys[1]);
  await authorizeTransaction(pool, acquirer, { ...base, idempotencyKey: randomUUID() });
  assert.notEqual(authKeys[2], authKeys[0]);
});

test("capture: acquirer key is stable across error+retry, differs for a different client key", async () => {
  const merchantId = await merchant();
  const { acquirer, capKeys } = recorder({ authorize: [], capture: ["error", "approved", "approved"] });
  const auth = await authorizeTransaction(pool, acquirer, { merchantId, amountFils: toFils(5_000), card: CARD, idempotencyKey: randomUUID() });
  const txnId = (auth.body as { id: string }).id;
  const k = randomUUID();
  const first = await captureTransaction(pool, acquirer, { merchantId, transactionId: txnId, idempotencyKey: k, actor: { type: "system" } } as never);
  assert.equal(first.statusCode, 502);
  const retry = await captureTransaction(pool, acquirer, { merchantId, transactionId: txnId, idempotencyKey: k, actor: { type: "system" } } as never);
  assert.equal(retry.statusCode, 200);
  assert.equal(capKeys[0], capKeys[1]);
  assert.equal(capKeys.length, 2);
  // different client key (partial capture on a fresh authorization)
  const auth2 = await authorizeTransaction(pool, acquirer, { merchantId, amountFils: toFils(5_000), card: CARD, idempotencyKey: randomUUID() });
  await captureTransaction(pool, acquirer, { merchantId, transactionId: (auth2.body as { id: string }).id, idempotencyKey: randomUUID(), actor: { type: "system" } } as never);
  assert.notEqual(capKeys[2], capKeys[0]);
});

test("authorize rejects zero/negative amounts before claim and acquirer call", async () => {
  const merchantId = await merchant();
  const { acquirer, authKeys } = recorder({ authorize: [], capture: [] });
  for (const amt of [0, -5]) {
    const key = randomUUID();
    const res = await authorizeTransaction(pool, acquirer, { merchantId, amountFils: amt as never, card: CARD, idempotencyKey: key });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.body, { error: "invalid_amount" });
    const claims = await pool.query(`SELECT 1 FROM idempotency_keys WHERE merchant_id=$1 AND key=$2`, [merchantId, key]);
    assert.equal(claims.rowCount, 0);
  }
  assert.equal(authKeys.length, 0);
});
