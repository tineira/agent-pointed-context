/**
 * Wake on pin (TIN-962, experimental), run for real: hub.ts on Node's SQLite, with a stand-in for what Cloudflare gives a
 * Durable Object, the webhook stubbed at fetch. The dock POSTs to a Grok Bot webhook trigger when the person points an
 * agent that is not calling: after a page reading, an app's ring, or a pairing turning paired that rang while pending.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ringBody, ringKey } from "@tineira/apc-server";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {};

const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);

const DID = "a".repeat(32);
const BROWSER = `chrome-extension://${"a".repeat(32)}`;
const WEBHOOK = "https://api2.cursor.sh/automations/webhook/99c9ef5d-fff0-4abc-9def-0123456789ab";
const KEY = "test-key-0123456789abcdef";
const APP_MCP = "https://pulse.test/mcp/s1/0123456789abcdef0123456789abcdef";
const reading = { reading: { url: "https://example.com/a", title: "A", element: { tag: "p", text: "Churn rose" } } };

interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** A hub with one agent whose client says it is Grok bot (or `client`), and the webhook stubbed: `answer` is its status. */
async function dock(t: TestContext, client = "Cursor") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-17T12:00:00.000Z") });
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: Array<string | number | null>) {
      if (query.trim().replace(/;\s*$/, "").includes(";")) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows };
    },
  };
  const tables = () => db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map((r) => String(r.name));
  const room = { alarm: null as number | null };
  const ctx = {
    storage: { sql, setAlarm: async (at: number) => void (room.alarm = at), deleteAll: async () => void tables().forEach((name) => db.exec(`drop table ${name}`)) },
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (work: () => unknown) => work(),
    getWebSockets: () => [],
  };
  const env = { READER_ORIGINS: BROWSER };
  const hub = new Hub(ctx, env);
  const { owner } = await hub.init(DID);
  const first = (await hub.state("https://dock.test")).agents[0];
  const mcp = (body: unknown) =>
    hub.fetch(new Request(`https://dock.test${new URL(first.mcp_url).pathname}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
  await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1.0.0" } } });

  const sent: Sent[] = [];
  /** `hold`: the webhook answers only when released, or fails when its request is aborted. */
  const hook = { answer: 202, hold: false, aborted: 0, release: () => {} };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api2.cursor.sh/")) return new Response("no", { status: 500 });
    sent.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
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
  });

  const allow = async (): Promise<string> => {
    const { ticket } = await hub.ticket(first.id);
    const { claim } = await hub.requestConnect({ ticket, agent: first.id, reader: true, label: "Chrome" }, BROWSER);
    const asked = (await hub.state("https://dock.test")).connects[0];
    await hub.approveConnect(asked.id, undefined, "https://dock.test");
    return (await hub.readerStatus({ claim }, BROWSER)).token;
  };
  /** A paired app, as the hub keeps one (introduced, so the hub does not call it). */
  const pairApp = (status = "paired", id = "pr_0123456789abcdef0123456789abcdef") => {
    const now = new Date().toISOString();
    db.prepare("insert into pairings (id, agent_id, app_id, app_name, app_origin, mcp_url, status, created_at, verified, approved_at, introduced_at) values (?, ?, 'pulse', 'Pulse', 'https://pulse.test', ?, ?, ?, 1, ?, ?)").run(id, first.id, APP_MCP, status, now, now, now);
    return id;
  };
  /** Time passes, and the work it set off ends. */
  const pass = async (ms: number) => {
    t.mock.timers.tick(ms);
    await hub.idle();
    await hub.idle();
  };
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return (await response.json()).result;
  };
  const wake = () => db.prepare("select * from wakes").all()[0] as Record<string, unknown> | undefined;
  const agentState = async () => (await hub.state("https://dock.test")).agents[0];
  const ring = async (id: string) => d_ring(hub, id);
  return { hub, db, ctx, env, room, owner, agent: first.id as string, sent, hook, allow, pairApp, pass, callTool, wake, agentState, ring };
}

/** A ring from the paired app `id`, signed as the app would (its MCP URL is APP_MCP). */
async function d_ring(hub: { ring(body: unknown): Promise<void> }, id: string) {
  await hub.ring(await ringBody({ url: `https://dock.test/apc/ring/${DID}`, id }, await ringKey(APP_MCP)));
}

test("a webhook is offered and taken only for Grok bot, only Grok Bot's trigger URL; the state never shows its key", async (t) => {
  const other = await dock(t, "claude-code");
  assert.equal((await other.agentState()).wake_offer, false);
  assert.deepEqual(await other.hub.setWake(other.agent, { url: WEBHOOK, key: KEY }), { ok: false, error: "not_offered" });
  t.mock.reset();

  const d = await dock(t);
  assert.equal((await d.agentState()).wake_offer, true);
  for (const url of ["https://evil.test/automations/webhook/99c9ef5d-fff0", "http://api2.cursor.sh/automations/webhook/99c9ef5d-fff0", `${WEBHOOK}?x=1`, `${WEBHOOK}/..`]) {
    assert.deepEqual(await d.hub.setWake(d.agent, { url, key: KEY }), { ok: false, error: "invalid" }, url);
  }
  assert.deepEqual(await d.hub.setWake(d.agent, { url: WEBHOOK, key: "short" }), { ok: false, error: "invalid" });
  assert.deepEqual(await d.hub.setWake(d.agent, { url: WEBHOOK, key: `Bearer ${KEY}` }), { ok: true });
  const state = JSON.stringify(await d.hub.state("https://dock.test"));
  assert.ok(!state.includes(KEY));
  assert.ok(!state.includes("99c9ef5d-fff0-4abc"));
  assert.equal((await d.agentState()).wake.url_tail, "6789ab");
  assert.equal(d.wake()!.key, KEY);
});

test("a page reading wakes Grok bot once, after it settles: Bearer key, and a body that names nothing", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(1_000);
  assert.equal(d.sent.length, 0, "not before it settles");
  await d.pass(1_500);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0]!.url, WEBHOOK);
  assert.equal(d.sent[0]!.authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(d.sent[0]!.body).sort(), ["at", "event", "kind", "v"]);
  assert.deepEqual({ ...d.sent[0]!.body, at: null }, { v: 1, event: "pin", kind: "page_reading", at: null });
  assert.equal((await d.agentState()).wake.status, "ok");

  // A second reading within 15 s of that wake waits for the gap, then wakes once.
  await d.hub.reading(reading, token, BROWSER);
  const w = d.wake()!;
  assert.equal(w.due, Number(w.sent_at) + 15_000);
  await d.pass(Number(w.due) - Date.now() - 100);
  assert.equal(d.sent.length, 1, "not before 15 s since the last wake");
  await d.pass(200);
  assert.equal(d.sent.length, 2);
});

