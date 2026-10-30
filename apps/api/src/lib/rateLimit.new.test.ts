import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { FixedWindowLimiter } from "./rateLimit.js";

const baseEnv = {
  DATABASE_URL: "postgres://unused/unused",
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};
// Every query returns no rows: logins fail with 401 invalid_credentials, no DB needed.
const stubPool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;

test("FixedWindowLimiter allows `limit` hits, then blocks with retry seconds, then resets", () => {
  let t = 1_000;
  const l = new FixedWindowLimiter(() => t);
  for (let i = 0; i < 3; i++) assert.equal(l.hit("k", 3, 60_000), null);
  assert.equal(l.hit("k", 3, 60_000), 60);
  assert.equal(l.hit("other", 3, 60_000), null);
  t += 60_000;
  assert.equal(l.hit("k", 3, 60_000), null);
});

test("default config in NODE_ENV=test leaves the limiter off", async () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.rateLimitEnabled, false);
  assert.equal(config.trustProxy, false);
  const app = buildApp(config, stubPool);
  for (let i = 0; i < 15; i++) {
    const res = await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: "a@b.c", password: "x" } });
    assert.equal(res.statusCode, 401);
  }
  await app.close();
});

test("RATE_LIMIT_ENABLED=true: email-login returns 429 rate_limited with Retry-After after the limit", async () => {
  const config = loadConfig({ ...baseEnv, RATE_LIMIT_ENABLED: "true", RATE_LIMIT_LOGIN_PER_MINUTE: "3" });
  const app = buildApp(config, stubPool);
  const send = (email: string) =>
    app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email, password: "x" } });
  for (let i = 0; i < 3; i++) assert.equal((await send("Victim@Example.com")).statusCode, 401);
  const limited = await send("victim@example.com "); // normalized to the same key
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, "rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  // A different email is a different key.
  assert.equal((await send("someone-else@example.com")).statusCode, 401);
  await app.close();
});

test("RATE_LIMIT_ENABLED=true: otp, admin login, public pay and signup are limited", async () => {
  const config = loadConfig({
    ...baseEnv, RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_OTP_PER_MINUTE: "2", RATE_LIMIT_ADMIN_LOGIN_PER_MINUTE: "2",
    RATE_LIMIT_PAY_PER_MINUTE: "2", RATE_LIMIT_SIGNUP_PER_HOUR: "2",
  });
  const app = buildApp(config, stubPool);
  const cases: Array<[string, string]> = [
    ["/v1/auth/otp/resend", "otp"],
    ["/v1/admin/auth/login", "admin"],
    ["/v1/payment-links/tok123/pay", "pay"],
    ["/v1/merchants", "signup"],
  ];
  for (const [url] of cases) {
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "POST", url, payload: { email: "a@b.c", password: "x" } });
      assert.notEqual(r.statusCode, 429, `${url} hit ${i + 1}`);
    }
    const r = await app.inject({ method: "POST", url, payload: { email: "a@b.c", password: "x" } });
    assert.equal(r.statusCode, 429, url);
    assert.equal(r.json().error, "rate_limited");
  }
  // Pay limit is per token: another token is unaffected.
  const other = await app.inject({ method: "POST", url: "/v1/payment-links/other/pay", payload: {} });
  assert.notEqual(other.statusCode, 429);
  await app.close();
});

test("TRUST_PROXY parsing and X-Forwarded-For handling", async () => {
  assert.equal(loadConfig({ ...baseEnv, TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ ...baseEnv, TRUST_PROXY: "2" }).trustProxy, 2);
  assert.deepEqual(loadConfig({ ...baseEnv, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).trustProxy, ["10.0.0.0/8", "127.0.0.1"]);
  // Untrusted by default: a spoofed XFF does not give a fresh limiter key.
  const config = loadConfig({ ...baseEnv, RATE_LIMIT_ENABLED: "true", RATE_LIMIT_LOGIN_PER_MINUTE: "1" });
  const app = buildApp(config, stubPool);
  const go = (xff: string) => app.inject({ method: "POST", url: "/v1/auth/email-login", headers: { "x-forwarded-for": xff }, payload: { email: "a@b.c", password: "x" } });
  assert.equal((await go("1.1.1.1")).statusCode, 401);
  assert.equal((await go("2.2.2.2")).statusCode, 429);
  await app.close();
});

test("email-login verifies at most loginMaxCandidates rows (S-17)", async () => {
  const queries: unknown[][] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => { queries.push(params); return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const app = buildApp(loadConfig({ ...baseEnv, LOGIN_MAX_CANDIDATES: "3" }), pool);
  await app.inject({ method: "POST", url: "/v1/auth/email-login", payload: { email: "a@b.c", password: "x" } });
  assert.equal(queries[0]![3], 3);
  await app.close();
});
