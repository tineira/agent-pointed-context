import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresenceWaitEvent } from "@tineira/apc-protocol";
import { flashTargets } from "../src/presence.ts";
import { dropExpiredWaits, foldWaitEvent, nextWaitExpiry, NO_OPEN_WAITS, waitOpen } from "../src/wait-presence.ts";

const at = "2026-11-13T10:00:00.000Z";
const wait = (grant_id: string, state: "open" | "closed"): PresenceWaitEvent => ({ v: 1, grant_id, at, kind: "wait", state });

test("a wait shows open only between its open and its closed", () => {
  let open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 1000);
  assert.equal(waitOpen(open, "g1", { now: 2000 }), true);
  assert.equal(waitOpen(open, "g2", { now: 2000 }), false, "another grant is not waiting");
  open = foldWaitEvent(open, wait("g1", "closed"), 3000);
  assert.equal(waitOpen(open, "g1", { now: 3000 }), false);
});

test("a takeover (closed, then open) leaves the grant waiting, timed from the new open", () => {
  let open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  open = foldWaitEvent(open, wait("g1", "closed"), 40_000);
  open = foldWaitEvent(open, wait("g1", "open"), 40_000);
  assert.equal(waitOpen(open, "g1", { now: 90_000 }), true, "50 s after the new open, within the default 60 s");
});

test("an open with no closed reads closed past the app's ceiling plus the margin", () => {
  const open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  assert.equal(waitOpen(open, "g1", { now: 59_999 }), true);
  assert.equal(waitOpen(open, "g1", { now: 60_000 }), false, "the default ceiling, 50 s, plus 10 s");
  assert.equal(waitOpen(open, "g1", { now: 39_999, ceilingS: 30 }), true);
  assert.equal(waitOpen(open, "g1", { now: 40_000, ceilingS: 30 }), false, "an app's own ceiling");
  assert.equal(nextWaitExpiry(open), 60_000);
  assert.equal(nextWaitExpiry(NO_OPEN_WAITS), null);
});

test("a dock grant is never shown waiting", () => {
  const open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  assert.equal(waitOpen(open, "g1", { now: 1, path: "dock" }), false);
  assert.equal(waitOpen(open, "g1", { now: 1, path: "direct" }), true);
});

test("a call event or junk changes nothing, and a call event still flashes, a wait event does not", () => {
  const open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  const call = { v: 1, grant_id: "g1", at, tool: "get_current_view", kind: "read", targets: [], count: 0 };
  for (const m of [call, null, "open", { ...wait("g1", "closed"), state: "shut" }]) assert.equal(foldWaitEvent(open, m, 5), open);
  assert.equal(flashTargets(wait("g1", "open"), "AG", { querySelectorAll: () => { throw new Error("no lookup for a wait"); } } as unknown as ParentNode), 0);
});

test("a replayed open for a wait already open keeps the first arrival: the clock does not restart", () => {
  const first = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  const replayed = foldWaitEvent(first, wait("g1", "open"), 50_000);
  assert.equal(replayed, first);
  assert.equal(waitOpen(replayed, "g1", { now: 60_000 }), false, "still 60 s from the first arrival");
});

test("dropExpiredWaits removes only the opens past the rule, and keeps the same object when none is", () => {
  let open = foldWaitEvent(NO_OPEN_WAITS, wait("g1", "open"), 0);
  open = foldWaitEvent(open, wait("g2", "open"), 30_000);
  assert.equal(dropExpiredWaits(open, 59_999), open);
  const pruned = dropExpiredWaits(open, 60_000);
  assert.deepEqual([...pruned.keys()], ["g2"]);
  assert.equal(nextWaitExpiry(pruned), 90_000, "the next timer is the next open's");
});
