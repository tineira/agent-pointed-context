/**
 * Signals against the APC conformance suite (APC 0.2, TIN-577). Signals offers the Dock profile only:
 * every grant is one it handed a dock's hub at pairing. Its Durable Object runs for real on Node's
 * SQLite (@tineira/apc-conformance/workers); the hub's side of pairing is the suite's stand-in (`standInHub`, one
 * per feed under test, on its own origin), which checks the pairing code (APC 0.9), so nothing leaves the process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, standInHub, type ApcAppAdapter, type StandInHub } from "@tineira/apc-conformance";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { APC_JSON_PATH, formatPairingCode, type FocusTarget, type PresenceMessage } from "@tineira/apc-protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@tineira/apc-web";
import { demoMarket } from "../../demo/src/model/demo-world.ts";
import { dockLifecycle, inProcessHandshake, isHandshake } from "../../demo/test/dock-conformance.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const HUB = "https://dock.test";
const SID = "7".repeat(32);

/** The stand-in hubs, by origin: one per feed under test, reached by Signals' server through fetch; nothing else leaves the process. */
const hubs = new Map<string, { hub: StandInHub; calls: string[] }>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const h = hubs.get(url.origin);
  if (!h) throw new Error(`no network in this test: ${url}`);
  h.calls.push(url.href);
  return h.hub.fetch(input, init);
}) as typeof fetch;
let hubCount = 0;

/** Signals' deploy (wrangler.jsonc): both profiles. */
const DEPLOY = { HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };

