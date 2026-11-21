/**
 * Signals' `?connect` (TIN-1093) and its framing headers (TIN-1093, closing TIN-1074), against the real Worker and the
 * real Feed: arriving to connect, the feed's one connect grant is made on the first `POST /api/s/:sid/grants/connect`
 * and returned on every later one, so two tabs, a lost answer or a reload never commit a second; a plain visit makes
 * nothing; after a revoke, only the next visit makes a new one. Two tabs and a reload are separate instances of the
 * page's module (connect-grant.ts), sharing one browser (one cookie, one feed). No Signals answer can be framed.
 * The same headers are read back in workerd and in production by scripts/dock-pairing.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { forbidsFraming } from "../../demo/src/worker/embed.ts";
import * as tabA from "../src/web/connect-grant.ts";

installWorkersStandIn();
const { Feed, MAX_DIRECT_GRANTS } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const tabB: typeof tabA = await import(new URL("../src/web/connect-grant.ts?tab=b", import.meta.url).href);

const ORIGIN = "https://signals.test";
const SID = "7".repeat(32);
const DEPLOY = { HUB_ORIGINS: "https://dock.test", PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };

type Grant = { id: string; path: string; secret: string | null };
type Answer = { status: number; json: { ok?: boolean; grant_id?: string; made?: boolean; error?: string } | null };

/** A fresh page load: its own instance of the page's module, so nothing is shared with the earlier loads. */
let loads = 0;
const reload = async (): Promise<typeof tabA> => import(new URL(`../src/web/connect-grant.ts?load=${++loads}`, import.meta.url).href);

/** The page's assets, stood in for: what Workers Assets answers for a path the Worker hands it. */
const ASSETS = { fetch: async () => new Response("<!doctype html><title>Signals</title>", { status: 200, headers: { "content-type": "text/html" } }) };

