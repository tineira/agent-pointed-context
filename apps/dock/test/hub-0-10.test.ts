/**
 * The reference hub meets APC 0.10 (TIN-892; the hub MUSTs H1 to H7 of the Dock profile as built, and the dock's
 * approving window). The real hub on Node's SQLite, with simulated apps (hostile-world.ts) whose every request is
 * counted, so "the hub sent nothing" is checked, not assumed.
 *
 * - H1: no `initialize`, `tools/list` or `tools/call` on a grant's MCP URL before the dock owner approved with the
 *   code; `initialize` first, always; nothing on an ended or revoked pairing.
 * - H2: `/apc/confirm` expires overdue requests before it answers.
 * - H3: `/apc/pair` replaces an unapproved pending request of the same agent and app.
 * - H4: the per-app idle flag, `idle: true` in `views[]`, the all-idle wait, and the `pairing` and `idle` errors relayed.
 * - H5: a 404 leaves an `ended` tombstone: `pairing_ended`, never `app_unreachable` or `unknown_app`.
 * - H6: the hub's instructions say what `idle`, `pairing` and `pairing_ended` mean.
 * - H7 is in apc-json.test.ts.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IDLE_MESSAGE, PAIRING_MESSAGE, idleCurrentView, idleWaitForFocus } from "@tineira/apc-protocol";
import { WAIT_PAGE_CLOSED_NOTE } from "@tineira/apc-server";
import { LIMITS } from "../src/worker/trust.ts";
import { asResult, fakeApp, PULSE, quickLimits, rpcAnswer, world, type FakeApp, type Json } from "./hostile-world.ts";

// After hostile-world.ts installed the Workers stand-in: hub.ts imports "cloudflare:workers".
const { HUB_INSTRUCTIONS } = (await import(new URL("../src/worker/hub.ts", import.meta.url).href)) as { HUB_INSTRUCTIONS: string };

const SHOP = "https://shop.example";
const MARKET = "https://market.example";
const CODE = "K7M4P2";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const grantUrl = (app: FakeApp, n = "c") => `${app.origin}/mcp/${n.repeat(32)}`;
/** A dock grant's tool error, as an app of APC 0.10 answers it: `{ error, message }` in the structured result and the text. */
const grantError = (error: "pairing" | "idle") => {
  const data = { error, message: error === "idle" ? IDLE_MESSAGE : PAIRING_MESSAGE };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
};
/** An app whose grant is asleep (dormant): the idle shapes for the core tools, the idle error for its own. */
const asleep = (method: string, params: Json) => {
  if (method !== "tools/call") return null;
  if (params.name === "get_current_view") return rpcAnswer(asResult({ ...idleCurrentView() }));
  if (params.name === "wait_for_focus") return rpcAnswer(asResult({ ...idleWaitForFocus() }));
  return rpcAnswer(grantError("idle"));
};

