import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdjustmentAmountFils, parseAdjustmentCsv } from "./adjustmentCsvParsing.js";

// 1 BD = 1000 fils (ADR-0001). The locked adjustmentImport.test.ts assumes 100.
test("6.00 BD is 6000 fils", () => {
  assert.equal(parseAdjustmentAmountFils("6.00"), 6000);
  assert.equal(parseAdjustmentAmountFils("-3.50"), -3500);
});

test("4.75 and 4.750 normalise identically; 3 decimals accepted", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("0.001"), 1);
});

test("bad amounts are rejected", () => {
  for (const bad of ["1.2345", "", "abc", "1e3", "1,5", "4.75 BD"]) {
    assert.throws(() => parseAdjustmentAmountFils(bad), { code: "invalid_amount" }, bad);
  }
});

test("-0 parses to a zero (no-op) row, not a negative amount", () => {
  assert.equal(Math.abs(parseAdjustmentAmountFils("-0.000")), 0);
});

test("commas in the reason are preserved", () => {
  const rows = parseAdjustmentCsv("merchantId,amount,reason\nm1,1.00,fix, again, please");
  assert.equal(rows[0]!.reason, "fix, again, please");
});
