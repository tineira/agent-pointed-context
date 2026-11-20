#!/usr/bin/env node
/** Exercise Pulse's real global WakeBudget Durable Object in workerd. */
import assert from "node:assert/strict";
import { startWorkerd } from "./lib/dock-workerd.mjs";

const runtime = await startWorkerd({ wakeBudget: true });
try {
  const midnight = Date.parse("2026-11-17T23:59:59.999Z");
  assert.equal((await runtime.takeWakeSlots(midnight, 2_001)).granted, 2_000, "Pulse's exported WakeBudget grants exactly 2,000 slots");
  assert.equal((await runtime.takeWakeSlots(midnight, 1)).granted, 0, "another RPC to the same global budget stays capped");
  assert.equal((await runtime.takeWakeSlots(midnight + 1, 1)).granted, 0, "caller timestamps cannot reset Pulse's global wake budget");
  console.log("Pulse WakeBudget in workerd: passed (3 checks)");
} finally {
  await runtime.stop();
}
