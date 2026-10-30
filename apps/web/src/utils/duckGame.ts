/** Rules for "Duck Dash", the waiting-room game: pure functions with no DOM or 3D, so they are easy to test. */
export type ThingKind = "cactus" | "ball" | "donut";

export interface Thing {
  id: number;
  kind: ThingKind;
  /** 0, 1 or 2 (left, middle, right). */
  lane: number;
  /** Depth: negative is ahead of the duck, 0 is the duck, things move towards positive z. */
  z: number;
}

export const LANE_COUNT = 3;
export const LANE_WIDTH = 2.4;
export const SPAWN_Z = -70;
export const DESPAWN_Z = 8;
export const GRAVITY = 38;
export const JUMP_SPEED = 14;
/** Highest point of a jump is JUMP_SPEED^2 / (2 * GRAVITY), about 2.58 units. */
export const CACTUS_HEIGHT = 3.2;
export const BALL_HEIGHT = 1.0;
const HIT_DEPTH = 0.9;

export function laneX(lane: number): number {
  return (lane - 1) * LANE_WIDTH;
}

export function clampLane(lane: number): number {
  return Math.max(0, Math.min(LANE_COUNT - 1, lane));
}

/** World speed in units per second: starts gentle, speeds up with distance, capped. */
export function speedFor(distance: number): number {
  return Math.min(13 + distance * 0.012, 30);
}

/** Seconds between rows of things: shorter as the game speeds up. */
export function spawnGap(distance: number): number {
  return Math.max(0.55, 1.25 - distance * 0.0006);
}

/**
 * One row of things. Always leaves at least one lane free of cacti, so the game is never unwinnable;
 * sometimes adds a beach ball (jumpable) and a donut in a free lane. `rand` returns 0..1.
 */
export function spawnRow(nextId: number, distance: number, rand: () => number): Thing[] {
  const rows: Thing[] = [];
  const freeLane = Math.floor(rand() * LANE_COUNT);
  const hard = Math.min(0.85, 0.35 + distance * 0.0004);
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    if (lane === freeLane) continue;
    const r = rand();
    if (r < hard * 0.6) rows.push({ id: nextId + rows.length, kind: "cactus", lane, z: SPAWN_Z });
    else if (r < hard) rows.push({ id: nextId + rows.length, kind: "ball", lane, z: SPAWN_Z });
  }
  if (rand() < 0.7) {
    rows.push({ id: nextId + rows.length, kind: "donut", lane: freeLane, z: SPAWN_Z - 0.01 });
  }
  return rows;
}

/** Does the duck (in `lane`, `height` above the ground) collide with this thing? Donuts never hurt. */
export function collides(lane: number, height: number, t: Thing): boolean {
  if (t.kind === "donut" || t.lane !== lane || Math.abs(t.z) > HIT_DEPTH) return false;
  return height < (t.kind === "cactus" ? CACTUS_HEIGHT : BALL_HEIGHT);
}

/** Does the duck grab this donut? (A little taller reach than a collision, so a jump still counts.) */
export function grabs(lane: number, height: number, t: Thing): boolean {
  return t.kind === "donut" && t.lane === lane && Math.abs(t.z) <= HIT_DEPTH + 0.4 && height < 3.2;
}

/** Moves things towards the duck and drops the ones that passed it. */
export function advance(things: Thing[], dz: number): Thing[] {
  const out: Thing[] = [];
  for (const t of things) {
    const moved = { ...t, z: t.z + dz };
    if (moved.z < DESPAWN_Z) out.push(moved);
  }
  return out;
}

/** Jump physics for one frame. Returns the new height and vertical velocity. */
export function stepJump(height: number, velocity: number, dt: number): { height: number; velocity: number } {
  if (height <= 0 && velocity <= 0) return { height: 0, velocity: 0 };
  const v = velocity - GRAVITY * dt;
  const h = height + v * dt;
  return h <= 0 ? { height: 0, velocity: 0 } : { height: h, velocity: v };
}
