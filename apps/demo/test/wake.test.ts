/**
 * Wake on pin in Direct mode (TIN-973, experimental): Pulse wakes a Grok bot agent connected to it directly through the
 * agent's own Grok Bot webhook, with the wake engine from @tineira/apc-server and the dock's rules. Run for real: the
 * Sandbox on Node's SQLite (durableObjectRoom), the webhook and the hub stubbed at fetch, the clock mocked.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { WAKE_DAY_MAX } from "@tineira/apc-server";
import { demoDataset } from "../src/model/demo-world.ts";
import { HUB, SID } from "./dock-lifecycle.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const WEBHOOK = "https://api2.cursor.sh/automations/webhook/99c9ef5d-fff0-4abc-9def-0123456789ab";
const KEY = "test-key-0123456789abcdef";
const RING = { url: `${HUB}/apc/ring/${"a".repeat(32)}`, id: "pr_ring0123456789" };
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const customers = demoDataset().customers;
const target = (i = 0) => ({ kind: "customer", id: customers[i]!.id, part: null, params: null });

interface Engine {
  idle(): Promise<void>;
  stopAll(): void;
  nextDue(): number | null;
  view(id: string): { status: string | null } | null;
}

/** A Pulse sandbox with one Direct agent whose client says `client` (Grok bot sends "Cursor"), and the webhook stubbed. */
async function pulse(t: TestContext, client = "Cursor") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-17T12:00:00.000Z") });
  const sent: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const rings: unknown[] = [];
  const hook = { answer: 202, hold: false, aborted: 0, release: () => {} };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://api2.cursor.sh/")) {
      sent.push({ url: request.url, authorization: request.headers.get("authorization"), body: (await request.json()) as Record<string, unknown> });
      if (hook.hold) {
        await new Promise<void>((resolve, reject) => {
          hook.release = resolve;
          init?.signal?.addEventListener("abort", () => {
            hook.aborted++;
            reject(new Error("aborted"));
          });
        });
      }
      return new Response(null, { status: hook.answer });
    }
    if (request.url === `${HUB}/apc/pair`) return Response.json({ ...ACK, ring: RING });
    if (request.url === RING.url) {
      rings.push(await request.json());
      return Response.json({ ok: true });
    }
    return new Response("no", { status: 500 });
  });
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  const { owner } = await sandbox.init();
  const engine = (sandbox as unknown as { wake: Engine }).wake;
  /** A Direct agent: its grant, and its MCP calls as its client makes them. */
  const connect = async (name: string) => {
    const grant = (await sandbox.addAgentGrant()) as { id: string; secret: string };
    const mcp = (body: unknown, signal?: AbortSignal): Promise<Response> =>
      sandbox.fetch(new Request(`${ORIGIN}/mcp/${SID}/${grant.secret}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }));
    const init = await (await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.0.0" } } })).json();
    const callTool = async (tool: string, args: Record<string, unknown> = {}) => (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })).json()).result;
    const seen = async () => {
      const again = await (await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.0.0" } } })).json();
      const list = await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).json();
      return { instructions: String(again.result.instructions), tools: list.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, { type?: string }> } }> };
    };
    return { id: grant.id, instructions: String(init.result.instructions), mcp, callTool, seen };
  };
  const agent = await connect(client);
  /** A dock agent dropped here and paired (its grant is a dock grant), pinned on the drop. */
  const dockGrant = async () => {
    const drop = { hub: HUB, agent: "ag_grok", ticket: `${"d".repeat(32)}.${"3".repeat(16)}`, target: target() };
    const asked = await sandbox.pairHub(SID, ORIGIN, drop, true);
    const done = await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }, true);
    assert.equal(done.ok, true, done.error);
    return done.grant_id as string;
  };
  /** Time passes, and the work it set off ends. */
  const pass = async (ms: number) => {
    t.mock.timers.tick(ms);
    await engine.idle();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await engine.idle();
  };
  const wakeKeys = () => (room.db.prepare("select key from apc_kv where key like 'wake%' order by key").all() as Array<{ key: string }>).map((r) => r.key);
  const grantState = async (id: string) => ((await sandbox.state()) as { grants: Array<{ id: string; wake_offer: boolean; wake: { url_tail: string; status: string | null } | null }> }).grants.find((g) => g.id === id)!;
  return { sandbox, room, owner, engine, agent, connect, dockGrant, sent, rings, hook, pass, wakeKeys, grantState };
}

test("Wake on pin is offered only for a Grok bot agent on a Direct grant, and the owner's routes take only this sandbox's Direct grants", async (t) => {
  const p = await pulse(t);
  assert.equal((await p.grantState(p.agent.id)).wake_offer, true);
  const seen = await p.agent.seen();
  assert.ok(seen.tools.some((x) => x.name === "wake_on_pin"));
  assert.match(seen.instructions, /Pulse can wake you/);
  assert.deepEqual(await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY }), { ok: true });

  const other = await p.connect("claude-code");
  assert.equal((await p.grantState(other.id)).wake_offer, false);
  assert.ok(!(await other.seen()).tools.some((x) => x.name === "wake_on_pin"));
  assert.ok(!other.instructions.includes("wake_on_pin"));
  assert.deepEqual(await p.sandbox.setWake(other.id, { url: WEBHOOK, key: KEY }), { ok: false, error: "not_offered" });

  // A dock grant is the dock's to wake, even when its client says Grok bot.
  const dock = await p.dockGrant();
  p.room.db.prepare("update grants set client_name = 'Cursor' where id = ?").run(dock);
  assert.equal((await p.grantState(dock)).wake_offer, false);
  for (const id of [dock, "g_ffffffff", "../g_1", "ag_0123"]) {
    assert.deepEqual(await p.sandbox.setWake(id, { url: WEBHOOK, key: KEY }), { ok: false, error: "unknown_grant" }, id);
    assert.deepEqual(await p.sandbox.testWake(id), { ok: false, error: "unknown_grant" }, id);
    assert.deepEqual(await p.sandbox.clearWake(id), { ok: false, error: "unknown_grant" }, id);
  }
  assert.ok(!p.wakeKeys().some((k) => k.includes(dock) || k.includes("ffffffff")), "a refused route writes nothing");
});

test("a pin on a Grok bot Direct agent wakes it once, after it settles: Bearer key, a body that names nothing; the page and the log never see the key or the URL", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: `Bearer ${KEY}` });
  await p.sandbox.pin(p.agent.id, target());
  await p.pass(1_000);
  assert.equal(p.sent.length, 0, "not before it settles");
  await p.pass(1_500);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0]!.url, WEBHOOK);
  assert.equal(p.sent[0]!.authorization, `Bearer ${KEY}`);
  assert.deepEqual({ ...p.sent[0]!.body, at: null }, { v: 1, event: "pin", kind: "pin", at: null });
  const view = (await p.grantState(p.agent.id)).wake!;
  assert.deepEqual([view.url_tail, view.status], ["6789ab", "ok"]);
  await p.sandbox.testWake(p.agent.id);
  for (const said of [JSON.stringify(await p.sandbox.state()), await p.sandbox.eventsJsonl(), JSON.stringify(await p.agent.callTool("wake_on_pin"))]) {
    assert.ok(!said.includes(KEY));
    assert.ok(!said.includes("99c9ef5d-fff0"));
  }
});

test("a pin taken off before its wake was due wakes nobody, nor does one the agent was handed", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  await p.sandbox.pin(p.agent.id, target());
  await p.pass(500);
  await p.sandbox.unpin(p.agent.id);
  await p.pass(5_000);
  assert.equal(p.sent.length, 0, "unpinned");
  await p.sandbox.pin(p.agent.id, target(1));
  await p.pass(300);
  await p.agent.callTool("get_current_view");
  await p.pass(5_000);
  assert.equal(p.sent.length, 0, "handed over");
});

test("a dock grant's pin never POSTs a webhook from Pulse; a Direct grant linked to it still wakes", async (t) => {
  const p = await pulse(t);
  const dock = await p.dockGrant();
  // Even with a webhook row under the dock grant's id (none can be set through the routes), with a wake already due on it,
  // Pulse never wakes it: a pin there makes nothing due, and the alarm drops what is.
  const row = { gen: "x", url: WEBHOOK, key: KEY, created_at: "x", sent_at: null, status: null, status_at: null, pending_at: Date.now(), pending_kind: "pin", pending_source: dock, due: Date.now(), delivered_at: null, delivered_event: null, delivered_outcome: null, delivered_code: null };
  p.room.db.prepare("insert into apc_kv (key, value) values (?, ?)").run(`wake:${dock}`, JSON.stringify(row));
  p.room.db.prepare("update grants set client_name = 'Cursor' where id = ?").run(dock);
  await p.sandbox.pin(dock, target(1));
  await p.sandbox.alarm();
  await p.pass(5_000);
  assert.equal(p.sent.length, 0);

  // apc_link: the same agent both ways. A pin on its Direct grant is still Pulse's to wake for.
  p.room.db.prepare("insert into apc_kv (key, value) values (?, ?), (?, ?)").run(`link:${p.agent.id}`, dock, `link:${dock}`, p.agent.id);
  assert.deepEqual(((await p.sandbox.state()) as { links: Array<[string, string]> }).links, [[p.agent.id, dock]]);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  await p.sandbox.pin(p.agent.id, target());
  await p.pass(3_000);
  assert.equal(p.sent.length, 1);
});

test("a sandbox sends at most 200 a day across its grants: a new grant gets no fresh budget", async (t) => {
  const p = await pulse(t);
  const second = await p.connect("Cursor");
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  await p.sandbox.setWake(second.id, { url: WEBHOOK, key: KEY });
  p.room.db.prepare("insert into apc_kv (key, value) values ('wake_budget:sandbox', ?)").run(JSON.stringify({ day: "2026-11-17", count: WAKE_DAY_MAX - 1 }));
  assert.deepEqual(await p.sandbox.testWake(p.agent.id), { ok: true, status: "ok" });
  assert.deepEqual(await p.sandbox.testWake(second.id), { ok: false, error: "limit" });
  await p.sandbox.pin(second.id, target());
  await p.pass(3_000);
  assert.equal(p.sent.length, 1);
  assert.equal((await p.grantState(second.id)).wake?.status, "limit");
});

test("revoking a grant cuts its POST in flight and deletes its webhook, hint and decline", async (t) => {
  const p = await pulse(t);
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake?.state, "off");
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  p.hook.hold = true;
  const testing = p.sandbox.testWake(p.agent.id);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.sent.length, 1);
  assert.ok(p.wakeKeys().includes(`wake:${p.agent.id}`));
  assert.equal((await p.sandbox.revokeGrant(p.agent.id)).ok, true);
  assert.equal(p.hook.aborted, 1);
  await testing;
  assert.deepEqual(p.wakeKeys().filter((k) => k.endsWith(p.agent.id) && !k.startsWith("wake_budget:")), []);
});

test("wake_on_pin: a zod input, Pulse's own routine and page, last_delivery while on, and the offer in results once a day until declined", async (t) => {
  const p = await pulse(t);
  const tool = (await p.agent.seen()).tools.find((x) => x.name === "wake_on_pin")!;
  assert.equal(tool.inputSchema.properties?.declined?.type, "boolean");
  assert.equal((await p.agent.callTool("wake_on_pin", { declined: "yes" })).isError, true, "checked by its schema");
  const off = (await p.agent.callTool("wake_on_pin")).structuredContent;
  assert.equal(off.wake, "off");
  assert.equal(off.routine.name, "Wake on Pulse pin", "never the dock's routine");
  assert.match(off.routine.instructions, /get_current_view on the Pulse connector/);
  assert.equal(off.paste_at, `${ORIGIN}/agents#wake-${p.agent.id}`);

  // The offer rides on get_current_view at most once a day.
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake?.state, "off");
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake, undefined, "not again the same day");
  // A day later (the sandbox lives 6 hours from its last use: the day is moved, not waited).
  p.room.db.prepare("update apc_kv set value = ? where key = ?").run(String(Date.now() - 24 * 3_600_000), `wake_hint:${p.agent.id}`);
  assert.match((await p.agent.callTool("get_current_view")).structuredContent.wake?.hint, /so Pulse can start a run/);
  // Declined: no offer in results or instructions again; the tool still answers.
  assert.equal((await p.agent.callTool("wake_on_pin", { declined: true })).structuredContent.declined, true);
  p.room.db.prepare("update apc_kv set value = ? where key = ?").run(String(Date.now() - 48 * 3_600_000), `wake_hint:${p.agent.id}`);
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake, undefined);
  assert.ok(!(await p.agent.seen()).instructions.includes("wake_on_pin"));
  assert.equal((await p.agent.callTool("wake_on_pin")).structuredContent.wake, "off");

  // On: the last call to the webhook, never the URL or the key.
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  assert.equal((await p.agent.callTool("wake_on_pin")).structuredContent.last_delivery, null);
  await p.sandbox.testWake(p.agent.id);
  const on = (await p.agent.callTool("wake_on_pin")).structuredContent;
  assert.deepEqual({ ...on.last_delivery, at: null }, { at: null, event: "test", outcome: "ok", http_status: 202 });
  assert.ok(!JSON.stringify(on).includes(KEY));
});

