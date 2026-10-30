import assert from "node:assert/strict";
import test from "node:test";
import {
  CACTUS_HEIGHT, GRAVITY, JUMP_SPEED, LANE_COUNT, advance, clampLane, collides, grabs, laneX, spawnRow, speedFor, stepJump,
} from "./utils/duckGame.js";

test("lanes are clamped and centred on the middle lane", () => {
  assert.equal(clampLane(-3), 0);
  assert.equal(clampLane(9), LANE_COUNT - 1);
  assert.equal(laneX(1), 0);
  assert.equal(laneX(0), -laneX(2));
});

test("speed grows with distance but is capped", () => {
  assert.ok(speedFor(2000) > speedFor(0));
  assert.equal(speedFor(1e9), 30);
});

test("every row leaves at least one lane free of cacti and balls", () => {
  for (let i = 0; i < 400; i++) {
    const seed = (i * 7919) % 1000;
    let n = 0;
    const rand = () => ((seed + (n++) * 389) % 997) / 997;
    const row = spawnRow(1, i * 50, rand);
    const blocked = new Set(row.filter((t) => t.kind !== "donut").map((t) => t.lane));
    assert.ok(blocked.size < LANE_COUNT, `row ${i} blocks every lane`);
  }
});

test("a cactus hurts unless it is a different lane; a ball can be jumped; a donut never hurts", () => {
  const cactus = { id: 1, kind: "cactus" as const, lane: 1, z: 0.2 };
  const ball = { id: 2, kind: "ball" as const, lane: 1, z: -0.3 };
  const donut = { id: 3, kind: "donut" as const, lane: 1, z: 0 };
  assert.equal(collides(1, 0, cactus), true);
  assert.equal(collides(0, 0, cactus), false);
  assert.equal(collides(1, 0, ball), true);
  assert.equal(collides(1, 1.6, ball), false, "high enough clears a beach ball");
  assert.equal(collides(1, 0, donut), false);
  assert.equal(grabs(1, 0, donut), true);
  assert.equal(grabs(2, 0, donut), false);
  assert.equal(collides(1, 0, { ...cactus, z: 3 }), false, "not yet there");
});

test("a full jump cannot clear a cactus but does clear a ball", () => {
  const peak = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
  assert.ok(peak < CACTUS_HEIGHT);
  assert.ok(peak > 1.0);
  let h = 0;
  let v = JUMP_SPEED;
  let max = 0;
  for (let i = 0; i < 200; i++) {
    ({ height: h, velocity: v } = stepJump(h + 0.0001, v, 1 / 120));
    max = Math.max(max, h);
    if (h === 0) break;
  }
  assert.equal(h, 0, "lands again");
  assert.ok(max > 2 && max < CACTUS_HEIGHT);
});

test("things move towards the duck and are dropped after they pass it", () => {
  const moved = advance([{ id: 1, kind: "ball", lane: 0, z: -10 }, { id: 2, kind: "ball", lane: 0, z: 7.5 }], 1);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.z, -9);
});
