import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const prod = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://x/db?sslmode=require",
  SETTLEMENT_INTERNAL_TOKEN: "a-real-token",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

test("valid production env loads", () => {
  assert.equal(loadConfig(prod).cookieSecure, true);
});
test("production rejects dev-token", () => {
  assert.throws(() => loadConfig({ ...prod, SETTLEMENT_INTERNAL_TOKEN: "dev-token" }), /dev default/);
});
test("production rejects the built-in dev webhook key", () => {
  assert.throws(
    () => loadConfig({ ...prod, WEBHOOK_SECRET_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }),
    /dev default/,
  );
});
test("production rejects sslmode=disable unless opted out", () => {
  const url = "postgres://x/db?sslmode=disable";
  assert.throws(() => loadConfig({ ...prod, DATABASE_URL: url }), /sslmode=disable/);
  assert.equal(loadConfig({ ...prod, DATABASE_URL: url, DATABASE_ALLOW_NO_TLS: "true" }).nodeEnv, "production");
});
test("production rejects insecure cookies and OTP exposure", () => {
  assert.throws(() => loadConfig({ ...prod, COOKIE_SECURE: "false" }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ ...prod, OTP_DEV_EXPOSE: "true" }), /OTP_DEV_EXPOSE/);
});
test("unrecognised NODE_ENV fails instead of silently becoming development", () => {
  assert.throws(() => loadConfig({ ...prod, NODE_ENV: "prod" }), /NODE_ENV/);
});
test("dev defaults still work outside production", () => {
  const cfg = loadConfig({ DATABASE_URL: "postgres://x/db?sslmode=disable" });
  assert.equal(cfg.nodeEnv, "development");
});