test("the alarm: an early wake alarm delivers and wipes nothing, the expiry alarm stays, a touch does not push a wake out, Start over wipes", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  const expires = async () => Date.parse(((await p.sandbox.state()) as { expires_at: string }).expires_at);
  await p.sandbox.pin(p.agent.id, target());
  const due = p.engine.nextDue()!;
  assert.equal(p.room.alarm, due, "the alarm is set for the wake");
  // Any request touches the sandbox: the wake's alarm stays.
  assert.equal(await p.sandbox.isOwner(p.owner), true);
  assert.equal(p.room.alarm, due);
  // The object was evicted before its timer: its alarm delivers, and the sandbox and its agents stay.
  p.engine.stopAll();
  t.mock.timers.tick(3_000);
  await p.sandbox.alarm();
  await p.pass(0);
  assert.equal(p.sent.length, 1);
  assert.equal((await p.grantState(p.agent.id)).wake?.status, "ok");
  assert.equal(p.room.alarm, await expires(), "the expiry alarm is set again");
  // Start over deletes everything, the webhook with it.
  assert.equal(await p.sandbox.reset(), true);
  assert.deepEqual(p.wakeKeys(), []);
  assert.equal(((await p.sandbox.state()) as { grants: unknown[] }).grants.length, 0);
});

