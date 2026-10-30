/** Only our own websites may call the API from a browser (foreign Origin -> 403). Requires DATABASE_URL. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("originGuard.new.test.ts requires DATABASE_URL");
const env = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  BROWSER_ORIGINS: "https://app.mine.test,https://admin.mine.test",
};
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const app = buildApp(loadConfig(env), pool);
const open = buildApp(loadConfig({ ...env, ENFORCE_ORIGIN: "false" }), pool);
test.after(async () => { await app.close(); await open.close(); await pool.end(); });

const login = { email: "nobody@x.test", password: "wrong-password-123" };

test("a request from another website is refused before any work is done", async () => {
  for (const method of ["POST", "GET"] as const) {
    const res = await app.inject({
      method,
      url: method === "POST" ? "/v1/auth/email-login" : "/v1/auth/me",
      headers: { origin: "https://evil.example" },
      ...(method === "POST" ? { payload: login } : {}),
    });
    assert.equal(res.statusCode, 403, method);
    assert.equal(res.json().error, "origin_not_allowed");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  }
});

test("our own websites are served normally (and get CORS headers)", async () => {
  for (const origin of ["https://app.mine.test", "https://admin.mine.test"]) {
    const res = await app.inject({ method: "POST", url: "/v1/auth/email-login", headers: { origin }, payload: login });
    assert.equal(res.statusCode, 401, "reaches the real handler (wrong credentials)");
    assert.equal(res.headers["access-control-allow-origin"], origin);
  }
});

test("requests with no Origin header (API keys, callbacks, curl) are not affected", async () => {
  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  const bearer = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: "Bearer fp_live_nope" } });
  assert.equal(bearer.statusCode, 401, "reaches authentication, not the origin guard");
});

test("a lookalike or scheme-different origin is not accepted", async () => {
  for (const origin of ["http://app.mine.test", "https://app.mine.test.evil.example", "https://evil-app.mine.test", "null"]) {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin } });
    assert.equal(res.statusCode, 403, origin);
  }
});

test("preflight behaviour is unchanged", async () => {
  const good = await app.inject({ method: "OPTIONS", url: "/v1/auth/email-login", headers: { origin: "https://app.mine.test" } });
  assert.equal(good.statusCode, 204);
  const bad = await app.inject({ method: "OPTIONS", url: "/v1/auth/email-login", headers: { origin: "https://evil.example" } });
  assert.equal(bad.statusCode, 403);
});

test("ENFORCE_ORIGIN=false turns the guard off (debugging only)", async () => {
  const res = await open.inject({ method: "GET", url: "/healthz", headers: { origin: "https://evil.example" } });
  assert.equal(res.statusCode, 200);
});
