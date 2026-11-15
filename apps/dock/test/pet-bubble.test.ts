import assert from "node:assert/strict";
import { test } from "node:test";
import { PET_BUBBLE_START, petBubbleReducer } from "../src/web/pet-bubble.ts";

test("pet bubble retains its room through expiry, denial, approval and blocked-browser fallback until Done", () => {
  let state = petBubbleReducer(PET_BUBBLE_START, { type: "show" });
  assert.equal(state.shown, true);
  state = petBubbleReducer(state, { type: "measure", width: 240, height: 200 });
  // An unverified warning or several requests need more room.
  state = petBubbleReducer(state, { type: "measure", width: 240, height: 540 });
  // An answer/expiry leaves the smaller idle card, or Connect leaves a blocked-browser link.
  for (const height of [80, 180, 260]) {
    state = petBubbleReducer(state, { type: "measure", width: 240, height });
    assert.deepEqual(state, { shown: true, size: { width: 240, height: 540 } });
  }
  assert.equal(petBubbleReducer(state, { type: "show" }), state);
  assert.equal(petBubbleReducer(state, { type: "done" }), PET_BUBBLE_START);
  // The next message gets its own size, rather than inheriting the previous session's maximum.
  assert.deepEqual(petBubbleReducer(PET_BUBBLE_START, { type: "measure", width: 240, height: 120 }), {
    shown: true, size: { width: 240, height: 120 },
  });
});

test("a pet bubble ignores a frame measured before layout (0 x 0)", () => {
  assert.equal(petBubbleReducer(PET_BUBBLE_START, { type: "measure", width: 0, height: 0 }), PET_BUBBLE_START);
  const sized = petBubbleReducer(PET_BUBBLE_START, { type: "measure", width: 240, height: 200 });
  assert.equal(petBubbleReducer(sized, { type: "measure", width: 240, height: 0 }), sized);
});
