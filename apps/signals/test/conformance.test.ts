/**
 * Signals against the APC conformance suite (APC 0.2, TIN-577). Signals offers the Dock profile only:
 * every grant is one it handed a dock's hub at pairing. Its Durable Object runs for real on Node's
 * SQLite (@apc/conformance/workers); the hub's side of pairing is a stand-in, so nothing leaves the
 * process.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { apcConformance, type ApcAppAdapter } from "@apc/conformance";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { APC_JSON_PATH, type FocusTarget, type PresenceEvent } from "@apc/protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@apc/web";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { buildMarket } from "../../demo/src/model/market.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const HUB = "https://dock.test";
const SID = "7".repeat(32);
const SEED = 4242;

function standInHub(t: TestContext | null): { calls: string[] } {
  const calls: string[] = [];
  const fake = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${HUB}/apc/pair`) return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null } });
    throw new Error(`no network in this test: ${url}`);
  };
  if (t) t.mock.method(globalThis, "fetch", fake);
  else globalThis.fetch = fake as typeof fetch;
  return { calls };
}

/** Signals' deploy (wrangler.jsonc): both profiles. */
const DEPLOY = { HUB_ORIGINS: HUB, APC_PROFILES: "direct,dock" };

async function signals(profile: "direct" | "dock" = "dock", options: { link?: boolean; env?: Record<string, string> } = {}) {
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, options.env ?? DEPLOY);
  await feed.init(SEED);
  const posts = buildMarket(generateDataset(SEED)).posts;
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
    const drop = { hub: HUB, agent: `ag_${agents}`, ticket: `${"d".repeat(32)}.${agents.toString().padStart(16, "0")}`, target: targets[0] };
    // Signals asks the person on its page first (TIN-606); their Allow brings the nonce back.
    const asked = await feed.pairHub(SID, ORIGIN, drop);
    assert.equal(asked.error, "consent_required");
    const paired = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
    assert.equal(paired.ok, true, `pairing: ${paired.error}`);
    await feed.unpin(paired.grant_id);
    return { grantId: paired.grant_id as string, mcpUrl: urlOf(paired.grant_id) };
  };
  const app: ApcAppAdapter = {
    name: "Signals",
    profile,
    // The MCP endpoint is the feed's; apc.json is the Worker's, for the whole origin (APC 0.5).
    fetch: (request) => (new URL(request.url).pathname === APC_JSON_PATH ? worker.fetch(request, options.env ?? DEPLOY) : feed.fetch(request)),
    connect: () => connectOn(profile),
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
      takePresence: () => room.takeMessages().filter((m) => m.type === "presence").map((m) => m.event as PresenceEvent),
      revoke: async (grantId) => (await feed.revokeGrant(grantId)).ok,
      // The page on a phone (APC 0.6), modelled with @apc/web's own pieces: the bar's collapse rule on mobile and
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
  return { app, feed, room };
}

standInHub(null);
for (const profile of ["direct", "dock"] as const) {
  // Both profiles (TIN-578); the apc_link checks once, with the Direct run.
  const { app } = await signals(profile, { link: profile === "direct" });
  for (const check of apcConformance(app)) test(check.name, check.run);
}

test("a Signals that offers only the dock makes no Direct agent", async () => {
  const { feed } = await signals("dock", { env: { HUB_ORIGINS: HUB, APC_PROFILES: "dock" } });
  assert.deepEqual(await feed.addDirectGrant(), { ok: false, error: "dock_only" });
});

test("a feed from before Direct gets a grants table that takes Direct agents, and keeps its dock grants", async () => {
  const room = durableObjectRoom();
  room.db.exec("create table grants (id text primary key, secret text not null unique, hub text not null, agent text not null, client_title text, created_at text not null, last_active_at text, unique (hub, agent))");
  room.db.exec("alter table grants add column client_icon text");
  room.db.exec(`insert into grants (id, secret, hub, agent, created_at) values ('g_old', '${"a".repeat(32)}', '${HUB}', 'ag_1', '2026-11-01T00:00:00.000Z')`);
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init(SEED);
  const made = await feed.addDirectGrant();
  assert.equal(made.ok, true);
  const { grants } = (await feed.state()) as { grants: Array<{ id: string; path: string; secret: string | null }> };
  assert.deepEqual(grants.map((g) => [g.id, g.path]), [["g_old", "dock"], [made.grant_id, "direct"]]);
  assert.equal(grants[0]!.secret, null, "a dock grant's secret stays the hub's: the page never gets it");
  assert.match(grants[1]!.secret ?? "", /^[0-9a-f]{32}$/);
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
  const { app, feed } = await signals();
  const hub = standInHub(t);
  const { grantId, mcpUrl } = await app.connect();
  const before = hub.calls.length;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the hub is down");
  });
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  assert.equal(hub.calls.length, before, "no call to the hub");
  assert.equal((await feed.state()).grants.length, 0);
  const response = await feed.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked_by, "signals.test");
});

test("Signals makes a grant for a dock agent only with the nonce its consent was shown with, even when the page thinks it is linked (TIN-606)", async (t) => {
  const { app, feed } = await signals();
  const hub = standInHub(t);
  const { grantId } = await app.connect();
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  // The page missed the revoke and sends the drop as a pin: the server asks for consent; nothing reaches the dock.
  const calls = hub.calls.length;
  const drop = { hub: HUB, agent: "ag_1", ticket: `${"d".repeat(32)}.${"1".repeat(16)}`, target: { kind: "post", id: buildMarket(generateDataset(SEED)).posts[0]!.id } };
  const asked = await feed.pairHub(SID, ORIGIN, drop);
  assert.equal(asked.error, "consent_required");
  assert.match(asked.consent, /^cn_[0-9a-f]{32}$/);
  assert.equal(hub.calls.length, calls);
  assert.equal((await feed.pairHub(SID, ORIGIN, { ...drop, consent: `cn_${"0".repeat(32)}` })).error, "consent_required");
  assert.equal((await feed.pairHub(SID, ORIGIN, { ...drop, agent: "ag_2", consent: asked.consent })).error, "consent_required", "another agent's drop");
  assert.equal(hub.calls.length, calls);
  const again = await feed.pairHub(SID, ORIGIN, drop);
  assert.equal((await feed.pairHub(SID, ORIGIN, { ...drop, consent: again.consent })).ok, true);
  assert.deepEqual(hub.calls.slice(calls), [`${HUB}/apc/pair`]);
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
      return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null } });
    }
    // Were the second request to ask the hub, it would hear the pairing does not exist yet.
    if (url === `${HUB}/apc/confirm`) return Response.json({ ok: false, error: "not_paired" });
    throw new Error(`no network in this test: ${url}`);
  });
  const drop = { hub: HUB, agent: "ag_7", ticket: `${"d".repeat(32)}.${"7".repeat(16)}`, target: { kind: "post", id: buildMarket(generateDataset(SEED)).posts[0]!.id } };
  const { consent } = await feed.pairHub(SID, ORIGIN, drop);
  const first = feed.pairHub(SID, ORIGIN, { ...drop, consent });
  await asked;
  // The grant exists while the hub answers, but it is not yet this agent's link.
  const during = (await feed.state()).grants as Array<{ id: string; agent: string | null }>;
  assert.deepEqual(during.map((g) => g.agent), [null]);
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
