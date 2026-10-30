import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://x",
  SETTLEMENT_INTERNAL_TOKEN: "t",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

test("acquirer callback signature requirement defaults to true in production", () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: "production" }).acquirerCallbackRequireSignature, true);
});

test("production can opt out only via explicit ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false", () => {
  const cfg = loadConfig({ ...base, NODE_ENV: "production", ACQUIRER_CALLBACK_REQUIRE_SIGNATURE: "false" });
  assert.equal(cfg.acquirerCallbackRequireSignature, false);
});

test("acquirer callback signature requirement defaults to false outside production", () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: "development" }).acquirerCallbackRequireSignature, false);
});
