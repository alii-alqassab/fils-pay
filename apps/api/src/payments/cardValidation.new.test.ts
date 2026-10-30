import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCardBrand, passesLuhn, requireValidCard, validateCard } from "./cardValidation.js";

// Fixed "today" so expiry tests do not rot: 15 June 2026.
const NOW = new Date(Date.UTC(2026, 5, 15));
const good = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const fieldsOf = (raw: unknown) => {
  const r = validateCard(raw, NOW);
  return r.ok ? null : r.fields;
};

test("Luhn: published test numbers pass, a changed digit fails", () => {
  for (const p of ["4242424242424242", "4111111111111111", "5555555555554444", "378282246310005", "6011111111111117", "4000000000000002", "4000000000000119", "4000000000000069"]) {
    assert.equal(passesLuhn(p), true, p);
  }
  for (const p of ["4242424242424241", "4111111111111112", "378282246310006", "1234567812345678"]) {
    assert.equal(passesLuhn(p), false, p);
  }
  assert.equal(passesLuhn(""), false);
  assert.equal(passesLuhn("42x2"), false);
});

test("brand detection", () => {
  assert.equal(detectCardBrand("4242424242424242"), "visa");
  assert.equal(detectCardBrand("5555555555554444"), "mastercard");
  assert.equal(detectCardBrand("2223003122003222"), "mastercard");
  assert.equal(detectCardBrand("2720999999999999"), "mastercard");
  assert.equal(detectCardBrand("2721000000000000"), "unknown");
  assert.equal(detectCardBrand("378282246310005"), "amex");
  assert.equal(detectCardBrand("6011111111111117"), "discover");
  assert.equal(detectCardBrand("3530111333300000"), "jcb");
  assert.equal(detectCardBrand("30569309025904"), "diners");
  assert.equal(detectCardBrand("6200000000000005"), "unionpay");
  assert.equal(detectCardBrand("9999999999999995"), "unknown");
});

test("a good card passes and is normalized (spaces and dashes removed, name tidied)", () => {
  const r = validateCard({ ...good, pan: "4242 4242-4242 4242", cardholderName: "  Ali   Al-Qassab " }, NOW);
  assert.ok(r.ok);
  assert.equal(r.value.card.pan, "4242424242424242");
  assert.equal(r.value.card.cardholderName, "Ali Al-Qassab");
  assert.equal(r.value.last4, "4242");
  assert.equal(r.value.brand, "visa");
  assert.deepEqual(Object.keys(r.value.card).sort(), ["cardholderName", "cvv", "expiryMonth", "expiryYear", "pan"]);
});

test("unknown extra fields are dropped, not passed on", () => {
  const r = validateCard({ ...good, admin: true, __proto__: { x: 1 } }, NOW);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value.card).sort(), ["cvv", "expiryMonth", "expiryYear", "pan"]);
});

test("number problems", () => {
  assert.deepEqual(fieldsOf({ ...good, pan: "" }), { pan: "required" });
  assert.deepEqual(fieldsOf({ ...good, pan: "4242 4242 abcd 4242" }), { pan: "invalid_number" });
  assert.deepEqual(fieldsOf({ ...good, pan: "4242424242424241" }), { pan: "luhn" });
  assert.deepEqual(fieldsOf({ ...good, pan: "42424242" }), { pan: "too_short" });
  assert.deepEqual(fieldsOf({ ...good, pan: "42424242424242424242" }), { pan: "invalid_length" });
  assert.deepEqual(fieldsOf({ ...good, pan: "378282246310005X" }), { pan: "invalid_number" });
});

test("a Visa number with an American Express length is wrong; Amex needs 15 digits", () => {
  assert.equal(fieldsOf({ ...good, pan: "424242424242424" })?.pan, "invalid_length");
  assert.equal(fieldsOf({ pan: "378282246310005", expiryMonth: 12, expiryYear: 2030, cvv: "1234" }), null);
  assert.equal(fieldsOf({ pan: "3782822463100050", expiryMonth: 12, expiryYear: 2030, cvv: "1234" })?.pan, "invalid_length");
});

test("expiry: valid through the last day of the month, never expired, not absurdly far", () => {
  assert.equal(fieldsOf({ ...good, expiryMonth: 6, expiryYear: 2026 }), null, "this month is still valid");
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 5, expiryYear: 2026 }), { expiry: "expired" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 12, expiryYear: 2025 }), { expiry: "expired" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 0, expiryYear: 2030 }), { expiry: "invalid_month" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 13, expiryYear: 2030 }), { expiry: "invalid_month" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 1.5, expiryYear: 2030 }), { expiry: "invalid_month" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: "12" as never, expiryYear: 2030 }), { expiry: "invalid_month" });
  assert.deepEqual(fieldsOf({ ...good, expiryYear: 30 }), { expiry: "invalid_year" });
  assert.deepEqual(fieldsOf({ ...good, expiryMonth: 7, expiryYear: 2046 }), { expiry: "too_far" });
  assert.equal(fieldsOf({ ...good, expiryMonth: 6, expiryYear: 2046 }), null, "exactly 20 years is allowed");
  assert.deepEqual(fieldsOf({ pan: good.pan, cvv: good.cvv }), { expiry: "required" });
});

test("security code: digits only, 3 long (4 for American Express)", () => {
  assert.deepEqual(fieldsOf({ ...good, cvv: "" }), { cvv: "required" });
  assert.deepEqual(fieldsOf({ ...good, cvv: "12" }), { cvv: "invalid_cvv" });
  assert.deepEqual(fieldsOf({ ...good, cvv: "1234" }), { cvv: "invalid_cvv" });
  assert.deepEqual(fieldsOf({ ...good, cvv: "12a" }), { cvv: "invalid_cvv" });
  assert.deepEqual(fieldsOf({ pan: "378282246310005", expiryMonth: 12, expiryYear: 2030, cvv: "123" }), { cvv: "invalid_cvv" });
});

test("name on card: optional, but when given it must look like a name", () => {
  assert.equal(fieldsOf({ ...good, cardholderName: "" }), null);
  assert.equal(fieldsOf({ ...good, cardholderName: "علي القصاب" }), null, "Arabic names are fine");
  assert.equal(fieldsOf({ ...good, cardholderName: "María-José O'Brien Jr." }), null);
  for (const bad of ["A", "1234", "<script>", "Ali; DROP TABLE", "x".repeat(61), 42 as never]) {
    assert.deepEqual(fieldsOf({ ...good, cardholderName: bad }), { cardholderName: "invalid_name" }, String(bad));
  }
});

test("garbage input never throws", () => {
  for (const raw of [null, undefined, 5, "card", [], { pan: {} }, { pan: [], expiryMonth: [], cvv: {} }]) {
    assert.ok(validateCard(raw, NOW).ok === false);
  }
});

test("requireValidCard throws the 400 invalid_card error with field reasons and no values", () => {
  assert.throws(
    () => requireValidCard({ ...good, pan: "4242424242424241", cvv: "9" }, NOW),
    (err: Error & { statusCode?: number; code?: string; fields?: Record<string, string> }) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "invalid_card");
      assert.deepEqual(err.fields, { pan: "luhn", cvv: "invalid_cvv" });
      assert.ok(!JSON.stringify(err.fields).includes("4242"));
      return true;
    },
  );
});
