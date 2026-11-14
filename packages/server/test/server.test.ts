import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseApcManifest, type FocusPayload, type FocusRow, type PresenceEvent, type PresenceWaitEvent } from "@tineira/apc-protocol";
import {
  THEN_NOTE,
  MemoryWaitSlots,
  WAIT_PAGE_CLOSED_NOTE,
  WAIT_TAKEN_OVER_NOTE,
  WAIT_TIMED_OUT_NOTE,
  announceWaits,
  apcJsonResponse,
  apcManifest,
  attachAttention,
  attachThen,
  attentionFor,
  isUnread,
  presenceEvent,
  registerApcTools,
  revokedResponse,
  thenApplies,
  thenBytes,
  toolError,
  toolResult,
  unknownBearerResponse,
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

test("a tool error carries { error, message } in structuredContent and the text, the same JSON (APC 0.10)", () => {
  const error = toolError("pairing", "Wait, or tell them.");
  assert.deepEqual(error, {
    content: [{ type: "text", text: JSON.stringify({ error: "pairing", message: "Wait, or tell them." }) }],
    structuredContent: { error: "pairing", message: "Wait, or tell them." },
    isError: true,
  });
  assert.deepEqual(JSON.parse(error.content[0]!.text), error.structuredContent);
});

test("apc.json may be cached a minute at most (M8, APC 0.10)", () => {
  const response = apcJsonResponse(apcManifest({ name: "Orders", origin: "https://orders.test", profiles: ["dock"] }));
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("apcManifest with mcp.endpoints (APC 0.11): it builds only a file readers take as written, and never judges the profiles offered now", () => {
  const origin = "https://orders.test";
  const split = [{ path: "/mcp", profiles: ["direct"] }, { path: "/mcp/{secret}", profiles: ["dock"] }] as const;
  const both = apcManifest({ name: "Orders", origin, profiles: ["direct", "dock"], connect: "/agents", mcpPath: "/mcp/", endpoints: split });
  assert.deepEqual(both.mcp, { path: "/mcp/", endpoints: [{ path: "/mcp", profiles: ["direct"] }, { path: "/mcp/{secret}", profiles: ["dock"] }] });
  assert.ok(parseApcManifest(both, origin).ok);
  const alone = apcManifest({ name: "Orders", origin, profiles: ["dock"], mcpPath: null, endpoints: split });
  assert.deepEqual(alone.mcp, { endpoints: [{ path: "/mcp", profiles: ["direct"] }, { path: "/mcp/{secret}", profiles: ["dock"] }] }, "null leaves mcp.path out");
  // M8: an app that is not pairing right now, or offers nothing at the moment, still serves its endpoints.
  assert.deepEqual(apcManifest({ name: "Orders", origin, profiles: ["direct"], connect: "/agents", mcpPath: "/mcp/", endpoints: split }).mcp.endpoints?.length, 2);
  assert.deepEqual(apcManifest({ name: "Orders", origin, profiles: [], mcpPath: "/mcp/", endpoints: split }).profiles, []);
  for (const [endpoints, mcpPath, why] of [
    [[{ path: "/api/mcp", profiles: ["direct"] }], "/mcp/", "outside mcpPath"],
    [[{ path: "/mcp/", profiles: ["direct"] }], null, "a trailing slash"],
    [[{ path: "/mcp/{sid}/{secret}", profiles: ["direct"] }], null, "two variables"],
    [[{ path: "/mcp", profiles: ["dock"] }], null, "dock on an exact path"],
    [[{ path: "/mcp/{secret}", profiles: ["hub"] }], null, "a word readers ignore"],
    [[{ path: "/mcp/{secret}", profiles: [] }], null, "no profile"],
    [[{ path: "/mcp/{secret}", profiles: ["dock"] }, { path: "/mcp/{secret}", profiles: ["direct"] }], null, "a path twice"],
    [[], "/mcp/", "an empty list"],
    [[{ path: "/mcp/{secret}", profiles: ["dock"] }], undefined, "endpoints without mcpPath (plain JavaScript)"],
    [[{ path: "/mcp/{secret}", profiles: ["dock"], note: "x" }], null, "a key other than path and profiles"],
  ] as const) {
    assert.throws(() => apcManifest({ name: "Orders", origin, profiles: ["direct", "dock"], mcpPath: mcpPath as never, endpoints: endpoints as never }), Error, why);
  }
  assert.deepEqual(apcManifest({ name: "Orders", origin, profiles: ["dock"] }).mcp, { path: "/mcp/" }, "without endpoints, as before");
});

test("apcManifest says how to fix an mcpPath that does not start and end with / (TIN-914), with endpoints or without", () => {
  const origin = "https://orders.test";
  const shared = [{ path: "/mcp", profiles: ["direct"] }] as const;
  assert.throws(() => apcManifest({ name: "Orders", origin, profiles: ["direct"], mcpPath: "/mcp", endpoints: shared }), /mcpPath "\/mcp" must start and end with \/.*write "\/mcp\/"/);
  assert.throws(() => apcManifest({ name: "Orders", origin, profiles: ["direct"], mcpPath: "/mcp" }), /must start and end with \/.*write "\/mcp\/"/, "without endpoints too: never a file readers refuse");
  assert.throws(() => apcManifest({ name: "Orders", origin, profiles: ["direct"], mcpPath: "mcp/" }), /must start and end with \//);
  assert.throws(() => apcManifest({ name: "Orders", origin, profiles: ["direct"], mcpPath: "/a/../mcp/" }), /must start and end with \//);
  // The fix it names works: /mcp/ with the exact endpoint /mcp under it.
  assert.deepEqual(apcManifest({ name: "Orders", origin, profiles: ["direct"], mcpPath: "/mcp/", endpoints: shared }).mcp, { path: "/mcp/", endpoints: [{ path: "/mcp", profiles: ["direct"] }] });
});

test("revokedResponse: 403 with a secret URL, 401 with the Bearer challenge for a bearer token; an unknown token a plain 401 (TIN-914)", async () => {
  const secret = revokedResponse("orders.test", "2026-11-14T00:00:00.000Z");
  assert.equal(secret.status, 403);
  assert.equal(secret.headers.get("www-authenticate"), null);
  const bearer = revokedResponse("orders.test", "2026-11-14T00:00:00.000Z", { bearer: true });
  assert.equal(bearer.status, 401);
  assert.equal(bearer.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  assert.equal(bearer.headers.get("cache-control"), "no-store");
  const body = (await bearer.json()) as Record<string, unknown>;
  assert.equal(body.error, "revoked");
  assert.equal(body.revoked_by, "orders.test");
  assert.equal(body.revoked_at, "2026-11-14T00:00:00.000Z");
  const unknown = unknownBearerResponse();
  assert.equal(unknown.status, 401);
  assert.equal(unknown.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  assert.notEqual(((await unknown.json()) as Record<string, unknown>).error, "revoked", "no RevokedAnswer: gone, not taken back");
  const missing = unknownBearerResponse({ missing: true });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer", "no token sent: the bare challenge, no error code (RFC 6750)");
});

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
  assert.equal((error.structuredContent as { then: string }).then, THEN_NOTE, "and its structured content (APC 0.10)");
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
    markSeen: async (pinnedAt) => {
      if (pinnedAt === focus.pinned_at) row.seen = true;
    },
    ...(page ? { pageOpen: async () => page.open } : {}),
    waitSlot: new MemoryWaitSlots().for("g"),
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
  assert.match(wait.description!, /^Call this after you answer, only while your last results carried 'then'/);
  assert.match(wait.description!, /in the background/, "it says to wait in the background where the client can (APC 0.8)");
  assert.match(wait.description!, /default 2\)/, "the default is capped by the ceiling (2 s in this fake)");
  assert.match(view.description!, /then answer, then call wait_for_focus/i);
  assert.match(APC_INSTRUCTIONS, /in the background/);
});

/** A fake grant with a pin store the test drives, for the APC 0.8 rules. */
async function grantWithPins(slots = new MemoryWaitSlots(), grantId = "g", events?: PresenceWaitEvent[]) {
  const pin: { at: string | null; seenAt: string | null } = { at: null, seenAt: null };
  const marked: string[] = [];
  const server = new McpServer({ name: "t", version: "0" });
  registerApcTools(server, {
    readView: async () => null,
    readFocus: async () => (pin.at ? { ...focus, pinned_at: pin.at } : null),
    focusUnread: async () => !!pin.at && pin.seenAt !== pin.at,
    markSeen: async (pinnedAt) => {
      marked.push(pinnedAt);
      if (pin.at === pinnedAt) pin.seenAt = pinnedAt;
    },
    pageOpen: async () => true,
    waitSlot: slots.for(grantId),
    ...(events ? { waitPresence: { grantId, publish: (e: PresenceWaitEvent) => void events.push(e) } } : {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 20,
    waitCeilingS: 5,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const drop = (at: string) => {
    pin.at = at;
  };
  return { client, pin, marked, drop };
}

type Waited = { structuredContent: { focus: FocusPayload | null; timed_out: boolean; retry_after_s?: number; note?: string } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = (client: Client, timeout_s: number, signal?: AbortSignal) => client.callTool({ name: "wait_for_focus", arguments: { timeout_s } }, undefined, signal ? { signal } : undefined) as Promise<unknown> as Promise<Waited>;

test("one wait per grant: a newer wait takes over, the older delivers nothing and marks nothing (APC 0.8)", async () => {
  let clock = 0;
  const g = await grantWithPins(new MemoryWaitSlots(() => clock));
  const older = wait(g.client, 3);
  await sleep(60);
  clock = 2500; // past the claim gap
  const newer = wait(g.client, 3);
  const old = await older;
  assert.equal(old.structuredContent.focus, null);
  assert.equal(old.structuredContent.timed_out, false);
  assert.equal(old.structuredContent.note, WAIT_TAKEN_OVER_NOTE);
  g.drop("2026-11-12T10:00:00.000Z");
  const got = await newer;
  assert.equal(got.structuredContent.focus?.pinned_at, "2026-11-12T10:00:00.000Z", "the newer wait gets the pin");
  assert.deepEqual(g.marked, ["2026-11-12T10:00:00.000Z"], "only the delivering wait marked it");
});

test("a second wait within the claim gap is refused with retry_after_s, and the first keeps its place (APC 0.8)", async () => {
  const g = await grantWithPins();
  const first = wait(g.client, 2);
  await sleep(40);
  const second = await wait(g.client, 2);
  assert.equal(second.structuredContent.focus, null);
  assert.equal(second.structuredContent.timed_out, false);
  assert.ok(second.structuredContent.retry_after_s! >= 1 && second.structuredContent.retry_after_s! <= 2);
  assert.match(second.structuredContent.note!, /retry in \d+ s/);
  g.drop("2026-11-12T10:00:01.000Z");
  assert.equal((await first).structuredContent.focus?.pinned_at, "2026-11-12T10:00:01.000Z", "the first wait still delivers");
});

test("a cancelled wait frees its place at once and leaves the pin unread (APC 0.8)", async () => {
  const slots = new MemoryWaitSlots();
  const g = await grantWithPins(slots);
  const controller = new AbortController();
  const waiting = wait(g.client, 3, controller.signal).catch((e: unknown) => e);
  await sleep(60);
  controller.abort();
  await waiting;
  await sleep(60);
  assert.ok("token" in (await slots.for("g").claim()), "the place is free right after the cancel, even within the claim gap");
  g.drop("2026-11-12T10:00:02.000Z");
  await sleep(60);
  assert.deepEqual(g.marked, [], "a cancelled wait marks nothing seen");
});

test("seen once delivered: the exact pin is marked, never a newer one dropped meanwhile (APC 0.8)", async () => {
  const g = await grantWithPins();
  g.drop("2026-11-12T10:00:03.000Z");
  const view = (await g.client.callTool({ name: "get_current_view", arguments: {} })) as unknown as { structuredContent: { focus: FocusPayload } };
  assert.equal(view.structuredContent.focus.pinned_at, "2026-11-12T10:00:03.000Z");
  assert.deepEqual(g.marked, ["2026-11-12T10:00:03.000Z"], "marked by its pinned_at");
  g.drop("2026-11-12T10:00:04.000Z");
  assert.equal(g.pin.seenAt, "2026-11-12T10:00:03.000Z", "the newer pin stays unread");
});

test("the result goes out even when marking seen fails (APC 0.8)", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerApcTools(server, {
    readView: async () => null,
    readFocus: async () => focus,
    focusUnread: async () => true,
    markSeen: async () => {
      throw new Error("store down");
    },
    waitSlot: new MemoryWaitSlots().for("g"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const view = (await client.callTool({ name: "get_current_view", arguments: {} })) as unknown as { isError?: boolean; structuredContent: { focus: FocusPayload } };
  assert.ok(!view.isError);
  assert.equal(view.structuredContent.focus.next, "get_figure");
});

test("then applies only with a page open and a pin within the window (APC 0.8)", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  assert.equal(thenApplies(true, "2026-11-12T11:45:00.000Z", now), true);
  assert.equal(thenApplies(true, "2026-11-12T11:29:59.000Z", now), false, "older than 30 minutes");
  assert.equal(thenApplies(true, null, now), false, "never pinned");
  assert.equal(thenApplies(false, "2026-11-12T11:59:00.000Z", now), false, "no page open");
  assert.equal(thenApplies(null, "2026-11-12T11:59:00.000Z", now), false, "the view is not shared");
  assert.equal(thenApplies(true, "2026-11-12T11:00:00.000Z", now, 2 * 3600_000), true, "the app sets its own window");
});

test("notifications/cancelled in a POST of its own aborts the call it names, on that grant only (APC 0.8)", async () => {
  const { InflightCalls } = await import("../src/index.ts");
  const calls = new InflightCalls();
  const wait = calls.track("g1", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait_for_focus" } });
  const other = calls.track("g2", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait_for_focus" } });
  const batch = calls.track("g1", [{ jsonrpc: "2.0", id: "a", method: "tools/call" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(calls.cancel("g1", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "7" } }), 0, "a string id is not the number 7");
  assert.equal(calls.cancel("g1", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }), 1);
  assert.equal(wait.signal.aborted, true);
  assert.equal(other.signal.aborted, false, "another grant's call with the same id runs on");
  assert.equal(batch.signal.aborted, false);
  wait.done();
  assert.equal(calls.cancel("g1", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }), 0, "a finished call is forgotten");
  assert.equal(calls.cancel("g1", [{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "a" } }]), 1, "in a batch too");
  assert.equal(batch.signal.aborted, true);
  other.done();
  batch.done();
});

/** The wait events of a grant, as open/closed words, oldest first. */
const states = (events: PresenceWaitEvent[]) => events.map((e) => e.state);

test("a wait sends open when it claims its place and closed when it gives it up, ids only (APC 0.11)", async () => {
  const events: PresenceWaitEvent[] = [];
  const g = await grantWithPins(new MemoryWaitSlots(), "g_w", events);
  const waiting = wait(g.client, 1);
  await sleep(40);
  assert.deepEqual(states(events), ["open"], "open while the wait runs");
  const done = await waiting;
  assert.equal(done.structuredContent.timed_out, true);
  assert.deepEqual(states(events), ["open", "closed"], "closed on the timeout");
  for (const e of events) assert.deepEqual(Object.keys(e).sort(), ["at", "grant_id", "kind", "state", "v"]);
  assert.ok(events.every((e) => e.v === 1 && e.kind === "wait" && e.grant_id === "g_w"));
});

test("a wait that delivers a pin sends closed before its result goes out (APC 0.11)", async () => {
  const events: PresenceWaitEvent[] = [];
  const g = await grantWithPins(new MemoryWaitSlots(), "g", events);
  const waiting = wait(g.client, 3);
  await sleep(40);
  g.drop("2026-11-13T10:00:00.000Z");
  const got = await waiting;
  assert.equal(got.structuredContent.focus?.pinned_at, "2026-11-13T10:00:00.000Z");
  assert.deepEqual(states(events), ["open", "closed"]);
});

test("a takeover sends the old wait's closed, then the new one's open; the old wait sends nothing later (APC 0.11)", async () => {
  let clock = 0;
  const events: PresenceWaitEvent[] = [];
  const g = await grantWithPins(new MemoryWaitSlots(() => clock), "g", events);
  const older = wait(g.client, 3);
  await sleep(40);
  clock = 2500; // past the claim gap
  const newer = wait(g.client, 1);
  await older;
  assert.deepEqual(states(events), ["open", "closed", "open"], "the old wait, finding it was taken over, sent no second closed");
  await newer;
  assert.deepEqual(states(events), ["open", "closed", "open", "closed"]);
});

test("a refused wait sends nothing; a cancelled one sends closed (APC 0.11)", async () => {
  const events: PresenceWaitEvent[] = [];
  const g = await grantWithPins(new MemoryWaitSlots(), "g", events);
  const controller = new AbortController();
  const first = wait(g.client, 3, controller.signal).catch((e: unknown) => e);
  await sleep(40);
  const refused = await wait(g.client, 2);
  assert.ok(refused.structuredContent.retry_after_s);
  assert.deepEqual(states(events), ["open"], "the refused wait claimed nothing");
  controller.abort();
  await first;
  await sleep(60);
  assert.deepEqual(states(events), ["open", "closed"]);
});

test("a grant forgotten during its wait still gets the closed, once (APC 0.11)", async () => {
  const slots = new MemoryWaitSlots();
  const events: PresenceWaitEvent[] = [];
  const slot = announceWaits(slots.for("g"), "g", (e) => void events.push(e));
  const claim = await slot.claim();
  assert.ok("token" in claim);
  assert.equal(slots.held("g"), true);
  slots.forget("g");
  assert.equal(slots.held("g"), false);
  assert.equal(await slot.release(claim.token), true);
  assert.equal(await slot.release(claim.token), false, "a second release is not a second closed");
  assert.deepEqual(states(events), ["open", "closed"]);
});

test("announceWaits sends nothing from a place that does not tell takeovers and releases atomically (APC 0.11)", async () => {
  // A store row read with holds, then released: two steps. A claim between them would end the page on closed.
  let holder: string | null = null;
  const plain = {
    claim: async () => ((holder = crypto.randomUUID()), { token: holder }),
    holds: async (token: string) => holder === token,
    release: async (token: string) => {
      if (holder === token) holder = null;
    },
  };
  const events: PresenceWaitEvent[] = [];
  const slot = announceWaits(plain, "g", (e) => void events.push(e));
  assert.equal(slot, plain, "the place is returned as it is");
  const a = await slot.claim();
  const b = await slot.claim();
  assert.ok("token" in a && "token" in b);
  await slot.release(a.token);
  await slot.release(b.token);
  assert.deepEqual(states(events), [], "no wait events: no waiting on the page beats a wrong one");
});

test("a release that throws still sends closed (APC 0.11)", async () => {
  const inner = new MemoryWaitSlots().for("g");
  const failing = { ...inner, release: async () => Promise.reject(new Error("store down")) } as typeof inner;
  const events: PresenceWaitEvent[] = [];
  const slot = announceWaits(failing, "g", (e) => void events.push(e));
  const claim = await slot.claim();
  assert.ok("token" in claim);
  await assert.rejects(slot.release(claim.token), /store down/);
  assert.deepEqual(states(events), ["open", "closed"]);
});

test("a presence channel that throws does not fail the wait (APC 0.11)", async () => {
  const slot = announceWaits(new MemoryWaitSlots().for("g"), "g", () => {
    throw new Error("page gone");
  });
  const claim = await slot.claim();
  assert.ok("token" in claim);
  assert.equal(await slot.release(claim.token), true);
});