/** Shop and Market as verified apps (in APP_ORIGINS), so a plain "approve" with the code is the person's yes. */
async function shopWorld(t: TestContext, env: Json = {}) {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP},${MARKET}`, ...env });
  const shop = fakeApp(SHOP, "Shop");
  const market = fakeApp(MARKET, "Market");
  w.apps.set(SHOP, shop);
  w.apps.set(MARKET, market);
  /** The app asks to pair, as after its owner's Allow. */
  const ask = async (app: FakeApp = shop, over: Json = {}, agentIndex = 0) => {
    const who = await w.agent(agentIndex);
    const { ticket } = await w.hub.ticket(who.id);
    const body = { ticket, agent: who.id, app: { name: app.name, origin: app.origin }, mcp_url: grantUrl(app), pairing_code: CODE, ...over };
    return { ticket, body, answer: (await w.hub.pair(body)) as { ok: boolean; error?: string; pairing_id?: string } };
  };
  /** Asked and approved in the dock with the code. */
  const pair = async (app: FakeApp = shop, over: Json = {}) => {
    const asked = await ask(app, over);
    assert.equal(asked.answer.ok, true, asked.answer.error);
    assert.deepEqual(await w.hub.decide(asked.answer.pairing_id!, "approve", CODE), { ok: true });
    return asked.answer.pairing_id!;
  };
  const lines = async (agentIndex = 0) => (await w.agent(agentIndex)).pairings as Json[];
  const line = async (id: string) => (await w.state()).agents.flatMap((a: Json) => a.pairings as Json[]).find((p: Json) => p.id === id);
  const row = (id: string) => w.hubRoom.db.prepare("select * from pairings where id = ?").get(id) as Json | undefined;
  /** What the app was sent over MCP: every method and tool, without the give-backs. */
  const mcp = (app: FakeApp) => app.calls.filter((c) => c !== "/apc/revoke");
  return { ...w, shop, market, ask, pair, lines, line, row, mcp };
}

/** Everything an agent and the dock can make the hub do with its pairings. */
async function exercise(w: Awaited<ReturnType<typeof shopWorld>>) {
  await w.state();
  await w.listHub();
  await w.callHub("get_current_view");
  await w.callHub("wait_for_focus", { timeout_s: 1 });
  await w.callHub("list_app_tools");
  await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  await w.callHub("shop__get_figure");
  await w.hub.setBadge((await w.agent()).id, `data:image/png;base64,${"A".repeat(40)}`);
  await w.hub.alarm();
  await w.hub.idle();
}

// ---- H1 ----

test("H1: a pending request is sent nothing over MCP, whatever the agent and the dock do, wrong codes included", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const { answer } = await w.ask();
  assert.equal(answer.ok, true, answer.error);
  await exercise(w);
  assert.deepEqual(w.shop.calls, [], "pending: no initialize, no tools/list, no tools/call");
  for (const left of [4, 3]) assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: left });
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve"), { ok: false, error: "pairing_code_required" });
  await exercise(w);
  assert.deepEqual(w.shop.calls, [], "wrong and missing codes reach the app with nothing");
  assert.equal(w.hits.get(SHOP), 1, "the one request it got is the hub reading its apc.json");
  // The right code: initialize is the first thing the app hears, then tools/list.
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve", CODE), { ok: true });
  assert.deepEqual(w.shop.calls.slice(0, 2), ["initialize", "tools/list"]);
  assert.ok(w.row(answer.pairing_id!)!.introduced_at, "the hub recorded that the app answered its initialize");
});

test("H1: a pairing whose initialize never succeeded is sent initialize first, and nothing else until the app answers it", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  // The app fails every initialize: the approval settles (as the hub does when the introduction fails), but the app is still in handoff.
  w.shop.respond = (method) => (method === "initialize" ? new Response("busy", { status: 503 }) : null);
  const { answer } = await w.ask();
  const id = answer.pairing_id!;
  // The yes stands, and the answer says the app is not connected yet: the dock keeps showing "connecting".
  assert.deepEqual(await w.hub.decide(id, "approve", CODE), { ok: true, connecting: true });
  assert.equal(w.row(id)!.status, "paired");
  assert.deepEqual([(await w.line(id)).status, (await w.line(id)).approving], ["pending", true], "never shown as paired before the app answered initialize");
  assert.equal(w.row(id)!.introduced_at, null);
  await exercise(w);
  assert.ok(w.shop.calls.length > 0);
  assert.deepEqual([...new Set(w.shop.calls)], ["initialize"], "only initialize was ever sent: no tools/list, no tools/call");
  const relayed = await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  assert.equal(JSON.parse(relayed.content[0].text).error, "app_unreachable");
  // The app answers now: initialize first, then the rest.
  w.shop.respond = undefined;
  w.shop.calls.length = 0;
  const read = await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  assert.equal(read.isError, undefined, JSON.stringify(read));
  assert.equal(w.shop.calls[0], "initialize", "introduced before anything else");
  assert.equal(w.shop.calls.filter((c) => c === "initialize").length, 1, "once");
  assert.ok(w.shop.calls.includes("get_figure"));
  assert.ok(w.row(id)!.introduced_at);
});

test("H1: an approval settled by the alarm without its introduction (the object was evicted) introduces itself on first use", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const { answer } = await w.ask();
  // As an eviction mid-introduction leaves it: approving in storage, the code accepted, nothing sent.
  w.hubRoom.db.prepare("update pairings set status = 'approving', pairing_code = null, approved_at = ? where id = ?").run(new Date(Date.now() - LIMITS.approvingMs - 1000).toISOString(), answer.pairing_id!);
  // No try of the hub's own left (as after the last one): the first use is what introduces it.
  const saved = LIMITS.introRetryMs;
  LIMITS.introRetryMs = [];
  t.after(() => (LIMITS.introRetryMs = saved));
  await w.hub.alarm();
  assert.equal((await w.line(answer.pairing_id!)).status, "paired");
  assert.equal(w.shop.calls.length, 0, "settled without a call");
  await w.callHub("get_current_view");
  assert.equal(w.shop.calls[0], "initialize");
  assert.ok(w.shop.calls.indexOf("initialize") < w.shop.calls.indexOf("get_current_view"));
});

test("H1: an approval the alarm settles without its introduction is introduced by that alarm: initialize first, then tools/list", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const { answer } = await w.ask();
  w.hubRoom.db.prepare("update pairings set status = 'approving', pairing_code = null, approved_at = ? where id = ?").run(new Date(Date.now() - LIMITS.approvingMs - 1000).toISOString(), answer.pairing_id!);
  await w.hub.alarm();
  assert.deepEqual(w.mcp(w.shop), ["initialize", "tools/list"]);
  assert.deepEqual([(await w.line(answer.pairing_id!)).status, (await w.line(answer.pairing_id!)).approving], ["paired", undefined]);
  assert.ok(w.row(answer.pairing_id!)!.introduced_at);
});

// ---- the approving window ----

test("while the hub is introducing itself the request takes no code: one typed then is not counted, and the first yes still pairs", async (t) => {
  const w = await shopWorld(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  w.shop.respond = (method) => (method === "initialize" ? held.then(() => rpcAnswer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Shop", version: "1" } })) : null);
  const { answer } = await w.ask();
  const id = answer.pairing_id!;
  assert.deepEqual(await w.hub.decide(id, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  const approving = w.hub.decide(id, "approve", CODE);
  await sleep(20);
  const line = await w.line(id);
  assert.equal(line.status, "pending");
  assert.equal(line.approving, true, "the dock shows it as connecting");
  assert.equal(line.code, undefined, "and asks for no code");
  // More tries than a request allows, right and wrong, with and without a code: none counted, none a wrong code.
  for (const code of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE", "FFFFFF", CODE, undefined, "x"]) {
    assert.deepEqual(await w.hub.decide(id, "approve", code), { ok: false, error: "approving" }, String(code));
  }
  assert.equal(w.row(id)!.code_attempts, 1, "the count is where it was");
  assert.equal(w.row(id)!.status, "approving", "the request is still there");
  assert.equal(w.shop.calls.filter((c) => c === "initialize").length, 1, "and the app heard one initialize");
  release();
  assert.deepEqual(await approving, { ok: true });
  assert.equal((await w.line(id)).status, "paired");
});

// ---- H2 ----

test("H2: /apc/confirm expires an overdue request before it answers: not_paired, with the ticket still good", async (t) => {
  const saved = LIMITS.pairingCodeMs;
  LIMITS.pairingCodeMs = 60;
  t.after(() => (LIMITS.pairingCodeMs = saved));
  const w = await shopWorld(t);
  const { answer, body } = await w.ask();
  const who = await w.agent();
  const first = await w.hub.ticket(who.id);
  assert.equal((await w.hub.confirm({ ticket: first.ticket, agent: who.id, mcp_url: body.mcp_url })).status, "pending", "in time, it is pending");
  await sleep(90);
  // No alarm rang and nobody opened the dock: confirm itself ends the request.
  const { ticket } = await w.hub.ticket(who.id);
  assert.deepEqual(await w.hub.confirm({ ticket, agent: who.id, mcp_url: body.mcp_url }), { ok: false, error: "not_paired" });
  assert.equal(await w.line(answer.pairing_id!), undefined, "the request went");
  assert.deepEqual(await w.hub.confirm({ ticket, agent: who.id, mcp_url: body.mcp_url }), { ok: false, error: "not_paired" }, "the ticket was not spent: the app can pair with it");
  await w.hub.idle();
  assert.deepEqual(w.shop.calls, ["/apc/revoke"], "its grant was given back, after the answer");
  // And the ticket pairs.
  assert.equal((await w.hub.pair({ ...body, ticket })).ok, true);
});

// ---- H3 ----

test("H3: a second /apc/pair of the same agent and app replaces the unapproved request: one line, a new code, a count from 0, the old grant given back", async (t) => {
  const w = await shopWorld(t);
  const first = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "a"), pairing_code: "AAAAAA" });
  assert.deepEqual(await w.hub.decide(first.answer.pairing_id!, "approve", "ZZZZZZ"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  const second = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b"), pairing_code: "BBBBBB" });
  assert.equal(second.answer.ok, true, second.answer.error);
  assert.notEqual(second.answer.pairing_id, first.answer.pairing_id);
  assert.deepEqual((await w.lines()).map((p) => p.id), [second.answer.pairing_id], "one pending request for the pair");
  assert.equal(w.row(first.answer.pairing_id!), undefined);
  assert.equal(w.row(second.answer.pairing_id!)!.code_attempts, 0, "the new request's count starts at 0");
  // The old request and its code are gone.
  assert.deepEqual(await w.hub.decide(first.answer.pairing_id!, "approve", "AAAAAA"), { ok: false, error: "unknown_pairing" });
  assert.deepEqual(await w.hub.decide(second.answer.pairing_id!, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  await w.hub.idle();
  assert.deepEqual(w.shop.calls, ["/apc/revoke"], "the replaced grant went back to the app, once, and nothing else was sent");
  assert.deepEqual(await w.hub.decide(second.answer.pairing_id!, "approve", "BBBBBB"), { ok: true });
});

test("H3: the old URL is given back after the answer, and only when it differs from the new one", async (t) => {
  const w = await shopWorld(t);
  // The app holds its /apc/revoke: the hub's answer to /apc/pair must not wait on it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  w.shop.revoke = () => held.then(() => Response.json({ ok: true }));
  await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "a") });
  const answered = await Promise.race([w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") }).then((r) => r.answer.ok), sleep(1000).then(() => "waited on the give-back")]);
  assert.equal(answered, true, "answered while the give-back was still out");
  assert.deepEqual(w.shop.calls, ["/apc/revoke"]);
  release();
  await w.hub.idle();
  // The same grant again (the app sent its URL twice): replaced, and not given back.
  w.shop.calls.length = 0;
  const again = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b"), pairing_code: "CCCCCC" });
  assert.equal(again.answer.ok, true);
  await w.hub.idle();
  assert.deepEqual(w.shop.calls, [], "no give-back of the grant the new request carries");
  assert.equal((await w.lines()).length, 1);
  assert.deepEqual(await w.hub.decide(again.answer.pairing_id!, "approve", "CCCCCC"), { ok: true });
});

test("H3: the replaced request holds no place under the cap, and another agent's or app's request is not replaced", async (t) => {
  const saved = LIMITS.pairings;
  LIMITS.pairings = 2;
  t.after(() => (LIMITS.pairings = saved));
  const w = await shopWorld(t);
  await w.hub.addAgent();
  const first = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "a") });
  const other = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "d") }, 1);
  assert.equal(other.answer.ok, true, "another agent's request for the same app stands beside it");
  // At the cap: a new app is refused, the same pair's new request is not (it takes the replaced one's place).
  assert.deepEqual((await w.ask(w.market)).answer, { ok: false, error: "too_many_apps" });
  const second = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.equal(second.answer.ok, true, second.answer.error);
  assert.equal(w.row(first.answer.pairing_id!), undefined);
  assert.ok(w.row(other.answer.pairing_id!), "the other agent's request was not touched");
  assert.equal(w.hubRoom.db.prepare("select count(*) as n from pairings").get()!.n, 2);
});

test("H3: an approving or a paired pairing is never replaced", async (t) => {
  const w = await shopWorld(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  w.shop.respond = (method) => (method === "initialize" ? held.then(() => rpcAnswer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Shop", version: "1" } })) : null);
  const first = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "a") });
  const approving = w.hub.decide(first.answer.pairing_id!, "approve", CODE);
  await sleep(20);
  const second = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.equal(second.answer.ok, true, second.answer.error);
  assert.equal(w.row(first.answer.pairing_id!)!.status, "approving", "the approved request stands");
  assert.equal((await w.lines()).length, 2);
  release();
  assert.deepEqual(await approving, { ok: true });
  // Paired now: a third request replaces the pending second one only.
  const third = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "e") });
  assert.equal(third.answer.ok, true, third.answer.error);
  assert.equal(w.row(first.answer.pairing_id!)!.status, "paired");
  assert.equal(w.row(second.answer.pairing_id!), undefined);
  assert.deepEqual((await w.lines()).map((p) => p.status).sort(), ["paired", "pending"]);
});

// ---- H4 ----

test("H4: an app that is asleep is flagged: idle: true in views[], cleared by its next answer without it", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const id = await w.pair();
  w.shop.respond = asleep;
  const view = (await w.callHub("get_current_view")).structuredContent;
  assert.deepEqual(view.views, [{ app: { id: "shop", name: "Shop", origin: SHOP }, view: null, idle: true }]);
  assert.equal(w.row(id)!.idle, 1);
  assert.equal(w.row(id)!.page_open, null, "idle says nothing of the page: never page closed");
  assert.equal((await w.line(id)).idle, true, "the dock knows it too");
  // Awake again: the flag goes with the next answer that lacks idle.
  w.shop.respond = undefined;
  const awake = (await w.callHub("get_current_view")).structuredContent;
  assert.equal(awake.views[0].idle, undefined);
  assert.ok(awake.views[0].view);
  assert.equal(w.row(id)!.idle, 0);
});

test("H4: when every paired app is asleep, wait_for_focus answers exactly the idle shape, and never that the person left", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  await w.pair();
  await w.pair(w.market);
  w.shop.respond = asleep;
  w.market.respond = asleep;
  const result = await w.callHub("wait_for_focus", { timeout_s: 5 });
  const s = result.structuredContent;
  assert.deepEqual(Object.keys(s).sort(), ["focus", "idle", "note", "page_open", "timed_out"]);
  assert.deepEqual({ ...s, note: "" }, { focus: null, timed_out: false, page_open: false, idle: true, note: "" });
  assert.match(s.note, /asleep/);
  assert.match(s.note, /wake when the person opens them/);
  assert.notEqual(s.note, WAIT_PAGE_CLOSED_NOTE);
  assert.deepEqual(JSON.parse(result.content[0].text), s, "the text says the same, with no then");
});

test("H4: an unverified app counts too: asleep alone, the wait answers the idle shape", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const evil = fakeApp("https://evil.example", "Evil", { respond: undefined });
  await w.pairApp(evil);
  evil.respond = asleep;
  const s = (await w.callHub("wait_for_focus", { timeout_s: 5 })).structuredContent;
  assert.equal(s.idle, true);
  assert.equal(s.timed_out, false);
  assert.equal(s.page_open, false);
  const views = (await w.callHub("get_current_view")).structuredContent.views;
  assert.equal(views[0].idle, true);
  assert.equal(views[0].untrusted, true);
});

test("H4: with a mixed fleet an idle answer never ends the wait early or reads as page closed; the answer names the apps asleep", async (t) => {
  quickLimits(t, 2000);
  const w = await shopWorld(t);
  await w.pair();
  await w.pair(w.market);
  w.shop.respond = asleep;
  // Market is awake, its page open: its wait runs its time and comes back empty.
  w.market.respond = (method, params) =>
    method === "tools/call" && params.name === "wait_for_focus" ? sleep(500).then(() => rpcAnswer(asResult({ focus: null, timed_out: true, page_open: true }))) : null;
  const started = Date.now();
  const s = (await w.callHub("wait_for_focus", { timeout_s: 2 })).structuredContent;
  assert.ok(Date.now() - started >= 450, `the hub waited on the app that is awake: ${Date.now() - started} ms`);
  assert.equal(s.idle, undefined, "not the all-idle answer");
  assert.equal(s.focus, null);
  assert.equal(s.timed_out, true);
  assert.equal(s.page_open, true, "the awake app's page, not the asleep one's silence");
  assert.deepEqual(s.asleep, ["shop"]);
  assert.match(s.note, /Asleep.*: shop\.$/);
  // The awake app's page closed: said as such, and the asleep app is still named, not counted as closed.
  w.market.respond = undefined;
  // The awake app's page closed while another app is asleep: never the closed page's "do not wait again", since the
  // app asleep wakes when the person opens it. No page_open (an app asleep says nothing of the page), the apps named.
  const closed = (await w.callHub("wait_for_focus", { timeout_s: 2 })).structuredContent;
  assert.deepEqual(Object.keys(closed).sort(), ["asleep", "focus", "note", "timed_out"]);
  assert.equal(closed.focus, null);
  assert.equal(closed.timed_out, false);
  assert.deepEqual(closed.asleep, ["shop"]);
  assert.notEqual(closed.note, WAIT_PAGE_CLOSED_NOTE);
  assert.doesNotMatch(closed.note, /do not call wait_for_focus again|do not wait again/);
  assert.match(closed.note, /Asleep \(the person is away from it; it wakes when opened again\): shop\.$/);
  // With no app asleep, a closed page is still said as before.
  w.shop.respond = undefined;
  await w.callHub("get_current_view");
  const plain = (await w.callHub("wait_for_focus", { timeout_s: 2 })).structuredContent;
  assert.deepEqual([plain.page_open, plain.asleep, plain.note], [false, undefined, WAIT_PAGE_CLOSED_NOTE]);
});

test("H4: an app's pairing and idle errors are relayed as tool errors: verbatim for a verified app, in the untrusted envelope for an unverified one", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const id = await w.pair();
  for (const error of ["idle", "pairing"] as const) {
    w.shop.respond = (method, params) => (method === "tools/call" && params.name === "get_figure" ? rpcAnswer(grantError(error)) : null);
    for (const relayed of [await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} }), await w.callHub("shop__get_figure")]) {
      assert.equal(relayed.isError, true, error);
      assert.deepEqual(relayed.structuredContent, { error, message: error === "idle" ? IDLE_MESSAGE : PAIRING_MESSAGE }, "the app's own answer");
      assert.deepEqual(JSON.parse(relayed.content[0].text), relayed.structuredContent, "in the text too");
    }
    assert.equal(w.row(id)!.idle, error === "idle" ? 1 : 0, "idle sets the app's flag; an answer without it clears it");
    assert.equal((await w.line(id)).status, "paired", "the pairing stands");
  }
  // Unverified: the same error, inside the envelope that marks it untrusted.
  const evil = fakeApp("https://evil.example", "Evil");
  await w.pairApp(evil);
  for (const error of ["idle", "pairing"] as const) {
    evil.respond = (method, params) => (method === "tools/call" && params.name === "get_figure" ? rpcAnswer(grantError(error)) : null);
    const relayed = await w.callHub("call_app_tool", { app: "evil_example", tool: "get_figure", args: {} });
    assert.equal(relayed.isError, true);
    assert.equal(relayed.structuredContent.untrusted, true);
    assert.equal(relayed.structuredContent.result.error, error);
    assert.equal(relayed.structuredContent.error, undefined, "never as the hub's own word");
    assert.notEqual(JSON.parse(relayed.content[0].text).error, "app_unreachable");
  }
});

// ---- H5 ----

test("H5: a 404 from a paired app leaves an ended tombstone: pairing_ended to the agent, never app_unreachable or unknown_app, and the app is called no more", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const id = await w.pair();
  await w.callHub("get_current_view");
  w.shop.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  const relayed = await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  assert.equal(relayed.isError, true);
  assert.equal(relayed.structuredContent.error, "pairing_ended");
  assert.match(relayed.structuredContent.message, /drops you on it again/);
  const line = await w.line(id);
  assert.equal(line.status, "ended");
  assert.equal(line.ended_by, "shop.example");
  assert.ok(line.ended_at);
  const row = w.row(id)!;
  assert.deepEqual([row.view, row.tools, row.page_open], [null, null, null], "nothing of the app's is kept");
  // From now on the hub does not call it, and still says pairing_ended (by either name of the tool).
  w.shop.calls.length = 0;
  for (const again of [await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} }), await w.callHub("shop__get_figure")]) {
    assert.equal(again.structuredContent.error, "pairing_ended");
  }
  await exercise(w);
  assert.deepEqual(w.shop.calls, [], "an ended pairing is never called, and never given back");
  assert.deepEqual((await w.callHub("get_current_view")).structuredContent.views, []);
  assert.equal((await w.listHub()).some((x) => x.name.startsWith("shop__")), false);
  // The dock's Allow on it says the same; its confirm says not_paired.
  assert.deepEqual(await w.hub.decide(id, "approve", CODE), { ok: false, error: "pairing_ended" });
  const who = await w.agent();
  const { ticket } = await w.hub.ticket(who.id);
  assert.deepEqual(await w.hub.confirm({ ticket, agent: who.id, mcp_url: grantUrl(w.shop) }), { ok: false, error: "not_paired" });
});

test("H5: the tombstone holds no place under the cap, is replaced by a re-pair (same app id), and Remove takes the line without a give-back", async (t) => {
  quickLimits(t);
  const saved = LIMITS.pairings;
  LIMITS.pairings = 1;
  t.after(() => (LIMITS.pairings = saved));
  const w = await shopWorld(t);
  const id = await w.pair();
  w.shop.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  await w.callHub("get_current_view");
  assert.equal((await w.line(id)).status, "ended");
  w.shop.respond = undefined;
  w.shop.calls.length = 0;
  // At a cap of one: the tombstone does not count, so another app pairs.
  const market = await w.ask(w.market);
  assert.equal(market.answer.ok, true, market.answer.error);
  assert.deepEqual(await w.hub.decide(market.answer.pairing_id!, "deny"), { ok: true });
  // The agent is dropped on Shop again: the new pairing replaces the ended line and keeps the app's id.
  const again = await w.pair(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.deepEqual((await w.lines()).map((p) => [p.id, p.status, (p.app as Json).id]), [[again, "paired", "shop"]]);
  assert.equal(w.shop.calls.includes("/apc/revoke"), false, "the ended grant was not given back");
  // Ended again, and removed by the person: the line goes, with no call to the app.
  w.shop.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  await w.callHub("get_current_view");
  w.shop.calls.length = 0;
  assert.deepEqual(await w.hub.decide(again, "unpair"), { ok: true });
  assert.deepEqual(await w.lines(), []);
  assert.deepEqual(w.shop.calls, []);
});

test("H5: a 404 while the hub is introducing itself (the grant ended in handoff) is pairing_ended, and the request becomes the ended line", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  w.shop.respond = (method) => (method === "initialize" ? Response.json({ error: "not_found" }, { status: 404 }) : null);
  const { answer } = await w.ask();
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve", CODE), { ok: false, error: "pairing_ended" });
  assert.equal((await w.line(answer.pairing_id!)).status, "ended");
  assert.deepEqual(w.shop.calls, ["initialize"], "one initialize, and no give-back: the grant is gone there already");
});

// ---- H6 ----

test("H6: the hub's instructions say what idle, pairing and pairing_ended mean", () => {
  assert.match(HUB_INSTRUCTIONS, /'idle'[^.]*idle: true[^.]*: the person is away from that app[^.]*\. Tell them, and do not retry/);
  assert.match(HUB_INSTRUCTIONS, /'pairing' from an app means the person has not finished pairing[^.]*: wait a little, or tell them/);
  assert.match(HUB_INSTRUCTIONS, /'pairing_ended'[^.]*drop you on that app again/);
});

// ---- the fix round on #169 ----

/** A gate an app's answer waits at: `held` resolves when the app got the request, `release()` lets it answer. */
function gate() {
  let release!: () => void;
  let arrived!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (arrived = resolve));
  return { held, release, wait: () => (arrived(), open) };
}

/** An app's answer to `initialize`. */
const INITIALIZED = () => rpcAnswer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Shop", version: "1" } });

/** Shop paired in storage with its `initialize` never answered, and no retry of the hub's own due: what its first use finds. */
async function neverIntroduced(t: TestContext) {
  quickLimits(t, 3000);
  const w = await shopWorld(t);
  w.shop.respond = (method) => (method === "initialize" ? new Response("busy", { status: 503 }) : null);
  const { answer } = await w.ask();
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve", CODE), { ok: true, connecting: true });
  await w.hub.idle();
  w.shop.calls.length = 0;
  return { w, id: answer.pairing_id! };
}

for (const [use, call] of [
  ["relay", (w: Awaited<ReturnType<typeof shopWorld>>) => w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} })],
  ["look", (w: Awaited<ReturnType<typeof shopWorld>>) => w.callHub("get_current_view")],
  ["list", (w: Awaited<ReturnType<typeof shopWorld>>) => w.callHub("list_app_tools")],
] as const) {
  test(`H1: a Deny while the app's initialize answer is held (first ${use} of a never-introduced pairing) sends the app nothing more`, async (t) => {
    const { w, id } = await neverIntroduced(t);
    const g = gate();
    w.shop.respond = (method) => (method === "initialize" ? g.wait().then(() => INITIALIZED()) : null);
    const running = call(w);
    await g.held;
    assert.deepEqual(await w.hub.decide(id, "deny"), { ok: true });
    g.release();
    await running;
    await w.hub.idle();
    assert.deepEqual(w.mcp(w.shop), ["initialize"], "after the Deny: no tools/call, no get_current_view, no tools/list");
    assert.equal(w.row(id), undefined);
  });
}

