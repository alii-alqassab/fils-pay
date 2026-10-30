/** CB-1: route tests with fresh timestamps (existing route tests use a rotted 2025 timestamp). */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("requires DATABASE_URL");
const SECRET = "acqsec_route_new_secret";
const config = loadConfig({
  DATABASE_URL: databaseUrl, NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => { await app.close(); await pool.end(); });

const hdr = (b: unknown, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${JSON.stringify(b)}`).digest("hex")}`;
const body = (transactionId: string, callbackId: string) => ({
  callbackId, type: "fraud_review.completed", transactionId,
  occurredAt: "2026-09-16T10:00:00.000Z", outcome: "confirmed_fraud", note: "n",
});
const post = (b: unknown, signature?: string) => app.inject({
  method: "POST", url: "/v1/acquirer/callbacks",
  headers: signature ? { "acquirer-callback-signature": signature } : {}, payload: b as object,
});

async function txn(): Promise<string> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`cb ${randomUUID()}`]);
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference) VALUES ($1,'captured',50000,50000,$2) RETURNING id`,
    [m.rows[0]!.id, `ref_${randomUUID()}`]);
  return t.rows[0]!.id;
}
const notes = async (id: string) =>
  (await pool.query<{ c: string }>(`SELECT count(*)::text c FROM acquirer_callback_notes WHERE callback_id=$1`, [id])).rows[0]!.c;

test("fresh-signed callback accepted; redelivery is idempotent", async () => {
  const b = body(await txn(), `acqcb_${randomUUID()}`);
  assert.equal((await post(b, hdr(b))).statusCode, 200);
  assert.equal((await post(b, hdr(b))).statusCode, 200);
  assert.equal(await notes(b.callbackId), "1");
});

test("stale-signed callback is rejected 401 and not applied", async () => {
  const b = body(await txn(), `acqcb_${randomUUID()}`);
  const r = await post(b, hdr(b, Math.floor(Date.now() / 1000) - 3600));
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().message, "timestamp_out_of_tolerance");
  assert.equal(await notes(b.callbackId), "0");
});

test("unknown transaction returns 404 and frees the receipt for redelivery", async () => {
  const b = body(randomUUID(), `acqcb_${randomUUID()}`);
  const r = await post(b, hdr(b));
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error, "transaction_not_found");
  const rec = await pool.query(`SELECT 1 FROM acquirer_callback_receipts WHERE callback_id=$1`, [b.callbackId]);
  assert.equal(rec.rowCount, 0);
});

test("bad signature on an invalid body is 401, not 400 (authenticate first)", async () => {
  const r = await post({ callbackId: "x" }, "t=1,v1=00");
  assert.equal(r.statusCode, 401);
});
