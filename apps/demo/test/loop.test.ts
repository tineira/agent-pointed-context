import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FocusPayload } from "@apc/protocol";
import { THEN_NOTE, WAIT_TIMED_OUT_NOTE, attachThen, registerApcTools, thenBytes, type ToolResult } from "@apc/server";
import { attendance, loopHinted } from "../src/worker/page.ts";

const focus: FocusPayload = {
  kind: "customer",
  id: "cus_0001",
  part: null,
  params: null,
  app_url: "https://demo.example/customers/cus_0001",
  pinned_at: "2026-10-19T12:00:00.000Z",
  next: "get_customer",
  next_args: { id: "cus_0001" },
};

type Result = ToolResult & { structuredContent: { focus?: FocusPayload | null; timed_out?: boolean; page_open?: boolean; note?: string; then?: string } };

/** The APC tools wired as the sandbox wires them: pageOpen and the loop hint both go through attendance(). */
async function sandbox(opts: { share: boolean; open: boolean; closeAfterMs?: number; pinAfterMs?: number }) {
  const page = { open: opts.open };
  const row = { pinned: false, seen: false };
  if (opts.closeAfterMs !== undefined) setTimeout(() => (page.open = false), opts.closeAfterMs);
  if (opts.pinAfterMs !== undefined) setTimeout(() => (row.pinned = true), opts.pinAfterMs);
  const attending = () => attendance(opts.share, () => page.open);
  const server = new McpServer({ name: "t", version: "0" });
  registerApcTools(server, {
    readView: async () => null,
    readFocus: async () => (row.pinned ? focus : null),
    focusUnread: async () => row.pinned && !row.seen,
    markSeen: async () => {
      row.seen = true;
    },
    pageOpen: async () => attending(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 50,
    waitCeilingS: 3,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const started = Date.now();
    const raw = (await client.callTool({ name, arguments: args })) as unknown as Result;
    const hinted = loopHinted(name, raw.structuredContent.focus != null, attending());
    return { result: attachThen(raw, hinted) as Result, then_bytes: thenBytes(hinted), ms: Date.now() - started };
  };
}

test("sharing on, page open: results carry then, and a wait that times out says page_open: true", async () => {
  const call = await sandbox({ share: true, open: true });
  const view = await call("get_current_view");
  assert.equal(view.result.structuredContent.then, THEN_NOTE);
  assert.ok(view.then_bytes > 0);
  const wait = await call("wait_for_focus", { timeout_s: 1 });
  assert.equal(wait.result.structuredContent.page_open, true);
  assert.equal(wait.result.structuredContent.timed_out, true);
});

test("sharing off, page open: no then, no page_open, the wait honors its timeout", async () => {
  const call = await sandbox({ share: false, open: true });
  const view = await call("get_current_view");
  assert.equal("then" in view.result.structuredContent, false);
  assert.equal(view.then_bytes, 0, "then_bytes logs 0");
  const wait = await call("wait_for_focus", { timeout_s: 1 });
  assert.ok(wait.ms >= 950, `ran to its timeout (${wait.ms} ms)`);
  assert.deepEqual(wait.result.structuredContent, { focus: null, timed_out: true, note: WAIT_TIMED_OUT_NOTE }, "no page_open key at all");
  assert.equal(wait.result.content[0]!.text.includes("page_open"), false);
});

test("sharing off: a pin dropped during the wait is returned; a page that closes does not end the wait", async () => {
  const pinned = await sandbox({ share: false, open: true, pinAfterMs: 300 });
  const got = await pinned("wait_for_focus", { timeout_s: 3 });
  assert.equal(got.result.structuredContent.focus?.next, "get_customer");
  assert.equal(got.result.structuredContent.timed_out, false);
  assert.ok(got.ms < 2000, "returned with the pin, not at the timeout");
  assert.equal("then" in got.result.structuredContent, false);

  const closing = await sandbox({ share: false, open: true, closeAfterMs: 100 });
  const wait = await closing("wait_for_focus", { timeout_s: 1 });
  assert.ok(wait.ms >= 950, `the close is not disclosed by an early return (${wait.ms} ms)`);
  assert.equal("page_open" in wait.result.structuredContent, false);
});

test("sharing on, no page open: page_open: false at once (unchanged)", async () => {
  const call = await sandbox({ share: true, open: false });
  const wait = await call("wait_for_focus", { timeout_s: 3 });
  assert.ok(wait.ms < 500, `no wait at all (${wait.ms} ms)`);
  assert.equal(wait.result.structuredContent.page_open, false);
  assert.equal(wait.then_bytes, 0);
});

test("set_agent_name carries no loop hint: naming itself answers nothing (TIN-356)", () => {
  assert.equal(loopHinted("set_agent_name", false, true), false);
  assert.equal(loopHinted("get_figure", false, true), true);
});
