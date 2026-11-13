import assert from "node:assert/strict";
import { test } from "node:test";
import { isPresenceWaitEvent, parsePresenceWaitEvent, WAIT_CEILING_DEFAULT_S, WAIT_EVENT_MARGIN_S, waitOpenLimitMs } from "../src/index.ts";

const open = { v: 1, grant_id: "g_1", at: "2026-11-13T10:00:00.000Z", kind: "wait", state: "open" };

test("a wait event parses only with its five keys, v 1, an ISO time and state open or closed", () => {
  assert.deepEqual(parsePresenceWaitEvent(open), open);
  assert.deepEqual(parsePresenceWaitEvent({ ...open, state: "closed" }), { ...open, state: "closed" });
  assert.equal(isPresenceWaitEvent(open), true);
  for (const bad of [
    null,
    "wait",
    [open],
    { ...open, state: "maybe" },
    { ...open, v: 2 },
    { ...open, kind: "read" },
    { ...open, at: "yesterday" },
    { ...open, at: "2026-11-13 10:00:00" },
    { ...open, grant_id: "" },
    { ...open, grant_id: 7 },
    { ...open, targets: [] },
    { ...open, tool: "wait_for_focus" },
    { v: 1, grant_id: "g_1", at: open.at, kind: "wait" },
  ]) {
    assert.equal(parsePresenceWaitEvent(bad), null, JSON.stringify(bad));
    assert.equal(isPresenceWaitEvent(bad), false);
  }
});

test("a call event is not a wait event", () => {
  assert.equal(isPresenceWaitEvent({ v: 1, grant_id: "g_1", at: open.at, tool: "get_current_view", kind: "read", targets: [], count: 0 }), false);
});

test("an open with no closed reads closed past the app's ceiling plus the margin", () => {
  assert.equal(WAIT_CEILING_DEFAULT_S, 50);
  assert.equal(WAIT_EVENT_MARGIN_S, 10);
  assert.equal(waitOpenLimitMs(), 60_000);
  assert.equal(waitOpenLimitMs(30), 40_000);
  assert.equal(waitOpenLimitMs(0), 60_000, "a ceiling that is no ceiling falls back to the default");
  assert.equal(waitOpenLimitMs(Number.NaN), 60_000);
});
