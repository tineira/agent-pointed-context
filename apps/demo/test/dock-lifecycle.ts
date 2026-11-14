/**
 * The Dock profile as built (APC 0.10, TIN-892), checked on an app's real Durable Object and Worker: the
 * grant's states and what each answers, the two time limits, the races around the hub's acknowledgement and
 * `initialize`, and the app MUSTs M1, M6, M7 and M8. Shared by Pulse (dock-lifecycle.test.ts here) and Signals
 * (apps/signals/test/dock-lifecycle.test.ts); not a test file itself.
 *
 * The app runs on Node's SQLite (@tineira/apc-conformance/workers). The hub is a stand-in each test scripts
 * (`fakeHub`): fetch reaches nothing else, and every call it got is recorded. TIN-884 adds the same checks to
 * the conformance suite; until then these are the checks.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, type DurableObjectRoom } from "@tineira/apc-conformance/workers";
import { APC_JSON_PATH, T_ACK_MAX_MS, T_CONNECT_MAX_MS } from "@tineira/apc-protocol";

export const HUB = "https://dock.test";
export const SID = "5".repeat(32);

type Json = Record<string, unknown>;

/** An app's Durable Object, as these checks use it. */
interface DockObject {
  init(): Promise<{ owner: string }>;
  state(): Promise<Json>;
  fetch(request: Request): Promise<Response>;
  pairHub(sid: string, origin: string, raw: unknown): Promise<Json & { ok: boolean; error?: string; grant_id?: string; status?: string; consent?: string; pairing_code?: string; pairing?: { code: string; expires_at: string } }>;
  cancelDockGrant(grantId: string): Promise<{ ok: boolean; error?: string }>;
  revokeGrant(grantId: string): Promise<{ ok: boolean; error?: string }>;
}

/** What each app gives the shared checks. */
export interface DockAppUnderTest {
  name: string;
  /** The app's public origin in these tests. */
  origin: string;
  /** Its session cookie's name, and the Durable Object binding its Worker reads. */
  cookie: string;
  binding: string;
  /** Its deploy's vars, with HUB_ORIGINS = HUB and PUBLIC_ORIGIN = origin. */
  env: Record<string, string>;
  create(ctx: unknown, env: Json): DockObject;
  worker: { fetch(request: Request, env: Json): Response | Promise<Response> };
  /** Two things a dock agent can be dropped on. */
  targets: [Json, Json];
  /** A tool of the app's own, with arguments that work. */
  probe: { tool: string; args: Json };
  /** Where a dock grant's lifecycle is stored: the table, and its grant id column. */
  row: { table: string; id: string };
  /** A dock grant on the page's state: where it stands and the code it shows. */
  link(state: Json, grantId: string): { state?: string; pairing?: { code: string; expires_at: string } | null } | undefined;
  /** The id of what a grant is pinned on, on the page's state. */
  pinned(state: Json, grantId: string): string | null;
  /** Every grant id the page's state lists. */
  grantIds(state: Json): string[];
  /** A new Direct agent, made the app's way: its id and secret (APC 0.12, M12). */
  direct(object: DockObject, room: DurableObjectRoom): Promise<{ id: string; secret: string }>;
}

const ACK = { ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" };
const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: "Agent via dock", version: "0.10.0" } };

/** A hub the test scripts: what it answers /apc/pair and /apc/confirm, and everything the app sent it. */
function fakeHub(t: TestContext) {
  const hub = {
    pair: async (_body: Json): Promise<Response> => Response.json(ACK),
    confirm: async (_body: Json): Promise<Response> => Response.json({ ok: true, status: "pending", agent: { name: "Agent via dock", icon: null } }),
    calls: [] as string[],
    sent: [] as Json[],
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== HUB) throw new TypeError(`no network in this test: ${url}`);
    hub.calls.push(url.pathname);
    const body = (await request.json()) as Json;
    hub.sent.push(body);
    if (url.pathname === "/apc/pair") return hub.pair(body);
    if (url.pathname === "/apc/confirm") return hub.confirm(body);
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  });
  return hub;
}

