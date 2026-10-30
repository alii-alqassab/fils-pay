import assert from "node:assert/strict";
import test from "node:test";
import { parseReportFilter } from "./parseReportFilter.js";

test("no filter gives an empty predicate", () => {
  assert.deepEqual(parseReportFilter(undefined), {});
});

test("valid status and dates pass through; merchantId is ignored", () => {
  assert.deepEqual(
    parseReportFilter(JSON.stringify({ status: "captured", from: "2026-09-01", to: "2026-09-30T10:00:00Z", merchantId: "x" })),
    { status: "captured", from: "2026-09-01", to: "2026-09-30T10:00:00Z" },
  );
});

test("malformed JSON, non-objects, bad dates and non-string status are 400s", () => {
  for (const raw of ["{", "[]", "null", JSON.stringify({ from: "not-a-date" }), JSON.stringify({ to: 5 }), JSON.stringify({ status: { a: 1 } })]) {
    assert.throws(() => parseReportFilter(raw), (e: { code?: string; statusCode?: number }) => e.statusCode === 400 || e.code === "invalid_filter");
  }
});
