/**
 * Pulse on the Dock profile as built (APC 0.10, TIN-892): the shared checks of dock-lifecycle.ts on Pulse's real
 * sandbox and Worker, and what is Pulse's alone (a region's grant, its event log, the state Pulse for Windows reads).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { demoDataset } from "../src/model/demo-world.ts";
import { dockLifecycleTests, HUB, SID, type DockAppUnderTest } from "./dock-lifecycle.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const { hubAllowlist, ownerRequestRefusal, publicOrigin, dockStateNow, DOCK_TIMES } = await import(new URL("../src/worker/dock-app.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const customers = demoDataset().customers;
type State = { grants: Array<{ id: string; secret: string; pin: { id: string | null } | null }>; hub_links: Array<{ grant_id: string; state?: string; pairing?: { code: string; expires_at: string } | null }> };

const pulse: DockAppUnderTest = {
  name: "Pulse",
  origin: ORIGIN,
  cookie: "apc_session",
  binding: "SANDBOX",
  env: DEPLOY,
  create: (ctx, env) => new Sandbox(ctx, env),
  worker,
  targets: [
    { kind: "customer", id: customers[0]!.id, part: null, params: null },
    { kind: "customer", id: customers[1]!.id, part: null, params: null },
  ],
  probe: { tool: "list_customers", args: { limit: 1 } },
  row: { table: "hub_links", id: "grant_id" },
  link: (state, grantId) => (state as unknown as State).hub_links.find((l) => l.grant_id === grantId),
  pinned: (state, grantId) => (state as unknown as State).grants.find((g) => g.id === grantId)?.pin?.id ?? null,
  grantIds: (state) => (state as unknown as State).grants.map((g) => g.id),
  direct: async (object) => {
    const g = await (object as unknown as { addAgentGrant(): Promise<{ id: string; secret: string }> }).addAgentGrant();
    return { id: g.id, secret: g.secret };
  },
};

dockLifecycleTests(pulse);

test("Pulse: the page's state never carries a dock grant's secret, and still carries a Direct agent's", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" }));
  const sandbox = new Sandbox(durableObjectRoom().ctx, DEPLOY);
  await sandbox.init();
  const direct = await sandbox.addAgentGrant();
  const drop = { hub: HUB, agent: "ag_1", ticket: `${"d".repeat(32)}.${"1".repeat(16)}`, target: pulse.targets[0], region: "latam" };
  const asked = await sandbox.pairHub(SID, ORIGIN, drop);
  const paired = await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
  assert.equal(paired.ok, true, paired.error);
  const state = (await sandbox.state()) as State;
  assert.equal(state.grants.find((g) => g.id === paired.grant_id)!.secret, "");
  assert.match(state.grants.find((g) => g.id === direct.id)!.secret, /^[0-9a-f]{32}$/);
  // What Pulse for Windows reads (apps/desktop/Model.cs, HubLink): hub, agent, grant_id and the pairing to show.
  const link = state.hub_links.find((l) => l.grant_id === paired.grant_id)! as Record<string, unknown>;
  assert.deepEqual(Object.keys(link).sort(), ["agent", "grant_id", "hub", "pairing", "state"]);
  // The log says what happened to the grant, never its code or its secret.
  const log = await sandbox.eventsJsonl();
  assert.match(log, /"type":"hub_paired"/);
  assert.equal(log.includes(asked.pairing_code), false);
});

test("the Dock configuration: the allowlist keeps only bare https origins, and the public origin is never read from a request", () => {
  assert.deepEqual(hubAllowlist({ HUB_ORIGINS: " https://apc.tineira.com , http://dock.test,https://dock.test/x,dock.test,https://Dock.test,https://dock.test:8443,https://apc.tineira.com" }), { hubs: ["https://apc.tineira.com", "https://dock.test:8443"], localDevHubs: [] });
  assert.deepEqual(hubAllowlist({}).hubs, []);
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "https://pulse.apc.tineira.com" }, "https://evil.test/api/session"), "https://pulse.apc.tineira.com");
  assert.equal(publicOrigin({}, "https://pulse.apc.tineira.com/api/session"), null, "not derived from the request");
  assert.equal(publicOrigin({}, "http://localhost:5199/api/session"), null, "nor from a loopback one, outside vite dev");
  for (const bad of ["pulse.apc.tineira.com", "https://pulse.apc.tineira.com/", "https://pulse.apc.tineira.com/app", "ftp://pulse.test", ""]) assert.equal(publicOrigin({ PUBLIC_ORIGIN: bad }), null, bad);
  const request = (headers: Record<string, string>, method = "POST") => new Request(`${ORIGIN}/api/x`, { method, headers });
  assert.equal(ownerRequestRefusal(request({ "content-type": "application/json" }), ORIGIN), null);
  assert.equal(ownerRequestRefusal(request({ "content-type": "application/json", origin: ORIGIN }), null), "origin_not_allowed");
  assert.equal(ownerRequestRefusal(request({ "content-type": "application/json", "sec-fetch-site": "Same-Site" }), ORIGIN), "cross_site_request");
  assert.equal(ownerRequestRefusal(request({ "content-type": "APPLICATION/JSON ; charset=utf-8" }), ORIGIN), null);
  assert.equal(ownerRequestRefusal(request({ "content-type": "application/jsonp" }), ORIGIN), "json_required");
  assert.equal(ownerRequestRefusal(request({}, "GET"), ORIGIN), null, "a GET needs no media type");
});

test("a dock grant's state from its stored state and times: T_ack and T_connect are the standard's most, and inclusive", () => {
  assert.equal(DOCK_TIMES.ackMs, 30_000);
  assert.equal(DOCK_TIMES.connectMs, 600_000);
  const now = 1_000_000_000;
  assert.equal(dockStateNow({ state: "in_flight", allowed_at: now - 29_999, acked_at: null }, now), "in_flight");
  assert.equal(dockStateNow({ state: "in_flight", allowed_at: now - 30_000, acked_at: null }, now), "ended");
  assert.equal(dockStateNow({ state: "in_flight", allowed_at: null, acked_at: null }, now), "ended", "a row with no time is overdue");
  assert.equal(dockStateNow({ state: "handoff", allowed_at: now - 700_000, acked_at: now - 599_999 }, now), "handoff");
  assert.equal(dockStateNow({ state: "handoff", allowed_at: now - 700_000, acked_at: now - 600_000 }, now), "ended");
  assert.equal(dockStateNow({ state: "live", allowed_at: 0, acked_at: 0 }, now), "live", "a live grant has no time limit here (no dormancy)");
  assert.equal(dockStateNow({ state: null, allowed_at: null, acked_at: null }, now), "live", "a grant from before 0.10");
});

const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" };
const rpc = (object: { fetch(request: Request): Promise<Response> }, url: string, message: unknown) =>
  object.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(message) }));
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: "Agent via dock", version: "0.10.0" } } };
const CALL = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_customers", arguments: { limit: 1 } } };

test("Pulse: a link from before APC 0.10 that still waits for its code is in handoff after the upgrade, never live: no data before the hub's initialize", async (t) => {
  let sent: { mcp_url?: string } = {};
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent = (await (input instanceof Request ? input : new Request(input, init)).json()) as { mcp_url?: string };
    return Response.json(ACK);
  });
  const room = durableObjectRoom();
  const before = new Sandbox(room.ctx, DEPLOY);
  await before.init();
  const drop = { hub: HUB, agent: "ag_old", ticket: `${"d".repeat(32)}.${"2".repeat(16)}`, target: pulse.targets[0] };
  const asked = await before.pairHub(SID, ORIGIN, drop);
  const paired = await before.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
  assert.equal(paired.ok, true, paired.error);
  // As Pulse 0.9 stored it: the code and its expiry, and none of the 0.10 columns.
  room.db.prepare("update hub_links set state = null, secret_hash = null, allowed_at = null, acked_at = null where grant_id = ?").run(paired.grant_id);
  const started = Date.now();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  const row = room.db.prepare("select state, acked_at, pairing_code from hub_links where grant_id = ?").get(paired.grant_id) as { state: string; acked_at: number; pairing_code: string };
  assert.equal(row.state, "handoff");
  assert.ok(row.acked_at >= started && row.acked_at <= Date.now(), "T_connect runs from the upgrade");
  assert.equal(row.pairing_code, asked.pairing_code);
  const link = ((await sandbox.state()) as State).hub_links.find((l) => l.grant_id === paired.grant_id)!;
  assert.equal(link.state, "handoff");
  assert.equal(link.pairing?.code, asked.pairing_code, "the waiting card is still shown");
  const gated = (await (await rpc(sandbox, sent.mcp_url!, CALL)).json()) as { result: { isError?: boolean; structuredContent?: { error?: string } } };
  assert.equal(gated.result.isError, true);
  assert.equal(gated.result.structuredContent?.error, "pairing");
  // The hub connects: only then does it serve.
  assert.equal((await rpc(sandbox, sent.mcp_url!, INIT)).status, 200);
  const served = (await (await rpc(sandbox, sent.mcp_url!, CALL)).json()) as { result: { isError?: boolean } };
  assert.equal(served.result.isError ?? false, false);
  // A link from before with no code was connected by its hub: it stays live.
  room.db.prepare("update hub_links set state = null where grant_id = ?").run(paired.grant_id);
  const again = new Sandbox(room.ctx, DEPLOY);
  assert.equal(((await again.state()) as State).hub_links.find((l) => l.grant_id === paired.grant_id)!.state, "live");
});

test("Pulse: an Allow whose second write fails leaves no grant, and a dock grant without its link is never served as a Direct one", async (t) => {
  let hubCalls = 0;
  let sent: { mcp_url?: string } = {};
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    hubCalls++;
    sent = (await (input instanceof Request ? input : new Request(input, init)).json()) as { mcp_url?: string };
    return Response.json(ACK);
  });
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  await sandbox.init();
  const sql = (room.ctx as { storage: { sql: { exec: (query: string, ...params: unknown[]) => unknown } } }).storage.sql;
  const exec = sql.exec.bind(sql);
  // The link's insert fails; so does the delete that would take the grant back (the storage is failing).
  let failing = true;
  sql.exec = (query: string, ...params: unknown[]) => {
    if (failing && (/^\s*insert into hub_links/i.test(query) || /^\s*delete from grants/i.test(query))) throw new Error("storage: the write could not be saved");
    return exec(query, ...params);
  };
  const drop = { hub: HUB, agent: "ag_torn", ticket: `${"d".repeat(32)}.${"3".repeat(16)}`, target: pulse.targets[0] };
  const asked = await sandbox.pairHub(SID, ORIGIN, drop);
  await assert.rejects(sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }), /storage/);
  assert.equal(hubCalls, 0, "the hub never heard of it");
  failing = false;
  // The grant's own row is there (the worst case), marked as a dock's, with no link.
  const orphan = room.db.prepare("select id, secret, dock from grants where dock = 1").get() as { id: string; secret: string; dock: number } | undefined;
  assert.ok(orphan, "the fault left the grant's row");
  assert.equal(room.db.prepare("select count(*) as n from hub_links").get()!.n, 0);
  // Its URL serves nothing: 404 to initialize and to a call, and the row is gone.
  const url = `${ORIGIN}/mcp/${SID}/${orphan.secret}`;
  assert.equal((await rpc(sandbox, url, INIT)).status, 404);
  assert.equal((await rpc(sandbox, url, CALL)).status, 404);
  assert.equal(room.db.prepare("select count(*) as n from grants where dock = 1").get()!.n, 0);
  assert.equal(((await sandbox.state()) as State).grants.some((g) => g.id === orphan.id), false);
  // With the storage well but for the link's insert, the grant is taken back at once, and the next Allow pairs.
  let once = true;
  sql.exec = (query: string, ...params: unknown[]) => {
    if (once && /^\s*insert into hub_links/i.test(query)) {
      once = false;
      throw new Error("storage: the write could not be saved");
    }
    return exec(query, ...params);
  };
  const second = { ...drop, agent: "ag_torn2", ticket: `${"d".repeat(32)}.${"4".repeat(16)}` };
  const asked2 = await sandbox.pairHub(SID, ORIGIN, second);
  await assert.rejects(sandbox.pairHub(SID, ORIGIN, { ...second, consent: asked2.consent }), /storage/);
  assert.equal(room.db.prepare("select count(*) as n from grants").get()!.n, 0);
  const third = { ...second, ticket: `${"d".repeat(32)}.${"5".repeat(16)}` };
  const asked3 = await sandbox.pairHub(SID, ORIGIN, third);
  const paired = await sandbox.pairHub(SID, ORIGIN, { ...third, consent: asked3.consent });
  assert.equal(paired.ok, true, paired.error);
  assert.equal(room.db.prepare("select dock from grants where id = ?").get(paired.grant_id)!.dock, 1);
  assert.match(String(sent.mcp_url), /^https:\/\/pulse\.test\/mcp\//);
});
