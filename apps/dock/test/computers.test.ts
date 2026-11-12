/**
 * Your dock on more than one computer (TIN-838): a computer links another with a code that works once and
 * for two minutes; the new computer joins only after a yes on a linked one, and gets its own secret; any
 * linked computer can remove another; a dock from before keeps opening with its old cookie. The real hub
 * and the real code directory on Node's SQLite, behind the real Worker, with one cookie jar per computer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { deviceLabel, formatJoinCode, JOIN_CODE_LENGTH, joinLink, newJoinCode, normalizeJoinCode } from "../src/worker/devices.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { JoinCodes } = await import(new URL("../src/worker/join-codes.ts", import.meta.url).href);
const { default: app } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

type Json = Record<string, any>;
const ORIGIN = "https://dock.test";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/156.0.0.0`;
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1; rv:140.0) Gecko/20100101 Firefox/140.0";

/** A Durable Object namespace of real objects, one per name, each on its own in-memory database. */
function namespace(make: (ctx: unknown) => any) {
  const objects = new Map<string, { object: any; room: ReturnType<typeof durableObjectRoom> }>();
  return {
    objects,
    idFromName: (name: string) => name,
    get(name: string) {
      if (!objects.has(name)) {
        const room = durableObjectRoom();
        objects.set(name, { object: make(room.ctx), room });
      }
      return objects.get(name)!.object;
    },
  };
}

function world() {
  const env: Json = { ASSETS: { fetch: async () => new Response("asset") } };
  env.HUB = namespace((ctx) => new Hub(ctx, env));
  env.JOIN_CODES = namespace((ctx) => new JoinCodes(ctx, env));
  return env;
}

/** One computer's browser: its own cookie jar, its user agent, on the dock's origin. */
function computer(env: Json, userAgent: string) {
  let cookie = "";
  const send = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r: Response = await app.request(
      `${ORIGIN}${path}`,
      body === undefined ? { headers: { cookie, "user-agent": userAgent, ...headers } } : { method: "POST", headers: { cookie, "user-agent": userAgent, "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) },
      env,
    );
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.replace(/^apc_dock=$/, "");
    return { status: r.status, json: (await r.json()) as Json };
  };
  return {
    send,
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      cookie = value;
    },
    async open() {
      return (await send("/api/dock", {})).json.did as string;
    },
    async state(did: string) {
      return (await send(`/api/d/${did}/state`)).json;
    },
  };
}

test("a join code: nine Crockford characters, shown in threes, read back however it was typed", () => {
  for (let i = 0; i < 50; i++) {
    const code = newJoinCode();
    assert.equal(code.length, JOIN_CODE_LENGTH);
    assert.equal(normalizeJoinCode(code), code);
    assert.equal(normalizeJoinCode(formatJoinCode(code).toLowerCase()), code);
  }
  assert.equal(formatJoinCode("KQ7M4P2XD"), "KQ7-M4P-2XD");
  assert.equal(normalizeJoinCode(" kq7-m4p-2xd "), "KQ7M4P2XD");
  // O reads as 0, I and L as 1: what a person types for what they saw.
  assert.equal(normalizeJoinCode("KQ7-M4P-OIL"), "KQ7M4P011");
  // The whole link works too.
  assert.equal(normalizeJoinCode(joinLink(ORIGIN, "KQ7M4P2XD")), "KQ7M4P2XD");
  assert.equal(joinLink(ORIGIN, "KQ7M4P2XD"), "https://dock.test/dock/join#KQ7M4P2XD");
  for (const bad of ["", "KQ7M4P2X", "KQ7M4P2XDD", "KQ7M4P2XU", "KQ7*M4P2X", 42, null, "x".repeat(500)]) assert.equal(normalizeJoinCode(bad), null, String(bad));
});

test("a computer is named by its browser and system, or as the desktop app", () => {
  assert.equal(deviceLabel(CHROME_WIN), "Chrome on Windows");
  assert.equal(deviceLabel(EDGE_WIN), "Edge on Windows");
  assert.equal(deviceLabel(FIREFOX_MAC), "Firefox on Mac");
  assert.equal(deviceLabel(EDGE_WIN, true), "Dock for Windows");
  assert.equal(deviceLabel("curl/8.0"), "A browser");
  assert.equal(deviceLabel(null), "A browser");
});