test("a pin the agent was handed before the wake was due wakes nobody", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(300);
  await d.callTool("page__get_reading");
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
  assert.equal(d.wake()!.pending_at, null);
});

test("a call that only looked is no proof: the wake still goes", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.callTool("list_app_tools");
  await d.pass(5_000);
  assert.equal(d.sent.length, 1);
});

test("a refused key marks the webhook broken, and no wake goes until it is set again", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  d.hook.answer = 401;
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(3_000);
  assert.equal(d.sent.length, 1);
  assert.equal((await d.agentState()).wake.status, "broken");
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(60_000);
  assert.equal(d.sent.length, 1);
  // Set again: it starts clean, and a test is allowed.
  d.hook.answer = 202;
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: true, status: "ok" });
  assert.equal(d.sent.at(-1)!.body.event, "test");
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: false, error: "too_soon" });
});

test("a ring needs the grant's own key, a time within 5 minutes and a nonce never seen", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const id = d.pairApp();
  const key = await ringKey(APP_MCP);
  const ring = { url: `https://dock.test/apc/ring/${DID}`, id };

  await d.hub.ring(await ringBody(ring, await ringKey(`${APP_MCP}x`)));
  await d.hub.ring(await ringBody(ring, key, Date.now() - 301_000));
  await d.hub.ring({ ...(await ringBody(ring, key)), id: "pr_other" });
  assert.equal(d.wake()!.pending_at, null, "a wrong key, a stale time or another pairing is nothing");

  const good = await ringBody(ring, key);
  await d.hub.ring(good);
  assert.ok(d.wake()!.pending_at);
  await d.pass(3_000);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0]!.body.kind, "pin");
  // The same ring again is a replay.
  await d.hub.ring(good);
  assert.equal(d.wake()!.pending_at, null);
});

test("a pin from a pairing unpaired before its wake was due wakes nobody", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const id = d.pairApp();
  await d.hub.ring(await ringBody({ url: `https://dock.test/apc/ring/${DID}`, id }, await ringKey(APP_MCP)));
  d.db.prepare("delete from pairings where id = ?").run(id);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
});