test("H1: a 404 that ends the pairing while its initialize answer is held sends the app nothing more", async (t) => {
  const { w, id } = await neverIntroduced(t);
  const g = gate();
  w.shop.respond = (method) => (method === "initialize" ? g.wait().then(() => INITIALIZED()) : null);
  const running = w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  await g.held;
  // As a concurrent call's 404 leaves it: the ended tombstone (markEnded), while the introduction is still out.
  w.hubRoom.db.prepare("update pairings set status = 'ended', ended_at = ? where id = ?").run(new Date().toISOString(), id);
  g.release();
  const answer = await running;
  await w.hub.idle();
  assert.deepEqual(w.mcp(w.shop), ["initialize"]);
  assert.equal(JSON.parse(answer.content[0].text).error, "pairing_ended");
  assert.equal(w.row(id)!.introduced_at, null, "an ended pairing is not recorded as introduced");
});

test("H1: the re-check before tools/call: a pairing back in approving (or held) when the call is about to leave is not called", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  const id = await w.pair();
  w.shop.calls.length = 0;
  // Introduced, so nothing is awaited before the re-check: only the re-check stands between this row and a tools/call.
  w.hubRoom.db.prepare("update pairings set status = 'approving' where id = ?").run(id);
  const hub = w.hub as unknown as { appCall(p: Json, tool: string, args: Json, ms: number): Promise<unknown>; pairings(): Json[] };
  const p = hub.pairings().find((x) => x.id === id)!;
  await assert.rejects(hub.appCall({ ...p, status: "paired" }, "get_figure", {}, 500));
  // Another grant's URL under the same pairing id is not this pairing either.
  w.hubRoom.db.prepare("update pairings set status = 'paired' where id = ?").run(id);
  await assert.rejects(hub.appCall({ ...p, status: "paired", mcp_url: grantUrl(w.shop, "d") }, "get_figure", {}, 500));
  assert.deepEqual(w.mcp(w.shop), [], "nothing left the hub");
  await hub.appCall({ ...p, status: "paired" }, "get_figure", {}, 500);
  assert.deepEqual(w.mcp(w.shop), ["get_figure"]);
  // The same re-check before tools/list: a pairing the app ended meanwhile, or another grant's URL, is not listed.
  const lister = w.hub as unknown as { appTools(p: Json): Promise<unknown> };
  w.shop.calls.length = 0;
  await assert.rejects(lister.appTools({ ...p, status: "paired", mcp_url: grantUrl(w.shop, "d") }));
  w.hubRoom.db.prepare("update pairings set status = 'ended' where id = ?").run(id);
  await assert.rejects(lister.appTools({ ...p, status: "paired" }));
  assert.deepEqual(w.mcp(w.shop), []);
});

