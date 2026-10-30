/**
 * WH-1 audit regression tests: concurrent dispatchers send a delivery once,
 * the sent body is exactly the signed bytes, each retry re-signs with a fresh
 * timestamp but keeps the same Webhook-Delivery-Id, and a replay mints a NEW
 * delivery id that matches the replayed envelope's `id`.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { replayWebhookDelivery } from "./replay.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("dispatcher.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "5",
  WEBHOOK_BACKOFF_BASE_MS: "1000",
  WEBHOOK_BACKOFF_CAP_MS: "60000",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
test.after(async () => {
  await pool.end();
});

async function setup() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`WH1 ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const url = `http://wh1.test/${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const ev = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 4_750, feeFils: 71, newStatus: "captured", capturedTotalFils: 4_750 },
  });
  return { merchantId, url, endpoint, outboxEventId: String(ev.id) };
}

async function secretOf(endpointId: string): Promise<string> {
  const { decodeEncryptionKey, decryptSecret } = await import("./secretCrypto.js");
  const r = await pool.query<{ secret_ciphertext: string }>(
    `SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1`,
    [endpointId],
  );
  return decryptSecret(r.rows[0]!.secret_ciphertext, decodeEncryptionKey(config.webhookSecretEncryptionKey));
}

test("concurrent dispatch passes send a given delivery exactly once (claim_token lease)", async () => {
  const { url } = await setup();
  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push(req);
    await new Promise((r) => setTimeout(r, 50));
    return { statusCode: 200, body: "ok" };
  };
  await Promise.all([
    runDispatchPass(pool, transport, config),
    runDispatchPass(pool, transport, config),
    runDispatchPass(pool, transport, config),
  ]);
  assert.equal(sent.length, 1);
});

test("body is the exact signed bytes; retry re-signs fresh but keeps Webhook-Delivery-Id; replay mints a new id matching its envelope", async () => {
  const { url, endpoint, outboxEventId } = await setup();
  const secret = await secretOf(endpoint.id);
  const sent: WebhookTransportRequest[] = [];
  let status = 500;
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push(req);
    return { statusCode: status, body: "" };
  };

  await runDispatchPass(pool, transport, config);
  const d = (
    await pool.query<{ id: string; delivery_event_id: string }>(
      `SELECT id, delivery_event_id FROM webhook_deliveries WHERE outbox_event_id = $1 AND endpoint_id = $2`,
      [outboxEventId, endpoint.id],
    )
  ).rows[0]!;
  await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1s' WHERE id = $1`, [d.id]);
  status = 200;
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 2);

  for (const req of sent) {
    const header = req.headers[WEBHOOK_SIGNATURE_HEADER]!;
    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header)!;
    const mac = createHmac("sha256", secret).update(`${m[1]}.${req.body}`).digest("hex");
    assert.equal(m[2], mac, "HMAC must cover the exact bytes sent");
    assert.equal(req.headers[WEBHOOK_DELIVERY_ID_HEADER], d.delivery_event_id);
    assert.equal(JSON.parse(req.body).id, d.delivery_event_id);
  }

  const replay = await replayWebhookDelivery(pool, { merchantId: (await pool.query(`SELECT merchant_id FROM webhook_endpoints WHERE id=$1`, [endpoint.id])).rows[0].merchant_id, endpointId: endpoint.id, deliveryId: d.id });
  await runDispatchPass(pool, transport, config);
  const last = sent[sent.length - 1]!;
  assert.equal(sent.length, 3);
  const newId = last.headers[WEBHOOK_DELIVERY_ID_HEADER]!;
  assert.notEqual(newId, d.delivery_event_id);
  assert.equal(JSON.parse(last.body).id, newId);
  assert.ok(replay.deliveryId);
});
