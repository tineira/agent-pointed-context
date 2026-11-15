import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD, FLOAT_START, cardOuterSize, fitsCard, floatSizeReducer, type FloatSizeEvent } from "../src/web/float-size.ts";

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

const small = { width: 96, height: 150 };
const big = { width: 300, height: 230 };
const run = (events: FloatSizeEvent[]) => events.reduce(floatSizeReducer, FLOAT_START);

test("Float's state: a click opens the card for that request and keeps the earlier size", () => {
  const s = run([{ type: "grow", outer: small }, { type: "open", id: "p1", outer: small, ok: true }]);
  assert.deepEqual(s, { before: small, opened: "p1", wantShrink: false });
});

test("Float's state: a click whose resize threw leaves the notice (P3-1)", () => {
  assert.equal(run([{ type: "open", id: "p1", outer: small, ok: false }]).opened, null);
});

test("Float's state: decide and idle never shrink Float by themselves (errors, wrong codes and fallbacks stay visible)", () => {
  let s = run([
    { type: "open", id: "p1", outer: small, ok: true },
    { type: "decide", last: true },
  ]);
  assert.deepEqual(s, { before: small, opened: "p1", wantShrink: false });
  s = floatSizeReducer(s, { type: "idle" });
  assert.deepEqual(s, { before: small, opened: null, wantShrink: false });
  // A subsequent request must not overwrite `before` with the still-large size.
  s = floatSizeReducer(s, { type: "grow", outer: big });
  assert.equal(s.before, small);
  assert.equal(s.wantShrink, false);
});

test("Float's state: only Done or dismiss (shrink) asks to shrink back, and the earlier size is kept until resize confirms it", () => {
  let s = run([
    { type: "open", id: "p1", outer: small, ok: true },
    { type: "idle" },
    { type: "shrink" },
  ]);
  assert.deepEqual(s, { before: small, opened: null, wantShrink: true });
  s = floatSizeReducer(s, { type: "resize", outer: big }); // still card-sized
  assert.equal(s.before, small);
  assert.equal(s.wantShrink, true);
  s = floatSizeReducer(s, { type: "resize", outer: small });
  assert.deepEqual(s, FLOAT_START);
});

test("Float's state: shrink with no saved earlier size does nothing", () => {
  assert.deepEqual(floatSizeReducer(FLOAT_START, { type: "shrink" }), FLOAT_START);
});

test("Float's state: reset clears everything when the window closes", () => {
  const s = run([
    { type: "open", id: "p1", outer: small, ok: true },
    { type: "reset" },
  ]);
  assert.deepEqual(s, FLOAT_START);
});
