import assert from "node:assert/strict";
import { test } from "node:test";
import { floatingAgents, marked, MAX_UNMARKED, noneSelected, readUnmarked, setMarks, writeUnmarked, type Marks } from "../src/web/float-marks.ts";

const A = { id: "ag_0a" };
const B = { id: "ag_0b" };
const off: Marks = { on: false, unmarked: [] };

test("A new agent floats by default while Float is on (TIN-698)", () => {
  const on = { ...off, on: true };
  assert.ok(marked(on, "ag_0c"));
  assert.deepEqual(floatingAgents(on, [A, B]), [A, B]);
  // Float off: no agent floats, whatever its mark.
  assert.deepEqual(floatingAgents(off, [A, B]), []);
});

test("Only the marked agents float: A and not B", () => {
  const m = setMarks({ ...off, on: true }, [B.id], false);
  assert.deepEqual(floatingAgents(m, [A, B]), [A]);
  assert.equal(m.on, true);
  // Unmarking never turns Float off; it stays on with what is left.
  assert.deepEqual(setMarks(m, [A.id], false).on, true);
});

test("Marking an agent while Float is off turns Float on", () => {
  const m = setMarks({ on: false, unmarked: [A.id, B.id] }, [A.id], true);
  assert.deepEqual(m, { on: true, unmarked: [B.id] });
  assert.deepEqual(floatingAgents(m, [A, B]), [A]);
  // Unmarking while it is off leaves it off; so does marking nothing (an empty All, a bad id).
  assert.equal(setMarks(off, [A.id], false).on, false);
  assert.equal(setMarks(off, [], true).on, false);
  assert.equal(setMarks(off, ["hint"], true).on, false);
});

test("A mark survives the agent leaving and coming back, and a restart", () => {
  const m = setMarks({ ...off, on: true }, [B.id], false);
  // B's connection is gone: it is not in the dock's list, so it does not float, and its mark stays.
  assert.deepEqual(floatingAgents(m, [A]), [A]);
  assert.deepEqual(m.unmarked, [B.id]);
  // B is back: still unmarked, so still not floating.
  assert.deepEqual(floatingAgents(m, [A, B]), [A]);
  // What is stored reads back the same (a reload of the page, a restart of the app).
  assert.deepEqual(readUnmarked(writeUnmarked(m.unmarked)), [B.id]);
});

test("Float on with no agent marked says so; off, or with no agents, it does not", () => {
  const none = setMarks({ ...off, on: true }, [A.id, B.id], false);
  assert.equal(noneSelected(none, [A.id, B.id]), true);
  assert.equal(noneSelected({ ...none, on: false }, [A.id, B.id]), false);
  assert.equal(noneSelected(none, []), false);
  assert.equal(noneSelected({ ...off, on: true }, [A.id]), false);
  // A new agent connecting is marked, so the notice goes.
  assert.equal(noneSelected(none, [A.id, B.id, "ag_0c"]), false);
});

test("All and None mark or unmark every listed agent", () => {
  const none = setMarks(off, [A.id, B.id], false);
  assert.deepEqual(none.unmarked, [A.id, B.id]);
  const all = setMarks(none, [A.id, B.id], true);
  assert.deepEqual(all, { on: true, unmarked: [] });
});

test("Stored marks: only agent ids, no repeats, at most MAX_UNMARKED", () => {
  assert.deepEqual(readUnmarked(null), []);
  assert.deepEqual(readUnmarked("not json"), []);
  assert.deepEqual(readUnmarked(JSON.stringify({ unmarked: ["ag_0a", "ag_0a", "x", 3, "ag_../"] })), ["ag_0a"]);
  // Unmarking twice keeps one entry; a long history keeps the newest.
  assert.deepEqual(setMarks(setMarks(off, [A.id], false), [A.id], false).unmarked, [A.id]);
  assert.deepEqual(setMarks(off, [A.id, A.id], false).unmarked, [A.id]);
  const many = Array.from({ length: MAX_UNMARKED + 5 }, (_, i) => `ag_${i.toString(16)}`);
  const m = setMarks(off, many, false);
  assert.equal(m.unmarked.length, MAX_UNMARKED);
  assert.equal(m.unmarked.at(-1), many.at(-1));
  // Ids that are not the dock's are never stored.
  assert.deepEqual(setMarks(off, ["hint", "ag_"], false).unmarked, []);
});
