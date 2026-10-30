import assert from "node:assert/strict";
import test from "node:test";
import { generateInviteCode } from "./inviteCode.js";

test("invite codes use the requested length and only the unambiguous alphabet", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(generateInviteCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  }
  assert.equal(generateInviteCode(12).length, 12);
});

test("invite codes do not repeat across many draws", () => {
  const seen = new Set(Array.from({ length: 500 }, () => generateInviteCode()));
  assert.equal(seen.size, 500);
});
