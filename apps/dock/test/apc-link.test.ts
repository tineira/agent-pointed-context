/**
 * apc_link (APC 0.4, TIN-578), end to end in one process: the real hub (hub.ts) and the real Pulse
 * sandbox (apps/demo) with both profiles, each on Node's SQLite, with fetch routed between them by
 * origin. One agent (MCP client "claude-code") reaches Pulse directly and through the dock; Pulse
 * offers a code on the new connection, the agent sends it back on the other one, and Pulse's agent
 * bar shows one agent. Both directions: the code relayed by the hub, and the code sent through it.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { generateDataset } from "../../demo/src/model/seed.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { Sandbox } = await import(new URL("../../demo/src/worker/sandbox.ts", import.meta.url).href);

const DOCK = "https://dock.test";
const PULSE = "https://pulse.test";
const DID = "c".repeat(32);
const SID = "d".repeat(32);
const SEED = 91;
const CLIENT = { name: "claude-code", version: "2.1.0" };

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };

async function rpc(fetcher: (r: Request) => Promise<Response>, url: string, method: string, params: Record<string, unknown>): Promise<Result> {
  const response = await fetcher(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
  return ((await response.json()) as { result: Result }).result;
}

async function world(t: TestContext) {
  const hub = new Hub(durableObjectRoom().ctx, { APP_ORIGINS: PULSE });
  await hub.init(DID);
  const pulse = new Sandbox(durableObjectRoom().ctx, { APC_V2: "1", HUB_ORIGINS: DOCK, APC_PROFILES: "direct,dock" });
  await pulse.init(SEED);
  const customers = generateDataset(SEED).customers;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === PULSE && url.pathname.startsWith("/mcp/")) return pulse.fetch(request);
    if (url.origin === DOCK && url.pathname === "/apc/pair") return Response.json(await hub.pair(await request.json()));
    if (url.origin === DOCK && url.pathname === "/apc/confirm") return Response.json(await hub.confirm(await request.json()));
    throw new TypeError(`no network in this test: ${url}`);
  });

  const agent = (await hub.state(DOCK)).agents[0];
  const hubUrl = `${DOCK}${new URL(agent.mcp_url).pathname}`;
  // The agent connects to its dock: the hub learns its MCP client.
  await rpc((r) => hub.fetch(r), hubUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT });
  const callHub = (name: string, args: Record<string, unknown> = {}) => rpc((r) => hub.fetch(r), hubUrl, "tools/call", { name, arguments: args });

  // The person makes an agent in Pulse (Direct) and puts its URL in the same agent.
  const direct = await pulse.addAgentGrant();
  const directUrl = `${PULSE}/mcp/${SID}/${direct.secret}`;
  const callDirect = (name: string, args: Record<string, unknown> = {}) => rpc((r) => pulse.fetch(r), directUrl, "tools/call", { name, arguments: args });
  const connectDirect = () => rpc((r) => pulse.fetch(r), directUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT });

  /** The person drops the agent from the dock on Pulse and says yes in Pulse, then in the dock: the hub introduces it. */
  const dropAndAllow = async () => {
    const { ticket } = await hub.ticket(agent.id);
    const paired = await pulse.pairHub(SID, PULSE, { hub: DOCK, agent: agent.id, ticket, target: { kind: "customer", id: customers[0]!.id } });
    assert.equal(paired.ok, true, `pairing: ${paired.error}`);
    const pending = (await hub.state(DOCK)).agents[0].pairings.find((p: { status: string }) => p.status === "pending");
    assert.equal((await hub.decide(pending.id, "approve")).ok, true);
    return paired.grant_id as string;
  };
  return { hub, pulse, customers, direct, directUrl, callHub, callDirect, connectDirect, dropAndAllow };
}

test("connected directly first, then through the dock: the code rides through the hub and goes back directly", async (t) => {
  const { pulse, direct, callHub, callDirect, connectDirect, dropAndAllow } = await world(t);
  await connectDirect();
  assert.equal((await callDirect("list_customers", { limit: 1 })).structuredContent?.apc_link, undefined, "nothing on the other path yet");

  const dockGrant = await dropAndAllow();
  // The hub's own merged results drop nothing of it: the offer waits for one of Pulse's own tools.
  await callHub("get_current_view");
  const relayed = await callHub("pulse__list_customers", { limit: 1 });
  const offer = relayed.structuredContent?.apc_link as { code: string; expires_in: number; note: string };
  assert.ok(offer, "the relayed result carries Pulse's offer");
  assert.equal(offer.expires_in, 120);
  assert.match(offer.note, /on your direct connection to Pulse/);
  assert.equal((await callHub("pulse__list_customers", { limit: 1 })).structuredContent?.apc_link, undefined, "once per session");

  const done = await callDirect("apc_link", { code: offer.code });
  assert.equal(done.isError, undefined, JSON.stringify(done));
  assert.equal(done.structuredContent?.linked, true);
  assert.deepEqual((await pulse.state()).links, [[direct.id, dockGrant]], "Pulse's bar shows one agent with both paths");

  // Linking grants nothing: each path still reads with its own grant.
  assert.equal((await callDirect("get_current_view")).isError, undefined);
  assert.equal((await callHub("pulse__list_customers", { limit: 1 })).isError, undefined);

  // Revoke on the linked agent cuts both: the direct URL and the dock's.
  assert.deepEqual(await pulse.revokeGrant(direct.id), { ok: true });
  const response = await pulse.fetch(new Request(`${PULSE}/mcp/${SID}/${direct.secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
  const viaDock = await callHub("pulse__list_customers", { limit: 1 });
  assert.equal(viaDock.isError, true);
  assert.match(viaDock.content[0]!.text, /revoked/);
});

test("through the dock first, then directly: the code comes on the direct connection and goes back through the hub", async (t) => {
  const { pulse, direct, callHub, callDirect, connectDirect, dropAndAllow } = await world(t);
  const dockGrant = await dropAndAllow();
  // The dock's connection came first and nothing was on the other path: it is asked nothing.
  assert.equal((await callHub("pulse__list_customers", { limit: 1 })).structuredContent?.apc_link, undefined);

  await connectDirect();
  const offer = (await callDirect("get_current_view")).structuredContent?.apc_link as { code: string; note: string };
  assert.ok(offer, "on Direct the offer rides on any result");
  assert.match(offer.note, /through your agent dock/);
  // Sent back on the same path (directly) it is refused; through the hub it links.
  const wrong = await callDirect("apc_link", { code: offer.code });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]!.text, /"reason":"same_connection"/);
  const done = await callHub("pulse__apc_link", { code: offer.code });
  assert.equal(done.isError, undefined, JSON.stringify(done));
  assert.deepEqual((await pulse.state()).links, [[direct.id, dockGrant]]);

  // The person unlinks: two agents again, both still reading.
  assert.deepEqual(await pulse.unlinkGrant(dockGrant), { ok: true });
  assert.deepEqual((await pulse.state()).links, []);
  assert.equal((await callDirect("get_current_view")).isError, undefined);
  assert.equal((await callHub("pulse__list_customers", { limit: 1 })).isError, undefined);
});
