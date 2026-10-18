import assert from "node:assert/strict";
import { test } from "node:test";
import { compatSummary, waitsAfterAnswer, type LoggedEvent } from "../src/worker/compat.ts";
import type { Grant } from "../src/worker/domain.ts";

const grant = (id: string, regions: Grant["regions"] = null): Grant => ({ id, secret: "s", label: id, client_name: null, regions, created_at: "", last_active_at: null });
let n = 0;
const ev = (type: string, grant_id: string, at: string, data: Record<string, unknown> = {}): LoggedEvent => ({ id: ++n, at, type, grant_id, ...data });

test("one row per agent: connected, read the pin after the envelope, followed next", () => {
  const P1 = "2026-10-15T12:00:00.000Z";
  const P2 = "2026-10-15T12:05:00.000Z";
  const events = [
    ev("initialize", "a", "2026-10-15T11:59:00.000Z", { client_name: "Grok", client_version: "1.0", protocol_version: "2025-06-18", user_agent: "grok/1" }),
    ev("tools_list", "a", "2026-10-15T11:59:01.000Z"),
    ev("pin", "a", P1, { pinned_at: P1 }),
    ev("tool_call", "a", "2026-10-15T12:00:05.000Z", { tool: "list_customers" }),
    ev("envelope_delivered", "a", "2026-10-15T12:00:05.000Z", { pinned_at: P1 }),
    ev("tool_call", "a", "2026-10-15T12:00:08.000Z", { tool: "get_current_view" }),
    ev("seen", "a", "2026-10-15T12:00:08.000Z", { pinned_at: P1, via: "get_current_view" }),
    ev("tool_call", "a", "2026-10-15T12:00:10.000Z", { tool: "get_figure" }),
    ev("next_read", "a", "2026-10-15T12:00:10.000Z", { pinned_at: P1 }),
    ev("pin", "a", P2, { pinned_at: P2 }),
    ev("tool_call", "a", "2026-10-15T12:05:02.000Z", { tool: "wait_for_focus" }),
    ev("seen", "a", "2026-10-15T12:05:02.000Z", { pinned_at: P2, via: "wait_for_focus" }),
    ev("initialize", "b", "2026-10-15T12:01:00.000Z", { client_name: "ChatGPT" }),
  ];
  const [a, b, c] = compatSummary([grant("a"), grant("b"), grant("c", ["latam"])], events);
  assert.equal(a!.client_name, "Grok");
  assert.equal(a!.connected && a!.listed_tools, true);
  assert.deepEqual(a!.tools, ["get_current_view", "get_figure", "list_customers", "wait_for_focus"]);
  assert.equal(a!.pins, 2);
  assert.equal(a!.envelopes, 1);
  assert.deepEqual(a!.read_via, { get_current_view: 1, wait_for_focus: 1 });
  assert.equal(a!.read_after_envelope, 1, "the second pin was read by a waiting agent, with no envelope");
  assert.equal(a!.next_reads, 1);
  assert.equal(a!.wait_calls, 1);
  assert.equal(a!.waits_after_answer, 0, "the wait came five minutes after the last answer");
  assert.equal(a!.median_pin_to_seen_ms, 5000, "median of 8 s and 2 s");
  assert.equal(a!.median_pin_to_next_ms, 10_000);

  assert.equal(b!.client_name, "ChatGPT");
  assert.equal(b!.tool_calls, 0);
  assert.equal(b!.median_pin_to_seen_ms, null);
  assert.equal(c!.connected, false);
  assert.equal(c!.restricted, true);
});

test("waits after answer: a wait that starts within 30 s after a non-wait call, not a re-wait", () => {
  // tool_call is logged when the call ends; ms is its duration.
  const call = (tool: string, end: string, ms: number) => ev("tool_call", "a", `2026-10-15T12:${end}.000Z`, { tool, ms });
  const calls = [
    call("get_current_view", "00:00", 50),
    call("get_figure", "00:02", 40),
    call("wait_for_focus", "00:30", 25_000), // started 00:05, 3 s after get_figure: counts
    call("wait_for_focus", "00:56", 25_000), // started 00:31, right after the first wait: a re-wait
    call("list_customers", "02:00", 30),
    call("wait_for_focus", "03:00", 20_000), // started 02:40, 40 s after list_customers: too late
    call("get_customer", "04:00", 30),
    call("wait_for_focus", "04:30", 0), // logged without ms (older events): starts at its end, 30 s after: counts
  ];
  assert.equal(waitsAfterAnswer(calls), 2);
  const [row] = compatSummary([grant("a")], calls);
  assert.equal(row!.wait_calls, 4);
  assert.equal(row!.waits_after_answer, 2);
});
