import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brandLabel, caretForDigits, cvvLength, detectBrand, formatExpiryInput, formatPan, maxPanDigits, messageForServerField,
  newIdempotencyKey, parseExpiry, passesLuhn, sanitizePanInput, validateAll, validateCvv, validateExpiry, validateName, validatePan,
} from "./utils/cardValidation.js";

const NOW = new Date(2026, 5, 15); // 15 June 2026 (local time, as the page uses)

test("Luhn and brand detection agree with the API's vectors", () => {
  for (const p of ["4242424242424242", "4111111111111111", "5555555555554444", "378282246310005", "6011111111111117", "4000000000000002", "4000000000000119", "4000000000000069"]) assert.equal(passesLuhn(p), true, p);
  for (const p of ["4242424242424241", "378282246310006", "1234567812345678"]) assert.equal(passesLuhn(p), false, p);
  assert.equal(detectBrand("4242424242424242"), "visa");
  assert.equal(detectBrand("2223003122003222"), "mastercard");
  assert.equal(detectBrand("378282246310005"), "amex");
  assert.equal(detectBrand("9999999999999995"), "unknown");
  assert.equal(brandLabel("amex"), "American Express");
  assert.equal(cvvLength("amex"), 4);
  assert.equal(cvvLength("visa"), 3);
  assert.equal(maxPanDigits("amex"), 15);
  assert.equal(maxPanDigits("visa"), 19);
});

test("card number is grouped as you type: 4-4-4-4, and 4-6-5 for American Express", () => {
  assert.equal(formatPan("4242424242424242"), "4242 4242 4242 4242");
  assert.equal(formatPan("42424"), "4242 4");
  assert.equal(formatPan("378282246310005"), "3782 822463 10005");
  assert.equal(sanitizePanInput("4242-4242 4242.4242abc"), "4242 4242 4242 4242");
  assert.equal(sanitizePanInput("3782822463100059999"), "3782 822463 10005", "capped at 15 for Amex");
  assert.equal(sanitizePanInput("42424242424242424242424"), "4242 4242 4242 4242 424", "capped at 19 for Visa");
  assert.equal(sanitizePanInput(""), "");
});

test("caret stays after the same digit when the text is regrouped", () => {
  assert.equal(caretForDigits("4242 4", 4), 4);
  assert.equal(caretForDigits("4242 4", 5), 6);
  assert.equal(caretForDigits("4242 4242", 0), 0);
  assert.equal(caretForDigits("4242 4242", 99), 9);
});

test("expiry box: typing, auto-slash, first digit 2-9, pasted formats, backspace over the slash", () => {
  assert.equal(formatExpiryInput("1"), "1");
  assert.equal(formatExpiryInput("12"), "12/");
  assert.equal(formatExpiryInput("123"), "12/3");
  assert.equal(formatExpiryInput("1230"), "12/30");
  assert.equal(formatExpiryInput("12/30"), "12/30");
  assert.equal(formatExpiryInput("12 / 30"), "12/30");
  assert.equal(formatExpiryInput("3"), "03/", "a first digit of 2-9 completes the month and adds the slash");
  assert.equal(formatExpiryInput("03/5"), "03/5");
  assert.equal(formatExpiryInput("0", "03/"), "0", "deleting back into the month");
  assert.equal(formatExpiryInput("122030"), "12/30", "browser autofill MM/YYYY");
  assert.equal(formatExpiryInput("12/3045678"), "12/30");
  assert.equal(formatExpiryInput("12", "12/"), "12", "backspace removes the slash instead of re-adding it");
  assert.equal(formatExpiryInput("", "1"), "");
  assert.equal(formatExpiryInput("ab"), "");
});

test("parseExpiry", () => {
  assert.deepEqual(parseExpiry("12/30"), { month: 12, year: 2030 });
  assert.deepEqual(parseExpiry("01 / 27"), { month: 1, year: 2027 });
  assert.equal(parseExpiry("12/3"), null);
  assert.equal(parseExpiry("1230"), null);
  assert.equal(parseExpiry(""), null);
});

