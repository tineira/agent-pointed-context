/**
 * Revoke from the app (APC 0.2, TIN-577), end to end in one process: the real hub (hub.ts) and the real
 * Pulse sandbox (apps/demo), each on Node's SQLite (@apc/conformance/workers), with fetch routed
 * between them by origin and nothing else reachable. The person pairs a dock agent with Pulse,
 * revokes it in Pulse's agent bar while the hub is down, and the hub learns it on its next call.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { generateDataset } from "../../demo/src/model/seed.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { Sandbox } = await import(new URL("../../demo/src/worker/sandbox.ts", import.meta.url).href);
/** Pulse's Worker, for the apc.json it serves at /.well-known/apc.json (APC 0.5): the hub reads it when Pulse pairs. */
const { default: pulseWorker } = await import(new URL("../../demo/src/worker/index.ts", import.meta.url).href);

const DOCK = "https://dock.test";
const PULSE = "https://pulse.test";
const DID = "a".repeat(32);
const SID = "b".repeat(32);
const SEED = 77;

async function world(t: TestContext) {
  const hub = new Hub(durableObjectRoom().ctx, { APP_ORIGINS: PULSE });
  await hub.init(DID);
  const pulseRoom = durableObjectRoom();
  const pulse = new Sandbox(pulseRoom.ctx, { APC_V2: "1", HUB_ORIGINS: DOCK });
  await pulse.init(SEED);
  const customers = generateDataset(SEED).customers;

  const net = { hubDown: false, toHub: 0 };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === PULSE && url.pathname === "/.well-known/apc.json") return pulseWorker.fetch(request, { APC_V2: "1", APC_PROFILES: "direct,dock" });
    if (url.origin === PULSE && url.pathname.startsWith("/mcp/")) return pulse.fetch(request);
    if (url.origin === PULSE && url.pathname === "/apc/revoke") {
      const secret = new URL(((await request.json()) as { mcp_url: string }).mcp_url).pathname.split("/").at(-1);
      const r = await pulse.revokeHubGrant(secret);
      return Response.json(r, { status: r.ok ? 200 : 404 });
    }
    if (url.origin === DOCK) {
      net.toHub++;
      if (net.hubDown) throw new TypeError("fetch failed: the hub is down");
      const body = await request.json();
      if (url.pathname === "/apc/pair") return Response.json(await hub.pair(body));
      if (url.pathname === "/apc/confirm") return Response.json(await hub.confirm(body));
    }
    throw new TypeError(`no network in this test: ${url}`);
  });

  const agent = async () => (await hub.state(DOCK)).agents[0];
  const first = await agent();

  /** The agent's call through the hub's MCP endpoint, as its client sends it. */
  const callHub = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await hub.fetch(
      new Request(`${DOCK}${new URL(first.mcp_url).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    return (await response.json()).result;
  };

  /** The person drops the agent from the dock on a customer in Pulse and says yes in Pulse; then yes in the dock. */
  const dropAndAllow = async (customer: string) => {
    const { ticket } = await hub.ticket(first.id);
    const paired = await pulse.pairHub(SID, PULSE, { hub: DOCK, agent: first.id, ticket, target: { kind: "customer", id: customer } });
    assert.equal(paired.ok, true, `pairing: ${paired.error}`);
    assert.equal(paired.status, "pending", "the dock still has to say yes");
    const pending = (await agent()).pairings.find((p: { status: string }) => p.status === "pending");
    assert.equal((await hub.decide(pending.id, "approve")).ok, true);
    return paired.grant_id as string;
  };

  return { hub, pulse, pulseRoom, net, agent, callHub, dropAndAllow, customers };
}

test("a dock agent revoked in Pulse cannot read Pulse, even with the hub down, and the dock says Pulse revoked it", async (t) => {
  const { hub, pulse, net, agent, callHub, dropAndAllow, customers } = await world(t);
  const grantId = await dropAndAllow(customers[0]!.id);

  // Paired: the agent reads Pulse through the hub.
  const view = await callHub("get_current_view");
  assert.equal(view.structuredContent.focus.id, customers[0]!.id);
  assert.equal((await callHub("call_app_tool", { app: "pulse", tool: "list_customers", args: { limit: 1 } })).isError, undefined);
  const grantUrl = ((await hub.ctx.storage.sql.exec("select mcp_url from pairings").toArray()) as Array<{ mcp_url: string }>)[0]!.mcp_url;

  // The hub goes down; the person revokes the agent in Pulse's agent bar. Pulse calls nobody.
  net.hubDown = true;
  const calledBefore = net.toHub;
  assert.deepEqual(await pulse.revokeGrant(grantId), { ok: true });
  assert.equal(net.toHub, calledBefore, "revoking in the app makes no call to the hub");

  // Whoever holds the grant's URL (the hub, or anything that copied it) gets 403 "revoked", whatever it asks.
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_current_view", arguments: {} } },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_customer", arguments: { id: customers[0]!.id } } },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  ]) {
    const response = await fetch(grantUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    assert.equal(response.status, 403);
    const answer = (await response.json()) as { error: string; revoked_by: string };
    assert.deepEqual([answer.error, answer.revoked_by], ["revoked", "pulse.test"]);
    assert.equal(JSON.stringify(answer).includes(customers[0]!.id), false, "no data of Pulse's");
  }
  assert.equal((await pulse.state()).hub_links.length, 0, "Pulse dropped its link to the dock");

  // The hub's next call to Pulse learns it: the pairing is revoked, and what the hub kept from Pulse goes.
  net.hubDown = false;
  const after = await callHub("get_current_view");
  assert.equal(after.structuredContent.focus, null, "the pin the hub took from Pulse is gone");
  assert.deepEqual(after.structuredContent.views, [], "and so is Pulse's view");
  const pairing = (await agent()).pairings.find((p: { app: { id: string } }) => p.app.id === "pulse");
  assert.equal(pairing.status, "revoked");
  assert.equal(pairing.revoked_by, "pulse.test", "the dock shows: Revoked by pulse.test");
  assert.equal(typeof pairing.revoked_at, "string");
  const relayed = await callHub("call_app_tool", { app: "pulse", tool: "list_customers", args: {} });
  assert.equal(relayed.isError, true);
  assert.match(relayed.content[0].text, /"error":"revoked"/);
  const listed = await callHub("list_app_tools");
  assert.deepEqual(listed.structuredContent.apps, [], "Pulse's tools are no longer offered");
  const stored = JSON.stringify(await hub.ctx.storage.sql.exec("select view, tools, page_open from pairings").toArray());
  assert.equal(stored.includes(customers[0]!.id), false, "the hub keeps nothing it read from Pulse");
});

test("a revoked grant never comes back by itself: the next drop asks the person again, in Pulse and in the dock", async (t) => {
  const { hub, pulse, agent, callHub, dropAndAllow, customers } = await world(t);
  const grantId = await dropAndAllow(customers[0]!.id);
  await callHub("get_current_view");
  await pulse.revokeGrant(grantId);
  await callHub("get_current_view");
  assert.equal((await agent()).pairings[0].status, "revoked");

  // The page sees no link to this dock agent any more, so a drop goes to consent (Pulse's own Allow),
  // then to the dock's Allow: dropAndAllow checks the pairing comes back pending, not paired.
  assert.equal((await pulse.state()).hub_links.length, 0);
  const again = await dropAndAllow(customers[1]!.id);
  assert.notEqual(again, grantId, "a new grant, with a new URL");
  const pairings = (await agent()).pairings;
  assert.deepEqual(pairings.map((p: { status: string; app: { id: string } }) => [p.app.id, p.status]), [["pulse", "paired"]], "the new pairing replaces the revoked line and keeps the app's id");
  const view = await callHub("get_current_view");
  assert.equal(view.structuredContent.focus.id, customers[1]!.id);

  // Removing a revoked line in the dock gives nothing back to Pulse: the grant is gone there already.
  await pulse.revokeGrant(again);
  await callHub("get_current_view");
  const revoked = (await agent()).pairings[0];
  assert.equal((await hub.decide(revoked.id, "unpair")).ok, true);
  assert.deepEqual((await agent()).pairings, []);
});

test("the hub never confirms a revoked pairing on a drop", async (t) => {
  const { hub, pulse, agent, callHub, dropAndAllow, customers } = await world(t);
  const grantId = await dropAndAllow(customers[0]!.id);
  const mcp_url = ((await hub.ctx.storage.sql.exec("select mcp_url from pairings").toArray()) as Array<{ mcp_url: string }>)[0]!.mcp_url;
  await pulse.revokeGrant(grantId);
  await callHub("get_current_view");
  assert.equal((await agent()).pairings[0].status, "revoked");
  const { ticket } = await hub.ticket((await agent()).id);
  assert.deepEqual(await hub.confirm({ ticket, agent: (await agent()).id, mcp_url }), { ok: false, error: "not_paired" });
});

test("a wait through the hub that is running when the person revokes in Pulse ends, and the hub marks the pairing revoked", async (t) => {
  const { pulse, pulseRoom, agent, callHub, dropAndAllow, customers } = await world(t);
  const grantId = await dropAndAllow(customers[0]!.id);
  await callHub("get_current_view");
  pulseRoom.openPage();
  const started = Date.now();
  const waiting = callHub("wait_for_focus", { timeout_s: 20 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await pulse.revokeGrant(grantId);
  const result = await waiting;
  assert.ok(Date.now() - started < 10_000, "it ended soon after the revoke, not at the timeout");
  assert.equal(result.structuredContent.focus, null);
  assert.equal((await agent()).pairings[0].status, "revoked");
});

test("a pin the hub took before the revoke is not handed over by a later wait", async (t) => {
  const { pulse, agent, callHub, dropAndAllow, customers } = await world(t);
  const grantId = await dropAndAllow(customers[0]!.id);
  // The hub takes the pin on a relayed call (it rides as attention), and the agent has not read it yet.
  const relayed = await callHub("call_app_tool", { app: "pulse", tool: "list_customers", args: { limit: 1 } });
  assert.equal(relayed.structuredContent.attention.focus.id, customers[0]!.id);
  assert.equal((await agent()).focus.seen, false);
  await pulse.revokeGrant(grantId);
  const waited = await callHub("wait_for_focus", { timeout_s: 1 });
  assert.equal(waited.structuredContent.focus, null);
  assert.equal(JSON.stringify(waited).includes(customers[0]!.id), false);
  assert.equal((await agent()).pairings[0].status, "revoked");
  assert.equal((await agent()).focus, null);
});
