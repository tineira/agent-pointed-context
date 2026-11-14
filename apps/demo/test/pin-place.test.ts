import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeCenterX } from "../src/web/pin-place.ts";

// Two or three agents on one order, at 375 px: Pulse places each badge's centre; the badge is 28 px, and on touch its × reaches 38 px past the mark (TIN-903).
const MARK = 28;
const REACH = 38;

test("Pulse on a phone: each badge's × stays clear of the next badge's mark, and on the screen", () => {
  for (const narrow of [false, true]) {
    const xs = [0, 1, 2].map((index) => badgeCenterX({ right: 360, narrow, index, viewportWidth: 375, touch: true }) - MARK / 2);
    xs.forEach((left, i) => {
      assert.ok(left + MARK + REACH <= 375, `badge ${i}'s × is off the screen (${left})`);
      if (i > 0) assert.ok(xs[i - 1]! - left >= MARK + REACH, `badge ${i}'s × covers the badge to its right (pitch ${xs[i - 1]! - left})`);
    });
  }
});

test("Pulse with a pointer: the corner × and the 30 px step, as before", () => {
  const xs = [0, 1].map((index) => badgeCenterX({ right: 500, narrow: true, index, viewportWidth: 1200, touch: false }));
  assert.equal(xs[0]! - xs[1]!, 30);
  assert.equal(xs[0], 500);
});
