import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CONNECT_REQUEST_TTL_MS, decodeApcConnect, TICKET_TTL_MS } from "@tineira/apc-protocol";
import { fakeApp, manifestOf, PULSE, world, type Json } from "./hostile-world.ts";

const DOCK = "https://dock.test";
const SHOP = "https://shop.example";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT = `chrome-extension://${"b".repeat(32)}`;
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

async function setup(t: TestContext, env: Json = {}) {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP}/#name=Shop`, READER_ORIGINS: `${EXT},${OTHER_EXT}`, PAIRING_CODE: "required", ...env });
  const owner = String(w.hubRoom.db.prepare("select secret from devices").get()!.secret);
  const agent = (await w.agent()).id as string;
  const app = (origin: string) => {
    const a = fakeApp(origin, "Store", { apcJson: () => Response.json(manifestOf(origin, "Store", { standard: "0.13.0", dock_connect: origin + "/connect/dock" })) });
    w.apps.set(origin, a);
    return a;
  };
  app(SHOP);
  const ask = async (origin = SHOP, who = agent) => {
    const { ticket } = await w.hub.ticket(who);
    return w.hub.requestConnect({ ticket, agent: who, app: { origin } });
  };
  const approve = (id: string, action?: string) => w.hub.asOwner(owner, "approveConnect", [id, action, DOCK]);
  const request = async () => (await w.state()).connects[0];
  const connectTicket = async (origin = SHOP, action?: string) => {
    assert.equal((await ask(origin)).ok, true);
    const approved = await approve((await request()).id, action);
    assert.ok(approved.ok && "url" in approved);
    const fragment = decodeApcConnect(new URL(approved.url).hash);
    assert.ok(fragment);
    return fragment.ticket;
  };
  const pair = (ticket: string, origin = SHOP, who = agent) => w.hub.pair({ ticket, agent: who, app: { origin, name: "Store" }, mcp_url: `${origin}/mcp/${"c".repeat(32)}`, pairing_code: "K7M4P2" });
  return { ...w, owner, agentId: agent, app, ask, approve, request, connectTicket, pair };
}

test("a drop never pairs; only owner approve returns an origin/agent-bound connect ticket, once", async (t) => {
  const w = await setup(t);
  const { ticket } = await w.hub.ticket(w.agentId);
  assert.deepEqual(await w.pair(ticket), { ok: false, error: "ticket_not_for_pairing" });
  assert.deepEqual(await w.hub.requestConnect({ ticket, agent: w.agentId, app: { origin: SHOP } }), { ok: true, status: "connect_requested" });
  const r = await w.request();
  const state = await w.state();
  assert.equal(r.kind, "app");
  assert.equal(r.name, "Shop");
  assert.equal(r.expires_at > Date.now() && r.expires_at <= Date.now() + CONNECT_REQUEST_TTL_MS, true);
  assert.deepEqual(state.apps.find((a: Json) => a.origin === PULSE), { origin: PULSE, name: "pulse.test" });
  assert.deepEqual(state.apps.find((a: Json) => a.origin === SHOP), { origin: SHOP, name: "Shop" });
  assert.deepEqual(await w.hub.asOwner(w.owner, "denyConnect", ["missing"]), { ok: false, error: "not_found" });
  const answers = await Promise.all([w.approve(r.id), w.approve(r.id)]);
  assert.equal(answers.filter((a) => a.ok).length, 1);
  assert.deepEqual(answers.find((a) => !a.ok), { ok: false, error: "not_found" });
  const yes = answers.find((a) => a.ok)!;
  assert.ok("url" in yes);
  const url = new URL(yes.url);
  assert.equal(url.origin, SHOP);
  assert.equal(url.pathname, "/connect/dock");
  assert.equal(url.search, "");
  const fragment = decodeApcConnect(url.hash)!;
  assert.ok(fragment);
  assert.equal(JSON.stringify(await w.state()).includes(fragment.ticket), false, "state never exposes the ticket");
  assert.deepEqual(await w.pair(fragment.ticket, "https://other.example"), { ok: false, error: "ticket_origin_mismatch" });
  assert.deepEqual(await w.pair(fragment.ticket, SHOP, "ag_other"), { ok: false, error: "ticket_origin_mismatch" });
  assert.deepEqual(await w.hub.requestConnect({ ticket: fragment.ticket, agent: w.agentId, app: { origin: SHOP } }), { ok: false, error: "ticket_not_for_pairing" });
  assert.deepEqual(await w.hub.confirm({ ticket: fragment.ticket, agent: w.agentId, mcp_url: SHOP + "/mcp/x" }), { ok: false, error: "ticket_not_for_pairing" });
  assert.equal((await w.pair(fragment.ticket)).ok, true);
  assert.deepEqual(await w.pair(fragment.ticket), { ok: false, error: "ticket_expired" });
});