/** The retry schedule shortened, and the row's approval moved back so a try is due. */
function quickRetries(t: TestContext, schedule: number[]) {
  const saved = LIMITS.introRetryMs;
  LIMITS.introRetryMs = schedule;
  t.after(() => (LIMITS.introRetryMs = saved));
}
const approvedAgo = (w: Awaited<ReturnType<typeof shopWorld>>, id: string, ms: number) => w.hubRoom.db.prepare("update pairings set approved_at = ? where id = ?").run(new Date(Date.now() - ms).toISOString(), id);

test("an introduction that failed is tried again by the alarm, and the dock says connecting until the app answered", async (t) => {
  quickRetries(t, [15_000, 45_000]);
  const { w, id } = await neverIntroduced(t);
  // Not due yet: the alarm sends nothing.
  await w.hub.alarm();
  assert.deepEqual(w.mcp(w.shop), []);
  assert.equal((await w.line(id)).approving, true);
  // A yes typed meanwhile is the connecting answer, never counted, never a second pairing.
  assert.deepEqual(await w.hub.decide(id, "approve", "AAAAAA"), { ok: false, error: "approving" });
  // Due, and the app still fails: one initialize, nothing else, still connecting.
  approvedAgo(w, id, 16_000);
  await w.hub.alarm();
  assert.deepEqual(w.mcp(w.shop), ["initialize"]);
  assert.deepEqual([w.row(id)!.intro_attempts, (await w.line(id)).status, (await w.line(id)).approving], [1, "pending", true]);
  // The same try is not made twice.
  await w.hub.alarm();
  await w.state();
  await w.hub.idle();
  assert.deepEqual(w.mcp(w.shop), ["initialize"]);
  // The second try finds the app answering: initialize, then tools/list, and only now the dock says paired.
  w.shop.respond = undefined;
  w.shop.calls.length = 0;
  approvedAgo(w, id, 46_000);
  await w.hub.alarm();
  assert.deepEqual(w.mcp(w.shop), ["initialize", "tools/list"]);
  const line = await w.line(id);
  assert.deepEqual([line.status, line.approving, line.error], ["paired", undefined, null]);
  assert.ok(w.row(id)!.introduced_at);
  await w.hub.alarm();
  assert.deepEqual(w.mcp(w.shop), ["initialize", "tools/list"], "introduced: no more tries");
});

