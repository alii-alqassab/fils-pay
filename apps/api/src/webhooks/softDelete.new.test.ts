/** S-14: soft-deleted webhook endpoints cannot be test-sent or looked up. Needs migrated DATABASE_URL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { NotFoundError } from "../lib/errors.js";
import { createWebhookEndpoint } from "./create.js";
import { getWebhookEndpoint } from "./list.js";
import { sendTestWebhookEvent } from "./testSend.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("softDelete.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => { await pool.end(); });

test("deleted endpoint: test-send is 404 and detail lookup is null; live endpoint still works", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`S14 ${randomUUID()}`]);
  const merchantId = m.rows[0]!.id;
  const ep = await createWebhookEndpoint(pool, config, {
    merchantId, url: "http://localhost:9/r", createdByType: "merchant_session", createdById: randomUUID(),
  });
  let sent = 0;
  const transport = async () => { sent++; return { statusCode: 200, body: "ok" }; };
  const input = { merchantId, endpointId: ep.id };

  assert.equal((await sendTestWebhookEvent(pool, config, transport, input)).statusCode, 200);
  assert.ok(await getWebhookEndpoint(pool, { merchantId, id: ep.id }));

  await pool.query(`UPDATE webhook_endpoints SET deleted_at = now(), status = 'disabled' WHERE id = $1`, [ep.id]);
  sent = 0;
  await assert.rejects(sendTestWebhookEvent(pool, config, transport, input), NotFoundError);
  assert.equal(sent, 0);
  assert.equal(await getWebhookEndpoint(pool, { merchantId, id: ep.id }), null);
});
