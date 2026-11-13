/** The Dock profile as built (APC 0.10, TIN-882): the grant's states, the answer table, the idle shapes and the time limits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOCK_GRANT_STATES,
  HUB_ANSWER_MAX_BYTES,
  HUB_CALL_DEADLINE_MS,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  dockGrantAnswer,
  dockGrantCallOf,
  dockGrantStateOf,
  idleAnswer,
  idleCurrentView,
  idleWaitForFocus,
  isIdleAnswer,
  isPairingAnswer,
  pairingAnswer,
  type DockGrantCall,
  type DockGrantState,
} from "../src/index.ts";

test("states take precedence revoked > ended > in_flight > handoff > dormant > live", () => {
  assert.deepEqual(DOCK_GRANT_STATES, ["revoked", "ended", "in_flight", "handoff", "dormant", "live"]);
  assert.equal(dockGrantStateOf({}), "live");
  assert.equal(dockGrantStateOf({ dormant: true }), "dormant");
  assert.equal(dockGrantStateOf({ handoff: true, dormant: true }), "handoff");
  assert.equal(dockGrantStateOf({ in_flight: true, handoff: true }), "in_flight");
  assert.equal(dockGrantStateOf({ ended: true, in_flight: true }), "ended");
  assert.equal(dockGrantStateOf({ revoked: true, ended: true }), "revoked", "revoked stays revoked");
});

test("the time limits are the ones the standard bounds", () => {
  assert.ok(T_ACK_MAX_MS <= 30_000 && T_ACK_MAX_MS > HUB_CALL_DEADLINE_MS, "T_ack is at most 30 s and longer than the hub call");
  assert.ok(HUB_CALL_DEADLINE_MS <= 10_000);
  assert.ok(T_CONNECT_MAX_MS <= 10 * 60_000);
  assert.equal(HUB_ANSWER_MAX_BYTES, 8192);
});

test("an MCP message is classified for the answer table", () => {
  assert.equal(dockGrantCallOf({ method: "initialize" }), "initialize");
  assert.equal(dockGrantCallOf({ method: "ping" }), "ping");
  assert.equal(dockGrantCallOf({ method: "tools/list" }), "tools/list");
  assert.equal(dockGrantCallOf({ method: "tools/call", tool: "get_current_view" }), "core_tool");
  assert.equal(dockGrantCallOf({ method: "tools/call", tool: "wait_for_focus" }), "core_tool");
  assert.equal(dockGrantCallOf({ method: "tools/call", tool: "get_order" }), "app_tool");
  assert.equal(dockGrantCallOf({ method: "resources/list" }), "other_method");
  assert.equal(dockGrantCallOf({ method: "notifications/initialized", notification: true }), "notification");
});

test("the answer table, per state and call", () => {
  const calls: DockGrantCall[] = ["initialize", "ping", "tools/list", "core_tool", "app_tool", "other_method", "notification"];
  const kinds = (state: DockGrantState) => calls.map((call) => dockGrantAnswer(state, call));
  for (const call of calls) {
    assert.deepEqual(dockGrantAnswer("in_flight", call), { kind: "not_found" }, `in_flight ${call}`);
    assert.deepEqual(dockGrantAnswer("ended", call), { kind: "not_found" }, `ended ${call}`);
    assert.deepEqual(dockGrantAnswer("revoked", call), { kind: "revoked" }, `revoked ${call}`);
    assert.deepEqual(dockGrantAnswer("live", call), { kind: "serve" }, `live ${call}`);
  }
  assert.deepEqual(kinds("handoff"), [
    { kind: "serve", commits: true },
    { kind: "serve" },
    { kind: "serve" },
    { kind: "tool_error", error: "pairing" },
    { kind: "tool_error", error: "pairing" },
    { kind: "rpc_error", code: -32000, error: "pairing" },
    { kind: "ignored" },
  ]);
  assert.deepEqual(kinds("dormant"), [
    { kind: "serve" },
    { kind: "serve" },
    { kind: "serve" },
    { kind: "idle_shape" },
    { kind: "tool_error", error: "idle" },
    { kind: "rpc_error", code: -32000, error: "idle" },
    { kind: "serve" },
  ]);
});

test("the idle shapes and the tool errors are told apart from 0.9 answers", () => {
  assert.deepEqual(idleCurrentView("away"), { view: null, focus: null, idle: true, note: "away" });
  assert.deepEqual(idleWaitForFocus("away"), { focus: null, timed_out: false, page_open: false, idle: true, note: "away" });
  assert.equal(isIdleAnswer(idleCurrentView()), true);
  assert.equal(isIdleAnswer(idleWaitForFocus()), true);
  assert.equal(isIdleAnswer(idleAnswer()), true);
  assert.equal(isIdleAnswer({ view: null, focus: null, note: "unavailable" }), false, "a 0.9 unavailable answer is not idle");
  assert.equal(isIdleAnswer({ focus: null, timed_out: false, page_open: false, note: "closed" }), false, "a closed page is not idle");
  assert.equal(isIdleAnswer({ error: "revoked", revoked_by: "x" }), false);
  assert.equal(isIdleAnswer(null), false);
  assert.equal(isPairingAnswer(pairingAnswer()), true);
  assert.equal(isPairingAnswer(idleAnswer()), false);
  assert.equal(isPairingAnswer("pairing"), false);
});
