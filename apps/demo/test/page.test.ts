import assert from "node:assert/strict";
import { test } from "node:test";
import { HEARTBEAT_MS, PAGE_WINDOW_MS, anyPageOpen, socketAlive } from "../src/worker/page.ts";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const ago = (ms: number) => now - ms;

test("the window is two heartbeats plus slack: 60 to 75 s", () => {
  assert.equal(HEARTBEAT_MS, 30_000);
  assert.ok(PAGE_WINDOW_MS >= 2 * HEARTBEAT_MS && PAGE_WINDOW_MS <= 75_000);
});

test("an OPEN socket whose last pong is older than the window is not a page", () => {
  assert.equal(socketAlive({ open: true, lastPongAt: ago(PAGE_WINDOW_MS + 1), acceptedAt: ago(10 * 60_000) }, now), false, "a proxy kept it OPEN, but the pings stopped");
  assert.equal(anyPageOpen([{ open: true, lastPongAt: ago(5 * 60_000), acceptedAt: ago(10 * 60_000) }], now), false);
});

test("an OPEN socket answered within the window is a page", () => {
  assert.equal(socketAlive({ open: true, lastPongAt: ago(HEARTBEAT_MS), acceptedAt: ago(10 * 60_000) }, now), true);
  assert.equal(socketAlive({ open: true, lastPongAt: ago(PAGE_WINDOW_MS), acceptedAt: ago(10 * 60_000) }, now), true, "the edge of the window still counts");
});

test("a fresh socket counts before its first pong, an old one without any pong does not", () => {
  assert.equal(socketAlive({ open: true, lastPongAt: null, acceptedAt: ago(1_000) }, now), true);
  assert.equal(socketAlive({ open: true, lastPongAt: null, acceptedAt: ago(PAGE_WINDOW_MS + 1) }, now), false);
  assert.equal(socketAlive({ open: true, lastPongAt: null, acceptedAt: 0 }, now), false, "accepted before accept times were recorded, and never pinged");
});

test("a socket that is not OPEN never counts; one live socket among dead ones is enough", () => {
  assert.equal(socketAlive({ open: false, lastPongAt: ago(1_000), acceptedAt: ago(2_000) }, now), false);
  const dead = { open: true, lastPongAt: ago(5 * 60_000), acceptedAt: ago(10 * 60_000) };
  assert.equal(anyPageOpen([dead, { open: true, lastPongAt: ago(3_000), acceptedAt: ago(60_000) }], now), true);
  assert.equal(anyPageOpen([], now), false);
});
