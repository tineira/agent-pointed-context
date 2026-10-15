import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FocusPayload, FocusRow, PresenceEvent } from "@apc/protocol";
import { attachAttention, attentionFor, isUnread, presenceEvent, registerApcTools, toolResult } from "../src/index.ts";

const focus: FocusPayload = {
  kind: "figure",
  id: null,
  part: "step:new",
  params: { key: "customer_bridge", month: "2026-03" },
  app_url: "https://demo.example/overview?month=2026-03",
  pinned_at: "2026-10-15T12:00:00.000Z",
  next: "get_figure",
  next_args: { key: "customer_bridge", params: { month: "2026-03", step: "new" } },
};

test("the pin is unread until a read after it was dropped", () => {
  const row: FocusRow = { grant_id: "g", kind: "customer", id: "cus_0001", part: null, params: null, pinned_at: "2026-10-15T12:00:00.000Z", seen_at: null };
  assert.equal(isUnread(null), false);
  assert.equal(isUnread(row), true);
  assert.equal(isUnread({ ...row, seen_at: "2026-10-15T12:00:01.000Z" }), false);
  assert.equal(isUnread({ ...row, seen_at: "2026-10-15T11:00:00.000Z" }), true, "a new pin after the last read is unread again");
});

test("the envelope is a top-level key of the structured result and of the text the model reads", () => {
  const result = attachAttention(toolResult({ rows: [1, 2] }), attentionFor(focus));
  assert.deepEqual((result.structuredContent as { attention: unknown }).attention, attentionFor(focus));
  const text = JSON.parse(result.content[0]!.text) as { rows: number[]; attention: { focus: FocusPayload } };
  assert.deepEqual(text.rows, [1, 2]);
  assert.equal(text.attention.focus.next, "get_figure");
  assert.equal("_meta" in result, false, "never only in _meta, which some clients withhold from the model");
});

test("presence carries ids only, deduped and capped at 20", () => {
  const event: PresenceEvent = presenceEvent({
    grantId: "g",
    tool: "list_customers",
    kind: "read",
    targets: [...Array.from({ length: 30 }, (_, i) => ({ kind: "customer", id: `cus_${i}` })), { kind: "customer", id: "cus_0" }],
  });
  assert.equal(event.targets.length, 20);
  assert.equal(event.count, 30);
  assert.deepEqual(Object.keys(event).sort(), ["at", "count", "grant_id", "kind", "targets", "tool", "v"], "no field that could hold content");
});

async function connect(pinAfterMs: number | null) {
  let row: { pinned: boolean; seen: boolean } = { pinned: false, seen: false };
  if (pinAfterMs === 0) row = { pinned: true, seen: false };
  else if (pinAfterMs !== null) setTimeout(() => (row = { pinned: true, seen: false }), pinAfterMs);
  const server = new McpServer({ name: "t", version: "0" });
  registerApcTools(server, {
    readView: async () => null,
    readFocus: async () => (row.pinned ? focus : null),
    focusUnread: async () => row.pinned && !row.seen,
    markSeen: async () => {
      row.seen = true;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 20,
    waitCeilingS: 2,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, state: () => row };
}

test("get_current_view returns the focus and marks it seen", async () => {
  const { client, state } = await connect(0);
  const result = (await client.callTool({ name: "get_current_view", arguments: {} })) as unknown as { structuredContent: { focus: FocusPayload | null } };
  assert.equal(result.structuredContent.focus?.next, "get_figure");
  assert.equal(state().seen, true);
});

test("wait_for_focus returns the pin when it arrives, or times out", async () => {
  const arrives = await connect(60);
  const got = (await arrives.client.callTool({ name: "wait_for_focus", arguments: { timeout_s: 2 } })) as unknown as { structuredContent: { focus: FocusPayload | null; timed_out: boolean } };
  assert.equal(got.structuredContent.timed_out, false);
  assert.equal(got.structuredContent.focus?.part, "step:new");
  assert.equal(arrives.state().seen, true);

  const never = await connect(null);
  const empty = (await never.client.callTool({ name: "wait_for_focus", arguments: { timeout_s: 1 } })) as unknown as { structuredContent: { focus: null; timed_out: boolean } };
  assert.deepEqual(empty.structuredContent, { focus: null, timed_out: true });
});