async function signals(profile: "direct" | "dock" = "dock", options: { link?: boolean; env?: Record<string, string> } = {}) {
  const room = durableObjectRoom();
  // A hub of its own, on its own origin: Signals pairs with it, and it calls Signals back (a give-back, its introduction).
  const hubOrigin = `https://dock-${++hubCount}.test`;
  const env = options.env ?? DEPLOY;
  const feedEnv = env.HUB_ORIGINS ? { ...env, HUB_ORIGINS: `${env.HUB_ORIGINS},${hubOrigin}` } : env;
  // `let`: a restart (APC 0.10, T_ack across one) puts a new object on the same storage, and everything below follows it.
  let feed = new Feed(room.ctx, feedEnv);
  const { owner } = await feed.init();
  // The Worker's own routes (/apc/revoke, the give-back), with this feed as the one its namespace holds.
  const workerEnv = { ...feedEnv, FEED: { idFromName: (name: string) => name, get: (id: string) => (id === SID ? feed : new Feed(durableObjectRoom().ctx, feedEnv)) } };
  const hub = standInHub({
    origin: hubOrigin,
    // The hub reaches Signals as it does in production: the grant's MCP URL, and the public /apc/revoke (M7, APC 0.10).
    app: async (request) => (new URL(request.url).pathname === "/apc/revoke" ? worker.fetch(request, workerEnv) : feed.fetch(request)),
  });
  const calls: string[] = [];
  hubs.set(hubOrigin, { hub, calls });
  const posts = demoMarket().posts;
  const targets: [FocusTarget, FocusTarget] = [
    { kind: "post", id: posts[0]!.id, part: null, params: null },
    { kind: "post", id: posts[1]!.id, part: "offer", params: null },
  ];
  let agents = 0;
  const urlOf = (grantId: string) => {
    const [row] = room.db.prepare("select secret from grants where id = ?").all(grantId);
    return `${ORIGIN}/mcp/${SID}/${String(row!.secret)}`;
  };
  const connectOn = async (path: "direct" | "dock") => {
    if (path === "direct") {
      // The person makes an agent on the page: its own grant and MCP URL (the Direct profile).
      const made = await feed.addDirectGrant();
      assert.equal(made.ok, true, `direct: ${made.error}`);
      return { grantId: made.grant_id as string, mcpUrl: urlOf(made.grant_id) };
    }
    agents++;
    const agent = `ag_${agents}`;
    const drop = { hub: hubOrigin, agent, ticket: hub.ticket(agent), target: targets[0] };
    // Signals asks the person on its page first (TIN-606); their Allow brings the nonce back.
    const asked = await feed.pairHub(SID, ORIGIN, drop);
    assert.equal(asked.error, "consent_required");
    const paired = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
    assert.equal(paired.ok, true, `pairing: ${paired.error}`);
    // The dock owner types the code, and the hub introduces itself (APC 0.10): only then does the grant serve calls.
    const approved = await hub.decide(hub.pairings.find((p) => p.agent === agent)!.id, "approve", asked.pairing_code);
    assert.equal(approved.ok, true, `the dock's Allow: ${approved.error}`);
    await feed.unpin(paired.grant_id);
    return { grantId: paired.grant_id as string, mcpUrl: urlOf(paired.grant_id) };
  };
  const app: ApcAppAdapter = {
    name: "Signals",
    profile,
    // The MCP endpoint is the feed's; apc.json is the Worker's, for the whole origin (APC 0.5).
    // The owner's endpoints and the give-back are the Worker's too (M6, M7, APC 0.10).
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === APC_JSON_PATH) return worker.fetch(request, options.env ?? DEPLOY);
      if (isHandshake(request)) return inProcessHandshake(worker, workerEnv, request);
      return path.startsWith("/api/") || path.startsWith("/apc/") ? worker.fetch(request, workerEnv) : feed.fetch(request);
    },
    connect: () => connectOn(profile),
    // The pairing code (APC 0.9): what Signals' consent shows (formatted, as app.tsx shows it), and the Allow on it.
    ...(profile === "dock"
      ? {
          dock: {
            hub,
            async drop(agent: string, ticket: string) {
              const drop = { hub: hubOrigin, agent, ticket, target: targets[0] };
              const asked = await feed.pairHub(SID, ORIGIN, drop);
              assert.equal(asked.error, "consent_required");
              return {
                shown: formatPairingCode(asked.pairing_code),
                allow: async () => {
                  const r = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
                  return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
                },
              };
            },
            // The Dock profile as built (APC 0.10). Signals does not sleep (dormant is a SHOULD): no idleMs.
            lifecycle: dockLifecycle({
              worker,
              workerEnv: () => workerEnv,
              disabledEnv: { APC_PROFILES: "direct,dock" },
              origin: ORIGIN,
              sid: SID,
              cookie: `apc_signals=${SID}.${owner}`,
              hub,
              target: targets[0],
              view: { screen: "feed", params: { kind: "competitor_offer" }, selection: { kind: "post", id: targets[0].id } },
              room,
              object: () => feed,
              restart: () => void (feed = new Feed(room.ctx, feedEnv)),
              directGrant: () => connectOn("direct"),
            }),
          },
        }
      : {}),
    ...(options.link
      ? {
          link: {
            connect: (path) => connectOn(path),
            async agents() {
              const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: string; linked_with: string | null }> };
              return grants.filter((g) => !(g.path === "dock" && g.linked_with)).map((g) => ({ grants: g.linked_with ? [g.id, g.linked_with] : [g.id] }));
            },
            unlink: async (grantId) => (await feed.unlinkGrant(grantId)).ok,
            async expireCodes() {
              room.db.exec("update apc_kv set value = json_set(value, '$.expires_at', 0) where key like 'code:%'");
            },
          },
        }
      : {}),
    targets,
    probe: { tool: "list_posts", args: {} },
    page: {
      setOpen(open) {
        if (!open) room.closePages();
        else if (!room.pages.some((p) => p.readyState === 1)) room.openPage();
      },
      async showView() {
        await feed.reportView({ screen: "feed", params: { kind: "competitor_offer" }, selection: { kind: "post", id: targets[0].id } });
      },
      pin: async (grantId, target) => (await feed.pin(grantId, target, true)).ok,
      takePresence: () => room.takeMessages().filter((m) => m.type === "presence").map((m) => m.event as PresenceMessage),
      revoke: async (grantId) => (await feed.revokeGrant(grantId)).ok,
      // The page on a phone (APC 0.6), modelled with @tineira/apc-web's own pieces: the bar's collapse rule on mobile and
      // the tap-to-pin controller `enablePinning` runs, which pins through the feed like the page's onPin does.
      // The real page, at 375x812 with a touch pointer, is scripts/mobile-e2e.mjs.
      mobile: {
        async agentBar() {
          const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: "direct" | "dock"; linked_with: string | null }> };
          const bar: BarAgent[] = grants.filter((g) => !(g.path === "dock" && g.linked_with)).map((g) => ({ id: g.id, name: g.id, state: "idle", paths: [g.path] }));
          return { visible: bar.map((a) => a.id), collapsible: barCanCollapse(bar, true) };
        },
        async pinByTouch(grantId, target) {
          const pins: Array<Promise<{ ok: boolean }>> = [];
          const tap = createTapPin({ onPin: (id, t) => void pins.push(feed.pin(id, t)) });
          tap.toggle(grantId);
          assert.equal(tap.tap({ element: {} as Element, target }), "pinned");
          return pins.length === 1 && (await pins[0]!).ok;
        },
        unpinByTouch: async (grantId) => (await feed.unpin(grantId), true),
      },
    },
  };
  return { app, feed, room, hub, calls, workerEnv };
}