/** A promise the test settles itself: a hub call held open. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  return { held, open };
}

export function dockLifecycleTests(app: DockAppUnderTest): void {
  const name = (what: string) => `${app.name} (dock, APC 0.10): ${what}`;
  let tickets = 0;
  const ticket = () => `${"d".repeat(32)}.${String(++tickets).padStart(16, "0")}`;

  /** One app instance on a room of its own, and its Worker with that instance behind its binding. */
  const start = async (env: Record<string, string> = app.env) => {
    const room = durableObjectRoom();
    const object = app.create(room.ctx, env);
    await object.init();
    return instance(room, object, env);
  };
  const instance = (room: DurableObjectRoom, object: DockObject, env: Record<string, string>) => {
    const others = new Map<string, DockObject>();
    const namespace = {
      idFromName: (id: string) => id,
      get: (id: string) => {
        if (id === SID) return object;
        if (!others.has(id)) others.set(id, app.create(durableObjectRoom().ctx, env));
        return others.get(id)!;
      },
    };
    const workerEnv = { ...env, [app.binding]: namespace };
    const self = {
      room,
      object,
      env,
      workerEnv,
      /** The object as a restart leaves it: a new instance on the same storage, with nothing kept in memory. */
      restart: (next: Record<string, string> = env) => instance(room, app.create(room.ctx, next), next),
      worker: (path: string, init: RequestInit = {}) => app.worker.fetch(new Request(`${app.origin}${path}`, init), workerEnv),
      /** One JSON-RPC message to a grant's MCP URL, as its hub sends it. */
      async rpc(mcpUrl: string, message: unknown) {
        const response = await object.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(message) }));
        const text = await response.text();
        let body: Json | null = null;
        try {
          body = JSON.parse(text) as Json;
        } catch {
          body = null;
        }
        return { status: response.status, body, text };
      },
      initialize: (mcpUrl: string) => self.rpc(mcpUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE }),
      call: (mcpUrl: string, tool: string, args: Json = {}) => self.rpc(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
      /** Set a stored column of a dock grant's lifecycle row. */
      set(grantId: string, column: string, value: string | number) {
        room.db.prepare(`update ${app.row.table} set ${column} = ? where ${app.row.id} = ?`).run(value, grantId);
      },
      link: async (grantId: string) => app.link(await object.state(), grantId),
    };
    return self;
  };
  type Instance = ReturnType<typeof instance>;

  /** A new agent dropped and Allowed: the grant, the MCP URL the hub was sent, and the code the consent showed. */
  const allow = async (i: Instance, hub: ReturnType<typeof fakeHub>, agent: string, target: Json = app.targets[0]) => {
    const drop = { hub: HUB, agent, ticket: ticket(), target };
    const asked = await i.object.pairHub(SID, app.origin, drop);
    assert.equal(asked.error, "consent_required");
    const answer = await i.object.pairHub(SID, app.origin, { ...drop, consent: asked.consent });
    const sent = hub.sent.filter((b) => b.agent === agent && typeof b.pairing_code === "string").at(-1);
    return { drop, asked, answer, grantId: answer.grant_id ?? "", mcpUrl: String(sent?.mcp_url ?? ""), code: String(asked.pairing_code) };
  };
  /** The same, with the hub's /apc/pair held open: the grant is in flight until `open()`. */
  const allowHeld = async (i: Instance, hub: ReturnType<typeof fakeHub>, agent: string) => {
    const g = gate();
    let reached!: () => void;
    const asked = new Promise<void>((resolve) => (reached = resolve));
    hub.pair = async () => {
      reached();
      await g.held;
      return Response.json(ACK);
    };
    const drop = { hub: HUB, agent, ticket: ticket(), target: app.targets[0] };
    const consent = await i.object.pairHub(SID, app.origin, drop);
    const answer = i.object.pairHub(SID, app.origin, { ...drop, consent: consent.consent });
    await asked;
    const mcpUrl = String(hub.sent.at(-1)!.mcp_url);
    const grantId = app.grantIds(await i.object.state()).at(-1)!;
    return { drop, answer, open: g.open, mcpUrl, grantId };
  };
  const revokedAnswer = (r: { status: number; body: Json | null }, what: string) => {
    assert.equal(r.status, 403, `${what}: HTTP ${r.status}`);
    assert.equal(r.body?.error, "revoked", what);
    assert.equal(r.body?.revoked_by, new URL(app.origin).host, what);
  };
  const noEnvelope = (text: string, what: string) => {
    for (const key of ['"attention"', '"then"', '"apc_link"']) assert.equal(text.includes(key), false, `${what} carries ${key}`);
  };

  // ---- the state table ----

  test(name("in flight, the grant answers HTTP 404 to a request, a notification and a GET, and the page gets no secret"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const held = await allowHeld(i, hub, "ag_flight");
    assert.equal((await i.link(held.grantId))?.state, "in_flight");
    assert.equal((await i.initialize(held.mcpUrl)).status, 404, "initialize");
    assert.equal((await i.rpc(held.mcpUrl, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 404, "ping");
    assert.equal((await i.rpc(held.mcpUrl, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 404, "tools/list");
    assert.equal((await i.call(held.mcpUrl, "get_current_view")).status, 404, "tools/call");
    assert.equal((await i.rpc(held.mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 404, "a notification");
    assert.equal((await i.object.fetch(new Request(held.mcpUrl))).status, 404, "a GET");
    // The 404s changed nothing: the grant is still in flight, and the page never sees its MCP URL or secret (I4).
    assert.equal((await i.link(held.grantId))?.state, "in_flight");
    assert.equal(JSON.stringify(await i.object.state()).includes(held.mcpUrl.split("/").at(-1)!), false, "the page's state carries the grant's secret");
    held.open();
    const answer = await held.answer;
    assert.equal(answer.ok, true, answer.error);
    assert.equal(answer.status, "pending");
    assert.equal((await i.link(held.grantId))?.state, "handoff");
  });

  test(name("in handoff, only initialize, ping and tools/list are served; a tools/call is the pairing error; nothing carries attention, then or presence"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    i.room.openPage();
    const g = await allow(i, hub, "ag_handoff");
    assert.equal(g.answer.ok, true, g.answer.error);
    assert.deepEqual(g.answer.pairing?.code, g.code);
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    i.room.takeMessages();

    const ping = await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 3, method: "ping" });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body?.result, {});
    const listed = await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal(listed.status, 200);
    assert.ok(((listed.body?.result as { tools: unknown[] }).tools ?? []).length > 0, "tools/list lists the tools");
    // The drop pinned the agent, and the page is open: a served call would carry attention and then.
    for (const [tool, args] of [["get_current_view", {}], ["wait_for_focus", { timeout_s: 1 }], [app.probe.tool, app.probe.args]] as const) {
      const r = await i.call(g.mcpUrl, tool, args);
      assert.equal(r.status, 200, tool);
      const result = r.body?.result as { isError?: boolean; structuredContent?: Json; content: Array<{ text: string }> };
      assert.equal(result.isError, true, tool);
      assert.equal(result.structuredContent?.error, "pairing", tool);
      assert.equal(typeof result.structuredContent?.message, "string");
      assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent, "the same in the text");
      assert.deepEqual(Object.keys(result.structuredContent!).sort(), ["error", "message"], `${tool}: no app data`);
      noEnvelope(r.text, tool);
    }
    const other = await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    assert.equal(other.status, 200);
    const error = other.body?.error as { code: number; data: Json };
    assert.equal(error.code, -32000);
    assert.equal(error.data.error, "pairing");
    // A batch is never an initialize: it commits nothing.
    const batch = await i.rpc(g.mcpUrl, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE }]);
    assert.equal((batch.body?.error as { code: number } | undefined)?.code, -32000, "a batch in handoff");
    const notified = await i.rpc(g.mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notified.status, 202);
    assert.equal(notified.text, "");
    assert.equal((await i.link(g.grantId))?.state, "handoff", "none of that moved the grant");
    assert.deepEqual(i.room.takeMessages().filter((m) => m.type === "presence"), [], "no presence event in handoff");
    // Agent traffic on a gated grant never reaches the tool wrapper: the grant is not stamped as used, and where
    // the app keeps a log of calls (Pulse), it holds none of them.
    assert.equal(i.room.db.prepare("select last_active_at from grants where id = ?").get(g.grantId)?.last_active_at ?? null, null, "a gated call stamped last_active_at");
    if (i.room.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'events'").get()) {
      const logged = i.room.db.prepare("select type from events where grant_id = ? and type in ('inbound', 'tool_call', 'envelope_delivered', 'link_offered')").all(g.grantId);
      assert.deepEqual(logged, [], "a gated call reached the event log");
    }

    // The hub's initialize commits the connection: the grant is live and serves data, with the envelope.
    const init = await i.initialize(g.mcpUrl);
    assert.equal(init.status, 200);
    assert.ok((init.body?.result as Json | undefined)?.serverInfo, "initialize answers its result");
    const link = await i.link(g.grantId);
    assert.equal(link?.state, "live");
    assert.equal(link?.pairing ?? null, null, "the code is done with");
    const served = await i.call(g.mcpUrl, app.probe.tool, app.probe.args);
    assert.equal((served.body?.result as { isError?: boolean }).isError ?? false, false);
    assert.equal(served.text.includes('"attention"'), true, "a live grant's answer carries the unread pin");
    assert.equal(i.room.takeMessages().some((m) => m.type === "presence"), true, "and its read shows on the page");
  });

  test(name("initialize fails closed: a storage failure answers HTTP 500, the grant stays in handoff, and a retry commits"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_closed");
    const sql = (i.room.ctx as { storage: { sql: { exec(query: string, ...params: unknown[]): unknown } } }).storage.sql;
    const exec = sql.exec.bind(sql);
    sql.exec = (query: string, ...params: unknown[]) => {
      if (/set state = 'live'/.test(query)) throw new Error("storage is down");
      return exec(query, ...params);
    };
    const failed = await i.initialize(g.mcpUrl);
    assert.equal(failed.status, 500);
    assert.equal(failed.body?.result, undefined, "no result without the commit");
    sql.exec = exec;
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    assert.equal(((await i.call(g.mcpUrl, app.probe.tool, app.probe.args)).body?.result as { structuredContent: Json }).structuredContent.error, "pairing");
    assert.equal((await i.initialize(g.mcpUrl)).status, 200);
    assert.equal((await i.link(g.grantId))?.state, "live");
  });

  // ---- the time limits ----

  test(name(`T_connect: a grant still in handoff ${T_CONNECT_MAX_MS / 60_000} minutes after the acknowledgement ends, and answers 404`), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_connect");
    // Just inside the limit it still waits.
    i.set(g.grantId, "acked_at", Date.now() - T_CONNECT_MAX_MS + 5_000);
    assert.equal((await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 200);
    i.set(g.grantId, "acked_at", Date.now() - T_CONNECT_MAX_MS);
    assert.equal((await i.initialize(g.mcpUrl)).status, 404, "initialize, past T_connect");
    assert.equal((await i.rpc(g.mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 404);
    assert.deepEqual(app.grantIds(await i.object.state()), [], "the page lists it no more");
    // The next drop of that agent asks the person again; the hub is not asked about a grant that ended.
    const before = hub.calls.length;
    assert.equal((await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_connect", ticket: ticket(), target: app.targets[0] })).error, "consent_required");
    assert.equal(hub.calls.length, before);
  });

  test(name(`T_ack: a grant still in flight ${T_ACK_MAX_MS / 1000} s after the Allow ends, whatever the hub then answers`), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const held = await allowHeld(i, hub, "ag_ack");
    i.set(held.grantId, "allowed_at", Date.now() - T_ACK_MAX_MS);
    // The acknowledgement comes late: the grant does not move to handoff.
    held.open();
    const answer = await held.answer;
    assert.deepEqual({ ok: answer.ok, error: answer.error }, { ok: false, error: "pairing_ended" });
    assert.equal((await i.initialize(held.mcpUrl)).status, 404);
    assert.deepEqual(app.grantIds(await i.object.state()), []);
  });

  test(name("a restart during the hub call: the grant stays in flight (404, one pairing at a time) until T_ack, then ends"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const held = await allowHeld(i, hub, "ag_restart");
    // The object is gone mid-call; a new one starts on the same storage, with no memory of the call.
    const after = i.restart();
    assert.equal((await after.link(held.grantId))?.state, "in_flight");
    assert.equal((await after.initialize(held.mcpUrl)).status, 404);
    const drop = { hub: HUB, agent: "ag_restart", ticket: ticket(), target: app.targets[0] };
    assert.deepEqual(await after.object.pairHub(SID, app.origin, drop), { ok: false, error: "pairing_in_progress" });
    assert.deepEqual(await after.object.cancelDockGrant(held.grantId), { ok: false, error: "not_cancellable" }, "Cancel is for handoff only");
    // No acknowledgement ever comes: past T_ack the grant ends, and the agent's next drop asks again.
    after.set(held.grantId, "allowed_at", Date.now() - T_ACK_MAX_MS - 1);
    assert.equal((await after.initialize(held.mcpUrl)).status, 404);
    assert.deepEqual(app.grantIds(await after.object.state()), []);
    assert.equal((await after.object.pairHub(SID, app.origin, drop)).error, "consent_required");
    held.open();
    await held.answer;
  });

  // ---- the acknowledgement against a give-back and a Revoke ----

  test(name("a give-back that lands during the hub call wins: the acknowledgement moves nothing, and the Allow says so"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const held = await allowHeld(i, hub, "ag_back");
    const back = await i.worker("/apc/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcp_url: held.mcpUrl }) });
    assert.equal(back.status, 200);
    assert.deepEqual(await back.json(), { ok: true });
    held.open();
    const answer = await held.answer;
    assert.deepEqual({ ok: answer.ok, error: answer.error }, { ok: false, error: "pairing_ended" });
    assert.equal((await i.initialize(held.mcpUrl)).status, 404, "ended stays ended");
    assert.deepEqual(app.grantIds(await i.object.state()), []);
  });

  test(name("a Revoke that lands during the hub call wins: the grant answers revoked, not handoff"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const held = await allowHeld(i, hub, "ag_revoked");
    assert.deepEqual(await i.object.revokeGrant(held.grantId), { ok: true });
    held.open();
    const answer = await held.answer;
    assert.equal(answer.ok, false);
    revokedAnswer(await i.initialize(held.mcpUrl), "initialize after the Revoke");
    // A give-back of a revoked grant is a no-op: revoked stays revoked.
    await i.worker("/apc/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcp_url: held.mcpUrl }) });
    revokedAnswer(await i.call(held.mcpUrl, "get_current_view"), "after a give-back of the revoked grant");
  });

  test(name("a hub that refuses, or cannot be reached, leaves no grant: it ended before the page heard back"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    for (const [agent, pair, error] of [
      ["ag_no_1", async () => Response.json({ ok: false, error: "ticket_expired" }, { status: 400 }), "ticket_expired"],
      ["ag_no_2", async () => Promise.reject(new TypeError("down")), "hub_unreachable"],
      ["ag_no_3", async () => Response.json({ ok: true, pairing_id: "pr_x", status: "pending" }), "hub_ignores_pairing_code"],
    ] as const) {
      hub.pair = pair as typeof hub.pair;
      const g = await allow(i, hub, agent);
      assert.deepEqual({ ok: g.answer.ok, error: g.answer.error }, { ok: false, error });
      assert.equal((await i.initialize(g.mcpUrl)).status, 404, agent);
    }
    assert.deepEqual(app.grantIds(await i.object.state()), []);
  });

  // ---- Cancel against initialize ----

  test(name("Cancel revokes in handoff: the initialize that follows gets the revoked answer"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_cancel");
    assert.deepEqual(await i.object.cancelDockGrant(g.grantId), { ok: true });
    revokedAnswer(await i.initialize(g.mcpUrl), "initialize after Cancel");
    revokedAnswer(await i.call(g.mcpUrl, app.probe.tool, app.probe.args), "a call after Cancel");
    assert.deepEqual(app.grantIds(await i.object.state()), []);
    assert.deepEqual(await i.object.cancelDockGrant(g.grantId), { ok: false, error: "unknown_grant" });
  });

  test(name("an initialize that committed first wins: Cancel is refused on a live grant, which keeps serving"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_live");
    assert.equal((await i.initialize(g.mcpUrl)).status, 200);
    assert.deepEqual(await i.object.cancelDockGrant(g.grantId), { ok: false, error: "not_cancellable" });
    assert.equal((await i.link(g.grantId))?.state, "live");
    const served = await i.call(g.mcpUrl, app.probe.tool, app.probe.args);
    assert.equal(served.status, 200);
    assert.equal((served.body?.result as { isError?: boolean }).isError ?? false, false);
    // The owner's Revoke is the way to cut a live grant.
    assert.deepEqual(await i.object.revokeGrant(g.grantId), { ok: true });
    revokedAnswer(await i.call(g.mcpUrl, app.probe.tool, app.probe.args), "after Revoke");
  });

  test(name("Cancel and initialize at once: exactly one wins, in either order of arrival"), async (t) => {
    const hub = fakeHub(t);
    for (const first of ["initialize", "cancel"] as const) {
      const i = await start();
      const g = await allow(i, hub, `ag_race_${first}`);
      // Both are started before either is awaited, in each order.
      const started = first === "initialize" ? { init: i.initialize(g.mcpUrl), cancel: i.object.cancelDockGrant(g.grantId) } : { cancel: i.object.cancelDockGrant(g.grantId), init: i.initialize(g.mcpUrl) };
      const [init, cancel] = await Promise.all([started.init, started.cancel]);
      if (cancel.ok) {
        revokedAnswer(init, `${first} first: Cancel won`);
        revokedAnswer(await i.call(g.mcpUrl, app.probe.tool, app.probe.args), "and the grant is revoked");
      } else {
        assert.equal(cancel.error, "not_cancellable", `${first} first`);
        assert.equal(init.status, 200, `${first} first: initialize won`);
        assert.equal((await i.link(g.grantId))?.state, "live");
      }
    }
  });

  // ---- M1: the hub allowlist ----

  test(name("M1: a hub that is not exactly an allowlisted https origin gets no consent and no grant"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    for (const bad of ["https://evil.test", "http://dock.test", "https://dock.test//", "https://dock.test/x", "https://user@dock.test", "https://dock.test?x=1", "https://dock.test#x", "https://DOCK.test", "https://dock.test.", "https://dock.test:443", "https://dock.test.evil.test", "dock.test", "", 7, null]) {
      const answer = await i.object.pairHub(SID, app.origin, { hub: bad, agent: "ag_m1", ticket: ticket(), target: app.targets[0] });
      assert.deepEqual(answer, { ok: false, error: "hub_not_allowed" }, JSON.stringify(bad));
    }
    assert.deepEqual(await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "not an agent", ticket: ticket(), target: app.targets[0] }), { ok: false, error: "invalid" });
    assert.deepEqual(await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_m1", ticket: "short", target: app.targets[0] }), { ok: false, error: "invalid" });
    assert.deepEqual(hub.calls, [], "nothing reached any hub");
    assert.deepEqual(app.grantIds(await i.object.state()), []);
    assert.equal(i.room.db.prepare("select count(*) as n from apc_kv where key like 'consent:%'").get()!.n, 0, "no consent was asked");
  });

  test(name("M1: the Allow checks the allowlist again: a hub taken off it between the drop and the Allow is refused"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const drop = { hub: HUB, agent: "ag_m1_allow", ticket: ticket(), target: app.targets[0] };
    const asked = await i.object.pairHub(SID, app.origin, drop);
    assert.equal(asked.error, "consent_required");
    // The operator takes the hub off the list: the consent the page still shows pairs nothing.
    const after = i.restart({ ...app.env, HUB_ORIGINS: "https://other-dock.test" });
    assert.deepEqual(await after.object.pairHub(SID, app.origin, { ...drop, consent: asked.consent }), { ok: false, error: "hub_not_allowed" });
    assert.deepEqual(hub.calls, []);
    assert.deepEqual(app.grantIds(await after.object.state()), []);
    // With no hub left at all, the app does not offer the Dock profile.
    const none = i.restart({ ...app.env, HUB_ORIGINS: "" });
    assert.deepEqual(await none.object.pairHub(SID, app.origin, { ...drop, consent: asked.consent }), { ok: false, error: "not_available" });
  });

  // ---- section 4: one pending pairing ----

  test(name("an Allow whose nonce does not take is consent_expired: no grant, no call to the hub, and no new question on its word"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const drop = { hub: HUB, agent: "ag_stale", ticket: ticket(), target: app.targets[0] };
    const asked = await i.object.pairHub(SID, app.origin, drop);
    const other = await i.object.pairHub(SID, app.origin, { ...drop, agent: "ag_other" });
    for (const consent of [`cn_${"0".repeat(32)}`, "not-a-nonce", 7, other.consent]) {
      assert.deepEqual(await i.object.pairHub(SID, app.origin, { ...drop, consent }), { ok: false, error: "consent_expired" }, String(consent));
    }
    assert.deepEqual(hub.calls, []);
    assert.deepEqual(app.grantIds(await i.object.state()), []);
    // The real nonce still pairs, once; sent again it finds the grant in handoff and asks the hub, never a second grant.
    assert.equal((await i.object.pairHub(SID, app.origin, { ...drop, consent: asked.consent })).ok, true);
    const again = await i.object.pairHub(SID, app.origin, { ...drop, ticket: ticket(), consent: asked.consent });
    assert.equal(again.status, "pending");
    assert.deepEqual(hub.calls, ["/apc/pair", "/apc/confirm"]);
    assert.equal(app.grantIds(await i.object.state()).length, 1);
  });

  test(name("a second drop before the dock connected shows the same code and expiry, with no new consent, and moves the pin"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_again");
    const first = g.answer.pairing!;
    assert.equal(app.pinned(await i.object.state(), g.grantId), app.targets[0].id);
    const again = await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_again", ticket: ticket(), target: app.targets[1] });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.status, "pending");
    assert.deepEqual(again.pairing, first, "the same code and the same expiry");
    assert.equal(again.consent, undefined);
    assert.deepEqual(hub.calls, ["/apc/pair", "/apc/confirm"]);
    assert.equal(hub.sent.at(-1)!.mcp_url, g.mcpUrl, "the hub was asked about the grant it holds");
    assert.equal(app.pinned(await i.object.state(), g.grantId), app.targets[1].id, "the drop's target replaces the pin");
    assert.deepEqual((await i.link(g.grantId))?.pairing, first, "and the page's card shows it");
  });

  test(name("a second drop the hub answers not_paired, or one past the stored expiry, ends the grant and asks again with a new code"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    // not_paired: the dock dropped the request (denied, expired there, tombstoned).
    const a = await allow(i, hub, "ag_np");
    hub.confirm = async () => Response.json({ ok: false, error: "not_paired" }, { status: 400 });
    const asked = await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_np", ticket: ticket(), target: app.targets[0] });
    assert.equal(asked.error, "consent_required");
    assert.notEqual(asked.pairing_code, a.code, "a fresh consent shows a new code");
    assert.equal((await i.initialize(a.mcpUrl)).status, 404, "the old grant ended");
    // Still pending at the hub, but the app's own stored expiry has passed: the same end.
    hub.confirm = async () => Response.json({ ok: true, status: "pending", agent: { name: null, icon: null } });
    const b = await allow(i, hub, "ag_late");
    assert.equal(b.answer.ok, true, b.answer.error);
    i.set(b.grantId, "pairing_expires_at", new Date(Date.now() - 1000).toISOString());
    const late = await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_late", ticket: ticket(), target: app.targets[0] });
    assert.equal(late.error, "consent_required");
    assert.equal((await i.initialize(b.mcpUrl)).status, 404);
    assert.deepEqual(app.grantIds(await i.object.state()), []);
  });

  test(name("a second drop the hub answers paired stays in handoff: connecting, no code, and only initialize makes it live"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_paired");
    hub.confirm = async () => Response.json({ ok: true, status: "paired", agent: { name: "Agent via dock", icon: null } });
    const again = await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_paired", ticket: ticket(), target: app.targets[1] });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.status, "connecting");
    assert.equal(again.pairing, undefined, "no code is shown again");
    const link = await i.link(g.grantId);
    assert.equal(link?.state, "handoff", "a confirm answer never moves the state");
    assert.equal(link?.pairing ?? null, null);
    assert.equal(((await i.call(g.mcpUrl, app.probe.tool, app.probe.args)).body?.result as { structuredContent: Json }).structuredContent.error, "pairing");
    assert.equal((await i.initialize(g.mcpUrl)).status, 200);
    assert.equal((await i.link(g.grantId))?.state, "live");
    assert.equal(app.pinned(await i.object.state(), g.grantId), app.targets[1].id, "the drop's target is the pin once it is live");
    // Live and paired: a later drop pins at once.
    const pinned = await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_paired", ticket: ticket(), target: app.targets[0] });
    assert.equal(pinned.ok, true, pinned.error);
    assert.equal(pinned.status, "paired");
  });

  test(name("a second drop while the hub cannot be reached changes nothing, and one whose grant went meanwhile says so"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_down");
    hub.confirm = async () => Promise.reject(new TypeError("down"));
    assert.deepEqual(await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_down", ticket: ticket(), target: app.targets[1] }), { ok: false, error: "hub_unreachable" });
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    assert.equal(app.pinned(await i.object.state(), g.grantId), app.targets[0].id);
    // Cancel lands while the hub answers the confirm: the drop does not pin a grant that is gone.
    hub.confirm = async () => {
      await i.object.cancelDockGrant(g.grantId);
      return Response.json({ ok: true, status: "pending", agent: { name: null, icon: null } });
    };
    assert.deepEqual(await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_down", ticket: ticket(), target: app.targets[1] }), { ok: false, error: "pairing_ended" });
    revokedAnswer(await i.initialize(g.mcpUrl), "after the Cancel");
  });

  // ---- M6: the owner's endpoints ----

  test(name("M6: an owner request with a foreign Origin, a cross-site or same-site Sec-Fetch-Site, or no JSON media type is refused; one with neither header is taken on its session"), async () => {
    const i = await start();
    const opened = await i.worker("/api/session", { method: "POST", headers: { "content-type": "application/json", origin: app.origin, "sec-fetch-site": "same-origin" }, body: "{}" });
    assert.equal(opened.status, 200);
    const sid = ((await opened.json()) as { sid: string }).sid;
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, new RegExp(`^${app.cookie}=`));
    const drop = JSON.stringify({ hub: HUB, agent: "ag_m6", ticket: ticket(), target: app.targets[0] });
    const post = (path: string, headers: Record<string, string>, body = "{}") => i.worker(path, { method: "POST", headers: { cookie, ...headers }, body });
    const json = { "content-type": "application/json" };
    // The drop and the Allow, Cancel, Revoke and a pin: every state change answers the same way.
    for (const [path, body] of [[`/api/s/${sid}/hub/pair`, drop], [`/api/s/${sid}/hub/cancel`, JSON.stringify({ grant_id: "g_none" })], [`/api/s/${sid}/grants/g_none/revoke`, "{}"], [`/api/s/${sid}/unpin`, JSON.stringify({ grant_id: "g_none" })], ["/api/session", "{}"]] as const) {
      const refused = async (headers: Record<string, string>, error: string, status: number) => {
        const r = await post(path, headers, body);
        assert.equal(r.status, status, `${path} ${JSON.stringify(headers)}`);
        assert.equal(((await r.json()) as { error: string }).error, error, `${path} ${JSON.stringify(headers)}`);
      };
      await refused({ ...json, origin: "https://evil.test" }, "origin_not_allowed", 403);
      await refused({ ...json, origin: `${app.origin}.evil.test` }, "origin_not_allowed", 403);
      await refused({ ...json, origin: "null" }, "origin_not_allowed", 403);
      await refused({ ...json, origin: HUB }, "origin_not_allowed", 403);
      await refused({ ...json, "sec-fetch-site": "cross-site" }, "cross_site_request", 403);
      await refused({ ...json, "sec-fetch-site": "same-site" }, "cross_site_request", 403);
      await refused({ ...json, origin: app.origin, "sec-fetch-site": "same-site" }, "cross_site_request", 403);
      await refused({}, "json_required", 415);
      await refused({ "content-type": "text/plain" }, "json_required", 415);
      await refused({ "content-type": "application/x-www-form-urlencoded", origin: app.origin }, "json_required", 415);
      // Taken: the page (Origin and same-origin), a browser that sends only one of them, and a client that sends neither.
      for (const headers of [{ ...json, origin: app.origin, "sec-fetch-site": "same-origin" }, { ...json, origin: app.origin }, { ...json, "sec-fetch-site": "same-origin" }, { ...json, "sec-fetch-site": "none" }, { "content-type": "application/json; charset=utf-8" }, json]) {
        const r = await post(path, headers, body);
        const answer = (await r.json()) as { error?: string };
        assert.ok(r.status === 200 || r.status === 400, `${path} ${JSON.stringify(headers)}: HTTP ${r.status}`);
        assert.ok(!["origin_not_allowed", "cross_site_request", "json_required"].includes(answer.error ?? ""), `${path} ${JSON.stringify(headers)}: ${answer.error}`);
      }
    }
    // The drop got through to the app, which asks the person first.
    assert.equal(((await (await post(`/api/s/${sid}/hub/pair`, json, drop)).json()) as { error: string }).error, "consent_required");
    // The configured origin is the rule, never the request's own: on another host name the app's page is refused.
    const elsewhere = await app.worker.fetch(new Request(`https://elsewhere.test/api/session`, { method: "POST", headers: { ...json, origin: "https://elsewhere.test" }, body: "{}" }), i.workerEnv);
    assert.equal(elsewhere.status, 403);
    // With no public origin configured, every request that names an Origin is refused.
    const unconfigured = await app.worker.fetch(new Request(`${app.origin}/api/session`, { method: "POST", headers: { ...json, origin: app.origin }, body: "{}" }), { ...i.workerEnv, PUBLIC_ORIGIN: "" });
    assert.equal(unconfigured.status, 403);
  });

  test(name("M6: the page's WebSocket handshake (its heartbeat) follows the same Origin rule"), async () => {
    const i = await start();
    const opened = await i.worker("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const sid = ((await opened.json()) as { sid: string }).sid;
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0]!;
    const shake = (headers: Record<string, string>) => i.worker(`/api/s/${sid}/ws`, { headers: { cookie, ...headers } });
    const refused: Array<Record<string, string>> = [{ origin: "https://evil.test" }, { origin: HUB }, { "sec-fetch-site": "cross-site" }, { origin: app.origin, "sec-fetch-site": "same-site" }];
    for (const headers of refused) {
      assert.equal((await shake(headers)).status, 403, JSON.stringify(headers));
    }
    // Let through to the object, which here (no upgrade on a plain request) answers 426: the page, and a client with no Origin (Pulse for Windows).
    const taken: Array<Record<string, string>> = [{ origin: app.origin }, { origin: app.origin, "sec-fetch-site": "same-origin" }, {}];
    for (const headers of taken) {
      assert.equal((await shake(headers)).status, 426, JSON.stringify(headers));
    }
    // Reading the state is not a state change: M6 leaves it to the session.
    assert.equal((await i.worker(`/api/s/${sid}/state`, { headers: { cookie } })).status, 200);
  });

  // ---- M7: the give-back ----

  test(name("M7: /apc/revoke answers the same 200 to a matching URL, an unknown one, junk, another method and an oversized body; only the match ends a grant"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const live = await allow(i, hub, "ag_m7_live");
    assert.equal((await i.initialize(live.mcpUrl)).status, 200);
    const waiting = await allow(i, hub, "ag_m7_handoff");
    const kept = await allow(i, hub, "ag_m7_kept");
    const json = { "content-type": "application/json" };
    const back = (init: RequestInit) => i.worker("/apc/revoke", init);
    const unknown = `${app.origin}/mcp/${SID}/${"0".repeat(32)}`;
    const answers: Array<[string, Response]> = [
      ["a live grant", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: live.mcpUrl }) })],
      ["a grant in handoff", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: waiting.mcpUrl }) })],
      ["the same grant again", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: live.mcpUrl }) })],
      ["an unknown secret", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: unknown }) })],
      ["another sandbox", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: `${app.origin}/mcp/${"9".repeat(32)}/${"0".repeat(32)}` }) })],
      ["another origin", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: kept.mcpUrl.replace(app.origin, "https://evil.test") }) })],
      ["a URL with a query", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: `${kept.mcpUrl}?x=1` }) })],
      ["no mcp_url", await back({ method: "POST", headers: json, body: "{}" })],
      ["junk", await back({ method: "POST", headers: json, body: "not json" })],
      ["no body", await back({ method: "POST" })],
      ["a GET", await back({ method: "GET" })],
      ["an oversized body", await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: kept.mcpUrl, pad: "x".repeat(5000) }) })],
      ["an app that pairs with no dock", await app.worker.fetch(new Request(`${app.origin}/apc/revoke`, { method: "POST", headers: json, body: JSON.stringify({ mcp_url: kept.mcpUrl }) }), { ...i.workerEnv, HUB_ORIGINS: "" })],
      ["an app with no public origin", await app.worker.fetch(new Request(`${app.origin}/apc/revoke`, { method: "POST", headers: json, body: JSON.stringify({ mcp_url: kept.mcpUrl }) }), { ...i.workerEnv, PUBLIC_ORIGIN: "" })],
    ];
    for (const [what, response] of answers) {
      assert.equal(response.status, 200, what);
      assert.equal(await response.text(), '{"ok":true}', what);
      assert.equal(response.headers.get("cache-control"), "no-store", what);
    }
    // Ended: 404 from then on. The grant nobody matched is untouched.
    assert.equal((await i.call(live.mcpUrl, app.probe.tool, app.probe.args)).status, 404);
    assert.equal((await i.initialize(waiting.mcpUrl)).status, 404);
    assert.equal((await i.link(kept.grantId))?.state, "handoff");
    assert.deepEqual(app.grantIds(await i.object.state()), [kept.grantId]);
    // A revoked grant given back stays revoked.
    assert.deepEqual(await i.object.revokeGrant(kept.grantId), { ok: true });
    await back({ method: "POST", headers: json, body: JSON.stringify({ mcp_url: kept.mcpUrl }) });
    revokedAnswer(await i.initialize(kept.mcpUrl), "a revoked grant, given back");
  });

  test(name("a dock grant from before APC 0.10 (no state, no secret hash) is live, and its hub can still give it back"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_old");
    await i.initialize(g.mcpUrl);
    for (const column of ["state", "secret_hash", "allowed_at", "acked_at"]) i.room.db.prepare(`update ${app.row.table} set ${column} = null where ${app.row.id} = ?`).run(g.grantId);
    // The next start reads it as live and gives it the hash a give-back finds it by.
    const after = i.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await after.link(g.grantId))?.state, "live");
    assert.equal((await after.call(g.mcpUrl, app.probe.tool, app.probe.args)).status, 200);
    const back = await after.worker("/apc/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcp_url: g.mcpUrl }) });
    assert.equal(back.status, 200);
    assert.equal((await after.call(g.mcpUrl, app.probe.tool, app.probe.args)).status, 404);
  });

  // ---- agent traffic extends nothing before the grant is live; the body is bounded ----

  test(name("a ping or tools/list served in handoff does not extend the app's life: its expiry and alarm stay as they were, until initialize commits"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_quiet");
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    const life = () => ({ expires: String((i.room.db.prepare("select value from meta where key = 'expires_at'").get() as { value: string }).value), alarm: i.room.alarm });
    const before = life();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 200);
    assert.equal((await i.rpc(g.mcpUrl, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 200);
    assert.equal((await i.call(g.mcpUrl, app.probe.tool, app.probe.args)).status, 200, "the pairing error");
    assert.deepEqual(life(), before, "agent traffic in handoff moved the expiry");
    // The hub's initialize makes it live, and a live grant's traffic keeps the app as before.
    assert.equal((await i.initialize(g.mcpUrl)).status, 200);
    assert.ok(Number(life().expires) > Number(before.expires), "a committed initialize extends it");
  });

  test(name("an MCP body over 1 MiB is refused with HTTP 413 before it is parsed, the same for a live grant and for a URL nobody holds"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_big");
    await i.initialize(g.mcpUrl);
    const unknown = g.mcpUrl.replace(/[0-9a-f]{32}$/, "0".repeat(32));
    const big = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: app.probe.tool, arguments: { pad: "x".repeat(1_048_576) } } });
    const post = (url: string, body: string, headers: Record<string, string> = {}) =>
      i.object.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body }));
    const answers: string[] = [];
    for (const url of [g.mcpUrl, unknown]) {
      // Cut on the stream (no content-length), refused on a declared length over the cap, and on one that is not a number.
      for (const [body, headers] of [[big, {}], ["{}", { "content-length": "1048577" }], ["{}", { "content-length": "12abc" }]] as const) {
        const response = await post(url, body, headers);
        assert.equal(response.status, 413, `${url === unknown ? "unknown" : "live"}: HTTP ${response.status}`);
        answers.push(await response.text());
      }
    }
    assert.equal(new Set(answers).size, 1, "one answer, whoever holds the URL");
    // A body at the cap's size or under still reaches the grant, whole.
    const served = await i.call(g.mcpUrl, app.probe.tool, app.probe.args);
    assert.equal(served.status, 200);
    assert.equal((served.body?.result as { isError?: boolean }).isError ?? false, false);
    assert.equal((await i.rpc(unknown, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
  });

  // ---- M8: apc.json ----

  test(name("M8: apc.json lists dock only while pairing is configured, and may be cached a minute at most"), async () => {
    const read = async (env: Record<string, string>) => {
      const response = await app.worker.fetch(new Request(`${app.origin}${APC_JSON_PATH}`), env);
      assert.equal(response.status, 200);
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? NaN);
      assert.ok(maxAge <= 60, `max-age ${maxAge}`);
      return ((await response.json()) as { profiles: string[] }).profiles;
    };
    assert.deepEqual(await read(app.env), ["direct", "dock"]);
    for (const [what, over] of [["no hub", { HUB_ORIGINS: "" }], ["a hub that is not an https origin", { HUB_ORIGINS: "http://dock.test" }], ["no public origin", { PUBLIC_ORIGIN: "" }], ["a public origin that is not one", { PUBLIC_ORIGIN: "pulse.test/app" }]] as const) {
      assert.deepEqual(await read({ ...app.env, ...over }), ["direct"], what);
      // And the app's own page and pairing agree with its file.
      const i = await start({ ...app.env, ...over });
      assert.deepEqual((await i.object.state()).profiles, ["direct"], what);
      assert.deepEqual(await i.object.pairHub(SID, app.origin, { hub: HUB, agent: "ag_m8", ticket: ticket(), target: app.targets[0] }), { ok: false, error: "not_available" }, what);
    }
  });

  // ---- the binding (APC 0.12, TIN-910) ----

  const BOUND_ID = "pr_0123456789abcdef0123456789abcdef";
  const OTHER_ID = "pr_fedcba9876543210fedcba9876543210";
  const introduce = (i: Instance, mcpUrl: string, meta?: Json, id: number | undefined = 1) =>
    i.rpc(mcpUrl, { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "initialize", params: { ...INITIALIZE, ...(meta ? { _meta: meta } : {}) } });
  const mismatch = (r: { status: number; body: Json | null }, what: string) => {
    assert.equal(r.status, 404, `${what}: HTTP ${r.status}`);
    assert.deepEqual(r.body, { error: "pairing_mismatch" }, what);
  };

  test(name("M10, M11: a hub that declares the binding: the grant in handoff commits only on its own pairing_id and agent, and a live one refuses another pairing"), async (t) => {
    const hub = fakeHub(t);
    hub.pair = async () => Response.json({ ...ACK, pairing_id: BOUND_ID, binding: "pairing_id" });
    const i = await start();
    const g = await allow(i, hub, "ag_bound");
    assert.equal(g.answer.ok, true, g.answer.error);
    const own = { "apc.tineira.com/pairing_id": BOUND_ID, "apc.tineira.com/agent": "ag_bound" };
    for (const [what, meta] of [
      ["no value", undefined],
      ["another pairing", { ...own, "apc.tineira.com/pairing_id": OTHER_ID }],
      ["its id changed by one character", { ...own, "apc.tineira.com/pairing_id": `${BOUND_ID.slice(0, -1)}0` }],
      ["its id as a prefix", { ...own, "apc.tineira.com/pairing_id": BOUND_ID.slice(0, -1) }],
      ["its id with a suffix", { ...own, "apc.tineira.com/pairing_id": `${BOUND_ID}0` }],
      ["its id in another case", { ...own, "apc.tineira.com/pairing_id": BOUND_ID.toUpperCase() }],
      ["a number", { ...own, "apc.tineira.com/pairing_id": 7 }],
      ["an empty string", { ...own, "apc.tineira.com/pairing_id": "" }],
      ["another agent", { ...own, "apc.tineira.com/agent": "ag_other" }],
      ["no id, its agent", { "apc.tineira.com/agent": "ag_bound" }],
    ] as const) {
      mismatch(await introduce(i, g.mcpUrl, meta as Json | undefined), what);
      assert.equal((await i.link(g.grantId))?.state, "handoff", `${what}: still in handoff`);
    }
    mismatch(await introduce(i, g.mcpUrl, { ...own, "apc.tineira.com/pairing_id": OTHER_ID }, undefined), "without an id");
    const batch = await i.rpc(g.mcpUrl, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { ...INITIALIZE, _meta: { ...own, "apc.tineira.com/pairing_id": OTHER_ID } } }]);
    mismatch(batch, "in a batch");
    // A body with the key twice: the parsed body the gate reads is the one that counts (the last value).
    const twice = await i.object.fetch(new Request(g.mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"apc-hub","version":"0"},"_meta":{"apc.tineira.com/pairing_id":"${BOUND_ID}","apc.tineira.com/agent":"ag_bound","apc.tineira.com/pairing_id":"${OTHER_ID}"}}}` }));
    assert.equal(twice.status, 404, "a duplicate key whose last value is another pairing");
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    const ok = await introduce(i, g.mcpUrl, own);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await i.link(g.grantId))?.state, "live", "its own pairing commits");
    mismatch(await introduce(i, g.mcpUrl, { ...own, "apc.tineira.com/pairing_id": OTHER_ID }), "live, another pairing");
    assert.equal((await introduce(i, g.mcpUrl)).status, 200, "live, no value: a hub rolled back to 0.11");
    assert.equal((await i.call(g.mcpUrl, app.probe.tool, app.probe.args)).status, 200, "still live");
  });

  test(name("M11: a hub before 0.12 (no binding declared): its plain initialize commits; one naming another pairing or agent is refused"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    const g = await allow(i, hub, "ag_legacy");
    assert.equal(g.answer.ok, true, g.answer.error);
    mismatch(await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": OTHER_ID, "apc.tineira.com/agent": "ag_legacy" }), "another pairing than the one acknowledged");
    mismatch(await introduce(i, g.mcpUrl, { "apc.tineira.com/agent": "ag_other" }), "another agent");
    assert.equal((await i.link(g.grantId))?.state, "handoff");
    assert.equal((await introduce(i, g.mcpUrl)).status, 200);
    assert.equal((await i.link(g.grantId))?.state, "live");
    assert.equal((await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": ACK.pairing_id, "apc.tineira.com/agent": "ag_legacy" })).status, 200, "a 0.12 hub's re-introduction of it");
  });

  test(name("M11: a link migrated from before 0.12 (no declared flag) keeps working: its stored id, or without one its agent, is checked mismatch-only"), async (t) => {
    const hub = fakeHub(t);
    hub.pair = async () => Response.json({ ...ACK, pairing_id: BOUND_ID, binding: "pairing_id" });
    const i = await start();
    const g = await allow(i, hub, "ag_migrated");
    assert.equal(g.answer.ok, true, g.answer.error);
    assert.equal((await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": BOUND_ID, "apc.tineira.com/agent": "ag_migrated" })).status, 200);
    // The row as an app before 0.12 left it: no declared flag (the column added by the migration, null).
    i.room.db.prepare(`update ${app.row.table} set declared = null where ${app.row.id} = ?`).run(g.grantId);
    i.room.db.prepare(`update ${app.row.table} set state = 'handoff' where ${app.row.id} = ?`).run(g.grantId);
    assert.equal((await introduce(i, g.mcpUrl)).status, 200, "a hub before 0.12 still introduces itself: no value is served");
    assert.equal((await i.link(g.grantId))?.state, "live");
    mismatch(await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": OTHER_ID, "apc.tineira.com/agent": "ag_migrated" }), "another pairing than the stored one");
    assert.equal((await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": BOUND_ID, "apc.tineira.com/agent": "ag_migrated" })).status, 200, "the 0.12 hub's re-introduction of it");
    // A row with no stored id at all (Signals before 0.12): checked on its agent alone.
    i.room.db.prepare(`update ${app.row.table} set pairing_id = null where ${app.row.id} = ?`).run(g.grantId);
    assert.equal((await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": OTHER_ID, "apc.tineira.com/agent": "ag_migrated" })).status, 200, "its own agent, any pairing: served");
    mismatch(await introduce(i, g.mcpUrl, { "apc.tineira.com/pairing_id": OTHER_ID, "apc.tineira.com/agent": "ag_other" }), "another agent");
    assert.equal((await i.call(g.mcpUrl, app.probe.tool, app.probe.args)).status, 200, "still live");
  });

  test(name("M12: a Direct grant answers 404 to an initialize carrying either key, revoked or not; its agent's own initialize is served"), async (t) => {
    fakeHub(t);
    const i = await start();
    const direct = await app.direct(i.object, i.room);
    const url = `${app.origin}/mcp/${SID}/${direct.secret}`;
    for (const meta of [{ "apc.tineira.com/pairing_id": BOUND_ID }, { "apc.tineira.com/agent": "ag_x" }, { "apc.tineira.com/pairing_id": null }]) mismatch(await introduce(i, url, meta), JSON.stringify(meta));
    mismatch(await introduce(i, url, { "apc.tineira.com/pairing_id": BOUND_ID }, undefined), "without an id");
    assert.equal((await introduce(i, url)).status, 200, "the agent's own initialize");
    assert.equal((await i.object.revokeGrant(direct.id)).ok, true);
    mismatch(await introduce(i, url, { "apc.tineira.com/pairing_id": BOUND_ID }), "revoked: still never the revoked answer for a hub");
    revokedAnswer(await introduce(i, url), "revoked, to its own agent");
  });

  test(name("M10: an acknowledgement with an unknown binding, or a declared id under 128 bits, is a refusal: the grant ends before the page hears back"), async (t) => {
    const hub = fakeHub(t);
    const i = await start();
    for (const [agent, body] of [
      ["ag_unknown", { ...ACK, pairing_id: BOUND_ID, binding: "hmac-v9" }],
      ["ag_short", { ...ACK, binding: "pairing_id" }],
    ] as const) {
      hub.pair = async () => Response.json(body);
      const g = await allow(i, hub, agent);
      assert.deepEqual(g.answer, { ok: false, error: "hub_refused" }, agent);
      assert.equal((await i.initialize(g.mcpUrl)).status, 404, `${agent}: no grant`);
    }
  });
}
