import assert from "node:assert/strict";
import test from "node:test";
import { bahrainDate } from "../../admin/src/dates.js";

test("bahrainDate rolls over at 21:00Z, not at UTC midnight", () => {
  assert.equal(bahrainDate(0, new Date("2026-09-11T20:59:59Z")), "2026-09-11");
  assert.equal(bahrainDate(0, new Date("2026-09-11T21:00:00Z")), "2026-09-12");
});

test("bahrainDate applies day offsets", () => {
  assert.equal(bahrainDate(-1, new Date("2026-09-12T00:30:00Z")), "2026-09-11");
  assert.equal(bahrainDate(1, new Date("2026-12-31T22:00:00Z")), "2027-01-02");
});
