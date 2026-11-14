/**
 * Hardening of the reference hub from the APC 1.0 review (TIN-911): no app's redirect is followed, a pin dated ahead
 * of the hub's clock is never taken, a grant the app did not take back is tried again and every grant goes back
 * before the dock's data does, secrets stay out of the logs, the dock's socket answers on its own path only, a
 * reader request alone never unpairs a browser, and a join request carries a number both screens show.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { durableObjectRoom } from "@tineira/apc-conformance/workers";
import { fakeApp, PULSE, world, type FakeApp, type Json } from "./hostile-world.ts";
import { loggable, redactSecrets } from "../src/worker/redact.ts";
import { LIMITS } from "../src/worker/trust.ts";

const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { JoinCodes } = await import(new URL("../src/worker/join-codes.ts", import.meta.url).href);
const { default: app } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const SHOP = "https://shop.example";
const MARKET = "https://market.example";
const ELSEWHERE = "https://elsewhere.example";
const EXTENSION = `chrome-extension://${"a".repeat(32)}`;
const CODE = "K7M4P2";
const grantUrl = (a: FakeApp) => `${a.origin}/mcp/${"c".repeat(32)}`;
const redirect = () => new Response(null, { status: 307, headers: { location: `${ELSEWHERE}/caught` } });

/** Shop and Market as verified apps, and an origin a redirect would lead to, whose every request is counted. */
async function verifiedWorld(t: TestContext) {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP},${MARKET}`, READER_ORIGINS: EXTENSION });
  const shop = fakeApp(SHOP, "Shop");
  const market = fakeApp(MARKET, "Market");
  const elsewhere = fakeApp(ELSEWHERE, "Elsewhere");
  for (const a of [shop, market, elsewhere]) w.apps.set(a.origin, a);
  const pair = async (a: FakeApp) => {
    const who = await w.agent();
    const { ticket } = await w.hub.ticket(who.id);
    const answer = await w.hub.pair({ ticket, agent: who.id, app: { name: a.name, origin: a.origin }, mcp_url: grantUrl(a), pairing_code: CODE });
    assert.equal(answer.ok, true, answer.error);
    assert.deepEqual(await w.hub.decide(answer.pairing_id, "approve", CODE), { ok: true });
    return answer.pairing_id as string;
  };
  const givebacks = () => w.hubRoom.db.prepare("select * from givebacks").all() as Json[];
  /** Every give-back due now, as the alarm finds them. */
  const due = () => w.hubRoom.db.prepare("update givebacks set next_at = 0").run();
  const revokes = (a: FakeApp) => a.calls.filter((c) => c === "/apc/revoke").length;
  return { ...w, shop, market, elsewhere, pair, givebacks, due, revokes };
}

// ---- F14: no redirect is followed, verified app or not ----

test("a verified app's redirect is a failure: the hub's MCP call and its give-back never reach the redirect's target", async (t) => {
  const w = await verifiedWorld(t);
  const id = await w.pair(w.shop);
  w.shop.respond = (method, params) => (method === "tools/call" && params.name === "get_figure" ? redirect() : undefined);
  const result = await w.callHub("shop__get_figure");
  assert.equal(result.isError, true, "the call failed");
  w.shop.revoke = redirect;
  assert.deepEqual(await w.hub.decide(id, "unpair"), { ok: true });
  await w.hub.idle();
  assert.equal(w.hits.get(ELSEWHERE), undefined, "nothing the hub sent, the grant included, reached the target");
  assert.deepEqual(w.elsewhere.calls, []);
});

// ---- F6: a pin dated ahead is never taken, verified app or not ----

test("a verified app's pin dated ahead of the hub's clock is not taken, so another app's pin still wins the focus", async (t) => {
  const w = await verifiedWorld(t);
  await w.pair(w.shop);
  await w.pair(w.market);
  const pin = (a: FakeApp, at: string) => ({ kind: "customer", id: `${a.name}-1`, part: null, params: null, app_url: `${a.origin}/`, pinned_at: at, next: "get_figure", next_args: {} });
  w.shop.focus = pin(w.shop, "2999-12-31T00:00:00.000Z");
  await w.callHub("get_current_view");
  assert.equal((await w.agent()).focus, null, "the pin dated ahead was not taken");
  w.market.focus = pin(w.market, new Date().toISOString());
  await w.callHub("get_current_view");
  assert.equal((await w.agent()).focus?.app.origin, MARKET, "the other app's pin, dated now, is the focus");
  // A pin with no real time is not taken either; one a moment ahead (clock skew) is.
  w.shop.focus = pin(w.shop, "not a time");
  await w.callHub("get_current_view");
  assert.equal((await w.agent()).focus?.app.origin, MARKET);
  w.shop.focus = pin(w.shop, new Date(Date.now() + 2_000).toISOString());
  await w.callHub("get_current_view");
  assert.equal((await w.agent()).focus?.app.origin, SHOP);
});

// ---- F7: give-backs are retried, and every grant goes back before the dock's data ----

test("a give-back the app did not take is tried again on the alarm until it is taken", async (t) => {
  const w = await verifiedWorld(t);
  const id = await w.pair(w.shop);
  w.shop.revoke = () => new Response("down", { status: 503 });
  assert.deepEqual(await w.hub.decide(id, "unpair"), { ok: true });
  assert.equal(w.revokes(w.shop), 1);
  assert.deepEqual(w.givebacks().map((g) => [g.mcp_url, g.attempts]), [[grantUrl(w.shop), 0]], "kept to try again");
  assert.ok(Number(w.givebacks()[0]!.next_at) >= Date.now() + LIMITS.giveBackRetryMs[0]! - 1_000, "not before its time");
  assert.equal(w.hubRoom.alarm, Number(w.givebacks()[0]!.next_at), "the dock's one alarm rings for it: nothing else is due sooner");
  await w.hub.alarm();
  assert.equal(w.revokes(w.shop), 1, "not due yet: nothing sent");
  w.due();
  await w.hub.alarm();
  assert.equal(w.revokes(w.shop), 2, "tried again");
  assert.equal(w.givebacks()[0]!.attempts, 1);
  w.shop.revoke = undefined;
  w.due();
  await w.hub.alarm();
  assert.equal(w.revokes(w.shop), 3);
  assert.deepEqual(w.givebacks(), [], "taken: nothing left to try");
});

test("give-back retries are bounded, and a grant paired again is never given back from the old try", async (t) => {
  const w = await verifiedWorld(t);
  w.shop.revoke = () => new Response("down", { status: 503 });
  await w.hub.decide(await w.pair(w.shop), "unpair");
  for (let i = 0; i < LIMITS.giveBackRetryMs.length + 3; i++) {
    w.due();
    await w.hub.alarm();
  }
  assert.equal(w.revokes(w.shop), 1 + LIMITS.giveBackRetryMs.length - 1 + 1, "the first try, then one per retry step");
  assert.deepEqual(w.givebacks(), [], "the tries ran out");
  // Failed again, then the app pairs the same grant again: the retry leaves it alone.
  await w.hub.decide(await w.pair(w.shop), "unpair");
  assert.equal(w.givebacks().length, 1);
  await w.pair(w.shop);
  assert.deepEqual(w.givebacks(), [], "the new pairing holds that grant");
  const sent = w.revokes(w.shop);
  w.due();
  await w.hub.alarm();
  assert.equal(w.revokes(w.shop), sent);
});

test("a 404 or another 4xx is final: the hub does not try that give-back again; a 429 is tried again", async (t) => {
  const w = await verifiedWorld(t);
  w.shop.revoke = () => Response.json({ error: "not_found" }, { status: 404 });
  await w.hub.decide(await w.pair(w.shop), "unpair");
  assert.deepEqual(w.givebacks(), [], "a 404: nothing kept");
  w.market.revoke = () => new Response("slow down", { status: 429 });
  await w.hub.decide(await w.pair(w.market), "unpair");
  assert.deepEqual(w.givebacks().map((g) => g.mcp_url), [grantUrl(w.market)]);
  w.market.revoke = () => new Response("gone", { status: 410 });
  w.due();
  await w.hub.alarm();
  assert.deepEqual(w.givebacks(), [], "a final answer on a retry ends it too");
});

test("the give-backs kept to try again are capped, the oldest dropped first", async (t) => {
  const w = await verifiedWorld(t);
  w.shop.revoke = () => new Response("down", { status: 503 });
  const who = await w.agent();
  for (let i = 0; i < 53; i++) {
    const { ticket } = await w.hub.ticket(who.id);
    const answer = await w.hub.pair({ ticket, agent: who.id, app: { name: w.shop.name, origin: SHOP }, mcp_url: `${SHOP}/mcp/${i.toString(16).padStart(32, "0")}`, pairing_code: CODE });
    assert.equal(answer.ok, true, answer.error);
    await w.hub.decide(answer.pairing_id, "deny");
  }
  const kept = w.givebacks().map((g) => String(g.mcp_url));
  assert.equal(kept.length, 50);
  assert.equal(kept.includes(`${SHOP}/mcp/${"0".repeat(32)}`), false, "the oldest went");
  assert.equal(kept.includes(`${SHOP}/mcp/${(52).toString(16).padStart(32, "0")}`), true, "the newest stays");
});

test("Start over, and an expiring dock, give back the grants still to retry as well as the live ones", async (t) => {
  const w = await verifiedWorld(t);
  w.shop.revoke = () => new Response("down", { status: 503 });
  await w.hub.decide(await w.pair(w.shop), "unpair");
  assert.equal(w.givebacks().length, 1, "one kept to retry, and no pairing holds it");
  await w.pair(w.market);
  w.shop.revoke = undefined;
  await w.hub.reset();
  assert.deepEqual([w.revokes(w.shop), w.revokes(w.market)], [2, 1], "Start over: the queued one again, and the live one");
  // The same for a dock that expires with a give-back still queued.
  const v = await verifiedWorld(t);
  v.shop.revoke = () => new Response("down", { status: 503 });
  await v.hub.decide(await v.pair(v.shop), "unpair");
  v.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() - 1));
  await v.hub.alarm();
  assert.equal(v.revokes(v.shop), 2, "expiry: the queued one tried once more before the data went");
});

test("a dock that expires gives every grant back before its data goes", async (t) => {
  const w = await verifiedWorld(t);
  await w.pair(w.shop);
  await w.pair(w.market);
  w.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() - 1));
  await w.hub.alarm();
  assert.deepEqual([w.revokes(w.shop), w.revokes(w.market)], [1, 1]);
  assert.equal(w.hubRoom.db.prepare("select count(*) as n from pairings").get()!.n, 0, "and then the data went");
});

test("a dock found expired by a request, before its alarm, gives every grant back too", async (t) => {
  const w = await verifiedWorld(t);
  await w.pair(w.shop);
  w.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() - 1));
  const who = (await w.hubRoom.db.prepare("select id from agents").get()) as { id: string };
  await w.hub.reader({ ticket: "x", agent: who.id }, EXTENSION);
  await w.hub.idle();
  assert.equal(w.revokes(w.shop), 1);
});

// ---- F8: secrets stay out of the logs ----

test("the dock's Workers keep no invocation logs, and what the dock logs carries no secret", () => {
  for (const name of ["dock", "demo", "signals"]) {
    const config = readFileSync(new URL(`../../${name}/wrangler.jsonc`, import.meta.url), "utf8");
    assert.match(config, /"observability": \{ "enabled": true, "logs": \{ "invocation_logs": false \} \}/, `${name}: invocation logs record each request URL`);
  }
  const did = "d".repeat(32);
  const secret = "e".repeat(32);
  const said = loggable(new TypeError(`fetch failed: https://apc.example/mcp/${did}/${secret} and https://shop.example/mcp/${secret}?x=1, ticket ${did}.${secret}`));
  assert.equal(said.includes(secret), false, said);
  assert.match(said, /fetch failed: https:\/\/apc\.example\/mcp\/\[redacted\] and https:\/\/shop\.example\/mcp\/\[redacted\]\?x=1, ticket \[redacted\]/);
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
  assert.equal(redactSecrets(`"https://signals.example/mcp/grant_Ab-9xYz" failed`), `"https://signals.example/mcp/[redacted]" failed`, "a grant secret in any alphabet");
  assert.equal(redactSecrets(`GET /x?token=abc-DEF_1&k=zz ok`), "GET /x?token=[redacted]&k=[redacted] ok", "a secret in a query value");
  assert.equal(redactSecrets(`tok_${"A1".repeat(16)} rd_${"b".repeat(32)}.${"C".repeat(32)}`), "tok_[redacted] rd_[redacted]", "hex glued to _ and in upper case");
});

