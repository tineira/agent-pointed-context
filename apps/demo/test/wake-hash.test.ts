/**
 * The Agents screen's Wake on pin link (TIN-973, TIN-981): `/agents#wake-<grant id>`, wake_on_pin's paste_at, opens that
 * agent's card on load and in a page already open, and closing the card by hand closes it for good.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { wakeAfterToggle, wakeCardOf, wakeLinkAtLoad, wakeOnHashChange, wakeScrollDue } from "../src/web/wake-hash.ts";

test("only #wake-<grant id> names a card", () => {
  assert.equal(wakeCardOf("#wake-g_0a1b2c3d"), "wake-g_0a1b2c3d");
  for (const hash of ["", "#", "#wake-", "#wake-ag_0a1b", "#wake-g_XYZ", "#wake-g_0a1b/..", "wake-g_0a1b", "#wake-g_0a1b?x=1", "#agents"]) assert.equal(wakeCardOf(hash), null, hash);
});

test("the address at load opens its card once, even after the hash is gone; the address's own hash wins", () => {
  // Pulse's routing dropped the hash before the cards mounted: the one read at load still opens.
  const link = wakeLinkAtLoad("#wake-g_0a1b");
  assert.equal(link.mount(""), "wake-g_0a1b");
  // Handed out once: a list that mounts again later (the screen left and opened again) opens nothing.
  assert.equal(link.mount(""), null);
  // The address's own hash, when there is one, is the card to open.
  assert.equal(wakeLinkAtLoad("#wake-g_0a1b").mount("#wake-g_ffff"), "wake-g_ffff");
  assert.equal(wakeLinkAtLoad(null).mount("#wake-g_ffff"), "wake-g_ffff");
  assert.equal(wakeLinkAtLoad("#other").mount(""), null);
  assert.equal(wakeLinkAtLoad(null).mount(""), null, "no location (not a browser): nothing");
});

test("a hashchange to a card's address opens it and asks for a scroll; any other hashchange changes nothing", () => {
  assert.deepEqual(wakeOnHashChange("#wake-g_0a1b"), { open: "wake-g_0a1b", pending: true });
  assert.equal(wakeOnHashChange(""), null, "the hash taken off the address (after the scroll) closes nothing");
  assert.equal(wakeOnHashChange("#elsewhere"), null);
});

test("closing the open card by hand closes it for good; other toggles leave the open card as it is", () => {
  assert.equal(wakeAfterToggle("wake-g_1", "wake-g_1", false), null, "closed by hand");
  assert.equal(wakeAfterToggle(null, "wake-g_1", false), null, "and it stays closed on the next toggle event");
  assert.equal(wakeAfterToggle("wake-g_1", "wake-g_2", false), "wake-g_1", "another card closing");
  assert.equal(wakeAfterToggle("wake-g_1", "wake-g_1", true), "wake-g_1", "the open card's own open event");
  assert.equal(wakeAfterToggle(null, "wake-g_2", true), null, "a card opened by hand is not the link's");
});

test("the open card is scrolled to once the cards are shown, and only while still pending", () => {
  assert.equal(wakeScrollDue("wake-g_1", "g_1", true), true);
  assert.equal(wakeScrollDue("wake-g_1", "", true), false, "no card shown yet: an agent that connects later is scrolled to when it appears");
  assert.equal(wakeScrollDue("wake-g_1", "g_1", false), false, "already scrolled to");
  assert.equal(wakeScrollDue(null, "g_1", true), false);
});