test("a ring while the pairing waits for approval is held, and wakes once it is paired; an approval with no ring wakes nobody", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const quiet = d.pairApp("approving", "pr_quiet0123456789abcdef0123456789");
  const settle = (pid: string) => (d.hub as unknown as { settleNow(p: unknown): unknown; pairings(): Array<{ id: string }> }).settleNow((d.hub as unknown as { pairings(): Array<{ id: string }> }).pairings().find((p) => p.id === pid));
  settle(quiet);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);

  const id = d.pairApp("approving");
  await d.hub.ring(await ringBody({ url: `https://dock.test/apc/ring/${DID}`, id }, await ringKey(APP_MCP)));
  await d.pass(5_000);
  assert.equal(d.sent.length, 0, "not while it waits");
  settle(id);
  await d.pass(5_000);
  assert.equal(d.sent.length, 1);
});

test("a client that no longer says Grok bot pauses the webhook, and Turn off stays offered", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  d.db.prepare("update agents set client_name = 'claude-code'").run();
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
  const a = await d.agentState();
  assert.equal(a.wake_offer, false);
  assert.equal(a.wake.status, "paused");
  assert.deepEqual(await d.hub.clearWake(d.agent), { ok: true });
  assert.equal(d.wake(), undefined);
});

test("removing the agent deletes its webhook; so does the last computer leaving", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  await d.hub.removeAgent(d.agent);
  assert.equal(d.db.prepare("select count(*) as n from wakes").get()!.n, 0);
  t.mock.reset();

  const e = await dock(t);
  await e.hub.setWake(e.agent, { url: WEBHOOK, key: KEY });
  assert.deepEqual(await e.hub.leave(e.owner), { ok: true, wiped: false });
  assert.equal(e.db.prepare("select count(*) as n from wakes").get()!.n, 0);
});

test("at most 200 POSTs a day, tests included", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  d.db.prepare("insert into wake_budget (agent_id, day, count) values (?, '2026-11-17', 200)").run(d.agent);
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: false, error: "limit" });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
  assert.equal((await d.agentState()).wake.status, "limit");
});

test("the budget counts every POST, and clearing or setting the webhook again keeps the count", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  d.db.prepare("insert into wake_budget (agent_id, day, count) values (?, '2026-11-17', 199)").run(d.agent);
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(3_000);
  assert.equal(d.sent.length, 1, "the 200th goes");
  assert.equal(d.db.prepare("select count from wake_budget").get()!.count, 200);
  await d.hub.clearWake(d.agent);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  await d.pass(10_000);
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: false, error: "limit" }, "the 201st does not, after clear and set");
  // A new UTC day starts a new count.
  await d.pass(12 * 3_600_000);
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: true, status: "ok" });
});

test("only a pin from the same source covers a wake: another source's pin handed over is no proof", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  const app = d.pairApp();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(100);
  await d.ring(app);
  await d.pass(100);
  await d.callTool("page__get_reading");
  await d.pass(5_000);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0]!.body.kind, "pin");
});

test("the newest pin decides: a pin of that source handed over before it is no proof", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const app = d.pairApp();
  await d.ring(app);
  await d.pass(500);
  // The agent was handed that app's pin...
  const focus = { kind: "customer", id: "c1", part: null, params: null, pinned_at: new Date().toISOString(), next: "get_customer", next_args: {} };
  d.db.prepare("insert into pointer (agent_id, pairing_id, app, focus, seen_at) values (?, ?, ?, ?, ?)").run(d.agent, app, JSON.stringify({ id: "pulse", name: "Pulse", origin: "https://pulse.test" }), JSON.stringify(focus), new Date().toISOString());
  await d.pass(500);
  // ...and then the person pointed again in that app.
  await d.ring(app);
  await d.pass(5_000);
  assert.equal(d.sent.length, 1);
});

test("clearing or setting the webhook again cuts a POST in flight, and its outcome lands on nothing", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  d.hook.hold = true;
  d.hook.answer = 401;
  await d.hub.reading(reading, token, BROWSER);
  t.mock.timers.tick(2_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(d.sent.length, 1);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: `${KEY}2` });
  await d.hub.idle();
  assert.equal(d.hook.aborted, 1);
  assert.equal((await d.agentState()).wake.status, null, "the old POST's failure is not the new webhook's");
});