test("validation order never fetches or spends before body, ticket, limits and origin pass; fetch completion rechecks single use", async (t) => {
  const w = await setup(t, { BLOCKED_APPS: "blocked.example" });
  const { ticket } = await w.hub.ticket(w.agentId);
  for (const body of [
    { ticket, agent: w.agentId, app: { origin: SHOP + "/path" } },
    { ticket, agent: "ag_missing", app: { origin: SHOP } },
    { ticket, agent: w.agentId, reader: true },
    { ticket, agent: w.agentId, app: { origin: "https://blocked.example" } },
  ]) assert.equal((await w.hub.requestConnect(body)).ok, false);
  assert.equal(w.hits.size, 0, "no fetch before all local guards");
  assert.ok(w.hubRoom.db.prepare("select 1 from tickets where ticket = ?").get(ticket));
  const a = w.app("https://slow.example");
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const hold = new Promise<void>((r) => { release = r; });
  a.apcJson = async () => { entered(); await hold; return Response.json(manifestOf(a.origin, a.name, { dock_connect: a.origin + "/connect" })); };
  const body = { ticket, agent: w.agentId, app: { origin: a.origin } };
  const one = w.hub.requestConnect(body);
  const two = w.hub.requestConnect(body);
  await waiting;
  release();
  const answers = await Promise.all([one, two]);
  assert.equal(answers.filter((a) => a.ok).length, 1);
  assert.equal((await w.state()).connects.length, 1);
});

test("per-agent origins, replacement, per-dock cap and request/ticket expiry are enforced without spending refused drops", async (t) => {
  const w = await setup(t);
  const origins = ["https://one.example", "https://two.example", "https://three.example", "https://four.example"];
  for (const origin of origins) w.app(origin);
  for (const origin of origins.slice(0, 3)) assert.equal((await w.ask(origin)).ok, true);
  const first = (await w.state()).connects.find((r: Json) => r.origin === origins[0])!.id;
  assert.equal((await w.ask(origins[0])).ok, true);
  assert.equal((await w.state()).connects.length, 3);
  assert.equal((await w.state()).connects.some((r: Json) => r.id === first), false);
  const { ticket } = await w.hub.ticket(w.agentId);
  assert.deepEqual(await w.hub.requestConnect({ ticket, agent: w.agentId, app: { origin: origins[3] } }), { ok: false, error: "too_many_requests" });
  assert.ok(w.hubRoom.db.prepare("select 1 from tickets where ticket = ?").get(ticket));
  for (let i = 0; i < 6; i++) {
    const who = (await w.hub.addAgent()).id;
    for (const origin of origins.slice(0, i === 5 ? 2 : 3)) assert.equal((await w.ask(origin, who)).ok, true);
  }
  assert.equal((await w.state()).connects.length, 20);
  assert.deepEqual(await w.ask(origins[2], (await w.state()).agents.at(-1).id), { ok: false, error: "too_many_requests" });
  w.hubRoom.db.prepare("update connect_requests set expires_at = 0").run();
  assert.equal((await w.state()).connects.length, 0);
  assert.deepEqual(await w.approve(first), { ok: false, error: "not_found" });
  const ct = await w.connectTicket();
  const row = w.hubRoom.db.prepare("select expires_at from connect_tickets where ticket = ?").get(ct)!;
  assert.ok(Number(row.expires_at) > Date.now() && Number(row.expires_at) <= Date.now() + TICKET_TTL_MS);
  w.hubRoom.db.prepare("update connect_tickets set expires_at = 0").run();
  assert.deepEqual(await w.pair(ct), { ok: false, error: "ticket_expired" });
  await w.hub.alarm();
  assert.equal(w.hubRoom.db.prepare("select count(*) n from connect_tickets").get()!.n, 0);
});

test("reader claim/check waits for Connect, pairs without a ticket, replaces earlier readers, and hands a token only once to its origin", async (t) => {
  const w = await setup(t);
  const ask = async () => {
    const { ticket } = await w.hub.ticket(w.agentId);
    return w.hub.requestConnect({ ticket, agent: w.agentId, reader: true, label: "Chrome" }, EXT);
  };
  const one = await ask();
  assert.ok(one.ok && "claim" in one);
  assert.match(one.claim!, /^[a-f0-9]{32}\.[a-f0-9]{32}$/);
  assert.match(one.check!, /^\d{4}$/);
  assert.equal((await w.request()).check, one.check);
  assert.equal(JSON.stringify(await w.state()).includes(one.claim!), false);
  assert.deepEqual(await w.hub.readerStatus({ claim: one.claim }, EXT), { ok: true, status: "pending" });
  assert.deepEqual(await w.hub.readerStatus({ claim: one.claim }, OTHER_EXT), { ok: true, status: "denied" });
  await ask(); await ask();
  assert.deepEqual(await ask(), { ok: false, error: "too_many_requests" });
  const r = await w.request();
  assert.deepEqual(await w.approve(r.id), { ok: true });
  assert.equal((await w.state()).connects.length, 0);
  assert.equal(w.hubRoom.db.prepare("select count(*) n from connect_tickets").get()!.n, 0);
  const paired = await w.hub.readerStatus({ claim: one.claim }, EXT);
  assert.equal(paired.status, "paired");
  assert.match(paired.token!, /^[a-f0-9]{32}\.[a-f0-9]{32}$/);
  assert.equal(paired.agent, w.agentId);
  assert.deepEqual(await w.hub.readerStatus({ claim: one.claim }, EXT), { ok: true, status: "denied" });
  await ask();
  await w.approve((await w.request()).id);
  assert.equal(w.hubRoom.db.prepare("select count(*) n from readers").get()!.n, 1);
  assert.deepEqual(await w.hub.reader({}, EXT), { ok: false, error: "ticket_not_for_pairing" });
});