test("without an alarm (vite dev) the retry rides on the next state, and after the last try the pairing shows its error", async (t) => {
  quickRetries(t, [15_000]);
  const { w, id } = await neverIntroduced(t);
  approvedAgo(w, id, 16_000);
  await w.state();
  await w.hub.idle();
  assert.deepEqual(w.mcp(w.shop), ["initialize"]);
  // No try left: the line is the paired one with its error, as before; the next use still introduces first.
  const line = await w.line(id);
  assert.deepEqual([line.status, line.approving], ["paired", undefined]);
  assert.match(String(line.error), /initialize/);
  await w.hub.alarm();
  await w.state();
  await w.hub.idle();
  assert.deepEqual(w.mcp(w.shop), ["initialize"], "the hub gave up trying on its own");
  w.shop.respond = undefined;
  w.shop.calls.length = 0;
  await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
  assert.equal(w.shop.calls[0], "initialize");
});

test("a Deny between tries stops them, and a 404 on a try ends the pairing", async (t) => {
  quickRetries(t, [15_000, 45_000]);
  const { w, id } = await neverIntroduced(t);
  assert.deepEqual(await w.hub.decide(id, "deny"), { ok: true });
  w.shop.calls.length = 0;
  await w.hub.alarm();
  await w.state();
  await w.hub.idle();
  assert.deepEqual(w.shop.calls, [], "nothing after the Deny");
  // Another pairing, whose grant ended at the app (T_connect) before the try.
  const second = await neverIntroduced(t);
  second.w.shop.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  approvedAgo(second.w, second.id, 16_000);
  await second.w.hub.alarm();
  assert.deepEqual(second.w.mcp(second.w.shop), ["initialize"]);
  assert.equal((await second.w.line(second.id)).status, "ended");
  approvedAgo(second.w, second.id, 46_000);
  await second.w.hub.alarm();
  assert.deepEqual(second.w.mcp(second.w.shop), ["initialize"], "an ended pairing is tried no more");
});

