import assert from "node:assert/strict";
import { test } from "node:test";
import { petState, pinPhase, READ_HOLD_MS, watchRead, type PetInput } from "../src/web/pet-state.ts";

const calm: PetInput = { connected: true, waiting: false, busy: false, pin: "none", requests: 0, dragging: false };

test("The pet's state: the person's drag, a request, offline, the pin, then what the agent does (TIN-483)", () => {
  assert.equal(petState(calm), "idle");
  assert.equal(petState({ ...calm, waiting: true }), "waiting");
  assert.equal(petState({ ...calm, busy: true }), "calling");
  assert.equal(petState({ ...calm, busy: true, waiting: true }), "calling");
  assert.equal(petState({ ...calm, pin: "unread" }), "pinned");
  assert.equal(petState({ ...calm, pin: "read" }), "read");
  // An agent that reads the pinned item is calling tools: that shows, not the read hold.
  assert.equal(petState({ ...calm, pin: "read", busy: true }), "calling");
  assert.equal(petState({ ...calm, pin: "unread", busy: true }), "pinned");
  assert.equal(petState({ ...calm, connected: false }), "offline");
  // A request waits on the person even for an agent no client has connected to yet.
  assert.equal(petState({ ...calm, connected: false, requests: 1 }), "pairing");
  assert.equal(petState({ ...calm, pin: "unread", requests: 2 }), "pairing");
  assert.equal(petState({ ...calm, requests: 1, dragging: true }), "dragging");
  assert.equal(petState({ ...calm, connected: false, dragging: true }), "dragging");
});

test("A pin read while the page watches shows as read for a moment; one already read does not", () => {
  const pin = (seen: boolean) => ({ pinned_at: "2026-10-27T10:00:00Z", seen });
  // The page's first look at a pin already read: old news.
  const first = watchRead(undefined, pin(true), 1000);
  assert.equal(pinPhase(first, 1000), "none");
  // Unread, then read: "read" for READ_HOLD_MS, then back to nothing.
  const unread = watchRead(first, pin(false), 2000);
  assert.equal(pinPhase(unread, 2000), "unread");
  const read = watchRead(unread, pin(true), 3000);
  assert.equal(pinPhase(read, 3000), "read");
  assert.equal(pinPhase(read, 3000 + READ_HOLD_MS - 1), "read");
  assert.equal(pinPhase(read, 3000 + READ_HOLD_MS), "none");
  // Polling again keeps the same hold; it does not restart it.
  assert.equal(watchRead(read, pin(true), 5000), read);
  // A new pin read between two looks shows too; no pin shows nothing.
  assert.equal(pinPhase(watchRead(read, { pinned_at: "2026-10-27T11:00:00Z", seen: true }, 9000), 9000), "read");
  assert.equal(pinPhase(watchRead(read, null, 9000), 9000), "none");
});
