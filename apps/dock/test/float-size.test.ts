import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD, cardOuterSize, fitsCard } from "../src/web/float-size.ts";

test("Float's card: the target outer size adds the title bar to the card's content size (TIN-480)", () => {
  // One agent: 96 x 110 content, outer 96 wide and 150 tall (a 40 px title bar).
  assert.deepEqual(cardOuterSize({ width: 96, height: 110 }, { width: 96, height: 150 }), { width: CARD.width, height: CARD.height + 40 });
  // Side borders count too.
  assert.deepEqual(cardOuterSize({ width: 96, height: 110 }, { width: 112, height: 150 }), { width: CARD.width + 16, height: CARD.height + 40 });
});

test("Float's card: a window already bigger is not shrunk, and shows the card at once", () => {
  assert.deepEqual(cardOuterSize({ width: 400, height: 300 }, { width: 400, height: 340 }), { width: 400, height: 340 });
  assert.equal(fitsCard({ width: 400, height: 300 }), true);
  assert.equal(fitsCard({ width: CARD.width, height: CARD.height }), true);
  assert.equal(fitsCard({ width: 96, height: 110 }), false);
  assert.equal(fitsCard({ width: 400, height: 110 }), false);
});
