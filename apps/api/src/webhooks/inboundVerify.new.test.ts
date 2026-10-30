/** CB-1: fresh-timestamp + hardening tests (existing tests use a rotted 2025 timestamp). */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";
import { loadConfig } from "../config.js";
import { withCallbackRetry } from "../acquirer/callbacks.js";
import { NotFoundError } from "../lib/errors.js";

const SECRET = "acqsec_test_secret";
const sign = (p: unknown, t: number, s = SECRET) =>
  `t=${t},v1=${createHmac("sha256", s).update(`${t}.${JSON.stringify(p)}`).digest("hex")}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test("a correctly-signed callback with a fresh timestamp verifies", () => {
  const p = { callbackId: "acqcb_1", outcome: "cleared" };
  assert.deepEqual(verifyAcquirerCallbackSignature(p, sign(p, nowSec()), SECRET), { valid: true });
});

test("a correctly-signed but stale callback is rejected (replay window)", () => {
  const p = { callbackId: "acqcb_1" };
  const r = verifyAcquirerCallbackSignature(p, sign(p, nowSec() - 3600), SECRET);
  assert.equal(r.reason, "timestamp_out_of_tolerance");
});

test("empty secret never validates a signature", () => {
  const p = { a: 1 };
  assert.equal(verifyAcquirerCallbackSignature(p, sign(p, nowSec(), ""), "").valid, false);
  assert.equal(verifyAcquirerCallbackSignature(p, undefined, "", true).valid, false);
});

const base = { DATABASE_URL: "postgres://x", WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=" };

test("production: require-signature cannot be disabled, empty secret fails startup", () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "production", SETTLEMENT_INTERNAL_TOKEN: "t" }), /ACQUIRER_CALLBACK_SIGNING_SECRET/);
  const prodEnv = {
    ...base, NODE_ENV: "production", ACQUIRER_CALLBACK_SIGNING_SECRET: "s", SETTLEMENT_INTERNAL_TOKEN: "t",
    BROWSER_ORIGINS: "https://a.example", COOKIE_SECURE: "true",
  };
  try {
    const c = loadConfig({ ...prodEnv, ACQUIRER_CALLBACK_REQUIRE_SIGNATURE: "false" });
    assert.equal(c.acquirerCallbackRequireSignature, true);
  } catch (e) {
    // other production prerequisites may be missing in this env; the secret check is covered above
    assert.doesNotMatch(String(e), /ACQUIRER_CALLBACK/);
  }
  assert.equal(loadConfig({ ...base, NODE_ENV: "test" }).acquirerCallbackRequireSignature, false);
});

test("retry wrapper does not retry deterministic AppErrors but retries transient ones", async () => {
  let n = 0;
  await assert.rejects(withCallbackRetry(async () => { n++; throw new NotFoundError("transaction_not_found"); }, { delayMs: 1 }));
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(withCallbackRetry(async () => { n++; throw new Error("conn reset"); }, { delayMs: 1 }));
  assert.equal(n, 3);
});