/** One visitor's browser on one feed: the page's calls, as it sends them, through the real Worker. */
async function browser(env: Record<string, string> = DEPLOY) {
  const feed = new Feed(durableObjectRoom().ctx, env);
  const { owner } = await feed.init();
  const workerEnv = { ...env, ASSETS, FEED: { idFromName: (name: string) => name, get: () => feed } };
  const headers = { "content-type": "application/json", cookie: `apc_signals=${SID}.${owner}`, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const request = async (path: string, init: RequestInit = {}) => (await worker.fetch(new Request(`${ORIGIN}${path}`, { headers, ...init }), workerEnv)) as Response;
  const send = async (): Promise<Answer> => {
    const response = await request(`/api/s/${SID}/grants/connect`, { method: "POST", body: "{}" });
    return { status: response.status, json: (await response.json().catch(() => null)) as Answer["json"] };
  };
  const grants = async () => ((await feed.state()) as { grants: Grant[] }).grants;
  return { feed, send, request, grants, headers, workerEnv };
}

test("arriving to connect means ?connect or #connect; nothing else", () => {
  assert.equal(tabA.cameToConnect("?connect", ""), true);
  assert.equal(tabA.cameToConnect("?post=post_001&connect", ""), true);
  assert.equal(tabA.cameToConnect("", "#connect"), true);
  for (const [search, hash] of [["", ""], ["?post=post_001", ""], ["?connected", ""], ["", "#connected"], ["?kind=our_ad", "#post"]]) assert.equal(tabA.cameToConnect(search!, hash!), false, `${search}${hash}`);
});

test("the feed makes the connect grant once and returns the same one on every later call", async () => {
  const { send, grants } = await browser();
  const first = await send();
  assert.equal(first.status, 200);
  assert.equal(first.json?.made, true);
  const again = await send();
  assert.equal(again.json?.grant_id, first.json?.grant_id);
  assert.equal(again.json?.made, false);
  const all = await grants();
  assert.deepEqual(all.map((g) => [g.id, g.path]), [[first.json?.grant_id, "direct"]], "one Direct grant, with its secret for the page's MCP address");
  assert.match(all[0]!.secret ?? "", /^[0-9a-f]{32}$/);
});

test("a plain visit makes nothing: opening the session and reading the state make no grant", async () => {
  const { request, grants } = await browser();
  assert.equal((await request("/api/session", { method: "POST", body: "{}" })).status, 200);
  assert.equal((await request(`/api/s/${SID}/state`)).status, 200);
  assert.deepEqual(await grants(), []);
});

test("an answer lost on the way does not make a second grant on reload", async () => {
  const { send, grants } = await browser();
  // The feed commits the grant, then the answer never reaches the page (a dropped connection, the tab unloading).
  const lost = async (): Promise<Answer> => {
    await send();
    throw new TypeError("Failed to fetch");
  };
  const page = await reload();
  assert.deepEqual(await page.ensureConnectGrant(SID, lost), { ok: false, error: "failed" });
  assert.equal((await grants()).length, 1, "the feed did commit one");
  // The same page never asks again (one call per page load): no retry into a second grant.
  let more = 0;
  assert.deepEqual(await page.ensureConnectGrant(SID, async () => (more++, send())), { ok: false, error: "failed" });
  assert.equal(more, 0);
  // The visitor reloads ?connect: a fresh page, nothing remembered in the browser.
  const after = await (await reload()).ensureConnectGrant(SID, send);
  assert.ok(after.ok);
  assert.equal(after.made, false, "the reload gets the grant the lost answer carried");
  assert.deepEqual((await grants()).map((g) => g.id), [after.grantId]);
});

test("two tabs arriving at once, each its own page, make one grant; callers on one page share one call", async () => {
  const { send, grants } = await browser();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const slow = async () => {
    calls++;
    await gate;
    return send();
  };
  // Tab A twice (StrictMode's second effect, a remount) and tab B: all three in flight before any answers.
  const all = Promise.all([tabA.ensureConnectGrant(SID, slow), tabA.ensureConnectGrant(SID, slow), tabB.ensureConnectGrant(SID, slow)]);
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [a, a2, b] = await all;
  assert.equal(calls, 2, "one call per page");
  assert.ok(a.ok && a2.ok && b.ok);
  assert.equal(a.grantId, b.grantId, "both tabs show the same agent");
  assert.equal(a2, a);
  assert.deepEqual([a.made, b.made].sort(), [false, true], "one made it, the other got it");
  assert.equal((await grants()).length, 1);
});

test("revoked, the connect grant is gone: the same page does not make another, the next ?connect visit does", async () => {
  const { feed, send, grants } = await browser();
  const page = await reload();
  const first = await page.ensureConnectGrant(SID, send);
  assert.ok(first.ok && first.made);
  assert.deepEqual(await feed.revokeGrant(first.grantId), { ok: true });
  // Still on the page that made it: it asked once, so it never asks again.
  const same = await page.ensureConnectGrant(SID, send);
  assert.equal(same, await page.ensureConnectGrant(SID, send));
  assert.deepEqual(await grants(), [], "no replacement within the visit that revoked it");
  // The next visit to ?connect makes a new one.
  const next = await (await reload()).ensureConnectGrant(SID, send);
  assert.ok(next.ok && next.made);
  assert.notEqual(next.grantId, first.grantId);
  assert.deepEqual((await grants()).map((g) => g.id), [next.grantId]);
});

test("only a qualifying grant is returned: never one made with Connect an agent, never one linked to a dock grant", async () => {
  const { feed, send, grants } = await browser();
  // An agent made on purpose with the panel's button is never the connect grant.
  const own = await feed.addDirectGrant();
  const connect = (await send()).json!;
  assert.equal(connect.made, true);
  assert.notEqual(connect.grant_id, own.grant_id);
  // Linked to a dock grant (apc_link), it is one agent with two paths: no longer the Direct one ?connect shows.
  const links = (feed as unknown as { links: { partnerOf: (id: string) => string | null } }).links;
  const partnerOf = links.partnerOf.bind(links);
  links.partnerOf = (id) => (id === connect.grant_id ? "g_dock" : partnerOf(id));
  const replaced = (await send()).json!;
  assert.equal(replaced.made, true);
  assert.notEqual(replaced.grant_id, connect.grant_id);
  assert.equal((await send()).json?.grant_id, replaced.grant_id, "and that new one is returned from then on");
  assert.equal((await grants()).length, 3, "nothing was revoked or replaced in place");
});

test("the connect grant counts against the Direct cap, and a dock-only Signals makes none", async () => {
  const { feed, send, grants } = await browser();
  for (let n = 0; n < MAX_DIRECT_GRANTS; n++) assert.equal((await feed.addDirectGrant()).ok, true);
  const full = await send();
  assert.equal(full.status, 400);
  assert.equal(full.json?.error, "too_many");
  assert.deepEqual(await (await reload()).ensureConnectGrant(SID, send), { ok: false, error: "too_many" });
  assert.equal((await grants()).length, MAX_DIRECT_GRANTS);
  const dockOnly = await browser({ ...DEPLOY, APC_PROFILES: "dock" });
  const refused = await dockOnly.send();
  assert.equal(refused.status, 400);
  assert.equal(refused.json?.error, "dock_only");
  assert.deepEqual(await dockOnly.grants(), []);
});

test("the connect route is the owner's only (M6): another site, a cross-site request, no cookie, not JSON", async () => {
  const { request, headers, grants } = await browser();
  const post = async (h: Record<string, string>) => (await request(`/api/s/${SID}/grants/connect`, { method: "POST", headers: h, body: "{}" })).status;
  assert.equal(await post({ ...headers, origin: "https://evil.test" }), 403);
  assert.equal(await post({ ...headers, "sec-fetch-site": "cross-site" }), 403);
  assert.equal(await post({ ...headers, "sec-fetch-site": "same-site" }), 403);
  assert.equal(await post({ ...headers, cookie: "" }), 403);
  assert.equal(await post({ ...headers, "content-type": "text/plain" }), 415);
  assert.deepEqual(await grants(), [], "no refused call made a grant");
});

function assertNoFraming(response: Response, what: string) {
  const csp = response.headers.get("content-security-policy");
  assert.ok(forbidsFraming(csp), `${what}: frame-ancestors 'none' (got ${csp})`);
  assert.equal(response.headers.get("x-frame-options"), "DENY", `${what}: X-Frame-Options`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${what}: nosniff`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${what}: Referrer-Policy`);
}

test("no Signals answer can be framed: the page, the API, MCP, apc.json, 404s, refusals and errors", async () => {
  const { request, workerEnv } = await browser();
  const plain = async (path: string, init: RequestInit = {}) => (await worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv)) as Response;
  const answers: Array<[string, Response]> = [
    ["an unknown /connect/ path (the Worker's fallback to the assets)", await plain("/connect/zzz-probe")],
    ["/connect/dock", await plain("/connect/dock")],
    ["/.well-known/apc.json", await plain("/.well-known/apc.json")],
    ["/.well-known/other", await plain("/.well-known/other")],
    ["/api/nope", await plain("/api/nope")],
    ["/apc/nope", await plain("/apc/nope")],
    ["/apc/revoke", await plain("/apc/revoke", { method: "POST", body: "{}" })],
    ["/mcp with a bad feed id", await plain("/mcp/zz/zz")],
    ["/mcp with an unknown secret", await plain(`/mcp/${SID}/${"0".repeat(32)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })],
    ["the owner's state", await request(`/api/s/${SID}/state`)],
    ["the connect route", await request(`/api/s/${SID}/grants/connect`, { method: "POST", body: "{}" })],
    ["a 403 without a cookie", await plain(`/api/s/${SID}/state`)],
    ["an M6 refusal", await plain("/api/session", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })],
  ];
  for (const [what, response] of answers) assertNoFraming(response, what);
  assert.equal(answers[0]![1].status, 200);
  // /connect/dock keeps its own fuller policy, which already forbids framing.
  assert.match(answers[1]![1].headers.get("content-security-policy") ?? "", /^default-src 'self'; script-src 'self' 'unsafe-inline'.*frame-ancestors 'none'/);
  // A profiles typo refuses every agent path early (profilesRefusal): covered too, the middleware runs first.
  assertNoFraming(await worker.fetch(new Request(`${ORIGIN}/.well-known/apc.json`), { ...workerEnv, APC_PROFILES: "drect" }), "a profiles refusal");
  // An error inside a handler, which Hono answers with a 500.
  const broken = { ...workerEnv, FEED: { idFromName: (name: string) => name, get: () => ({ isOwner: async () => { throw new Error("feed down"); } }) } };
  const error = (await worker.fetch(new Request(`${ORIGIN}/api/s/${SID}/state`, { headers: { cookie: `apc_signals=${SID}.${"1".repeat(32)}` } }), broken)) as Response;
  assert.equal(error.status, 500);
  assertNoFraming(error, "a 500");
});

test("public/_headers sets the same framing headers on what the assets answer first (the page, its files, the SPA fallback)", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const rules = headers.split("\n").filter((l) => !l.startsWith("#") && l.trim());
  assert.deepEqual(rules, ["/*", "  Content-Security-Policy: frame-ancestors 'none'", "  X-Frame-Options: DENY", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer"]);
  // The Worker's last route hands unknown paths it runs first for to the assets: without the binding, a 500.
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"assets": \{[^}]*"binding": "ASSETS"/);
});