for (const profile of ["direct", "dock"] as const) {
  // Both profiles (TIN-578).
  const { app } = await signals(profile);
  for (const check of apcConformance(app)) test(check.name, check.run);
}
// The apc_link checks once, on a feed of their own: a feed holds at most 20 Direct agents, and the core checks use most of one.
{
  const { app } = await signals("direct", { link: true });
  for (const check of apcConformance(app).filter((c) => c.name.includes("(apc_link)"))) test(check.name, check.run);
}

test("a Signals that offers only the dock makes no Direct agent", async () => {
  const { feed } = await signals("dock", { env: { HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "dock" } });
  assert.deepEqual(await feed.addDirectGrant(), { ok: false, error: "dock_only" });
});

test("a feed from before Direct gets a grants table that takes Direct agents, and keeps its dock grants", async () => {
  const room = durableObjectRoom();
  room.db.exec("create table grants (id text primary key, secret text not null unique, hub text not null, agent text not null, client_title text, created_at text not null, last_active_at text, unique (hub, agent))");
  room.db.exec("alter table grants add column client_icon text");
  room.db.exec(`insert into grants (id, secret, hub, agent, created_at) values ('g_old', '${"a".repeat(32)}', '${HUB}', 'ag_1', '2026-11-01T00:00:00.000Z')`);
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const made = await feed.addDirectGrant();
  assert.equal(made.ok, true);
  const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: string; secret: string | null }> };
  assert.deepEqual(grants.map((g) => [g.id, g.path]), [["g_old", "dock"], [made.grant_id, "direct"]]);
  assert.equal(grants[0]!.secret, null, "a dock grant's secret stays the hub's: the page never gets it");
  assert.match(grants[1]!.secret ?? "", /^[0-9a-f]{32}$/);
});

const OLD_GRANTS = "create table grants (id text primary key, secret text not null unique, hub text not null, agent text not null, client_title text, created_at text not null, last_active_at text, unique (hub, agent))";
const NEW_GRANTS = "create table grants_direct (id text primary key, secret text not null unique, hub text, agent text, client_title text, created_at text not null, last_active_at text, client_icon text, unique (hub, agent))";
const oldRow = `insert into grants (id, secret, hub, agent, created_at) values ('g_old', '${"a".repeat(32)}', '${HUB}', 'ag_1', '2026-11-01T00:00:00.000Z')`;

test("the grants-table rebuild survives a stop after the copy table was made (a leftover grants_direct, TIN-607)", async () => {
  const room = durableObjectRoom();
  room.db.exec(OLD_GRANTS);
  room.db.exec("alter table grants add column client_icon text");
  room.db.exec(oldRow);
  room.db.exec(NEW_GRANTS); // the earlier start made it, then stopped before the copy finished
  room.db.exec(`insert into grants_direct (id, secret, created_at) values ('g_half', '${"b".repeat(32)}', '2026-11-01T00:00:00.000Z')`);
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: string }> };
  assert.deepEqual(grants.map((g) => [g.id, g.path]), [["g_old", "dock"]], "the real grants are kept; the half copy is not");
  assert.equal((await feed.addDirectGrant()).ok, true, "and the table takes a Direct agent now");
  assert.equal(room.db.prepare("select name from sqlite_master where name = 'grants_direct'").all().length, 0, "no leftover");
});

