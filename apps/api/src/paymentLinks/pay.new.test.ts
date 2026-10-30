/**
 * PAY-1: reservation timeout while the first request is still running
 * authorize/capture. Real Postgres (DATABASE_URL, migrated); slow acquirer stub.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("pay.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
test.after(() => pool.end());

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const OTHER_CARD = { ...CARD, pan: "4000000000000002" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config = { paymentLinkReservationTimeoutSeconds: 1 };

async function setup() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pay1 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1,$2,'owner','x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = randomUUID();
  const l = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1,$2,4750, now() + interval '1 day', 'merchant_session', $3) RETURNING id`,
    [merchantId, token, u.rows[0]!.id],
  );
  return { merchantId, token, linkId: l.rows[0]!.id };
}

/** Acquirer whose first authorize is slow (outlasting the reservation timeout). */
function slowAcquirer(opts: { slowAuthMs: number; onCapture?: () => Promise<void> }) {
  let authCalls = 0;
  let captureCalls = 0;
  const acq: AcquirerSimulator = {
    async authorize(req) {
      authCalls++;
      if (authCalls === 1) await sleep(opts.slowAuthMs);
      return { outcome: "approved", acquirerReference: `acq_${req.idempotencyKey}`, latencyMs: 0 };
    },
    async capture(req) {
      captureCalls++;
      await opts.onCapture?.();
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund(req) {
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
  return { acq, calls: () => ({ authCalls, captureCalls }) };
}

async function txnCount(merchantId: string) {
  const r = await pool.query<{ n: string }>(`SELECT count(*) n FROM transactions WHERE merchant_id = $1`, [merchantId]);
  return Number(r.rows[0]!.n);
}

test("timed-out reservation, same card: second request replays, one transaction, both 200 same id", async () => {
  const { merchantId, token, linkId } = await setup();
  const { acq } = slowAcquirer({ slowAuthMs: 2_500 });
  const first = payPaymentLink(pool, acq, config, { token, card: CARD, idempotencyKey: "k1" });
  await sleep(1_500); // reservation (1s) has timed out; first still in authorize
  const second = payPaymentLink(pool, acq, config, { token, card: CARD, idempotencyKey: "k2" });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal((a.body as { transactionId: string }).transactionId, (b.body as { transactionId: string }).transactionId);
  assert.equal(await txnCount(merchantId), 1);
  const row = await pool.query(`SELECT status, transaction_id FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(row.rows[0].status, "paid");
  assert.equal(row.rows[0].transaction_id, (a.body as { transactionId: string }).transactionId);
});

test("timed-out reservation, second request different card: charged link must still end 'paid'", async () => {
  const { merchantId, token, linkId } = await setup();
  const { acq } = slowAcquirer({ slowAuthMs: 2_500 });
  const first = payPaymentLink(pool, acq, config, { token, card: CARD, idempotencyKey: "k1" });
  await sleep(1_500);
  const second = payPaymentLink(pool, acq, config, { token, card: OTHER_CARD, idempotencyKey: "k2" });
  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, "fulfilled");
  assert.equal((a as PromiseFulfilledResult<{ statusCode: number; body: unknown }>).value.statusCode, 200);
  assert.equal(b.status, "rejected"); // idempotency_key_reused, never a second charge
  assert.equal(await txnCount(merchantId), 1);
  const row = await pool.query(`SELECT status, transaction_id FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(row.rows[0].status, "paid", "captured transaction must be recorded on the link");
  const aBody = (a as PromiseFulfilledResult<{ body: unknown }>).value.body as { transactionId: string };
  assert.equal(row.rows[0].transaction_id, aBody.transactionId);
});

test("finalize finds the link paid with a DIFFERENT transaction: loud 409, never a silent 200", async () => {
  const { merchantId, token, linkId } = await setup();
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const { acq } = slowAcquirer({
      slowAuthMs: 0,
      onCapture: async () => {
        const t = await pool.query<{ id: string }>(
          `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
           VALUES ($1,'captured',4750,4750,'acq_other') RETURNING id`,
          [merchantId],
        );
        await pool.query(
          `UPDATE payment_links SET status='paid', paid_at=now(), transaction_id=$2, reservation_token=NULL WHERE id=$1`,
          [linkId, t.rows[0]!.id],
        );
      },
    });
    const res = await payPaymentLink(pool, acq, config, { token, card: CARD, idempotencyKey: "k1" });
    assert.equal(res.statusCode, 409);
    assert.equal((res.body as { error: string }).error, "payment_link_double_charge");
    assert.equal("linkTransactionId" in (res.body as object), false);
    assert.ok(errors.some((e) => e.includes("DOUBLE CHARGE")));
  } finally {
    console.error = origError;
  }
});
