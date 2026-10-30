/** F-4: an authorization whose hold has lapsed can no longer be captured. Requires DATABASE_URL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("captureExpiredHold.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const acquirer: AcquirerSimulator = {
  async authorize() {
    return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
  },
  async capture(req) {
    return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
  },
  async refund() {
    throw new Error("unused");
  },
};

async function authorized(): Promise<{ merchantId: string; txnId: string }> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`F4 ${randomUUID()}`]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const auth = await authorizeTransaction(pool, acquirer, { merchantId, amountFils: toFils(5_000), card: CARD, idempotencyKey: randomUUID() });
  return { merchantId, txnId: (auth.body as { id: string }).id };
}

const capture = (merchantId: string, transactionId: string) =>
  captureTransaction(pool, acquirer, { merchantId, transactionId, idempotencyKey: randomUUID(), actor: { type: "system" } } as never);

test("capture after the hold expired is a 409 authorization_expired", async () => {
  const { merchantId, txnId } = await authorized();
  await pool.query(`UPDATE holds SET status = 'expired' WHERE transaction_id = $1`, [txnId]);
  const res = await capture(merchantId, txnId);
  assert.equal(res.statusCode, 409);
  assert.equal((res.body as { error: string }).error, "authorization_expired");
});

test("capture while the hold is still active succeeds", async () => {
  const { merchantId, txnId } = await authorized();
  const res = await capture(merchantId, txnId);
  assert.equal(res.statusCode, 200);
});
