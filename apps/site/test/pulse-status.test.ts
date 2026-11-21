/**
 * The real hero's parent side (TIN-1071, TIN-1072; design TIN-1063 §§ 2, 5, 6.3): no frame until "Use your own agent",
 * even with /try's hint stored, then exactly one, sandboxed, pointing at Pulse's hero; the frame's messages taken only
 * from Pulse's origin and the frame's own window, in the contract's shapes; and the hint /try reads, kept to its
 * schema and 6 h, with the agent's name cleaned as Pulse cleans it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanName as pulseCleanName } from "../../demo/src/worker/names.ts";
import { HeroSwitch } from "../src/web/landing/hero/live.ts";
import { PULSE_ORIGIN } from "../src/pulse-origin.ts";
import {
  cleanName,
  clearPulseStatus,
  embedMessage,
  FRAME_MAX,
  FRAME_MIN,
  PULSE_HERO,
  readPulseStatus,
  savePulseStatus,
  STATUS_KEY,
  STATUS_TTL_MS,
} from "../src/web/pulse-status.ts";

/** A sessionStorage stand-in. */
function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const NOW = 1_800_000_000_000;
const stored = (value: unknown) => memory({ [STATUS_KEY]: typeof value === "string" ? value : JSON.stringify(value) });
const iframes = (html: string) => html.match(/<iframe\b[^>]*>/g) ?? [];

test("the landing renders no frame before the click, even with the hint stored, and exactly one after", () => {
  const demo = createElement("figure", { className: "hero-stage" }, "simulated");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: stored({ connected: true, agentName: "Claude", updatedAt: Date.now() }), configurable: true });
  try {
    // Initial state: HeroStage starts with live = false (landing.test.ts checks the source), whatever is stored.
    const before = renderToStaticMarkup(createElement(HeroSwitch, { live: false, demo, onBack: () => {} }));
    assert.deepEqual(iframes(before), []);
    assert.match(before, /simulated/);
    // After "Use your own agent" (setLive(true)): one frame, Pulse's hero, sandboxed, hidden behind its loading state.
    const after = renderToStaticMarkup(createElement(HeroSwitch, { live: true, demo, onBack: () => {} }));
    const frames = iframes(after);
    assert.equal(frames.length, 1);
    assert.match(frames[0]!, / src="https:\/\/pulse\.apc\.tineira\.com\/embed\/hero"/);
    assert.match(frames[0]!, / sandbox="allow-scripts allow-same-origin"/);
    assert.match(frames[0]!, / allow="clipboard-write"/);
    assert.doesNotMatch(after, /simulated/, "in place of the simulated stage");
    assert.match(after, /data-phase="loading"/);
    assert.match(after, /Opening Pulse…/);
    assert.match(after, /<a href="https:\/\/pulse\.apc\.tineira\.com\/agents" target="_blank" rel="noopener">or open Pulse/, "the site owns the way out");
    assert.match(after, /Back to the demo/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
  assert.equal(PULSE_HERO, "https://pulse.apc.tineira.com/embed/hero");
  assert.equal(PULSE_ORIGIN, "https://pulse.apc.tineira.com");
});

test("a message counts only from Pulse's origin and the frame's own window, in the contract's shapes", () => {
  const frame = { name: "frame" };
  const at = (data: unknown, origin = PULSE_ORIGIN, source: unknown = frame) => embedMessage({ origin, source, data }, frame);
  assert.deepEqual(at({ type: "apc:embed-ready" }), { type: "apc:embed-ready" });
  // A wrong origin: the site itself, a sibling host, Pulse over http, a look-alike.
  for (const origin of ["https://apc.tineira.com", "https://signals.apc.tineira.com", "http://pulse.apc.tineira.com", "https://pulse.apc.tineira.com.evil.example", "null"]) {
    assert.equal(at({ type: "apc:embed-ready" }, origin), null, origin);
  }
  // A wrong source: another window, none, or no frame mounted.
  assert.equal(at({ type: "apc:embed-ready" }, PULSE_ORIGIN, { name: "other" }), null);
  assert.equal(at({ type: "apc:embed-ready" }, PULSE_ORIGIN, null), null);
  assert.equal(embedMessage({ origin: PULSE_ORIGIN, source: null, data: { type: "apc:embed-ready" } }, null), null);
  // A bad schema.
  for (const data of [
    null,
    "apc:embed-ready",
    [{ type: "apc:embed-ready" }],
    { type: "apc:theme", scheme: "dark" },
    { type: "apc:pulse-status" },
    { type: "apc:pulse-status", connected: "true", agentName: null },
    { type: "apc:pulse-status", connected: true, agentName: 42 },
    { type: "apc:pulse-status", connected: true, agentName: "x".repeat(401) },
    { type: "apc:embed-resize", height: "600" },
    { type: "apc:embed-resize", height: Number.NaN },
    { type: "apc:embed-resize", height: Number.POSITIVE_INFINITY },
    { type: "apc:embed-resize" },
  ]) {
    assert.equal(at(data), null, JSON.stringify(data));
  }
  // Heights are clamped; names are cleaned; not connected carries no name.
  assert.deepEqual(at({ type: "apc:embed-resize", height: 90 }), { type: "apc:embed-resize", height: FRAME_MIN });
  assert.deepEqual(at({ type: "apc:embed-resize", height: 5000 }), { type: "apc:embed-resize", height: FRAME_MAX });
  assert.deepEqual(at({ type: "apc:embed-resize", height: 612.4 }), { type: "apc:embed-resize", height: 612 });
  assert.deepEqual(at({ type: "apc:pulse-status", connected: true, agentName: "Claude‮\u0007 Code" }), { type: "apc:pulse-status", connected: true, agentName: "Claude Code" });
  assert.deepEqual(at({ type: "apc:pulse-status", connected: false, agentName: "Claude" }), { type: "apc:pulse-status", connected: false, agentName: null });
  // Status only: whatever else a message carries is dropped.
  assert.deepEqual(at({ type: "apc:pulse-status", connected: true, agentName: null, secret: "s", sid: "x" }), { type: "apc:pulse-status", connected: true, agentName: null });
});