test("an agent's MCP request logs nothing, even when it fails: the platform stamps any record with the URL", async (t) => {
  const said: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => void said.push(args));
  const did = "d".repeat(32);
  const secret = "e".repeat(32);
  // The Worker: the dock's object throws.
  const env: Json = { ASSETS: { fetch: async () => new Response("asset") }, HUB: { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error(`boom at /mcp/${did}/${secret}`); } }) } };
  const answer: Response = await app.request(`https://dock.test/mcp/${did}/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, env);
  assert.equal(answer.status, 500);
  // The dock's object: its MCP handler throws.
  const w = await world(t);
  const first = await w.agent();
  (w.hub as { mcp: unknown }).mcp = async () => { throw new Error(`boom at ${first.mcp_url}`); };
  const inside: Response = await w.hub.fetch(new Request(`https://dock.test${new URL(first.mcp_url).pathname}`, { method: "POST", body: "{}" }));
  assert.equal(inside.status, 500);
  assert.deepEqual(said, [], "nothing was logged");
});

// ---- F5: a reader request alone never unpairs a browser ----

test("a new reader request leaves the browser already paired as it is until the person allows the new one", async (t) => {
  const w = await verifiedWorld(t);
  const who = await w.agent();
  const ask = async () => {
    const { ticket } = await w.hub.ticket(who.id);
    return (await w.hub.reader({ ticket, agent: who.id, label: "Chrome on Windows" }, EXTENSION)).claim as string;
  };
  const readers = async () => ((await w.agent()).pairings as Json[]).filter((p) => p.kind === "reader");
  const claim = await ask();
  await w.hub.decide((await readers())[0]!.id, "approve");
  const token = (await w.hub.readerStatus({ claim }, EXTENSION)).token as string;
  const reading = { reading: { url: "https://news.example/a", title: "A", text: "Hello", element: null } };
  assert.equal((await w.hub.reading(reading, token, EXTENSION)).ok, true);
  // Another request for the same agent and extension: the paired browser keeps sending.
  const second = await ask();
  assert.deepEqual((await readers()).map((r) => r.status).sort(), ["paired", "pending"]);
  assert.equal((await w.hub.reading(reading, token, EXTENSION)).ok, true, "a request alone unpaired nothing");
  // A third request (one sent with another drop's ticket) leaves the second one waiting too.
  const third = await ask();
  assert.deepEqual((await readers()).map((r) => r.status).sort(), ["paired", "pending", "pending"], "the earlier request still waits");
  assert.equal((await w.hub.readerStatus({ claim: second }, EXTENSION)).status, "pending");
  // Allowed: the one the person allows replaces every other.
  const secondId = (await readers()).filter((r) => r.status === "pending")[0]!.id;
  await w.hub.decide(secondId, "approve");
  assert.equal((await readers()).length, 1);
  assert.equal((await w.hub.readerStatus({ claim: third }, EXTENSION)).status, "denied", "the other request went");
  assert.equal((await w.hub.reading(reading, token, EXTENSION)).error, "not_paired");
  const fresh = (await w.hub.readerStatus({ claim: second }, EXTENSION)).token as string;
  assert.equal((await w.hub.reading(reading, fresh, EXTENSION)).ok, true);
});

