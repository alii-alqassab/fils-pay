import assert from "node:assert/strict";
import test from "node:test";
import { bahrainDayStartIso, dayStartIso } from "./format.js";

test("bahrainDayStartIso is 21:00Z of the previous day (Asia/Bahrain midnight)", () => {
  assert.equal(bahrainDayStartIso("2026-09-12"), "2026-09-11T21:00:00.000Z");
  assert.equal(bahrainDayStartIso("2026-01-01"), "2025-12-31T21:00:00.000Z");
});

test("bahrainDayStartIso rejects empty and malformed input", () => {
  assert.equal(bahrainDayStartIso(""), undefined);
  assert.equal(bahrainDayStartIso("12/09/2026"), undefined);
  assert.equal(bahrainDayStartIso("2026-13-45"), undefined);
});

test("bahrainDayStartIso differs from the UTC helper by exactly 3 hours", () => {
  const utc = Date.parse(dayStartIso("2026-09-12")!);
  const bh = Date.parse(bahrainDayStartIso("2026-09-12")!);
  assert.equal(utc - bh, 3 * 60 * 60 * 1000);
});