test("a request the dock has no room for leaves the Ended by and Revoked by lines as they were", async (t) => {
  quickLimits(t);
  const saved = LIMITS.pairings;
  t.after(() => (LIMITS.pairings = saved));
  const w = await shopWorld(t);
  const id = await w.pair();
  w.shop.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  await w.callHub("get_current_view");
  assert.equal((await w.line(id)).status, "ended");
  w.shop.respond = undefined;
  // The dock is full (Market holds its one place): Shop's new request is refused, and its ended line stays.
  await w.pair(w.market);
  LIMITS.pairings = 1;
  const refused = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.deepEqual([refused.answer.ok, refused.answer.error], [false, "too_many_apps"]);
  assert.equal((await w.line(id)).status, "ended", "the Ended by line is still there");
  // The same for a line the app revoked.
  w.hubRoom.db.prepare("update pairings set status = 'revoked', revoked_at = ? where id = ?").run(new Date().toISOString(), id);
  const again = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.equal(again.answer.error, "too_many_apps");
  assert.equal((await w.line(id)).status, "revoked");
  // With room, the request replaces the line.
  LIMITS.pairings = saved;
  const ok = await w.ask(w.shop, { mcp_url: grantUrl(w.shop, "b") });
  assert.equal(ok.answer.ok, true, ok.answer.error);
  assert.equal(await w.line(id), undefined);
});