test("a second computer joins the dock after a yes on the first: same agents, same MCP URL, its own secret", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const b = computer(env, EDGE_WIN);
  const did = await a.open();
  const ownDid = await b.open();
  assert.notEqual(did, ownDid, "each browser starts with a dock of its own, as before");

  const before = await a.state(did);
  assert.deepEqual(before.devices.map((d: Json) => [d.label, d.current]), [["Chrome on Windows", true]]);
  assert.equal(JSON.stringify(before.devices).includes(a.cookie.split(".")[1]!), false, "no computer's secret is in the state");

  // A: Link another computer.
  const link = await a.send(`/api/d/${did}/link`, {});
  assert.equal(link.status, 200);
  const code: string = link.json.code;
  assert.equal(normalizeJoinCode(code), code);
  assert.deepEqual((await a.state(did)).link, { code, expires_at: link.json.expires_at });

  // B types it: it waits for a yes, and gets nothing yet.
  const asked = await b.send("/api/dock/join", { code: formatJoinCode(code).toLowerCase() });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.equal(asked.json.label, "Edge on Windows");
  const claim: string = asked.json.claim;
  assert.deepEqual((await b.send("/api/dock/join/status", { claim })).json, { status: "pending" });
  const waiting = await a.state(did);
  assert.equal(waiting.link, null, "a claimed code is no longer shown");
  assert.deepEqual(waiting.joins.map((j: Json) => [j.label, j.status]), [["Edge on Windows", "pending"]]);

  // The code worked once: a second claim finds nothing.
  assert.deepEqual((await computer(env, FIREFOX_MAC).send("/api/dock/join", { code })).json, { ok: false, error: "unknown_code" });

  // A says yes; B collects its secret once, and its cookie now opens A's dock.
  assert.deepEqual((await a.send(`/api/d/${did}/joins/${waiting.joins[0].id}`, { action: "approve" })).json, { ok: true });
  const joined = await b.send("/api/dock/join/status", { claim });
  assert.deepEqual(joined.json, { status: "joined", did });
  assert.match(b.cookie, new RegExp(`^apc_dock=${did}\\.[0-9a-f]{32}$`));
  assert.notEqual(b.cookie, a.cookie, "each computer has its own secret");
  assert.deepEqual((await b.send("/api/dock/join/status", { claim })).json, { status: "expired" }, "the secret is handed out once");

  // Both see the same agents, with the same MCP URL.
  const onA = await a.state(did);
  const onB = await b.state(did);
  assert.deepEqual(onB.agents.map((x: Json) => x.mcp_url), onA.agents.map((x: Json) => x.mcp_url));
  assert.deepEqual(onA.devices.map((d: Json) => [d.label, d.current]), [["Chrome on Windows", true], ["Edge on Windows", false]]);
  assert.deepEqual(onB.devices.map((d: Json) => d.current), [false, true]);
  assert.deepEqual(onA.joins, []);
  // Resuming (the desktop app's pets) finds the joined dock.
  assert.deepEqual((await b.send("/api/dock", { resume: true })).json, { did, created: false });

  // B's own dock had nothing in it: it went when B left it.
  assert.equal(await env.HUB.get(ownDid).isOwner("0".repeat(32)), false);
  assert.equal(env.HUB.objects.get(ownDid).room.db.prepare("select count(*) as n from meta where key = 'did'").get()!.n, 0);
});

test("a no, or no answer in time, joins nothing; the other computer is told", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const did = await a.open();
  const askWith = async () => {
    const code = (await a.send(`/api/d/${did}/link`, {})).json.code;
    const b = computer(env, EDGE_WIN);
    const claim = (await b.send("/api/dock/join", { code })).json.claim;
    return { b, claim, id: (await a.state(did)).joins[0].id as string };
  };
  const denied = await askWith();
  assert.deepEqual((await a.send(`/api/d/${did}/joins/${denied.id}`, { action: "deny" })).json, { ok: true });
  assert.deepEqual((await denied.b.send("/api/dock/join/status", { claim: denied.claim })).json, { status: "denied" });
  assert.equal(denied.b.cookie, "", "no cookie for a computer that was told no");

  const late = await askWith();
  env.HUB.objects.get(did).room.db.prepare("update joins set answer_by = 0").run();
  assert.deepEqual((await late.b.send("/api/dock/join/status", { claim: late.claim })).json, { status: "expired" });
  assert.deepEqual((await a.state(did)).joins, [], "the request went from the dock too");
  assert.equal((await a.state(did)).devices.length, 1);

  // An answer to a request that is gone is refused, not taken.
  assert.equal((await a.send(`/api/d/${did}/joins/${late.id}`, { action: "approve" })).status, 400);
});

test("a code nobody claims in time is gone; a new code ends the last one; Cancel ends it", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const did = await a.open();
  const first = (await a.send(`/api/d/${did}/link`, {})).json.code;
  const second = (await a.send(`/api/d/${did}/link`, {})).json.code;
  assert.equal((await computer(env, EDGE_WIN).send("/api/dock/join", { code: first })).json.error, "unknown_code", "a newer code ended it");
  assert.deepEqual((await a.send(`/api/d/${did}/link/cancel`, { code: second })).json, { ok: true });
  assert.equal((await computer(env, EDGE_WIN).send("/api/dock/join", { code: second })).json.error, "unknown_code");
  const third = (await a.send(`/api/d/${did}/link`, {})).json.code;
  env.JOIN_CODES.objects.get("join-codes").room.db.prepare("update codes set expires_at = 0").run();
  assert.equal((await computer(env, EDGE_WIN).send("/api/dock/join", { code: third })).json.error, "unknown_code");
});