test("the grants-table rebuild survives a stop after the old table was dropped (the copy is complete, only its name is missing)", async () => {
  const room = durableObjectRoom();
  room.db.exec(NEW_GRANTS);
  room.db.exec(`insert into grants_direct (id, secret, hub, agent, created_at) values ('g_old', '${"a".repeat(32)}', '${HUB}', 'ag_1', '2026-11-01T00:00:00.000Z')`);
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: string }> };
  assert.deepEqual(grants.map((g) => [g.id, g.path]), [["g_old", "dock"]], "the dock grant was not lost");
  assert.equal((await feed.addDirectGrant()).ok, true);
});

test("a Direct agent names itself on initialize, the person can rename it, and revoking it calls nobody", async (t) => {
  const { app, feed } = await signals("direct");
  const { grantId, mcpUrl } = await app.connect();
  await app.fetch!(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } }) }));
  type Row = { id: string; name: string; connected: boolean };
  const row = async () => ((await feed.state()) as { grants: Row[] }).grants.find((g) => g.id === grantId)!;
  assert.equal((await row()).name, "claude-code");
  assert.equal((await row()).connected, true);
  await feed.renameGrant(grantId, "  Research bot ");
  assert.equal((await row()).name, "Research bot");
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("no network");
  });
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  const response = await feed.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
});

test("revoking an agent in Signals calls nobody; the URL answers revoked with Signals' host, and the dock link goes", async (t) => {
  const { app, feed, calls: hubCalls } = await signals();
  const { grantId, mcpUrl } = await app.connect();
  const before = hubCalls.length;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the hub is down");
  });
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  assert.equal(hubCalls.length, before, "no call to the hub");
  assert.equal((await feed.state()).grants.length, 0);
  const response = await feed.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked_by, "signals.test");
});

test("Signals makes a grant for a dock agent only with the nonce its consent was shown with, even when the page thinks it is linked (TIN-606)", async () => {
  const { app, feed, hub, calls: hubCalls } = await signals();
  const { grantId } = await app.connect();
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  // The page missed the revoke and sends the drop as a pin: the server asks for consent; nothing reaches the dock.
  const calls = hubCalls.length;
  const drop = { hub: hub.origin, agent: "ag_1", ticket: hub.ticket("ag_1"), target: { kind: "post", id: demoMarket().posts[0]!.id } };
  const asked = await feed.pairHub(SID, ORIGIN, drop);
  assert.equal(asked.error, "consent_required");
  assert.match(asked.consent, /^cn_[0-9a-f]{32}$/);
  assert.equal(formatPairingCode(asked.pairing_code).length, 7, "and the pairing code its consent shows (APC 0.9)");
  assert.equal(hubCalls.length, calls);
  // An Allow whose nonce does not take fails closed (APC 0.10): consent_expired, and no new question on its word.
  assert.deepEqual(await feed.pairHub(SID, ORIGIN, { ...drop, consent: `cn_${"0".repeat(32)}` }), { ok: false, error: "consent_expired" });
  assert.deepEqual(await feed.pairHub(SID, ORIGIN, { ...drop, agent: "ag_2", consent: asked.consent }), { ok: false, error: "consent_expired" }, "another agent's drop");
  assert.deepEqual(await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }), { ok: false, error: "consent_expired" }, "and the nonce went with that try: used or not, it works once");
  assert.equal(hubCalls.length, calls);
  const again = await feed.pairHub(SID, ORIGIN, drop);
  assert.equal((await feed.pairHub(SID, ORIGIN, { ...drop, consent: again.consent })).ok, true);
  assert.deepEqual(hubCalls.slice(calls), [`${hub.origin}/apc/pair`]);
  assert.equal(hub.received.at(-1)!.pairing_code, again.pairing_code, "the code the consent showed went to the hub");
});

