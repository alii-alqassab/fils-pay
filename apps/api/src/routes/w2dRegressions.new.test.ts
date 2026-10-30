/**
 * Regression tests for DISC S-9 (business profile PATCH), S-10 (saved filter
 * caps) and S-12 (framework 4xx errors). Requires a migrated DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("w2dRegressions.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  OTP_DEV_EXPOSE: "true",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function setup(): Promise<{ merchantId: string; cookies: Record<string, string> }> {
  const id = randomUUID();
  const email = `w2d-${id}@w2d.test`;
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`W2D ${id.slice(0, 8)}`],
  );
  const merchantId = m.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')`,
    [merchantId, email, await hashPassword("pw-12345678", config)],
  );
  await pool.query(
    `INSERT INTO merchant_business_profiles (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Acme', 'R1', 'llc', 'a@acme.test', '+97300000000', 'Road 1', 'Manama')`,
    [merchantId],
  );
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: "pw-12345678" } });
  const pending = login.cookies.find((c) => c.name === config.cookieName)!.value;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: pending },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  return { merchantId, cookies: { [config.cookieName]: verify.cookies.find((c) => c.name === config.cookieName)!.value } };
}

test("S-9: PATCH with unknown/inherited keys gives 400, not 500", async () => {
  const { merchantId, cookies } = await setup();
  for (const payload of ['{"foo":"x"}', '{"constructor":"x"}', '{"__proto__":{"a":1},"toString":"x"}', '{"hasOwnProperty":"x"}']) {
    const res = await app.inject({
      method: "PATCH", url: `/v1/merchants/${merchantId}/business-profile`, cookies,
      headers: { "content-type": "application/json" }, payload,
    });
    assert.equal(res.statusCode, 400, payload);
  }
});

test("S-9: PATCH validates values and applies valid ones", async () => {
  const { merchantId, cookies } = await setup();
  const url = `/v1/merchants/${merchantId}/business-profile`;
  const bad: Array<Record<string, unknown>> = [
    { businessType: "bogus" }, { legalName: null }, { legalName: "  " }, { city: 5 },
    { contactEmail: "nope" }, { country: "bhr" }, { country: null }, { legalName: "x".repeat(300) },
  ];
  for (const payload of bad) {
    const res = await app.inject({ method: "PATCH", url, cookies, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  const ok = await app.inject({
    method: "PATCH", url, cookies,
    payload: { legalName: " New Name ", businessType: "partnership", contactEmail: "NEW@Acme.test", country: "AE", postalCode: null },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().legalName, "New Name");
  assert.equal(ok.json().contactEmail, "new@acme.test");
  assert.equal(ok.json().country, "AE");
});

test("S-10: saved filter name/size caps and per-merchant limit of 50 (concurrent safe)", async () => {
  const { merchantId, cookies } = await setup();
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/reporting/saved-filters", cookies, payload: payload as object });
  assert.equal((await post({ name: "n".repeat(101), filter: {} })).statusCode, 400);
  assert.equal((await post({ name: "big", filter: { x: "y".repeat(9000) } })).statusCode, 400);
  assert.equal((await post({ name: "arr", filter: [1] })).statusCode, 400);
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => post({ name: `f${i}`, filter: { status: "captured" } })));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 50);
  const rejected = results.filter((r) => r.statusCode !== 201);
  assert.ok(rejected.every((r) => r.statusCode === 409 && r.json().error === "saved_filter_limit_reached"));
  const n = await pool.query(`SELECT count(*)::int AS n FROM reporting_saved_filters WHERE merchant_id = $1`, [merchantId]);
  assert.equal(n.rows[0].n, 50);
});

test("S-12: framework 4xx errors keep their status with stable codes", async () => {
  const { cookies } = await setup();
  const bad = await app.inject({
    method: "POST", url: "/v1/reporting/saved-filters", cookies,
    headers: { "content-type": "application/json" }, payload: "{not json",
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_request");
  const media = await app.inject({
    method: "POST", url: "/v1/reporting/saved-filters", cookies,
    headers: { "content-type": "application/x-weird" }, payload: "abc",
  });
  assert.equal(media.statusCode, 415);
  assert.equal(media.json().error, "unsupported_media_type");
  const big = await app.inject({
    method: "POST", url: "/v1/reporting/saved-filters", cookies,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "a", filter: { x: "z".repeat(2 * 1024 * 1024) } }),
  });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error, "payload_too_large");
});
