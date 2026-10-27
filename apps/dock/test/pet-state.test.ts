import assert from "node:assert/strict";
import { test } from "node:test";
import { grabPoint, movesPet, petMood } from "../src/web/pet-state.ts";

test("A pet's mood: a request first, then not connected, waiting or idle (TIN-479)", () => {
  assert.equal(petMood({ client_name: "Claude", waiting: false }, 1), "asking");
  assert.equal(petMood({ client_name: null, waiting: false }, 2), "asking");
  assert.equal(petMood({ client_name: null, waiting: false }, 0), "off");
  assert.equal(petMood({ client_name: "Claude", waiting: true }, 0), "waiting");
  assert.equal(petMood({ client_name: "Claude", waiting: false }, 0), "idle");
});

test("A pet's grab point is where the drag held it, inside it", () => {
  const box = { left: 0, top: 0, width: 72, height: 72 };
  assert.deepEqual(grabPoint({ x: 30, y: 40 }, box), [30, 40]);
  // The logo away from the window's corner (a bubble beside it).
  assert.deepEqual(grabPoint({ x: 200, y: 140 }, { left: 168, top: 106, width: 72, height: 72 }), [32, 34]);
  assert.deepEqual(grabPoint({ x: -5, y: 90 }, box), [0, 72]);
});

test("Only a drop nothing took moves the pet", () => {
  assert.equal(movesPet("none"), true);
  assert.equal(movesPet("link"), false);
  assert.equal(movesPet("copy"), false);
  assert.equal(movesPet(undefined), false);
});
