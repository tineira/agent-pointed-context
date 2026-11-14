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
