/**
 * The docs' Orders example (apps/dock/src/docs/examples, shown at /docs/integrate and /docs/conformance) is a
 * conforming APC app: the conformance suite runs against it on both profiles, the apc_link checks with Direct.
 * The samples type-check through apps/dock/tsconfig.docs.json (`pnpm typecheck`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { MCP_BODY_MAX_BYTES, OrdersApp, type OrdersStore } from "../src/docs/examples/orders-app.ts";
import { apcConformance, standInHub } from "@tineira/apc-conformance";
import { APC_AGENT_TYPE, decodeApcConnect, encodeApcConnect, parseAgentDrag, type PresenceMessage, type PresenceWaitEvent } from "@tineira/apc-protocol";
import { exampleRegion } from "../src/docs/markdown.ts";
import { cdpDropFromDock, cdpPinMark, ordersChecks, ordersUnderTest } from "../src/docs/examples/orders-conformance.ts";

for (const profile of ["direct", "dock"] as const) {
  for (const check of ordersChecks(profile, { link: profile === "direct" })) test(check.name, check.run);
}

test("Orders declares its MCP endpoint exactly (APC 0.11): the suite checks each profile's grant against mcp.endpoints", async () => {
  for (const profile of ["direct", "dock"] as const) {
    const { app } = ordersUnderTest(profile);
    const raw = (await (await app.fetch(new Request("https://orders.test/.well-known/apc.json"))).json()) as { mcp: unknown };
    assert.deepEqual(raw.mcp, { path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["direct", "dock"] }] });
    const served = named(ordersChecks(profile), "serves apc.json");
    await served.run();
    assert.match(served.note ?? "", /\/mcp\/\{secret\} declares every child of \/mcp\//, profile);
  }
});

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
  // The default hub refuses the omitted code before pairing; the app cannot complete the suite's setup.
  await assert.rejects(named(checks, "sends that code").run(), /pairing_code_required/);
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
  const call = async (path: string, body: unknown) =>
    (await app.fetch(new Request(`https://orders.test${path}`, { method: "POST", headers: { ...adapter.dock!.lifecycle!.owner.session, "content-type": "application/json" }, body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
  // A first drop asks the hub to connect (APC 0.13); the dock opens dock_connect, whose page asks with the connect ticket.
  const target = { kind: "order", id: "ord_9999" };
  assert.deepEqual(await call("/api/drop", { hub: hub.origin, agent: "ag_pin", ticket: hub.ticket("ag_pin"), target }), { ok: true, status: "connect_requested" });
  const opened = decodeApcConnect(new URL((await hub.approveConnect("ag_pin")).url!).hash)!;
  const drop = { ...opened };
  const asked = await call("/api/connect/dock", drop);
  const paired = await call("/api/connect/dock", { ...drop, consent: asked.consent });
  assert.equal(paired.ok, true);
  assert.equal(paired.status, "pending");
  assert.equal((paired.pairing as { code: string }).code, asked.pairing_code);
  assert.equal(paired.pin_error, "invalid_target");
  assert.deepEqual(app.agents().find((a) => a.id === paired.grant_id)?.pairing, paired.pairing, "the page's waiting row has the code");
});

test("Orders retains a non-default first-drop target through the real fragment-only Connect payload and a restart, then clears it", async () => {
  const { app, adapter } = ordersUnderTest("dock");
  const hub = adapter.dock!.hub;
  const lifecycle = adapter.dock!.lifecycle!;
  const dropped = await lifecycle.dropAgent({ hub: hub.origin, agent: "ag_target", ticket: hub.ticket("ag_target"), target: { kind: "order", id: "ord_1002", part: null, params: null } });
  assert.equal(dropped.page, "connecting");
  const opened = await hub.approveConnect("ag_target");
  assert.ok(opened.url);
  // Restart on the same per-person store before the fragment reaches the Connect page.
  await lifecycle.restart!();
  const consent = await lifecycle.connectDock!(opened.url);
  assert.equal(consent.page, "consent");
  if (consent.page !== "consent") throw new Error("no consent");
  const paired = await consent.allow();
  assert.equal(paired.ok, true);
  const pairing = hub.pairings.find((p) => p.agent === "ag_target")!;
  assert.equal((await hub.decide(pairing.id, "approve", paired.code)).ok, true);
  const response = await adapter.fetch!(new Request(pairing.mcp_url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_view", arguments: {} } }),
  }));
  const body = await response.json() as { result: { structuredContent: { focus: { id: string } } } };
  assert.equal(body.result.structuredContent.focus.id, "ord_1002");
  // The old object and restarted object share the durable per-person store.
  const store = (app as unknown as { store: OrdersStore }).store;
  assert.deepEqual(store.kv.list("connect-target:"), []);
});

test("Orders discards an expired retained target and never recovers another agent's target", async () => {
  for (const scenario of ["expired", "other-agent"]) {
    const { app, adapter } = ordersUnderTest("dock");
    const hub = adapter.dock!.hub;
    const lifecycle = adapter.dock!.lifecycle!;
    await lifecycle.dropAgent({ hub: hub.origin, agent: "ag_saved", ticket: hub.ticket("ag_saved"), target: { kind: "order", id: "ord_1002", part: null, params: null } });
    const agent = scenario === "expired" ? "ag_saved" : "ag_other";
    if (scenario === "expired") await lifecycle.advance(360_000);
    else {
      // Connect an app from the dock, with no drop in Orders for this other agent.
      const requested = await hub.fetch(`${hub.origin}/apc/connect`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, ticket: hub.ticket(agent), app: { origin: "https://orders.test" } }),
      });
      assert.equal(requested.ok, true);
    }
    const opened = await hub.approveConnect(agent);
    const consent = await lifecycle.connectDock!(opened.url!);
    assert.equal(consent.page, "consent");
    if (consent.page !== "consent") throw new Error("no consent");
    const paired = await consent.allow();
    assert.equal(paired.ok, true);
    assert.equal(app.agents().find((a) => a.id === paired.grantId)!.pin, null, scenario);
  }
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

test("Orders: a child of /mcp/ that fits a secret but names no grant is an unknown grant, 404, even with no session (EP-5)", async () => {
  const origin = "https://orders.test";
  const app = new OrdersApp({ origin, profiles: ["direct", "dock"], signedIn: () => false });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  // Each fits a secret and misses the grant route ([0-9a-f]{32}), so only the {secret} rule answers it.
  for (const child of ["AbCdEfGhIjKlMnOpQrStUv", "operations-console", "A".repeat(32)]) {
    const url = `${origin}/mcp/${child}`;
    const post = await app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    assert.equal(post.status, 404, `POST ${child}`);
    const get = await app.fetch(new Request(url));
    assert.equal(get.status, 404, `GET ${child}`);
  }
  // A path that does not fit a secret is not claimed by /mcp/{secret}: the app's own answer stands.
  assert.equal((await app.fetch(new Request(`${origin}/mcp/short`))).status, 401);
});

test("Orders: agent traffic stamps nothing: ping and tools/list in handoff, and anything served while asleep, leave the grant as it was", async () => {
  const { adapter, app } = ordersUnderTest("dock");
  const life = adapter.dock!.lifecycle!;
  const hub = adapter.dock!.hub;
  const send = async (url: string, method: string, params: Record<string, unknown> = {}) =>
    adapter.fetch!(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const grants = (app as unknown as { store: { grants: Map<string, Record<string, unknown>> } }).store.grants;
  const snapshot = (url: string) => JSON.stringify(grants.get(url.split("/").pop()!));

  // Handoff: dropped and allowed, the dock has not connected. A first drop asks the hub to connect (APC 0.13), and the
  // person is asked on the dock_connect page the dock opens.
  const dropped = await life.dropAgent({ agent: "ag_quiet", ticket: hub.ticket("ag_quiet"), hub: hub.origin });
  assert.equal(dropped.page, "connecting");
  const shown = await life.connectDock!((await hub.approveConnect("ag_quiet")).url!);
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

test("an app that sends no wait events passes every wait-event check with a note: they are optional (APC 0.11)", async () => {
  const checks = rewrittenPresence((m) => m.filter((e) => e.kind !== "wait"));
  const names = [WAITS, TAKEOVER, "a cancelled wait publishes closed", "a wait whose grant is revoked publishes closed", "a refused wait publishes nothing"];
  const waitChecks = names.map((n) => named(checks, n));
  for (const c of waitChecks) {
    await c.run();
    assert.match(c.note ?? "", /not checked: the app sends no wait events/, c.name);
  }
});

test("an app that sends open but never closed is held to the rules and fails (APC 0.11)", async () => {
  const openOnly = rewrittenPresence((m) => m.filter((e) => !(e.kind === "wait" && e.state === "closed")));
  await assert.rejects(named(openOnly, WAITS).run(), /has its closed, and only that: got \[\]/);
  await assert.rejects(named(openOnly, "a cancelled wait publishes closed").run(), /got \[open\]/);
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

const CANCEL = "a cancelled wait publishes closed";
const REVOKE = "a wait whose grant is revoked publishes closed";
const REFUSED = "a refused wait publishes nothing";

test("the wait-event checks fail an app that sends no closed on a cancel or a revoke (APC 0.11)", async () => {
  const noClosed = rewrittenPresence((m) => m.filter((e) => !(e.kind === "wait" && e.state === "closed")));
  await assert.rejects(named(noClosed, CANCEL).run(), /a cancelled wait sends open, then closed when it stops: got \[open\]/);
  await assert.rejects(named(noClosed, REVOKE).run(), /a wait cut by a revoke sends open, then closed.*got \[open\]/);
});

test("the wait-event checks fail an app whose wait on a revoked grant sends an event (APC 0.11)", async () => {
  // As if the revoked grant's wait claimed a place: an open after the closed.
  const reopened = rewrittenPresence((m) => {
    const last = m.findLastIndex((e) => e.kind === "wait" && e.state === "closed");
    return last < 0 ? m : [...m, { ...(m[last] as PresenceWaitEvent), state: "open" }];
  });
  await assert.rejects(named(reopened, REVOKE).run(), /got \[open,closed,open\]/);
});

test("the wait-event checks fail an app whose refused wait sends an event (APC 0.11)", async () => {
  // As if the refused wait sent its own open.
  const doubled = rewrittenPresence((m) => m.flatMap((e) => (e.kind === "wait" && e.state === "open" ? [e, e] : [e])));
  await assert.rejects(named(doubled, REFUSED).run(), /got \[open,open\]/);
});

const GUARD = "an app whose wait-event checks were not checked sends no wait event anywhere in the run";

test("an app that sends wait events only on a takeover cannot pass as not checked: the last check fails it (APC 0.11)", async () => {
  // Wait events kept only in a drain that holds a takeover (a closed right before an open): the probe and a plain wait see none.
  const takeoverOnly = rewrittenPresence((m) => {
    const waits = m.filter((e) => e.kind === "wait");
    const takeover = waits.some((e, i) => e.state === "closed" && waits[i + 1]?.state === "open");
    return takeover ? m : m.filter((e) => e.kind !== "wait");
  });
  const skipped = named(takeoverOnly, WAITS);
  await skipped.run();
  assert.match(skipped.note ?? "", /the app sends no wait events/, "skipped while it had sent none");
  await named(takeoverOnly, "one wait per grant: a newer wait takes over").run();
  await assert.rejects(named(takeoverOnly, GUARD).run(), /the app sent wait events in this run/);
});

test("an app that sends no wait events passes the last check too (APC 0.11)", async () => {
  const none = rewrittenPresence((m) => m.filter((e) => e.kind !== "wait"));
  await named(none, WAITS).run();
  await named(none, "one wait per grant: a newer wait takes over").run();
  await named(none, GUARD).run();
});

test("a revoke that throws while a wait-event check gives its agent back does not hide the check's result (APC 0.11)", async () => {
  const { adapter } = ordersUnderTest("direct");
  const take = adapter.page.takePresence.bind(adapter.page);
  const checks = apcConformance({
    ...adapter,
    page: {
      ...adapter.page,
      takePresence: () => take().filter((e) => !(e.kind === "wait" && e.state === "closed")),
      revoke: async () => {
        throw new Error("revoke broke");
      },
    },
  });
  await assert.rejects(named(checks, "a cancelled wait publishes closed").run(), /got \[open\]/);
});

test("the wait-event probe runs once per run, and each check makes one agent (APC 0.11)", async () => {
  const { adapter } = ordersUnderTest("direct");
  let probes = 0;
  let agents = 0;
  const checks = apcConformance({
    ...adapter,
    connect: async () => (agents++, adapter.connect()),
    fetch: async (request) => {
      const body = request.method === "POST" ? await request.clone().text() : "";
      if (body.includes('"wait_for_focus"') && body.includes('"timeout_s":1}')) probes++;
      return adapter.fetch!(request);
    },
  });
  await named(checks, WAITS).run();
  await named(checks, "a cancelled wait publishes closed").run();
  assert.equal(probes, 1);
  assert.equal(agents, 2);
});

test("Orders 1.0: a missing Connect route refuses the drop, and /connect/dock pairs signed-in account", async () => {
  const HUB = "https://dock.test";
  const ORIGIN = "https://orders.test";
  let connectAnswer = () => Response.json({ ok: true, status: "connect_requested" });
  let pairAnswer = () => Response.json({ ok: true, pairing_id: "pr_" + "a".repeat(32), binding: "pairing_id", status: "pending", pairing_code: "required", agent: { name: "Agent", icon: null } });
  const called: Array<{ url: string; body: Record<string, unknown> }> = [];
  let cookie = "orders_session=1";

  const app = new OrdersApp({
    origin: ORIGIN,
    profiles: ["direct", "dock"],
    hubs: [HUB],
    account: "demo@orders.test",
    connectScript: "/connect-dock.js",
    signedIn: (r) => r.headers.get("cookie") === cookie,
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const body = (await req.clone().json()) as Record<string, unknown>;
      called.push({ url: req.url, body });
      if (req.url === `${HUB}/apc/connect`) return connectAnswer();
      if (req.url === `${HUB}/apc/pair`) return pairAnswer();
      if (req.url === `${HUB}/apc/confirm`) return Response.json({ ok: true, status: "paired", agent: { name: "Agent", icon: null } });
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });

  // 1. apc.json declares dock_connect; GET /connect/dock answers 200 (even signed out) with no-referrer and no third-party script.
  const manifest = await (await app.fetch(new Request(`${ORIGIN}/.well-known/apc.json`))).json() as { dock_connect?: string };
  assert.equal(manifest.dock_connect, `${ORIGIN}/connect/dock`);
  const page = await app.fetch(new Request(`${ORIGIN}/connect/dock`, { redirect: "manual" }));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.match(html, /data-session="false" data-signed-in="false"/);
  assert.match(html, /history\.replaceState/);
  assert.equal(/<script[^>]+src=["'](?:https?:)?\/\//i.test(html), false);

  const post = (path: string, body: unknown) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

  // 2. Unlinked drop calls requestConnect and does not ask for consent or call /apc/pair.
  const dropTicket = `${"a".repeat(32)}.${"b".repeat(32)}`;
  const drop = { hub: HUB, agent: "ag_o1", ticket: dropTicket, target: { kind: "order", id: "ord_1001" } };
  assert.deepEqual(await (await post("/api/drop", drop)).json(), { ok: true, status: "connect_requested" });
  assert.deepEqual(called.map((c) => new URL(c.url).pathname), ["/apc/connect"]);

  // 3. Every missing Connect route is a refusal; no drop-time consent remains.
  for (const [status, body, error] of [
    [404, { error: "not_found", detail: "missing route" }, "hub_refused"],
    [400, { ok: false, error: "not_found" }, "not_found"],
    [409, { ok: false, error: "not_found" }, "hub_refused"],
    [429, { ok: false, error: "not_found" }, "hub_refused"],
  ] as const) {
    connectAnswer = () => Response.json(body, { status });
    assert.deepEqual(await (await post("/api/drop", drop)).json(), { ok: false, error });
  }
  connectAnswer = () => Response.json({ error: "not_found" }, { status: 404 });
  assert.deepEqual(await (await post("/api/drop", drop)).json(), { ok: false, error: "not_found" });
  assert.equal(called.some((c) => c.url.endsWith("/apc/pair")), false);
  const connectOnly = await (await post("/api/connect/dock", drop)).json() as { consent: string };
  assert.deepEqual(await (await post("/api/drop", { ...drop, consent: connectOnly.consent })).json(), { ok: false, error: "not_found" });
  assert.equal(called.some((c) => c.url.endsWith("/apc/pair")), false, "Connect consent cannot authorize a drop-time Allow");

  // 4. Full /api/connect/dock consent -> Allow -> pending + pairing code, then drop on linked agent confirms.
  const connectTicket = `${"c".repeat(32)}.${"d".repeat(32)}`;
  const connectAsked = await (await post("/api/connect/dock", { hub: HUB, agent: "ag_o1", ticket: connectTicket })).json() as { error: string; consent: string };
  assert.equal(connectAsked.error, "consent_required");
  const paired = await (await post("/api/connect/dock", { hub: HUB, agent: "ag_o1", ticket: connectTicket, consent: connectAsked.consent })).json() as { ok: boolean; status: string };
  assert.equal(paired.ok, true);
  assert.equal(paired.status, "pending");
  const confirmed = await (await post("/api/drop", drop)).json() as { ok: boolean; status: string };
  assert.equal(confirmed.ok, true);
  assert.equal(new URL(called.at(-1)!.url).pathname, "/apc/confirm");

  // 5. The hub's initialize makes it live; a re-Connect the hub refuses leaves that grant serving.
  const oldUrl = String(called.filter((c) => new URL(c.url).pathname === "/apc/pair").at(-1)!.body.mcp_url);
  const rpc = (url: string, method: string, params: Record<string, unknown> = {}) =>
    app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const meta = { "apc.tineira.com/pairing_id": "pr_" + "a".repeat(32), "apc.tineira.com/agent": "ag_o1" };
  assert.equal((await rpc(oldUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", version: "1" }, _meta: meta })).status, 200);
  const serves = async (what: string) => {
    const served = await rpc(oldUrl, "tools/call", { name: "list_orders", arguments: {} });
    assert.equal(served.status, 200, what);
    assert.equal(((await served.json()) as { result: { isError?: boolean } }).result.isError ?? false, false, what);
  };
  await serves("live");
  const again = { hub: HUB, agent: "ag_o1", ticket: `${"e".repeat(32)}.${"f".repeat(32)}` };
  const reAsked = await (await post("/api/connect/dock", again)).json() as { error: string; consent: string; replaces?: boolean };
  assert.equal(reAsked.error, "consent_required");
  assert.equal(reAsked.replaces, true, "the card says it replaces the current connection");
  pairAnswer = () => Response.json({ ok: false, error: "ticket_expired" }, { status: 400 });
  assert.deepEqual(await (await post("/api/connect/dock", { ...again, consent: reAsked.consent })).json(), { ok: false, error: "ticket_expired" });
  await serves("a refused re-Connect leaves the old grant serving");
  // An acknowledged re-Connect replaces it.
  pairAnswer = () => Response.json({ ok: true, pairing_id: "pr_" + "b".repeat(32), binding: "pairing_id", status: "pending", pairing_code: "required", agent: { name: "Agent", icon: null } });
  const reYes = await (await post("/api/connect/dock", again)).json() as { consent: string };
  const replaced = await (await post("/api/connect/dock", { ...again, consent: reYes.consent })).json() as { ok: boolean; status: string };
  assert.equal(replaced.ok, true);
  assert.equal(replaced.status, "pending");
  assert.notEqual((await rpc(oldUrl, "tools/call", { name: "list_orders", arguments: {} })).status, 200, "the replaced grant no longer serves");
});

test("Orders 0.13: without the dock profile, apc.json has no dock_connect and GET /connect/dock is 404", async () => {
  const app = new OrdersApp({ origin: "https://orders.test", profiles: ["direct"], hubs: [], signedIn: () => true });
  const manifest = await (await app.fetch(new Request("https://orders.test/.well-known/apc.json"))).json() as Record<string, unknown>;
  assert.equal("dock_connect" in manifest, false);
  assert.equal((await app.fetch(new Request("https://orders.test/connect/dock"))).status, 404);
});

test("browser-drop helpers emit trusted CDP mouse and dock drag events", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return {};
  };

  await cdpPinMark(cdp, { x: 100, y: 200 }, { x: 260, y: 210 });
  assert.deepEqual(
    calls.map((c) => [c.method, c.params.type]),
    [
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseMoved"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
    ],
  );
  assert.equal(calls[2]!.params.buttons, 1);

  calls.length = 0;
  await cdpDropFromDock(
    cdp,
    { x: 260, y: 210 },
    { agent: "Helper", hub: "https://hub.example", ticket: "ticket_1234567890" },
  );
  assert.deepEqual(
    calls.map((c) => [c.method, c.params.type]),
    [
      ["Input.dispatchDragEvent", "dragEnter"],
      ["Input.dispatchDragEvent", "dragOver"],
      ["Input.dispatchDragEvent", "drop"],
    ],
  );
  const dropData = calls[2]!.params.data as { items: Array<{ mimeType: string; data: string }> };
  assert.equal(dropData.items[0]!.mimeType, APC_AGENT_TYPE);
  assert.deepEqual(parseAgentDrag(dropData.items[0]!.data), {
    v: 1,
    agent: "Helper",
    hub: "https://hub.example",
    ticket: "ticket_1234567890",
  });
});

/** Parse TypeScript source with the repo's `tsc` (`--noCheck --noEmit`) and fail on any syntactic diagnostic. */
function assertParsesWithTsc(source: string, filename: string): void {
  const dir = mkdtempSync(join(tmpdir(), "apc-docs-asm-"));
  const file = join(dir, filename);
  const tsc = resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc");
  try {
    writeFileSync(file, source);
    execFileSync(process.execPath, [tsc, "--noEmit", "--noCheck", "--noResolve", "--target", "esnext", "--module", "nodenext", "--moduleResolution", "nodenext", file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [answer, message] of [
  [{ ok: false, error: "not_found" }, /cannot take a connection request.*too old for Connect.*Update your dock/],
  [{ ok: false, error: "hub_refused" }, /refused the connection request.*Check your dock/],
  [{ ok: false, error: "too_many_requests" }, /too many pending requests.*Answer one/],
  [{ ok: false, error: "hub_not_allowed" }, /does not pair with that dock.*Use a dock allowed/],
  [{ ok: false, error: "ticket_not_for_pairing" }, /Drop the agent again, then confirm/],
  [{ ok: false, error: "unexpected_refusal" }, /could not connect.*Check your dock/],
  [{ ok: true, status: "connect_requested" }, /Confirm in your dock/],
] as const) {
  test(`Orders page: ${"error" in answer ? answer.error : answer.status} remains visible across refresh and the waiting-code interval`, async () => {
    // Execute the published handler and countdown, including replaceChildren wiping waiting's contents.
    class Element {
      children: Element[] = [];
      textContent = "";
      attributes = new Map<string, string>();
      setAttribute(key: string, value: string) { this.attributes.set(key, value); }
      append(...elements: Element[]) { this.children.push(...elements); }
      replaceChildren(...elements: Element[]) { this.textContent = ""; this.children = elements; }
      addEventListener() {}
      before(element: Element) { root.children.splice(root.children.indexOf(this), 0, element); }
    }
    const root = new Element();
    const waiting = new Element();
    root.append(waiting);
    const onRefresh: Array<(rows: unknown[]) => void> = [];
    let tick: (() => void) | undefined;
    const source = readFileSync(resolve(import.meta.dirname, "../src/docs/examples/orders-page.ts"), "utf8");
    const region = exampleRegion(source, "waiting");
    assert.ok(region);
    const context = vm.createContext({
      document: { querySelector: () => waiting, createElement: () => new Element() },
      onRefresh, onDockDrop: undefined,
      post: async () => answer,
      refresh: async () => { for (const fn of onRefresh) fn([]); },
      formatPairingCode: (code: string) => code,
      setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 1000); tick = fn; },
    });
    vm.runInContext(stripTypeScriptTypes(region), context);
    for (const rows of [[], [{ id: "other_agent", waiting: "code", pairing: { code: "K7M4P2", expires_at: new Date(Date.now() + 60_000).toISOString() } }]]) {
      onRefresh[0]!(rows);
      await vm.runInContext('dropFromDock({ hub: "https://dock.test", agent: "ag_1", ticket: "drop" }, { kind: "order", id: "ord_1001" })', context);
      const status = root.children[0]!;
      assert.notEqual(status, waiting, "the status is attached outside the redrawn waiting rows");
      assert.equal(status.attributes.get("role"), "status");
      assert.match(status.textContent, message, "the real drop handler leaves an actionable message");
      onRefresh[0]!(rows); // A later server refresh redraws the panel.
      tick!(); // The real one-second callback redraws another agent's waiting-code row.
      assert.match(status.textContent, message, "refresh and interval preserve the drop message");
      if (rows.length) assert.match(waiting.children[0]!.textContent, /Waiting for your dock/);
    }
  });
}

/** Run assembled `orders-page.ts` excerpts with stubbed browser/package globals to verify `void refresh()` has no TDZ or missing-symbol errors. */
async function runAssembledOrdersPage(regions: string[], pageSrc: string): Promise<void> {
  const parts = regions.map((name) => {
    const code = exampleRegion(pageSrc, name);
    assert.ok(code !== null, `missing orders-page.ts#${name}`);
    return name === "imports" ? code.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "") : code;
  });
  const assembled = parts.join("\n").replace(/\bexport /g, "");
  assertParsesWithTsc(regions.map((name) => exampleRegion(pageSrc, name)!).join("\n"), "orders-page.ts");
  const js = stripTypeScriptTypes(assembled);

  const fakeEl = () => ({ setAttribute() {}, append() {}, before() {}, replaceChildren() {}, addEventListener() {}, dataset: {} as Record<string, string>, textContent: "" });
  const doc = { querySelector: () => fakeEl(), createElement: () => fakeEl(), body: fakeEl() };
  const noop = () => {};
  let listFetched = false;
  const fetchMock = async (url: string) => {
    if (url === "/api/agents/list") {
      listFetched = true;
      return { json: async () => [{ id: "g_1", name: "Helper", paths: ["direct"], grants: ["g_1"], url: "https://orders.test/mcp/1", client: null, pin: null, waiting: null, pairing: null }] };
    }
    return { json: async () => ({ ok: true }) };
  };
  const fn = new Function(
    "document", "location", "fetch", "EventSource", "T_IDLE_RECOMMENDED_MS", "NO_OPEN_WAITS",
    "focusAttrs", "formatPairingCode", "createViewReporter", "defineAgentBar", "defineDirectAgents",
    "enablePinning", "flashTargets", "initials", "loadApcProfiles", "formatPageTime", "agentBadge",
    "defineHeaderPets", "petState", "agentWaitOpen", "dropExpiredWaits", "foldWaitEvent", "nextWaitExpiry",
    "setTimeout", "clearTimeout", "setInterval",
    js,
  );
  fn(
    doc, { origin: "https://orders.test" }, fetchMock,
    function () { return { addEventListener: noop }; },
    1800000, {}, () => ({}), String, () => noop, noop, noop,
    noop, noop, () => "H", () => ["direct"], () => "", () => "",
    noop, () => ({}), () => false, (x: unknown) => x, (x: unknown) => x, () => null,
    noop, noop, noop,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(listFetched, true, "void refresh() fetched /api/agents/list");
}

test("integrate.md Orders excerpts assemble into syntactically valid TypeScript modules and run safely (Full and Direct-only)", async () => {
  const integrateMd = readFileSync(resolve(import.meta.dirname, "../src/docs/pages/integrate.md"), "utf8");
  const ordersAppSrc = readFileSync(resolve(import.meta.dirname, "../src/docs/examples/orders-app.ts"), "utf8");
  const appRegions = [...integrateMd.matchAll(/<!-- include orders-app\.ts#([\w-]+) -->/g)].map((m) => m[1]!);
  const assembledApp = appRegions.map((name) => {
    const code = exampleRegion(ordersAppSrc, name);
    assert.ok(code !== null, `missing orders-app.ts#${name}`);
    return code;
  }).join("\n");

  assertParsesWithTsc(assembledApp, "orders-app.ts");
  for (const symbol of ["live(", "byId(", "mcpUrl(", "publish(", "unlink(", "dockConnectPage("]) {
    assert.ok(assembledApp.includes(symbol), `missing ${symbol} from assembled integrate.md excerpts`);
  }

  const ordersPageSrc = readFileSync(resolve(import.meta.dirname, "../src/docs/examples/orders-page.ts"), "utf8");
  const pageRegions = [...integrateMd.matchAll(/<!-- include orders-page\.ts#([\w-]+) -->/g)].map((m) => m[1]!);
  assert.ok(pageRegions.indexOf("start") > pageRegions.indexOf("waiting"), "start region runs after waiting");
  await runAssembledOrdersPage(pageRegions, ordersPageSrc);
  await runAssembledOrdersPage(["imports", "markup", "direct", "view", "bar", "events", "pinning", "pets", "start"], ordersPageSrc);
});

test("orders-connect.ts mounts against a fake DOM and drives the 0.13 Dock Connect flow with OrdersApp", async () => {
  const saved = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    customElements: globalThis.customElements,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    location: globalThis.location,
    history: globalThis.history,
    window: (globalThis as { window?: unknown }).window,
  };
  try {
    const { doc, El } = await import("../../../packages/web/test/fake-dom.ts");
    let currentHash = "";
    const sessionMap = new Map<string, string>();
    const sessionStorageStub: Storage = {
      get length() { return sessionMap.size; },
      clear: () => sessionMap.clear(),
      key: (i: number) => [...sessionMap.keys()][i] ?? null,
      getItem: (k: string) => sessionMap.get(k) ?? null,
      setItem: (k: string, v: string) => { sessionMap.set(k, v); },
      removeItem: (k: string) => { sessionMap.delete(k); },
    };
    const locationStub = {
      href: "https://orders.test/connect/dock",
      origin: "https://orders.test",
      pathname: "/connect/dock",
      search: "",
      get hash() { return currentHash; },
      set hash(next: string) { currentHash = next; },
    };
    const historyStub = {
      state: { idx: 0 },
      replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
        void url;
        currentHash = "";
      },
    };
    let signedIn = true;
    const hub = standInHub({ origin: "https://dock.test", app: (req) => app.fetch(req) });
    const app = new OrdersApp({
      origin: "https://orders.test",
      profiles: ["direct", "dock"],
      hubs: ["https://dock.test"],
      fetch: hub.fetch,
      account: "alice@orders.test",
      signedIn: () => signedIn,
    });
    const fetchCalls: string[] = [];
    Object.assign(globalThis, {
      sessionStorage: sessionStorageStub,
      location: locationStub,
      history: historyStub,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        fetchCalls.push(url);
        const target = url.startsWith("http") ? url : `https://orders.test${url}`;
        return app.fetch(new Request(target, { ...init, headers: { origin: "https://orders.test", ...(init?.headers as Record<string, string> | undefined) } }));
      },
    });
    Object.assign((globalThis as unknown as { window: Record<string, unknown> }).window, {
      location: locationStub,
      history: historyStub,
      sessionStorage: sessionStorageStub,
    });
    (doc as unknown as { querySelector(selector: string): InstanceType<typeof El> | null }).querySelector = (selector: string) => {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return doc.documentElement.elements().find((e) => e.getAttribute("id") === id) ?? null;
      }
      const tag = selector.toUpperCase();
      return doc.documentElement.elements().find((e) => e.tagName === tag) ?? null;
    };

    const resetDom = (isSignedIn: boolean) => {
      signedIn = isSignedIn;
      doc.body.replaceChildren();
      const mainEl = doc.createElement("main");
      mainEl.dataset = { app: "Orders", session: "false", signedIn: isSignedIn ? "true" : "false", account: isSignedIn ? "alice@orders.test" : "No account signed in." };
      const accountEl = Object.assign(doc.createElement("p"), { id: "account" });
      const messageEl = Object.assign(doc.createElement("p"), { id: "message" });
      const consentEl = Object.assign(doc.createElement("div"), { id: "consent" });
      const handoffEl = Object.assign(doc.createElement("apc-handoff"), { hidden: true, host: "", pairing: null as { code: string; expires_at: string } | null, autoFocus: false });
      mainEl.append(accountEl, messageEl, consentEl, handoffEl);
      doc.body.append(mainEl);
      currentHash = "";
      sessionMap.clear();
      fetchCalls.length = 0;
      return { accountEl, messageEl, consentEl, handoffEl };
    };

    // Extract the <head> script directly from GET /connect/dock.
    const pageHtml = await (await app.fetch(new Request("https://orders.test/connect/dock"))).text();
    const headScript = pageHtml.match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(headScript, "CONNECT_HEAD present in /connect/dock HTML");
    const runHead = (hash: string) => {
      currentHash = hash;
      vm.runInNewContext(headScript, { location: locationStub, history: historyStub, sessionStorage: sessionStorageStub, atob, Uint8Array, TextDecoder });
    };

    // 1. Signed out: keeps apc_connect in sessionStorage and makes no API fetch.
    let ui = resetDom(false);
    runHead(encodeApcConnect({ v: 1, hub: "https://dock.test", agent: "ag_out", ticket: "1".repeat(32) + "." + "2".repeat(32) }));
    const { mountOrdersConnect } = await import("../src/docs/examples/orders-connect.ts");
    await mountOrdersConnect();
    assert.equal(ui.accountEl.textContent, "No account signed in.");
    assert.match(ui.messageEl.textContent, /Sign in first/);
    assert.ok(sessionMap.get("apc_connect"), "keeps stored handoff across sign-in");
    assert.equal(fetchCalls.length, 0);

    // 2. Signed in: drop -> hub.approveConnect -> CONNECT_HEAD -> Allow -> <apc-handoff> -> Cancel.
    ui = resetDom(true);
    const dropRes = await (await app.fetch(new Request("https://orders.test/api/drop", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://orders.test" },
      body: JSON.stringify({ hub: "https://dock.test", agent: "ag_conn", ticket: hub.ticket("ag_conn"), target: { kind: "order", id: "ord_1001" } }),
    }))).json() as { ok: boolean; status: string };
    assert.deepEqual(dropRes, { ok: true, status: "connect_requested" });
    const approved = await hub.approveConnect("ag_conn");
    assert.ok(approved.url);

    runHead(new URL(approved.url).hash);
    assert.equal(locationStub.hash, "");
    await mountOrdersConnect();
    assert.equal(ui.accountEl.textContent, "Signed in: alice@orders.test");
    assert.match(ui.messageEl.textContent, /dock\.test/);

    const allow = ui.consentEl.elements().find((b) => b.textContent === "Allow") as (InstanceType<typeof El> & { onclick?: () => void }) | undefined;
    assert.ok(allow, "Allow button rendered");
    allow.onclick?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.handoffEl.hidden, false);
    assert.equal(ui.handoffEl.host, "dock.test");
    assert.ok(ui.handoffEl.pairing?.code);
    assert.equal(sessionMap.get("apc_connect"), undefined);

    ui.handoffEl.fire("apc-cancel");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.handoffEl.hidden, true);
    assert.equal(ui.messageEl.textContent, "Connection cancelled.");
  } finally {
    Object.assign(globalThis, saved);
  }
});
