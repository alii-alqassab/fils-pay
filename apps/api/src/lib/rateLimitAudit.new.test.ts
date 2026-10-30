import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedWindowLimiter, canonicalPath } from "./rateLimit.js";

test("encoded token spellings share one canonical path", () => {
  const base = canonicalPath("/v1/payment-links/abc/pay");
  for (const v of ["/v1/payment-links/%61bc/pay", "/v1/payment-links/a%62c/pay", "/v1/payment-links/ab%63/pay"]) {
    assert.equal(canonicalPath(v), base);
  }
});

test("an encoded slash or invalid encoding is left raw, never turned into a new path segment", () => {
  assert.equal(canonicalPath("/v1/payment-links/a%2Fb/pay"), "/v1/payment-links/a%2Fb/pay");
  assert.equal(canonicalPath("/v1/payment-links/%E0%A4%A/pay"), "/v1/payment-links/%E0%A4%A/pay");
});

test("the limiter store is bounded: a new key is refused when it is full of live keys", () => {
  let now = 1_000;
  const l = new FixedWindowLimiter(() => now, 2);
  assert.equal(l.hit("a", 5, 60_000), null);
  assert.equal(l.hit("b", 5, 60_000), null);
  assert.notEqual(l.hit("c", 5, 60_000), null, "third live key is refused");
  assert.equal(l.hit("a", 5, 60_000), null, "existing keys keep working");
  now += 61_000;
  assert.equal(l.hit("c", 5, 60_000), null, "after the windows expire there is room again");
});
