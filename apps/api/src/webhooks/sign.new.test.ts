import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { signPayload } from "./sign.js";

test("signPayload returns the exact body string that the HMAC covers", () => {
  const payload = { b: 1, a: { z: 2, y: [3, { d: 1, c: 2 }] } };
  const { timestamp, signature, body } = signPayload(payload, "secret", 1700000000);
  const hex = createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signature, `t=${timestamp},v1=${hex}`);
  assert.deepEqual(JSON.parse(body), payload);
});