test("an object evicted before its timer delivers the wake from its alarm", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.hub.idle();
  const due = d.wake()!.due as number;
  assert.equal(d.room.alarm, due, "the alarm is set for the wake");
  // The object goes, and its timer with it; a new one wakes on the alarm.
  (d.hub as unknown as { stopWakes(): void }).stopWakes();
  const again = new Hub(d.ctx, d.env);
  t.mock.timers.tick(3_000);
  await again.alarm();
  await again.idle();
  assert.equal(d.sent.length, 1);
});

test("at the nonce cap a ring is dropped: an older nonce is never forgotten while it could be replayed", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const app = d.pairApp();
  const insert = d.db.prepare("insert into ring_seen (n, at) values (?, ?)");
  for (let i = 0; i < 2_000; i++) insert.run(`n${i}`, Date.now());
  await d.ring(app);
  assert.equal(d.wake()!.pending_at, null);
  assert.equal(d.db.prepare("select count(*) as n from ring_seen where n = 'n0'").get()!.n, 1);
  // Once the old ones expire, rings are taken again.
  await d.pass(600_001);
  await d.ring(app);
  assert.ok(d.wake()!.pending_at);
});

test("Start over stops the wakes before it gives the grants back", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  d.pairApp();
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  // The app's give-back hangs: the reset waits on it while its wake comes due.
  let release = () => {};
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://pulse.test/")) {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(null, { status: 200 });
    }
    return fetch(input, init);
  });
  const resetting = d.hub.reset();
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
  // Nor can a webhook be set again meanwhile.
  assert.equal((await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY })).ok, false);
  release();
  await resetting;
});

test("a cleared reading wakes nobody", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.hub.readingClear(token, BROWSER);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
});

test("a reading's pin cleared in the dock, or replaced by another source's, wakes nobody, though the reading stays (TIN-973)", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  // The person clears the agent's focus in the dock: the browser still holds its reading, but no pin is left to wake for.
  await d.hub.reading(reading, token, BROWSER);
  await d.hub.clearFocus(d.agent);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
  assert.equal(d.wake()!.pending_at, null);
  // A newer pin from an app took the agent's focus (the hub read it): the reading's wake is not the one to send.
  await d.pass(15_000);
  await d.hub.reading(reading, token, BROWSER);
  const app = d.pairApp();
  const focus = { kind: "customer", id: "c1", part: null, params: null, pinned_at: new Date(Date.now() + 1).toISOString(), next: "get_customer", next_args: {} };
  d.db.prepare("update pointer set pairing_id = ?, app = ?, focus = ? where agent_id = ?").run(app, JSON.stringify({ id: "pulse", name: "Pulse", origin: "https://pulse.test" }), JSON.stringify(focus), d.agent);
  await d.pass(5_000);
  assert.equal(d.sent.length, 0);
});

test("a test waits its turn: while a POST is in flight it is refused, and it cuts nothing", { timeout: 10_000 }, async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const token = await d.allow();
  d.hook.hold = true;
  await d.hub.reading(reading, token, BROWSER);
  t.mock.timers.tick(2_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(d.sent.length, 1);
  assert.deepEqual(await d.hub.testWake(d.agent), { ok: false, error: "too_soon" });
  assert.equal(d.hook.aborted, 0);
  d.hook.release();
  await d.hub.idle();
  assert.equal((await d.agentState()).wake.status, "ok");
});