test("only the dock's own page can join: another site cannot start or finish a join", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const did = await a.open();
  const code = (await a.send(`/api/d/${did}/link`, {})).json.code;
  const b = computer(env, EDGE_WIN);
  const evil = { origin: "https://evil.example" };
  assert.equal((await b.send("/api/dock/join", { code }, evil)).status, 403);
  assert.equal((await b.send("/api/dock/join", { code }, { origin: "", "sec-fetch-site": "cross-site" })).status, 403);
  // The code was not spent by the refused tries.
  const claim = (await b.send("/api/dock/join", { code })).json.claim;
  await a.send(`/api/d/${did}/joins/${(await a.state(did)).joins[0].id}`, { action: "approve" });
  assert.equal((await b.send("/api/dock/join/status", { claim }, evil)).status, 403);
  assert.equal(b.cookie, "");
  assert.equal((await b.send("/api/dock/join/status", { claim })).json.status, "joined");
});

test("a computer removes another, never itself; the removed one's cookie stops opening the dock", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const b = computer(env, EDGE_WIN);
  const did = await a.open();
  const code = (await a.send(`/api/d/${did}/link`, {})).json.code;
  const claim = (await b.send("/api/dock/join", { code })).json.claim;
  await a.send(`/api/d/${did}/joins/${(await a.state(did)).joins[0].id}`, { action: "approve" });
  await b.send("/api/dock/join/status", { claim });
  const [mine, theirs] = (await a.state(did)).devices as Json[];
  // A dock page open on each computer, as the hub tags its sockets.
  const { room } = env.HUB.objects.get(did);
  const pageA = room.openPage();
  pageA.serializeAttachment({ accepted_at: Date.now(), device: mine!.id });
  const pageB = room.openPage();
  pageB.serializeAttachment({ accepted_at: Date.now(), device: theirs!.id });
  assert.equal((await a.send(`/api/d/${did}/devices/${mine!.id}/remove`, {})).json.error, "this_device");
  assert.deepEqual((await a.send(`/api/d/${did}/devices/${theirs!.id}/remove`, {})).json, { ok: true });
  assert.equal((await b.send(`/api/d/${did}/state`)).status, 404);
  assert.equal((await a.state(did)).devices.length, 1);
  // The removed computer's page was closed; this one's stays open.
  assert.equal(pageB.readyState, 3);
  assert.equal(pageA.readyState, 1);
});

test("a dock from before (one owner secret) becomes its first computer, and its old cookie still opens it", async () => {
  const room = durableObjectRoom();
  const did = "a".repeat(32);
  const owner = "b".repeat(32);
  // A dock as TIN-823 left it: the owner secret in meta, no devices table.
  new Hub(room.ctx, {});
  room.db.exec("drop table devices");
  room.db.prepare("insert into meta (key, value) values ('owner', ?), ('did', ?), ('created_at', ?), ('expires_at', ?)").run(owner, did, "2026-11-01T00:00:00.000Z", String(Date.now() + 60_000));
  const hub = new Hub(room.ctx, {});
  assert.equal(await hub.isOwner(owner, "Chrome on Windows"), true);
  assert.equal(room.db.prepare("select count(*) as n from meta where key = 'owner'").get()!.n, 0, "the secret lives in devices only");
  const state = await hub.state(ORIGIN, owner);
  assert.deepEqual(state.devices.map((d: Json) => [d.label, d.current, d.created_at]), [["Chrome on Windows", true, "2026-11-01T00:00:00.000Z"]]);
  assert.equal(await hub.isOwner("c".repeat(32)), false);
});

test("leaving a dock with something in it keeps it for its agents; Start over still ends it for every computer", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const did = await a.open();
  const hub = env.HUB.get(did);
  // Its agent connected once: the dock has something in it.
  env.HUB.objects.get(did).room.db.prepare("update agents set client_name = 'claude-ai'").run();
  const secret = a.cookie.split(".")[1]!;
  assert.deepEqual(await hub.leave(secret), { ok: true, wiped: false });
  assert.equal(await hub.isOwner(secret), false);
  assert.equal(env.HUB.objects.get(did).room.db.prepare("select count(*) as n from agents").get()!.n, 1, "the agents stay, for their connection");

  // Start over on one computer ends the dock for all of them.
  const c = computer(env, CHROME_WIN);
  const d = computer(env, EDGE_WIN);
  const did2 = await c.open();
  const code = (await c.send(`/api/d/${did2}/link`, {})).json.code;
  const claim = (await d.send("/api/dock/join", { code })).json.claim;
  await c.send(`/api/d/${did2}/joins/${(await c.state(did2)).joins[0].id}`, { action: "approve" });
  await d.send("/api/dock/join/status", { claim });
  await c.send(`/api/d/${did2}/reset`, {});
  assert.equal((await d.send(`/api/d/${did2}/state`)).status, 404);
});

test("guessing codes: past 60 misses in a minute the directory answers busy, even for a real code", async () => {
  const env = world();
  const a = computer(env, CHROME_WIN);
  const did = await a.open();
  const code = (await a.send(`/api/d/${did}/link`, {})).json.code;
  const b = computer(env, EDGE_WIN);
  for (let i = 0; i < 60; i++) assert.equal((await b.send("/api/dock/join", { code: "000000000" })).json.error, "unknown_code");
  const busy = await b.send("/api/dock/join", { code });
  assert.equal(busy.status, 429);
  assert.equal(busy.json.error, "busy");
});