test("unverified Connect warns once; only code approval commits the domain approval; approve reruns the verdict without fetching", async (t) => {
  const w = await setup(t);
  const origin = "https://unverified.example";
  w.app(origin);
  assert.equal((await w.ask(origin)).ok, true);
  assert.deepEqual(await w.approve((await w.request()).id), { ok: false, error: "warning_required" });
  const ct = await w.connectTicket(origin, "approve_unverified");
  assert.equal(w.hubRoom.db.prepare("select count(*) n from unverified_ok").get()!.n, 0);
  const pair = await w.pair(ct, origin);
  assert.ok(pair.ok);
  assert.equal((await w.pairingOf(origin)).warning, false);
  assert.deepEqual(await w.hub.decide(pair.pairing_id!, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  assert.equal(w.hubRoom.db.prepare("select count(*) n from unverified_ok").get()!.n, 0);
  assert.deepEqual(await w.hub.decide(pair.pairing_id!, "approve", "K7M4P2"), { ok: true });
  assert.equal(w.hubRoom.db.prepare("select count(*) n from unverified_ok").get()!.n, 1);
  await w.ask(origin);
  await w.hub.denyConnect((await w.request()).id);
  assert.equal(w.hubRoom.db.prepare("select count(*) n from unverified_ok").get()!.n, 1);
  await w.ask(origin);
  const hits = w.hits.get(origin);
  w.hubEnv.UNVERIFIED_PAIRING = "closed";
  assert.deepEqual(await w.approve((await w.request()).id), { ok: false, error: "app_not_allowed" });
  assert.equal(w.hits.get(origin), hits, "approve has no outbound fetch");
});

test("owner-only routes reject missing or other cookies and cross-site approves, then double approval returns not_found", async (t) => {
  const w = await setup(t);
  const did = "a".repeat(32);
  const env = { ...w.hubEnv, HUB: { idFromName: (id: string) => id, get: () => w.hub } };
  const cookie = `apc_dock=${did}.${w.owner}`;
  const send = (path: string, body: unknown, headers: Record<string, string> = {}) => worker.request(DOCK + path, { method: "POST", headers: { "content-type": "application/json", cookie, origin: DOCK, ...headers }, body: JSON.stringify(body) }, env);
  const create = await send(`/api/d/${did}/connects`, { agent: w.agentId, host: SHOP });
  assert.equal(create.status, 200);
  const made = await create.json();
  const path = `/api/d/${did}/connects/${made.request.id}/approve`;
  const refusals: Array<[Record<string, string>, number]> = [[{ cookie: "" }, 403], [{ cookie: `apc_dock=${did}.${"f".repeat(32)}` }, 404], [{ origin: "https://evil.example" }, 403], [{ "sec-fetch-site": "same-site" }, 403], [{ "sec-fetch-site": "cross-site" }, 403]];
  for (const [headers, status] of refusals) assert.equal((await send(path, {}, headers)).status, status);
  assert.equal((await w.state()).connects.length, 1);
  assert.equal((await send(path, {})).status, 200);
  const twice = await send(path, {});
  assert.equal(twice.status, 400);
  assert.deepEqual(await twice.json(), { ok: false, error: "not_found" });
});

for (const operation of ["remove", "rotate", "reset"] as const) test(`${operation} purges connect requests and tickets`, async (t) => {
  const w = await setup(t);
  await w.connectTicket();
  await w.ask();
  if (operation === "remove") await w.hub.removeAgent(w.agentId);
  else if (operation === "reset") await w.hub.reset();
  else {
    const code = await w.hub.newLink();
    assert.ok(code.ok);
    const claim = await w.hub.askJoin(code.code, "Other computer");
    assert.ok(claim.ok);
    const join = (await w.state()).joins[0];
    await w.hub.decideJoin(join.id, "approve");
    await w.hub.joinStatus(claim.claim);
    const second = w.hubRoom.db.prepare("select id from devices where secret <> ?").get(w.owner)!;
    await w.hub.removeDevice(String(second.id), w.owner);
  }
  for (const table of ["connect_requests", "connect_tickets"]) assert.equal(w.hubRoom.db.prepare(`select count(*) n from ${table}`).get()!.n, 0, table);
});