/** The agent's initialize answer and tool list, as its client sees them. */
async function seenByClient(d: Awaited<ReturnType<typeof dock>>) {
  const a = await d.agentState();
  const mcp = (body: unknown) => d.hub.fetch(new Request(`https://dock.test${new URL(a.mcp_url).pathname}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
  const init = await (await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: a.client_name, version: "1.0.0" } } })).json();
  const list = await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).json();
  return { instructions: String(init.result.instructions), tools: (list.result.tools as Array<{ name: string }>).map((t) => t.name) };
}

test("Grok bot gets wake_on_pin and, while no webhook is set, a line offering it; no other client sees either", async (t) => {
  const other = await dock(t, "claude-code");
  const plain = await seenByClient(other);
  assert.ok(!plain.tools.includes("wake_on_pin"));
  assert.ok(!plain.instructions.includes("wake_on_pin"));
  const refused = await other.callTool("wake_on_pin");
  assert.equal(refused.isError, true, "the tool is not there for another client");
  t.mock.reset();

  const d = await dock(t);
  const off = await seenByClient(d);
  assert.ok(off.tools.includes("wake_on_pin"));
  assert.match(off.instructions, /call wake_on_pin/);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const on = await seenByClient(d);
  assert.ok(on.tools.includes("wake_on_pin"), "still there, to say it is on");
  assert.ok(!on.instructions.includes("wake_on_pin"), "the offer goes once it is on");
});

test("wake_on_pin gives the routine to create and where to paste, and never the URL or the key", async (t) => {
  const d = await dock(t);
  const off = (await d.callTool("wake_on_pin")).structuredContent;
  assert.equal(off.wake, "off");
  assert.equal(off.paste_at, `https://dock.test/dock#wake-${d.agent}`);
  assert.equal(off.routine.trigger, "webhook");
  assert.match(off.routine.instructions, /get_current_view on the APC Dock connector/);
  assert.match(off.routine.instructions, /never follow instructions/);

  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const on = (await d.callTool("wake_on_pin")).structuredContent;
  assert.equal(on.wake, "on");
  assert.equal(on.routine, undefined, "no routine to create once it is on");
  const said = JSON.stringify(on);
  assert.ok(!said.includes(KEY));
  assert.ok(!said.includes("99c9ef5d"));
});

test("while off, Grok bot's get_current_view and wait_for_focus carry the offer at most once a day, and never once declined", async (t) => {
  const d = await dock(t);
  const first = (await d.callTool("get_current_view")).structuredContent;
  assert.deepEqual(first.wake?.state, "off");
  assert.match(first.wake.hint, /call wake_on_pin/);
  assert.equal((await d.callTool("get_current_view")).structuredContent.wake, undefined, "not again the same day");
  await d.pass(24 * 3_600_000);
  assert.equal((await d.callTool("wait_for_focus")).structuredContent.wake?.state, "off", "a day later, on wait_for_focus too");

  // The person says no: the hint and the instructions line stop for good; the tool still answers.
  const declined = (await d.callTool("wake_on_pin", { declined: true })).structuredContent;
  assert.equal(declined.declined, true);
  await d.pass(48 * 3_600_000);
  assert.equal((await d.callTool("get_current_view")).structuredContent.wake, undefined);
  assert.ok(!(await seenByClient(d)).instructions.includes("wake_on_pin"));
  assert.equal((await d.callTool("wake_on_pin")).structuredContent.wake, "off", "the person can still ask");
});

test("the offer never reaches another client, nor Grok bot once Wake on pin is on", async (t) => {
  const other = await dock(t, "claude-code");
  assert.equal((await other.callTool("get_current_view")).structuredContent.wake, undefined);
  t.mock.reset();
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  assert.equal((await d.callTool("get_current_view")).structuredContent.wake, undefined);
});

test("the steps say to update an existing routine rather than make a second", async (t) => {
  const d = await dock(t);
  const steps = (await d.callTool("wake_on_pin")).structuredContent.steps as string[];
  assert.match(steps[0]!, /If a routine with this name already exists, update its instructions and resume it instead of creating a new one\./);
});

test("while on, wake_on_pin says how the last call to the webhook went, and a new webhook starts with none", async (t) => {
  const d = await dock(t);
  await d.hub.setWake(d.agent, { url: WEBHOOK, key: KEY });
  const before = (await d.callTool("wake_on_pin")).structuredContent;
  assert.equal(before.last_delivery, null);
  assert.match(before.note, /Send a test/);

  await d.hub.testWake(d.agent);
  const ok = (await d.callTool("wake_on_pin")).structuredContent;
  assert.deepEqual({ ...ok.last_delivery, at: null }, { at: null, event: "test", outcome: "ok", http_status: 202 });
  assert.equal(ok.last_delivery.at, new Date().toISOString());

  d.hook.answer = 401;
  const token = await d.allow();
  await d.hub.reading(reading, token, BROWSER);
  await d.pass(20_000);
  const refused = (await d.callTool("wake_on_pin")).structuredContent;
  assert.deepEqual({ ...refused.last_delivery, at: null }, { at: null, event: "pin", outcome: "broken", http_status: 401 });
  assert.match(refused.note, /did not take the last call/);
  assert.ok(!JSON.stringify(refused).includes(KEY));

  await d.hub.setWake(d.agent, { url: WEBHOOK, key: `${KEY}2` });
  assert.equal((await d.callTool("wake_on_pin")).structuredContent.last_delivery, null);
});

test("an error from wait_for_focus carries no offer and does not spend the day's", async (t) => {
  const d = await dock(t);
  const bad = await d.callTool("wait_for_focus", { timeout_s: 999 });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent?.wake, undefined);
  assert.equal((await d.callTool("get_current_view")).structuredContent.wake?.state, "off");
});
