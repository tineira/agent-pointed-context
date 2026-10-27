import assert from "node:assert/strict";
import { test } from "node:test";
import { blobPath, blink, CLIP, farthest, FX, frameAt, PetSim, POSES, share, stilled } from "../src/web/pet-pose.ts";
import type { PetState } from "../src/web/pet-state.ts";

const STATES = Object.keys(POSES) as PetState[];

test("Every state has a pose and effects, and the table names the eight states (TIN-483)", () => {
  assert.deepEqual([...STATES].sort(), ["calling", "dragging", "idle", "offline", "pairing", "pinned", "read", "waiting"]);
  for (const s of STATES) assert.ok(FX[s], s);
});

test("The body is a closed path of finite numbers at any time", () => {
  for (const s of STATES) {
    for (const t of [0, 0.7, 13.37]) {
      const d = blobPath(POSES[s], t, 1);
      assert.match(d, /^M-?[\d.]+ -?[\d.]+( C(-?[\d.]+ ){5}-?[\d.]+){40}Z$/);
      assert.ok(!d.includes("NaN"));
    }
  }
});

test("Easing moves toward the target at the same speed at any frame rate", () => {
  assert.equal(share(0, 7), 0);
  const slow = 1 - share(0.5, 7);
  const fast = (1 - share(0.1, 7)) ** 5;
  assert.ok(Math.abs(slow - fast) < 1e-9);
  const sim = new PetSim();
  let f = sim.step("idle", 0, 0.016);
  for (let i = 0; i < 300; i++) f = sim.step("offline", i * 0.016, 0.016);
  // After ~5 s offline: grey body, eyes closed, zz showing, no ring.
  assert.equal(f.fill, "rgb(154,160,171)");
  assert.ok(f.left.h < 3.5);
  assert.ok(f.zz[0]!.opacity > 0 || f.zz[1]!.opacity > 0);
  assert.ok(f.ring.opacity < 0.01);
});

test("Each state shows its own effects (the spec's table)", () => {
  const fx = (s: PetState) => frameAt(POSES[s], FX[s], 1, false);
  assert.ok(fx("calling").orbit.every((o) => o.opacity === 1));
  assert.equal(fx("pinned").ring.opacity, 0.95);
  assert.equal(fx("pinned").bang.opacity, 1);
  assert.equal(fx("read").check.opacity, 1);
  assert.equal(fx("read").wink.opacity, 1);
  assert.equal(fx("read").right.opacity, 0);
  assert.equal(fx("pairing").bang.opacity, 0.85);
  assert.equal(fx("idle").bang.opacity, 0);
  assert.ok(POSES.dragging.squash < 0 && POSES.dragging.eyeH > POSES.idle.eyeH);
  assert.ok(POSES.pinned.hop > 0 && POSES.pinned.eyeH > POSES.idle.eyeH);
  assert.ok(POSES.waiting.bob > POSES.idle.bob);
});

test("Reduced motion: a still pose does not depend on time, and nothing hops, orbits or breathes", () => {
  for (const s of STATES) {
    const a = frameAt(stilled(POSES[s]), FX[s], 1.3, true);
    const b = frameAt(stilled(POSES[s]), FX[s], 99, true);
    assert.deepEqual(a, b, s);
    assert.equal(a.bob, 0);
  }
  assert.equal(stilled(POSES.pinned).hop, 0);
  // The still frame of a sim snaps to the state at once.
  const sim = new PetSim();
  assert.deepEqual(sim.still("read"), frameAt(stilled(POSES.read), FX.read, 0, true));
});

test("The blink closes the eyes briefly every 3.4 s, and never when still or already shut", () => {
  assert.equal(blink(1, false, 21), 1);
  assert.ok(blink(3.4 * 0.975, false, 21) < 0.2);
  assert.equal(blink(3.4 * 0.975, true, 21), 1);
  assert.equal(blink(3.4 * 0.975, false, 3), 1);
});

test("A pet runs slowly once its state has stayed put, whatever the state, but never while dragged", () => {
  const sim = new PetSim();
  assert.equal(sim.calm(5), false);
  let t = 100;
  for (const state of ["idle", "waiting", "pinned", "pairing", "offline", "calling"] as const) {
    sim.step(state, t, 0.016);
    assert.equal(sim.calm(t + 5), false, state);
    assert.equal(sim.calm(t + 11), true, state);
    t += 100;
  }
  sim.step("dragging", t, 0.016);
  assert.equal(sim.calm(t + 100), false);
});

test("Everything drawn stays inside the Windows pet's circular clip, with a margin (TIN-483)", () => {
  for (const s of STATES) {
    let far = 0;
    for (let t = 0; t < 30; t += 0.05) far = Math.max(far, farthest(s, t, false));
    far = Math.max(far, farthest(s, 0, true));
    assert.ok(far <= CLIP.r - 3, `${s}: ${far.toFixed(1)} of ${CLIP.r}`);
  }
});

test("The first frame is the state's pose, drawn before the loop runs", () => {
  const sim = new PetSim();
  const f = sim.snap("offline", 3);
  assert.equal(f.fill, "rgb(154,160,171)");
  // It does not start the clock: the first step of the loop does.
  assert.equal(sim.calm(1000), false);
});
