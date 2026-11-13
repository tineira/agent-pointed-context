/**
 * The docs' Orders example (apps/dock/src/docs/examples, shown at /docs/integrate and /docs/conformance) is a
 * conforming APC app: the conformance suite runs against it on both profiles, the apc_link checks with Direct.
 * The samples type-check through apps/dock/tsconfig.docs.json (`pnpm typecheck`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_BODY_MAX_BYTES, OrdersApp } from "../src/docs/examples/orders-app.ts";
import { apcConformance } from "@tineira/apc-conformance";
import type { PresenceMessage, PresenceWaitEvent } from "@tineira/apc-protocol";
import { ordersChecks, ordersUnderTest } from "../src/docs/examples/orders-conformance.ts";

for (const profile of ["direct", "dock"] as const) {
  for (const check of ordersChecks(profile, { link: profile === "direct" })) test(check.name, check.run);
}

test("a page whose stream died is dropped, and the tool call that published to it still answers", async () => {
  const origin = "https://orders.test";
  const app = new OrdersApp({ origin, profiles: ["direct"] });
  // A page whose stream closed without the server hearing of it: sending to it throws, as enqueue on a closed stream does.
  const pages = (app as unknown as { pages: Set<(message: unknown) => void> }).pages;
  pages.add(() => {
    throw new TypeError("Invalid state: ReadableStream is closed");
  });
  const made = (await (await app.fetch(new Request(`${origin}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json()) as { url: string };
  const response = await app.fetch(
    new Request(made.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_orders", arguments: {} } }),
    }),
  );
  const body = (await response.json()) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> }; error?: unknown };
  assert.equal(response.status, 200);
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  assert.ok(Array.isArray(body.result?.structuredContent?.orders), "the tool's own result");
  assert.equal(pages.size, 0, "the dead page is gone");
  assert.equal(body.result?.structuredContent?.then, undefined, "with no page open, no then");
});

/** Orders with its server's calls to the hub rewritten: a broken app, as the pairing-code checks must catch it. */
function brokenOrders(rewrite: (send: typeof fetch) => typeof fetch) {
  const { app, adapter } = ordersUnderTest("dock");
  const inner = app as unknown as { send: typeof fetch };
  inner.send = rewrite(inner.send);
  return apcConformance(adapter);
}
const named = (checks: ReturnType<typeof apcConformance>, part: string) => checks.find((c) => c.name.includes(part))!;

test("the pairing-code checks fail an app that claims 0.9 on the Dock profile without the dock adapter", async () => {
  const { adapter } = ordersUnderTest("dock");
  const { dock: _dock, ...without } = adapter;
  await assert.rejects(named(apcConformance(without), "the dock adapter is given").run(), /requires the pairing code to be checked/);
});

