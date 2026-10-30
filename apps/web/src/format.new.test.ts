import assert from "node:assert/strict";
import test from "node:test";
import { bhd } from "./format.js";

test("bhd formats negative fils with a leading minus", () => {
  assert.equal(bhd(-1), "-0.001 BHD");
  assert.equal(bhd(-4750), "-4.750 BHD");
});

test("bhd keeps non-negative output and rejects non-integers", () => {
  assert.equal(bhd(0), "0.000 BHD");
  assert.equal(bhd(4750), "4.750 BHD");
  assert.throws(() => bhd(1.5));
  assert.throws(() => bhd(Number.NaN));
});