test("/try: a valid hint shows the agent, and an expired, future or malformed one is removed", () => {
  // Valid, with a name, and without one ("Connected directly").
  assert.deepEqual(readPulseStatus(stored({ connected: true, agentName: "Claude", updatedAt: NOW - 1000 }), NOW), { agentName: "Claude" });
  assert.deepEqual(readPulseStatus(stored({ connected: true, agentName: null, updatedAt: NOW }), NOW), { agentName: null });
  assert.deepEqual(readPulseStatus(stored({ connected: true, agentName: "Claude", updatedAt: NOW - STATUS_TTL_MS }), NOW), { agentName: "Claude" }, "6 h is still valid");
  assert.equal(readPulseStatus(memory(), NOW), null, "nothing stored: the unconnected walk");
  // Expired, from the future, or malformed: ignored and removed.
  for (const value of [
    { connected: true, agentName: "Claude", updatedAt: NOW - STATUS_TTL_MS - 1 },
    { connected: true, agentName: "Claude", updatedAt: NOW + 60_000 },
    { connected: false, agentName: "Claude", updatedAt: NOW },
    { connected: "true", agentName: "Claude", updatedAt: NOW },
    { connected: true, agentName: 7, updatedAt: NOW },
    { connected: true, agentName: "Claude", updatedAt: String(NOW) },
    { connected: true, agentName: "Claude" },
    [true, "Claude", NOW],
    null,
    "{not json",
    "",
  ]) {
    const store = stored(value);
    assert.equal(readPulseStatus(store, NOW), null, JSON.stringify(value));
    assert.equal(store.map.has(STATUS_KEY), false, `${JSON.stringify(value)} is removed`);
  }
  // Blocked storage never breaks the page.
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(readPulseStatus(blocked, NOW), null);
  assert.doesNotThrow(() => savePulseStatus({ connected: true, agentName: "x" }, blocked, NOW));
  assert.doesNotThrow(() => clearPulseStatus(blocked));
});

test("/try: a hostile name with bidi or control characters is cleaned on read, as Pulse cleans it", () => {
  const hostile = [
    "‮tnegA‬ evil",
    "Claude\u0000\u0007\u001B[31m",
    "a b c",
    "​‍﻿",
    "Grok⁦⁩؜",
    "é", // NFC: é
    "x".repeat(80),
    "  spaced   out  ",
  ];
  for (const name of hostile) {
    const read = readPulseStatus(stored({ connected: true, agentName: name, updatedAt: NOW }), NOW);
    assert.ok(read, JSON.stringify(name));
    assert.equal(read.agentName, cleanName(name));
    assert.equal(cleanName(name), pulseCleanName(name), `the site cleans ${JSON.stringify(name)} as Pulse does`);
    if (read.agentName) {
      assert.doesNotMatch(read.agentName, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      assert.ok([...read.agentName].length <= 40);
    }
  }
  assert.equal(readPulseStatus(stored({ connected: true, agentName: "​‍", updatedAt: NOW }), NOW)?.agentName, null, "nothing left: Connected directly");
  assert.equal(cleanName("é"), "é");
});

test("the landing keeps the hint as the contract says: on connected, dropped on not connected", () => {
  const store = memory();
  savePulseStatus({ connected: true, agentName: "Claude‮" }, store, NOW);
  assert.deepEqual(JSON.parse(store.map.get(STATUS_KEY)!), { connected: true, agentName: "Claude", updatedAt: NOW });
  savePulseStatus({ connected: false, agentName: null }, store, NOW);
  assert.equal(store.map.has(STATUS_KEY), false);
  savePulseStatus({ connected: true, agentName: null }, store, NOW);
  clearPulseStatus(store);
  assert.equal(store.map.has(STATUS_KEY), false, "cleared when a frame mounts");
});