test("the pairing-code checks fail an app that sends the hub no code", async () => {
  const checks = brokenOrders((send) => (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    delete body.pairing_code;
    return send(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch);
  // Its own pairWithHub then refuses the hub that took no code (no acknowledgement), so the check fails either way.
  await assert.rejects(named(checks, "sends that code").run(), /without pairing_code|hub_ignores_pairing_code/);
});

test("the pairing-code checks fail an app that keeps a grant the hub did not acknowledge", async () => {
  const ack = { ok: true, pairing_id: "pr_x", status: "pending", agent: { name: "A", icon: null }, pairing_code: "required" };
  const checks = brokenOrders((send) => (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await send(url, { ...init, redirect: "follow" });
    // As if the app believed any yes: an unacknowledged one, a redirected one, a 500.
    return String(url).endsWith("/apc/pair") && response.status !== 400 ? Response.json(ack) : response;
  }) as typeof fetch);
  await assert.rejects(named(checks, "holds no grant").run(), /the Allow says it paired/);
});

test("Orders: a drop that pairs but cannot pin its target answers ok with the waiting code and pin_error, which its page shows", async () => {
  const { app, adapter } = ordersUnderTest("dock");
  const hub = adapter.dock!.hub;
  const call = async (body: unknown) =>
    (await app.fetch(new Request("https://orders.test/api/drop", { method: "POST", headers: { ...adapter.dock!.lifecycle!.owner.session, "content-type": "application/json" }, body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
  const drop = { hub: hub.origin, agent: "ag_pin", ticket: hub.ticket("ag_pin"), target: { kind: "order", id: "ord_9999" } };
  const asked = await call(drop);
  const paired = await call({ ...drop, consent: asked.consent });
  assert.equal(paired.ok, true);
  assert.equal(paired.status, "pending");
  assert.equal((paired.pairing as { code: string }).code, asked.pairing_code);
  assert.equal(paired.pin_error, "invalid_target");
  assert.deepEqual(app.agents().find((a) => a.id === paired.grant_id)?.pairing, paired.pairing, "the page's waiting row has the code");
});

test("Orders: the heartbeat's answer carries the T_idle in effect, so the page beats within half of it", async () => {
  const headers = { "content-type": "application/json" };
  const beat = async (app: OrdersApp) => (await app.fetch(new Request("https://orders.test/api/heartbeat", { method: "POST", headers, body: "{}" }))).json();
  assert.deepEqual(await beat(new OrdersApp({ origin: "https://orders.test", profiles: ["direct", "dock"], hubs: ["https://dock.test"], idleMs: 4 * 60_000 })), { ok: true, idle_ms: 4 * 60_000 });
  assert.deepEqual(await beat(new OrdersApp({ origin: "https://orders.test", profiles: ["direct", "dock"], hubs: ["https://dock.test"] })), { ok: true, idle_ms: 30 * 60_000 });
});

test("Orders: an MCP request over 1 MiB answers 413 before it is parsed, to a grant's URL and to an unknown one alike", async () => {
  const origin = "https://orders.test";
  const app = new OrdersApp({ origin, profiles: ["direct"] });
  const made = (await (await app.fetch(new Request(`${origin}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json()) as { url: string };
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_BODY_MAX_BYTES) } });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const url of [made.url, `${origin}/mcp/${"0".repeat(32)}`]) {
    const declared = await app.fetch(new Request(url, { method: "POST", headers, body: big }));
    assert.equal(declared.status, 413, url);
    assert.deepEqual(await declared.json(), { error: "too_large" });
    // The same bytes with no content-length: a stream, cut at the cap.
    const streamed = await app.fetch(new Request(url, { method: "POST", headers, body: new Blob([big]).stream(), duplex: "half" } as RequestInit));
    assert.equal(streamed.status, 413, `${url}, streamed`);
  }
  // Under the cap the same grant still answers, from the body the transport was handed back.
  const ok = await app.fetch(new Request(made.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { jsonrpc: "2.0", id: 1, result: {} });
});

test("Orders: agent traffic stamps nothing: ping and tools/list in handoff, and anything served while asleep, leave the grant as it was", async () => {
  const { adapter, app } = ordersUnderTest("dock");
  const life = adapter.dock!.lifecycle!;
  const hub = adapter.dock!.hub;
  const send = async (url: string, method: string, params: Record<string, unknown> = {}) =>
    adapter.fetch!(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const grants = (app as unknown as { store: { grants: Map<string, Record<string, unknown>> } }).store.grants;
  const snapshot = (url: string) => JSON.stringify(grants.get(url.split("/").pop()!));

  // Handoff: dropped and allowed, the dock has not connected.
  const shown = await life.dropAgent({ agent: "ag_quiet", ticket: hub.ticket("ag_quiet"), hub: hub.origin });
  assert.equal(shown.page, "consent");
  assert.equal((await (shown as Extract<typeof shown, { page: "consent" }>).allow()).ok, true);
  const waiting = hub.pairings.filter((p) => p.agent === "ag_quiet").at(-1)!.mcp_url;
  const before = snapshot(waiting);
  await life.advance(60_000);
  for (const method of ["ping", "tools/list"]) assert.equal((await send(waiting, method)).status, 200, method);
  const refused = (await (await send(waiting, "tools/call", { name: "list_orders", arguments: {} })).json()) as { result: { structuredContent: { error: string } } };
  assert.equal(refused.result.structuredContent.error, "pairing");
  assert.equal(snapshot(waiting), before, "nothing on the grant moved in handoff");

  // Asleep: a live grant, T_idle after the person's last wake action.
  const live = await adapter.connect();
  await life.advance(life.idleMs! + 1000);
  const was = JSON.parse(snapshot(live.mcpUrl)) as Record<string, unknown>;
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", version: "1" } };
  for (const [method, params] of [["initialize", init], ["ping", {}], ["tools/list", {}], ["tools/call", { name: "list_orders", arguments: {} }]] as const) {
    assert.equal((await send(live.mcpUrl, method, params)).status, 200, method);
  }
  const view = (await (await send(live.mcpUrl, "tools/call", { name: "get_current_view", arguments: {} })).json()) as { result: { structuredContent: { idle?: boolean } } };
  assert.equal(view.result.structuredContent.idle, true, "still asleep after all of it");
  const after = JSON.parse(snapshot(live.mcpUrl)) as Record<string, unknown>;
  assert.equal(after.lastWake, was.lastWake, "agent traffic is not a wake action");
  assert.equal(after.state, was.state);
});

/** Orders with what its page hears rewritten: a broken app, as the wait-event checks (APC 0.11) must catch it. */
function rewrittenPresence(rewrite: (messages: PresenceMessage[]) => PresenceMessage[]) {
  const { adapter } = ordersUnderTest("direct");
  const take = adapter.page.takePresence.bind(adapter.page);
  return apcConformance({ ...adapter, page: { ...adapter.page, takePresence: () => rewrite(take()) } });
}
const WAITS = "a wait publishes open, then closed";
const TAKEOVER = "a takeover publishes the old wait's closed";

test("the wait-event checks fail an app that sends no wait events (APC 0.11)", async () => {
  const checks = rewrittenPresence((m) => m.filter((e) => e.kind !== "wait"));
  await assert.rejects(named(checks, WAITS).run(), /the page has its open/);
});

test("the wait-event checks fail an app whose wait events carry more than ids, or another shape (APC 0.11)", async () => {
  const withTool = rewrittenPresence((m) => m.map((e) => (e.kind === "wait" ? ({ ...e, tool: "wait_for_focus" } as unknown as PresenceMessage) : e)));
  await assert.rejects(named(withTool, WAITS).run(), /ids only/);
  const badState = rewrittenPresence((m) => m.map((e) => (e.kind === "wait" ? ({ ...e, state: "waiting" } as unknown as PresenceMessage) : e)));
  await assert.rejects(named(badState, WAITS).run(), /state open or closed/);
});

test("the wait-event checks fail an app that never sends closed, or sends it twice (APC 0.11)", async () => {
  const noClosed = rewrittenPresence((m) => m.filter((e) => !(e.kind === "wait" && e.state === "closed")));
  await assert.rejects(named(noClosed, WAITS).run(), /has its closed, and only that/);
  const twice = rewrittenPresence((m) => m.flatMap((e) => (e.kind === "wait" && e.state === "closed" ? [e, e] : [e])));
  await assert.rejects(named(twice, WAITS).run(), /has its closed, and only that/);
});

test("the wait-event checks fail a takeover that opens before it closes, or whose old wait closes late (APC 0.11)", async () => {
  // The newer wait's open before the older one's closed: a page folding them in order would end up not waiting.
  const openFirst = rewrittenPresence((m) => {
    const out = [...m];
    const i = out.findIndex((e, k) => k > 0 && e.kind === "wait" && e.state === "closed");
    if (i >= 0 && out[i + 1]?.kind === "wait") [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
    return out;
  });
  await assert.rejects(named(openFirst, TAKEOVER).run(), /got \[open,open,closed,closed\]/);
  // The old wait sends its own closed when it finds it was taken over, after the newer one's open.
  const lateClosed = rewrittenPresence((m) => {
    const out = [...m];
    const i = out.findIndex((e, k) => k > 0 && e.kind === "wait" && e.state === "open");
    if (i >= 0) out.splice(i + 1, 0, { ...(out[i] as PresenceWaitEvent), state: "closed" });
    return out;
  });
  await assert.rejects(named(lateClosed, TAKEOVER).run(), /got \[open,closed,open,closed,closed\]/);
});