test("expiry rules: month range, expired, this month still valid, too far", () => {
  assert.equal(validateExpiry("", NOW), "Enter the expiry date as MM/YY.");
  assert.equal(validateExpiry("12/", NOW), "Enter the expiry date as MM/YY.");
  assert.equal(validateExpiry("13/30", NOW), "The month must be between 01 and 12.");
  assert.equal(validateExpiry("00/30", NOW), "The month must be between 01 and 12.");
  assert.equal(validateExpiry("05/26", NOW), "This card has expired.");
  assert.equal(validateExpiry("12/25", NOW), "This card has expired.");
  assert.equal(validateExpiry("06/26", NOW), null, "valid through the end of June 2026");
  assert.equal(validateExpiry("12/30", NOW), null);
  assert.equal(validateExpiry("06/46", NOW), null);
  assert.equal(validateExpiry("07/46", NOW), "That expiry date is too far in the future.");
});

test("number, name and security-code messages", () => {
  assert.equal(validatePan(""), "Enter your card number.");
  assert.equal(validatePan("4242 4242"), "That card number is too short.");
  assert.equal(validatePan("4242 4242 4242 4241"), "That card number is not valid. Please check it.");
  assert.equal(validatePan("4242 4242 4242 4242"), null);
  assert.equal(validatePan("3782 822463 10005"), null);
  assert.equal(validatePan("4242 4242 4242 42ab"), "The card number can only contain digits.");
  assert.equal(validateName(""), "Enter the name shown on the card.");
  assert.equal(validateName("A"), "Use letters only for the name on the card.");
  assert.equal(validateName("12345"), "Use letters only for the name on the card.");
  assert.equal(validateName("Ali Al-Qassab"), null);
  assert.equal(validateName("علي القصاب"), null);
  assert.equal(validateCvv("", "visa"), "Enter the 3-digit security code.");
  assert.equal(validateCvv("12", "visa"), "The security code has 3 digits (on the back).");
  assert.equal(validateCvv("123", "visa"), null);
  assert.equal(validateCvv("123", "amex"), "American Express security codes have 4 digits (on the front).");
  assert.equal(validateCvv("1234", "amex"), null);
  assert.equal(validateCvv("12a", "visa"), "The security code has 3 digits (on the back).");
});

test("validateAll reports every wrong field at once and nothing for a good card", () => {
  assert.deepEqual(validateAll({ name: "Ali", pan: "4242 4242 4242 4242", expiry: "12/30", cvv: "123" }, NOW), {});
  const bad = validateAll({ name: "", pan: "4242", expiry: "01/20", cvv: "1" }, NOW);
  assert.deepEqual(Object.keys(bad).sort(), ["cvv", "expiry", "name", "pan"]);
  const amex = validateAll({ name: "Ali", pan: "3782 822463 10005", expiry: "12/30", cvv: "123" }, NOW);
  assert.deepEqual(Object.keys(amex), ["cvv"], "an Amex needs a 4-digit code");
});

test("server field codes map to plain messages (and unknown fields are ignored)", () => {
  assert.deepEqual(messageForServerField("pan", "luhn"), { field: "pan", message: "That card number is not valid. Please check it." });
  assert.deepEqual(messageForServerField("expiry", "expired"), { field: "expiry", message: "This card has expired." });
  assert.equal(messageForServerField("cardholderName", "invalid_name")?.field, "name");
  assert.equal(messageForServerField("surprise", "x"), null);
});

test("idempotency keys look like UUIDs, are unique, and work without crypto.randomUUID (plain-http pages)", () => {
  const a = newIdempotencyKey();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, newIdempotencyKey());
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true });
  try {
    const b = newIdempotencyKey();
    assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
  }
});
