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
    const mcp = (body: unknown) =>
      sandbox.fetch(new Request(`${ORIGIN}/mcp/${SID}/${grant.secret}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
    const init = await (await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.0.0" } } })).json();
    const callTool = async (tool: string, args: Record<string, unknown> = {}) => (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })).json()).result;
    const seen = async () => {
      const again = await (await mcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.0.0" } } })).json();
      const list = await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).json();
      return { instructions: String(again.result.instructions), tools: list.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, { type?: string }> } }> };
    };
    return { id: grant.id, instructions: String(init.result.instructions), callTool, seen };
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
