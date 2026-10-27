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

test("Float's state: the last decision shrinks, and the earlier size is kept until a resize confirms it (P2-2)", () => {
  let s = run([{ type: "open", id: "p1", outer: small, ok: true }, { type: "decide", last: true }]);
  assert.deepEqual(s, { before: small, opened: null, wantShrink: true });
  s = floatSizeReducer(s, { type: "resize", outer: big }); // refused: still card-sized
  assert.equal(s.before, small);
  assert.equal(s.wantShrink, true);
  s = floatSizeReducer(s, { type: "grow", outer: big }); // the next request must not record the big size
  assert.equal(s.before, small);
  s = floatSizeReducer(s, { type: "decide", last: true });
  s = floatSizeReducer(s, { type: "resize", outer: small });
  assert.deepEqual(s, FLOAT_START);
});

test("Float's state: a request decided elsewhere shrinks on the next click in the window (P2-2)", () => {
  const s = run([{ type: "open", id: "p1", outer: small, ok: true }, { type: "idle" }]);
  assert.deepEqual(s, { before: small, opened: null, wantShrink: true });
});

test("Float's state: after a decision, a replacing request shows the notice again (P2-1)", () => {
  const s = run([{ type: "open", id: "p1", outer: small, ok: true }, { type: "decide", last: true }]);
  assert.equal(s.opened, null); // p2 is not the request the card was opened for
});

test("Float's state: a decision with another request waiting keeps the size, and the window closing resets", () => {
  let s = run([{ type: "open", id: "p1", outer: small, ok: true }, { type: "decide", last: false }]);
  assert.deepEqual(s, { before: small, opened: null, wantShrink: false });
  s = floatSizeReducer(s, { type: "reset" });
  assert.deepEqual(s, FLOAT_START);
});