test("an unverified app's request refused for its id (app_id_taken) leaves another app's ended line of that id", async (t) => {
  quickLimits(t);
  const w = await world(t);
  const first = fakeApp("https://a-b.example", "First");
  const asked = await w.pairApp(first);
  first.respond = () => Response.json({ error: "not_found" }, { status: 404 });
  await w.callHub("get_current_view");
  assert.equal((await w.pairingOf(first.origin)).status, "ended");
  // a.b.example maps to the same id as a-b.example: refused, and the first app's line stays.
  const second = await w.pairApp(fakeApp("https://a.b.example", "Second"), { approve: false });
  assert.deepEqual([second.ok, second.error], [false, "app_id_taken"]);
  assert.equal((await w.pairingOf(first.origin)).id, asked.pairing_id);
  assert.equal((await w.pairingOf(first.origin)).status, "ended");
});

test("H4: a verified app's attention, then and apc_link on its pairing or idle error do not reach the agent; the hub's own still ride", async (t) => {
  quickLimits(t);
  const w = await shopWorld(t);
  await w.pair();
  const extras = { attention: { focus: { kind: "x", id: "1" }, note: "the app's" }, then: "the app's then", apc_link: { code: "ABCDEF", note: "the app's link" } };
  for (const error of ["pairing", "idle"] as const) {
    const data = { error, message: error === "idle" ? IDLE_MESSAGE : PAIRING_MESSAGE };
    w.shop.respond = (method, params) =>
      method === "tools/call" && params.name === "get_figure"
        ? rpcAnswer({ content: [{ type: "text", text: JSON.stringify({ ...data, ...extras }) }, { type: "text", text: JSON.stringify({ apc_link: extras.apc_link }) }], structuredContent: { ...data, ...extras }, isError: true })
        : null;
    const relayed = await w.callHub("call_app_tool", { app: "shop", tool: "get_figure", args: {} });
    assert.equal(relayed.isError, true);
    assert.deepEqual(relayed.structuredContent, data, `${error}: the error itself, verbatim, and nothing of the app's envelope`);
    assert.deepEqual(relayed.content.map((c: Json) => JSON.parse(c.text as string)), [data]);
  }
  // The hub's own attention is added as on every result: a pin the hub holds unread rides on the relayed error.
  w.market.focus = { kind: "figure", id: "f1", part: null, params: null, app_url: `${MARKET}/`, pinned_at: new Date().toISOString(), next: "get_figure", next_args: {} };
  await w.pair(w.market);
  w.market.respond = (method, params) => (method === "tools/call" && params.name === "get_figure" ? rpcAnswer({ ...grantError("pairing"), structuredContent: { ...grantError("pairing").structuredContent, ...extras } }) : null);
  const withPin = await w.callHub("call_app_tool", { app: "market", tool: "get_figure", args: {} });
  assert.equal(withPin.structuredContent.error, "pairing");
  assert.equal(withPin.structuredContent.attention.focus.app.id, "market", "the hub's attention, about its own focus");
  assert.notEqual(withPin.structuredContent.attention.note, "the app's");
  assert.equal(withPin.structuredContent.apc_link, undefined);
  assert.notEqual(withPin.structuredContent.then, "the app's then");
});
