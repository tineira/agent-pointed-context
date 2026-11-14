import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffClock, handoffView } from "../src/handoff-card.ts";

const NOW = Date.parse("2026-11-14T10:00:00.000Z");
const pairing = { code: "K7M4P2", expires_at: new Date(NOW + 100_000).toISOString() };

test("the code is shown large, formatted, with the time left, until the stored expiry", () => {
  const v = handoffView({ host: "apc.tineira.com", pairing, now: NOW });
  assert.equal(v.phase, "code");
  assert.equal(v.code, "K7M-4P2");
  assert.equal(v.left, 100);
  assert.equal(v.clock, "1:40");
  assert.equal(v.button, "Cancel");
  assert.match(v.title, /apc\.tineira\.com/);
  assert.ok(v.lines.some((l) => /never give it to anyone/.test(l)));
  assert.ok(v.lines.some((l) => /the agent wasn't yours: Cancel/.test(l)));
});

test("at and past the stored expiry the countdown stays at zero and the code goes", () => {
  for (const at of [NOW + 100_000, NOW + 100_001, NOW + 999_000]) {
    const v = handoffView({ host: "dock.test", pairing, now: at });
    assert.equal(v.phase, "expired");
    assert.equal(v.code, null);
    assert.equal(v.left, 0);
    assert.equal(v.clock, "0:00");
    assert.match(v.lines.join(" "), /no longer works/);
    assert.match(v.lines.join(" "), /Drag the agent from the dock again/);
    assert.ok(!JSON.stringify(v).includes("K7M"), "no trace of the code");
  }
});

test("a bad stored expiry is as good as expired: never a code with no clock", () => {
  const v = handoffView({ host: "dock.test", pairing: { code: "K7M4P2", expires_at: "not a time" }, now: NOW });
  assert.equal(v.phase, "expired");
  assert.equal(v.code, null);
});

test("with no pairing the dock took the code and is connecting: no code, Cancel stays", () => {
  const v = handoffView({ host: "dock.test", pairing: null, now: NOW });
  assert.equal(v.phase, "connecting");
  assert.equal(v.code, null);
  assert.equal(v.button, "Cancel");
});

test("an ended pairing says what happened, asks to drop the agent again, offers no new code", () => {
  const v = handoffView({ host: "dock.test", pairing, message: "The dock refused the pairing code.", now: NOW });
  assert.equal(v.phase, "ended");
  assert.equal(v.code, null);
  assert.deepEqual(v.lines, ["The dock refused the pairing code.", "Drag the agent from the dock again."]);
  assert.equal(v.button, "Close");
  assert.ok(!/new code/i.test(JSON.stringify(v)));
});

test("the words can be replaced", () => {
  const v = handoffView({ host: "h", pairing, now: NOW }, { waitingTitle: (h) => `«${h}»`, cancel: "«cancel»" });
  assert.equal(v.title, "«h»");
  assert.equal(v.button, "«cancel»");
});

test("handoffClock", () => {
  assert.equal(handoffClock(120), "2:00");
  assert.equal(handoffClock(61), "1:01");
  assert.equal(handoffClock(9), "0:09");
  assert.equal(handoffClock(-5), "0:00");
});

import { handoffFollow, heldPairing, type HandoffFlow } from "../src/handoff-card.ts";

const held = { code: "K7M4P2", expires_at: new Date(NOW + 100_000).toISOString() };
const flow = (over: Partial<HandoffFlow> = {}): HandoffFlow => ({ grantId: "g_1", held, seen: false, ...over });

test("a code the page holds, with no stored expiry yet, shows with no countdown, and is never given a guessed one", () => {
  assert.deepEqual(heldPairing("K7M4P2", undefined), { code: "K7M4P2", expires_at: null });
  assert.deepEqual(heldPairing("K7M4P2", {}), { code: "K7M4P2", expires_at: null });
  assert.deepEqual(heldPairing("K7M4P2", { expires_at: held.expires_at }), held);
  const v = handoffView({ host: "dock.test", pairing: heldPairing("K7M4P2", null), now: NOW + 9_999_999 });
  assert.equal(v.phase, "code");
  assert.equal(v.code, "K7M-4P2");
  assert.equal(v.timed, false);
});

test("the card follows the app's state: held until the state has the grant, then the state's pairing is the truth", () => {
  // The state has not caught up with the Allow yet: the page's held code, and not done.
  assert.deepEqual(handoffFollow(flow(), undefined), { pairing: held, seen: false, done: false });
  // In handoff with the code still to be typed: its pairing, and now seen.
  const again = { code: "K7M4P2", expires_at: held.expires_at };
  assert.deepEqual(handoffFollow(flow(), { state: "handoff", pairing: again }), { pairing: again, seen: true, done: false });
  // The dock took the code: no pairing, so the card says it is connecting and shows no code; still not done.
  assert.deepEqual(handoffFollow(flow({ seen: true }), { state: "handoff", pairing: null }), { pairing: null, seen: true, done: false });
});

test("the card is done when the dock connects or the grant goes, but not before the state has had the grant in handoff", () => {
  assert.equal(handoffFollow(flow({ seen: true }), { state: "live" }).done, true, "connected");
  assert.equal(handoffFollow(flow({ seen: true }), undefined).done, true, "the grant went (cancelled, given back, expired)");
  assert.equal(handoffFollow(flow({ seen: false }), { state: "live" }).done, true, "a grant that comes straight as live");
  assert.equal(handoffFollow(flow({ seen: false }), undefined).done, false, "a stale state from before the Allow must not close the card");
  assert.equal(handoffFollow(flow({ seen: false }), { state: "in_flight" }).done, false);
});