// ---- The Worker: F13 and F12 ----

function namespace(make: (ctx: unknown) => unknown) {
  const objects = new Map<string, unknown>();
  return { idFromName: (name: string) => name, get: (name: string) => (objects.has(name) ? objects : objects.set(name, make(durableObjectRoom().ctx))).get(name) };
}
function workerEnv() {
  const env: Json = { ASSETS: { fetch: async () => new Response("asset") } };
  env.HUB = namespace((ctx) => new Hub(ctx, env));
  env.JOIN_CODES = namespace((ctx) => new JoinCodes(ctx, env));
  return env;
}
const ORIGIN = "https://dock.test";
function browser(env: Json, userAgent: string) {
  let cookie = "";
  const send = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r: Response = await app.request(
      `${ORIGIN}${path}`,
      body === undefined ? { headers: { cookie, "user-agent": userAgent, ...headers } } : { method: "POST", headers: { cookie, "user-agent": userAgent, "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) },
      env,
    );
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.replace(/^apc_dock=$/, "");
    return { status: r.status, json: (await r.json().catch(() => null)) as Json };
  };
  return { send, secret: () => cookie.split(".")[1]! };
}

test("the dock's socket answers on its own path only: never through an agent's MCP path, with a header the caller sent", async () => {
  const env = workerEnv();
  const a = browser(env, "Mozilla/5.0 (Windows NT 10.0) Chrome/156.0.0.0");
  const did = (await a.send("/api/dock/new", {})).json.did as string;
  const forged = await a.send(`/mcp/${did}/ws`, undefined, { "x-apc-owner": a.secret(), upgrade: "websocket" });
  assert.equal(forged.status, 404);
  const hub = (env.HUB as { get: (n: string) => { fetch: (r: Request) => Promise<Response> } }).get(did);
  const direct = await hub.fetch(new Request(`${ORIGIN}/mcp/${did}/ws`, { headers: { "x-apc-owner": a.secret(), upgrade: "websocket" } }));
  assert.equal(direct.status, 404, "the dock's object takes /ws on its own path only");
  // The owner's socket refuses another origin before it reads the cookie (TIN-865).
  assert.equal((await a.send(`/api/d/${did}/ws`, undefined, { origin: "https://pulse.apc.tineira.com", upgrade: "websocket" })).status, 403);
});

test("a join request carries a number both screens show, so the person compares more than the joiner's own label", async () => {
  const env = workerEnv();
  const a = browser(env, "Mozilla/5.0 (Windows NT 10.0) Chrome/156.0.0.0");
  const b = browser(env, "Mozilla/5.0 (Macintosh) Firefox/140.0");
  const did = (await a.send("/api/dock/new", {})).json.did as string;
  const code = (await a.send(`/api/d/${did}/link`, {})).json.code as string;
  const asked = await b.send("/api/dock/join", { code });
  assert.match(String(asked.json.check), /^\d{4}$/, "the joining computer shows a number");
  const joins = (await a.send(`/api/d/${did}/state`)).json.joins as Json[];
  assert.equal(joins[0]!.check, asked.json.check, "the request on the linked computer shows the same one");
  assert.equal(asked.json.check === undefined, false);
});