test("the alarm at the sandbox's end deletes it, its webhooks with it", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  t.mock.timers.tick(6 * 3_600_000 + 1);
  await p.sandbox.alarm();
  assert.deepEqual(p.wakeKeys(), []);
  assert.equal(p.room.db.prepare("select count(*) as n from grants").get()!.n, 0);
});

// ---- the review's test gaps (TIN-981) ----

/** Let the requests and timers already started run as far as they can without the clock moving. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("the offer rides only on a real answer: a refused wait, a cancelled or hung-up wait and an error neither carry it nor spend the day's", async (t) => {
  const p = await pulse(t);
  const hintKey = `wake_hint:${p.agent.id}`;
  const call = (id: number, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    p.agent.mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, signal);
  const resultOf = async (response: Response) => {
    const text = await response.text();
    return text ? (JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } }).result : undefined;
  };

  // The person does not share their view: a wait runs to its timeout (on the mocked clock), never ended by a closed page.
  await p.sandbox.setSetting("share_view", false);
  // A wait that holds the place...
  const waiting = call(7, "wait_for_focus", { timeout_s: 45 });
  await settle();
  // ...makes a second one within the claim gap a refused wait: retry_after_s, and no offer.
  const refused = await resultOf(await call(8, "wait_for_focus", { timeout_s: 45 }));
  assert.equal(typeof refused?.structuredContent?.retry_after_s, "number");
  assert.equal(refused?.structuredContent?.wake, undefined, "a refused wait carries no offer");
  assert.ok(!p.wakeKeys().includes(hintKey), "nor spends the day's");

  // The first wait is cancelled by notifications/cancelled, in a POST of its own.
  await p.agent.mcp({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user" } });
  const cancelled = await resultOf(await waiting);
  assert.equal(cancelled?.structuredContent?.wake, undefined, "a cancelled wait carries no offer");
  assert.ok(!p.wakeKeys().includes(hintKey), "nor spends the day's");

  // A wait whose client hung up (the request aborted).
  await p.pass(30_000);
  const hangUp = new AbortController();
  const hungUp = call(9, "wait_for_focus", { timeout_s: 45 }, hangUp.signal);
  await settle();
  hangUp.abort();
  await hungUp.then(resultOf, () => undefined);
  await settle();
  assert.ok(!p.wakeKeys().includes(hintKey), "a hung-up wait spends nothing");

  // An error (out of range: the tool's schema refuses it).
  await p.pass(30_000);
  const bad = await resultOf(await call(10, "wait_for_focus", { timeout_s: 99_999 }));
  assert.equal(bad?.isError, true);
  assert.equal(bad?.structuredContent?.wake, undefined);
  assert.ok(!p.wakeKeys().includes(hintKey), "an error spends nothing");

  // The first real answer still carries it.
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake?.state, "off");
  assert.ok(p.wakeKeys().includes(hintKey));
});

test("wake_on_pin checks again at call time: an agent adopted as another client gets not_offered, and its next wake is paused", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  // Another product on the same URL raises a conflict; the client stays Grok bot until the person answers it.
  await p.agent.mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } } });
  assert.equal((await p.grantState(p.agent.id)).wake_offer, true);
  // The request registers wake_on_pin while the client says Grok bot; the person adopts the newcomer while the call runs.
  const sandbox = p.sandbox as unknown as { log(type: string, grantId: string | null, data: Record<string, unknown>): void };
  const log = sandbox.log.bind(sandbox);
  t.mock.method(sandbox, "log", (type: string, grantId: string | null, data: Record<string, unknown>) => {
    log(type, grantId, data);
    if (type === "inbound" && data.tool === "wake_on_pin") void p.sandbox.resolveConflict(p.agent.id, "adopt");
  });
  const answer = await p.agent.callTool("wake_on_pin");
  assert.equal(answer.isError, true);
  assert.equal(answer.structuredContent.error, "not_offered");
  assert.equal((await p.grantState(p.agent.id)).wake_offer, false, "adopted: no longer Grok bot");

  // The webhook stays (Turn off stays reachable), but the next wake is paused, not sent.
  await p.sandbox.pin(p.agent.id, target());
  await p.pass(3_000);
  assert.equal(p.sent.length, 0);
  assert.equal((await p.grantState(p.agent.id)).wake?.status, "paused");
});

test("a wake is put off while a call of that grant is in flight, and goes once the call ends", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  // A wait that is in flight but has not looked yet: its claim is held until the test lets it answer (refused).
  let answerClaim = () => {};
  const slots = (p.sandbox as unknown as { waitSlots: { for(id: string): unknown } }).waitSlots;
  t.mock.method(slots, "for", () => ({
    atomic: true,
    claim: () => new Promise((resolve) => (answerClaim = () => resolve({ retryAfterS: 1 }))),
    holds: async () => false,
    release: async () => false,
  }));
  const waiting = p.agent.callTool("wait_for_focus", { timeout_s: 45 });
  await settle();
  await p.sandbox.pin(p.agent.id, target());
  await p.pass(2_500);
  assert.equal(p.sent.length, 0, "not while the call is in flight");
  await p.pass(10_000);
  assert.equal(p.sent.length, 0, "put off again and again while it lasts");
  answerClaim();
  await waiting;
  // The call ended (its count went back to zero): the next try sends it.
  await p.pass(3_500);
  assert.equal(p.sent.length, 1);
});

test("the start-up cleanup of a deploy without Direct purges the leftover grant's webhook and hint", async (t) => {
  const p = await pulse(t);
  assert.equal((await p.agent.callTool("get_current_view")).structuredContent.wake?.state, "off");
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  assert.deepEqual(p.wakeKeys().filter((k) => k.endsWith(p.agent.id)), [`wake:${p.agent.id}`, `wake_hint:${p.agent.id}`]);
  // The object starts again on a deploy that offers only the Dock profile: the Direct grant is a leftover and goes.
  const again = new Sandbox(p.room.ctx, { ...DEPLOY, APC_PROFILES: "dock" });
  await again.isOwner(p.owner);
  assert.equal(p.room.db.prepare("select count(*) as n from grants where id = ?").get(p.agent.id)!.n, 0);
  assert.deepEqual(p.wakeKeys().filter((k) => k.endsWith(p.agent.id)), [], "its webhook and hint go with it");
});

test("an owner's wake route sweeps first: a dock grant past its time ends there, its wake keys with it", async (t) => {
  const p = await pulse(t);
  const dock = await p.dockGrant();
  const row = { gen: "x", url: WEBHOOK, key: KEY, created_at: "x", sent_at: null, status: null, status_at: null, pending_at: null, pending_kind: null, pending_source: null, due: null, delivered_at: null, delivered_event: null, delivered_outcome: null, delivered_code: null };
  p.room.db.prepare("insert into apc_kv (key, value) values (?, ?), (?, ?)").run(`wake:${dock}`, JSON.stringify(row), `wake_hint:${dock}`, String(Date.now()));
  // Still in handoff long after T_connect: overdue, but nothing has swept it yet.
  await (p.sandbox as unknown as { advanceDockClock(ms: number): Promise<void> }).advanceDockClock(24 * 3_600_000);
  assert.deepEqual(await p.sandbox.setWake(dock, { url: WEBHOOK, key: KEY }), { ok: false, error: "unknown_grant" });
  assert.equal(p.room.db.prepare("select count(*) as n from grants where id = ?").get(dock)!.n, 0, "the route ended it");
  assert.deepEqual(p.wakeKeys().filter((k) => k.endsWith(dock)), [], "and purged its webhook and hint");
});

test("the owner's wake routes through the Worker: the session cookie, the Origin check, and each answer's status", async (t) => {
  const p = await pulse(t);
  const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
  const env = { ...DEPLOY, SANDBOX: { idFromName: (name: string) => name, get: (id: string) => (id === SID ? p.sandbox : assert.fail(`no sandbox ${id}`)) } };
  const cookie = `apc_session=${SID}.${p.owner}`;
  const json = { "content-type": "application/json" };
  const post = async (path: string, headers: Record<string, string>, body: unknown = {}) => {
    const r = (await worker.fetch(new Request(`${ORIGIN}/api/s/${SID}/grants/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env)) as Response;
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const owner = { ...json, cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const id = p.agent.id;

  // Not the owner, or not the page: refused before the sandbox is asked.
  for (const path of [`${id}/wake`, `${id}/wake/clear`, `${id}/wake/test`]) {
    assert.deepEqual(await post(path, json, { url: WEBHOOK, key: KEY }), { status: 403, body: { error: "forbidden" } }, path);
    assert.deepEqual(await post(path, { ...json, cookie: `apc_session=${SID}.${"0".repeat(32)}` }, { url: WEBHOOK, key: KEY }), { status: 404, body: { error: "sandbox_expired" } }, path);
    assert.deepEqual(await post(path, { ...owner, origin: "https://evil.test" }, { url: WEBHOOK, key: KEY }), { status: 403, body: { error: "origin_not_allowed" } }, path);
    assert.deepEqual(await post(path, { ...owner, "content-type": "text/plain" }, { url: WEBHOOK, key: KEY }), { status: 415, body: { error: "json_required" } }, path);
  }
  assert.equal(p.wakeKeys().length, 0, "nothing was set");

  // The owner: set, test, clear, each with its status.
  assert.deepEqual(await post(`${id}/wake`, owner, { url: "https://evil.test/automations/webhook/x", key: KEY }), { status: 400, body: { ok: false, error: "invalid" } });
  assert.deepEqual(await post("g_ffffffff/wake", owner, { url: WEBHOOK, key: KEY }), { status: 400, body: { ok: false, error: "unknown_grant" } });
  assert.deepEqual(await post(`${id}/wake/test`, owner), { status: 400, body: { ok: false, error: "no_webhook" } });
  assert.deepEqual(await post(`${id}/wake`, owner, { url: WEBHOOK, key: KEY }), { status: 200, body: { ok: true } });
  assert.deepEqual(await post(`${id}/wake/test`, owner), { status: 200, body: { ok: true, status: "ok" } });
  assert.equal(p.sent.length, 1);
  assert.deepEqual(await post(`${id}/wake/test`, owner), { status: 400, body: { ok: false, error: "too_soon" } });
  assert.deepEqual(await post(`${id}/wake/clear`, owner), { status: 200, body: { ok: true } });
  assert.deepEqual(await post("g_ffffffff/wake/clear", owner), { status: 400, body: { ok: false, error: "unknown_grant" } });
  assert.equal((await p.grantState(id)).wake, null);
});

test("a wake whose grant is no longer Direct is dropped as not live, not paused as if its client had changed", async (t) => {
  const p = await pulse(t);
  await p.sandbox.setWake(p.agent.id, { url: WEBHOOK, key: KEY });
  await p.sandbox.pin(p.agent.id, target());
  // Before it is due, a dock holds the grant (its link is there and live): the pin is now the dock's to wake for.
  p.room.db.prepare("insert into hub_links (hub, agent, grant_id, created_at, state) values (?, 'ag_x', ?, ?, 'live')").run(HUB, p.agent.id, new Date().toISOString());
  await p.pass(3_000);
  assert.equal(p.sent.length, 0);
  assert.equal(p.engine.view(p.agent.id)!.status, null, "dropped, not marked paused");
  assert.equal(p.engine.nextDue(), null);
});
