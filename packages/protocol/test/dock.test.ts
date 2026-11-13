/** The Dock profile as built (APC 0.10, TIN-882): the grant's states, the answer table, the idle shapes and the time limits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APC_JSON_PAIRING_MAX_AGE_S,
  DOCK_GRANT_RPC_ERROR_CODE,
  DOCK_GRANT_STATES,
  HUB_ANSWER_MAX_BYTES,
  HUB_CALL_DEADLINE_MS,
  IDLE_ERROR,
  IDLE_MESSAGE,
  LONG_DORMANCY_RECOMMENDED_MS,
  PAIRING_ENDED_ERROR,
  PAIRING_ERROR,
  PAIRING_MESSAGE,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  T_IDLE_RECOMMENDED_MS,
  dockGrantAnswer,
  dockGrantCallOf,
  dockGrantStateOf,
  idleAnswer,
  idleCurrentView,
  idleWaitForFocus,
  isIdleAnswer,
  isPairingAnswer,
  pairingAnswer,
  type CurrentViewResult,
  type DockGrantCall,
  type DockGrantState,
  type IdleCurrentView,
  type IdleWaitForFocus,
  type WaitForFocusResult,
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

test("every constant has the value the standard gives it", () => {
  assert.equal(T_ACK_MAX_MS, 30_000);
  assert.ok(T_ACK_MAX_MS > HUB_CALL_DEADLINE_MS, "T_ack is longer than the hub call");
  assert.equal(HUB_CALL_DEADLINE_MS, 10_000);
  assert.equal(T_CONNECT_MAX_MS, 600_000);
  assert.equal(T_IDLE_RECOMMENDED_MS, 1_800_000, "30 minutes");
  assert.equal(LONG_DORMANCY_RECOMMENDED_MS, 2_592_000_000, "30 days");
  assert.equal(HUB_ANSWER_MAX_BYTES, 8192);
  assert.equal(APC_JSON_PAIRING_MAX_AGE_S, 60);
  assert.equal(DOCK_GRANT_RPC_ERROR_CODE, -32000);
  assert.equal(PAIRING_ENDED_ERROR, "pairing_ended");
  assert.equal(PAIRING_ERROR, "pairing");
  assert.equal(IDLE_ERROR, "idle");
  assert.equal(PAIRING_MESSAGE, "The person has not finished pairing this app with their dock yet. Wait, or tell them.");
  assert.equal(IDLE_MESSAGE, "The person is away from this app, so it is asleep. It wakes when they open it again: tell them, and do not retry.");
});

test("a JSON-RPC message is classified for the answer table", () => {
  assert.equal(dockGrantCallOf({ id: 1, method: "initialize" }), "initialize");
  assert.equal(dockGrantCallOf({ id: 2, method: "ping" }), "ping");
  assert.equal(dockGrantCallOf({ id: "3", method: "tools/list" }), "tools/list");
  assert.equal(dockGrantCallOf({ id: 4, method: "tools/call", params: { name: "get_current_view" } }), "core_tool");
  assert.equal(dockGrantCallOf({ id: 5, method: "tools/call", params: { name: "wait_for_focus", arguments: {} } }), "core_tool");
  assert.equal(dockGrantCallOf({ id: 6, method: "tools/call", params: { name: "get_order" } }), "app_tool");
  assert.equal(dockGrantCallOf({ id: 7, method: "tools/call" }), "app_tool", "a call that names no tool is not a core tool");
  assert.equal(dockGrantCallOf({ id: 8, method: "resources/list" }), "other_method");
  assert.equal(dockGrantCallOf({ method: "notifications/initialized" }), "notification");
  assert.equal(dockGrantCallOf({ id: 9, method: "notifications/cancelled" }), "notification", "any notifications/* method");
  assert.equal(dockGrantCallOf({ method: "tools/list" }), "notification", "a message with no id");
});

test("a notification in handoff is ignored, never a JSON-RPC error", () => {
  assert.deepEqual(dockGrantAnswer("handoff", dockGrantCallOf({ method: "notifications/initialized" })), { kind: "ignored" });
});

test("the answer table, per state and call", () => {
  const calls: DockGrantCall[] = ["initialize", "ping", "tools/list", "core_tool", "app_tool", "other_method", "notification"];
  const kinds = (state: DockGrantState) => calls.map((call) => dockGrantAnswer(state, call));
  const serve = { kind: "serve", commits: false, wakes: false };
  for (const call of calls) {
    assert.deepEqual(dockGrantAnswer("in_flight", call), { kind: "not_found" }, `in_flight ${call}`);
    assert.deepEqual(dockGrantAnswer("ended", call), { kind: "not_found" }, `ended ${call}`);
    assert.deepEqual(dockGrantAnswer("revoked", call), { kind: "revoked" }, `revoked ${call}`);
    assert.deepEqual(dockGrantAnswer("live", call), serve, `live ${call}`);
  }
  assert.deepEqual(kinds("handoff"), [
    { kind: "serve", commits: true, wakes: false },
    serve,
    serve,
    { kind: "tool_error", error: "pairing" },
    { kind: "tool_error", error: "pairing" },
    { kind: "rpc_error", code: -32000, error: "pairing" },
    { kind: "ignored" },
  ]);
  assert.deepEqual(kinds("dormant"), [
    serve,
    serve,
    serve,
    { kind: "idle_shape" },
    { kind: "tool_error", error: "idle" },
    { kind: "rpc_error", code: -32000, error: "idle" },
    serve,
  ]);
});

test("the idle shapes and the tool errors are told apart from 0.9 answers", () => {
  const view: IdleCurrentView = idleCurrentView("away");
  const wait: IdleWaitForFocus = idleWaitForFocus("away");
  const asView: CurrentViewResult = view;
  const asWait: WaitForFocusResult = wait;
  assert.deepEqual(asView, { view: null, focus: null, idle: true, note: "away" });
  assert.deepEqual(asWait, { focus: null, timed_out: false, page_open: false, idle: true, note: "away" });
  assert.equal(isIdleAnswer(idleCurrentView()), true);
  assert.equal(isIdleAnswer(idleWaitForFocus()), true);
  assert.equal(isIdleAnswer(idleAnswer()), true);
  assert.equal(isIdleAnswer({ error: "idle" }), false, "an idle error without a message");
  assert.equal(isIdleAnswer({ idle: true }), false, "an idle shape without a note");
  assert.equal(isIdleAnswer({ view: null, focus: null, note: "unavailable" }), false, "a 0.9 unavailable answer is not idle");
  assert.equal(isIdleAnswer({ focus: null, timed_out: false, page_open: false, note: "closed" }), false, "a closed page is not idle");
  assert.equal(isIdleAnswer({ error: "revoked", revoked_by: "x" }), false);
  assert.equal(isIdleAnswer(null), false);
  assert.equal(isPairingAnswer(pairingAnswer()), true);
  assert.equal(isPairingAnswer({ error: "pairing" }), false, "a pairing error without a message");
  assert.equal(isPairingAnswer({ error: "pairing", message: 1 }), false);
  assert.equal(isPairingAnswer(idleAnswer()), false);
  assert.equal(isPairingAnswer("pairing"), false);
});

test("the core result types refuse an idle answer that carries data or a timeout", () => {
  // @ts-expect-error an idle get_current_view carries no view
  const badView: CurrentViewResult = { view: { screen: "s", params: {}, selection: null, app_url: "/", updated_at: "", age_seconds: 0, stale: false, next: null }, focus: null, idle: true, note: "x" };
  // @ts-expect-error an idle wait is never timed out, and its page is never open
  const badWait: WaitForFocusResult = { focus: null, timed_out: true, page_open: true, idle: true, note: "x" };
  assert.ok(badView && badWait);
});
