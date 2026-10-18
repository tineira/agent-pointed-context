import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FocusPayload, FocusRow, PresenceEvent } from "@apc/protocol";
import {
  THEN_NOTE,
  WAIT_PAGE_CLOSED_NOTE,
  WAIT_TIMED_OUT_NOTE,
  attachAttention,
  attachThen,
  attentionFor,
  isUnread,
  presenceEvent,
  registerApcTools,
  thenBytes,
  toolError,
  toolResult,
} from "../src/index.ts";

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

test("the loop hint rides on every result only while a page is open, structured and in the text", () => {
  const open = attachThen(attachAttention(toolResult({ rows: [1] }), attentionFor(focus)), true);
  assert.equal((open.structuredContent as { then: string }).then, THEN_NOTE);
  const text = JSON.parse(open.content[0]!.text) as { rows: number[]; attention: unknown; then: string };
  assert.equal(text.then, THEN_NOTE);
  assert.deepEqual(text.attention, attentionFor(focus), "next to the envelope, which is unchanged");
  assert.equal("_meta" in open, false);
  assert.equal(new TextEncoder().encode(open.content[0]!.text).length - new TextEncoder().encode(attachAttention(toolResult({ rows: [1] }), attentionFor(focus)).content[0]!.text).length, thenBytes(true));

  const closed = attachThen(toolResult({ rows: [1] }), false);
  assert.deepEqual(closed, toolResult({ rows: [1] }), "no page open: the result is untouched");
  assert.equal(closed.content[0]!.text.includes('"then"'), false);
  assert.equal(thenBytes(false), 0);

  const error = attachThen(toolError("not_found", "no such customer"), true);
  assert.equal((JSON.parse(error.content[0]!.text) as { then: string }).then, THEN_NOTE, "an error's text carries it too");
  const plain = attachThen({ content: [{ type: "text", text: "not json" }] }, true);
  assert.deepEqual(JSON.parse(plain.content[1]!.text), { then: THEN_NOTE }, "a non-JSON text gets an extra block");
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

async function connect(pinAfterMs: number | null, page: { open: boolean; closeAfterMs?: number } | null = null) {
  let row: { pinned: boolean; seen: boolean } = { pinned: false, seen: false };
  if (page?.closeAfterMs !== undefined) setTimeout(() => (page.open = false), page.closeAfterMs);
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
    ...(page ? { pageOpen: async () => page.open } : {}),
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
  assert.deepEqual(empty.structuredContent, { focus: null, timed_out: true, note: WAIT_TIMED_OUT_NOTE }, "a host without pageOpen: no page_open");
});

type WaitResult = { structuredContent: { focus: FocusPayload | null; timed_out: boolean; page_open?: boolean; note?: string } };

test("a wait that times out with the page open says so and sends the agent back to the person", async () => {
  const { client } = await connect(null, { open: true });
  const result = (await client.callTool({ name: "wait_for_focus", arguments: { timeout_s: 1 } })) as unknown as WaitResult;
  assert.deepEqual(result.structuredContent, { focus: null, timed_out: true, page_open: true, note: WAIT_TIMED_OUT_NOTE });
});

test("a wait returns early when the person closes the page, and does not start with no page open", async () => {
  const closing = await connect(null, { open: true, closeAfterMs: 100 });
  const started = Date.now();
  const early = (await closing.client.callTool({ name: "wait_for_focus", arguments: { timeout_s: 2 } })) as unknown as WaitResult;
  assert.ok(Date.now() - started < 1000, "returned on the next poll, not at the timeout");
  assert.deepEqual(early.structuredContent, { focus: null, timed_out: false, page_open: false, note: WAIT_PAGE_CLOSED_NOTE });

  const none = await connect(null, { open: false });
  const t0 = Date.now();
  const at = (await none.client.callTool({ name: "wait_for_focus", arguments: {} })) as unknown as WaitResult;
  assert.ok(Date.now() - t0 < 200, "no wait at all");
  assert.equal(at.structuredContent.page_open, false);

  const pinned = await connect(0, { open: false });
  const got = (await pinned.client.callTool({ name: "wait_for_focus", arguments: {} })) as unknown as WaitResult;
  assert.equal(got.structuredContent.focus?.next, "get_figure", "an unread pin is still delivered after the page closed");
});

test("the tools teach the loop: instructions and descriptions name wait_for_focus after answering", async () => {
  const { APC_INSTRUCTIONS } = await import("../src/index.ts");
  assert.match(APC_INSTRUCTIONS, /After you answer.*call wait_for_focus/);
  const { client } = await connect(null);
  const { tools } = await client.listTools();
  const wait = tools.find((t) => t.name === "wait_for_focus")!;
  const view = tools.find((t) => t.name === "get_current_view")!;
  assert.match(wait.description!, /^Call this after you answer, only while the person is on the page/);
  assert.match(wait.description!, /default 2\)/, "the default is capped by the ceiling (2 s in this fake)");
  assert.match(view.description!, /then answer, then call wait_for_focus/i);
});