test("a double-clicked Allow in Signals pairs once: the second request changes nothing, and the grant the first made stays (Grok on #123)", async (t) => {
  const { feed } = await signals();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  let pairAsked!: () => void;
  const asked = new Promise<void>((resolve) => (pairAsked = resolve));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${HUB}/apc/pair`) {
      pairAsked();
      // The hub takes its time (it reads the app's apc.json first).
      await held;
      return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" });
    }
    // Were the second request to ask the hub, it would hear the pairing does not exist yet.
    if (url === `${HUB}/apc/confirm`) return Response.json({ ok: false, error: "not_paired" }, { status: 400 });
    throw new Error(`no network in this test: ${url}`);
  });
  const drop = { hub: HUB, agent: "ag_7", ticket: `${"d".repeat(32)}.${"7".repeat(16)}`, target: { kind: "post", id: demoMarket().posts[0]!.id } };
  const { consent } = await feed.pairHub(SID, ORIGIN, drop);
  const first = feed.pairHub(SID, ORIGIN, { ...drop, consent });
  await asked;
  // The grant exists while the hub answers, in flight (APC 0.10): this agent's, and answering nothing yet.
  const during = (await feed.state()).grants as Array<{ id: string; agent: string | null; state: string }>;
  assert.deepEqual(during.map((g) => [g.agent, g.state]), [["ag_7", "in_flight"]]);
  assert.deepEqual(await feed.pairHub(SID, ORIGIN, { ...drop, consent }), { ok: false, error: "pairing_in_progress" });
  release();
  const done = await first;
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(calls, [`${HUB}/apc/pair`], "no confirm, no second pairing");
  const grants = (await feed.state()).grants as Array<{ id: string; agent: string | null }>;
  assert.deepEqual(grants.map((g) => [g.id, g.agent]), [[done.grant_id, "ag_7"]], "the grant the hub got is still there, linked");
});

test("a running call in Signals is cut by its own grant, never by a grant id a later grant reuses (TIN-606)", async () => {
  const { app, feed, room } = await signals("direct");
  room.openPage();
  const { grantId, mcpUrl } = await app.connect();
  const waitOn = async (url: string) => {
    const response = await feed.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: 8 } } }) }));
    const { result } = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: result.isError, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = Date.now();
  const waiting = waitOn(mcpUrl);
  await sleep(100);
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  const reused = "e".repeat(32);
  room.db.prepare("insert into grants (id, secret, created_at) values (?, ?, ?)").run(grantId, reused, new Date().toISOString());
  const cut = await waiting;
  assert.ok(Date.now() - started < 5_000, "it ended at its next poll");
  assert.equal(cut.body.error, "revoked");
  const second = waitOn(`${ORIGIN}/mcp/${SID}/${reused}`);
  await sleep(100);
  room.db.prepare("delete from grants where id = ?").run(grantId);
  assert.equal((await second).body.error, "unknown_grant", "the later grant went without a revoke");
});

test("Signals ends the loop like Pulse: no then on a wait that came back empty", async () => {
  const { app } = await signals();
  const { mcpUrl } = await app.connect();
  await app.page.setOpen(true);
  const response = await app.fetch!(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: 1 } } }) }));
  const { result } = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
  assert.equal(result.structuredContent.timed_out, true);
  assert.equal("then" in result.structuredContent, false);
});

test("Signals: a page that connects mid-wait is told the open first, and the state no longer counts waits (APC 0.11)", async () => {
  const { app, feed, room } = await signals("direct");
  room.openPage();
  const conn = await app.connect();
  room.takeMessages();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: 2 } } });
  const waiting = feed.fetch(new Request(conn.mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(feed.waitsNow().map((m: { event: { grant_id: string; state: string } }) => [m.event.grant_id, m.event.state]), [[conn.grantId, "open"]]);
  assert.deepEqual(feed.waitsNow(Date.now() + 61_000), [], "an open the worker never closed is not replayed past 50 s plus 10 s");
  assert.equal(((await feed.state()).grants as Array<{ id: string; waiting?: boolean }>).find((g) => g.id === conn.grantId)?.waiting, undefined, "the page reads waits from the wait events");
  await waiting;
  assert.deepEqual(feed.waitsNow(), []);
  assert.deepEqual(room.takeMessages().filter((m) => m.type === "presence" && (m.event as { kind: string }).kind === "wait").map((m) => (m.event as { state: string }).state), ["open", "closed"]);
});
