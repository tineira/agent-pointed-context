/**
 * The Dock profile as built (APC 0.10, TIN-884): the app-side checks. On an app that claims 0.10.0 or later on
 * the Dock profile, through the adapter's `dock.lifecycle` and the suite's stand-in hub:
 *
 * - **The gate fails closed.** The suite reads the claimed standard from `apc.json` at the adapter's owner origin
 *   (a bare origin, the same as the grants'). Only an app that provably claims a standard before 0.10.0 skips; an
 *   `apc.json` the suite cannot read or parse, or an owner origin that is not the app's, fails every check.
 * - **The answer table**: in every state (in flight, handoff, live, dormant for an app that sleeps, ended,
 *   revoked), the exact answer to `initialize`, `ping`, `tools/list`, the core tools, one of the app's own tools,
 *   another method and two notifications, each classified by `dockGrantCallOf` and judged by `dockGrantAnswer`
 *   (`@tineira/apc-protocol`), plus the "any request" row (a GET, a DELETE, a POST that does not parse).
 * - **The transitions**: `initialize` commits the move out of handoff and fails closed; it races Cancel and a
 *   give-back and ends by the state that won; Cancel holds only in handoff before a served call; the
 *   acknowledgement's move is conditional; `T_ack` (across a restart), `T_connect`, `T_idle` and the precedence
 *   of handoff, revoked and ended over dormant through the time seam; wake actions wake, agent traffic never.
 * - **The hub call** (M1 to M5, M9) through the stand-in hub, **the owner's endpoints** (M6, the configured
 *   origin and a WebSocket heartbeat included), **the give-back** (M7), **`apc.json` with pairing disabled**
 *   (M8), **the code only in `/apc/pair`**, and **one pending pairing** (the spec's § "One pending pairing").
 *
 * The hub call's own deadline (M3) runs on the real clock: `advance` moves the app's limits, not its timers.
 * The hub's own duties (H1 to H7) are not checked here: the hub is reference-only until after 1.0.
 */
import {
  APC_JSON_PATH,
  APC_JSON_PAIRING_MAX_AGE_S,
  APC_LINK_KEY,
  HUB_CALL_DEADLINE_MS,
  IDLE_ERROR,
  PAIRING_CODE_TTL_MS,
  PAIRING_ERROR,
  REVOKED_HTTP_STATUS,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  canonicalTarget,
  compareStandard,
  dockGrantAnswer,
  dockGrantCallOf,
  formatPairingCode,
  isRevokedAnswer,
  normalizePairingCode,
  parseApcManifest,
  type DockGrantCall,
  type DockGrantState,
  type FocusTarget,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, expect, isObject, resultKey, rpcBody, sameJson, text, type ToolCallResult } from "./shared.ts";
import type { StandInHold, StandInHubMode } from "./hub.ts";
import type { ApcAppAdapter, ApcDockAdapter, ApcDockDropOutcome, ApcDockLifecycleAdapter, ApcDockOwnerEndpoint } from "./index.ts";

interface Named {
  name: string;
  run(): Promise<void>;
  note?: string;
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: "apc-conformance via dock", version: "0.10.0" } };
/** How long an owner request may take while another holds the hub call (M5): it must not wait on it. */
const UNBLOCKED_MS = 2500;
/** How long a hub call may take past its deadline before the check gives up on it (M3). */
const DEADLINE_SLACK_MS = 2500;
/** A host the app is never configured with: a request sent there with a matching `Origin` must still be refused (M6). */
const INTERNAL_ORIGIN = "https://apc-conformance-internal.example";
/** The members of `dock.lifecycle` a 0.10 Dock app must give (idleMs and hubDeadlineMs are optional). */
const REQUIRED = ["dropAgent", "cancel", "heartbeat", "advance", "failCommits", "restart", "pairingDisabled"] as const;

/** One message to a grant's MCP URL, as the hub sends it. */
interface Sent {
  status: number;
  body: unknown;
  headers: Headers;
  ms: number;
}

/** A message of the answer table: what it is to `dockGrantAnswer`, and what to send. */
interface TableCall {
  label: string;
  call: DockGrantCall;
  method: string;
  params: Record<string, unknown>;
  /** Sent with no `id` member. */
  noId: boolean;
}

/** Races `work` against `ms`: the value, or `timedOut`. */
async function within<T>(work: Promise<T>, ms: number): Promise<{ value: T; timedOut: false } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => (timer = setTimeout(() => resolve({ timedOut: true }), ms)));
  try {
    return await Promise.race([work.then((value) => ({ value, timedOut: false as const })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The checks of the Dock profile as built (APC 0.10). */
export function dockLifecycleChecks(app: ApcAppAdapter, dock: ApcDockAdapter | undefined): Named[] {
  const [first, second] = app.targets;
  const fetchApp = (request: Request) => (app.fetch ? app.fetch(request) : fetch(request));

  /**
   * The standard the app claims, failing closed: from apc.json at the owner origin (a bare origin) when the adapter
   * gives `dock.lifecycle`, else at a grant's origin. A read or a parse that fails is a failure, never "before 0.10".
   */
  const claimed = async (life: ApcDockLifecycleAdapter | undefined): Promise<string> => {
    let origin: string;
    if (life) {
      const o = (life.owner as { origin?: unknown } | undefined)?.origin;
      expect(typeof o === "string" && URL.canParse(o) && new URL(o).origin === o, `dock.lifecycle.owner.origin is ${JSON.stringify(o)}, not a bare origin (scheme://host[:port], no path, no trailing slash): the suite cannot read the app's apc.json there, and the 0.10 checks fail closed`);
      origin = o;
    } else origin = new URL((await app.connect()).mcpUrl).origin;
    let response: Response;
    try {
      response = await fetchApp(new Request(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }));
    } catch (error) {
      throw new ConformanceError(`cannot tell which standard the app claims: GET ${origin}${APC_JSON_PATH} failed (${String(error)}); the 0.10 checks fail closed`);
    }
    expect(response.status === 200, `cannot tell which standard the app claims: GET ${origin}${APC_JSON_PATH} answered HTTP ${response.status}; the 0.10 checks fail closed`);
    const parsed = parseApcManifest(await response.json().catch(() => undefined), origin);
    expect(parsed.ok, `cannot tell which standard the app claims: ${origin}${APC_JSON_PATH} is ${parsed.ok ? "" : `${parsed.error} (${parsed.detail})`}; the 0.10 checks fail closed`);
    return parsed.manifest.standard;
  };

  const check = (name: string, body: (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => Promise<void | { note: string }>): Named => {
    const named: Named = {
      name: `${app.name} (dock): 0.10: ${name}`,
      async run() {
        const standard = await claimed(dock?.lifecycle);
        if (compareStandard(standard, "0.10.0") < 0) {
          named.note = `not checked: the app's apc.json claims ${standard}, before 0.10.0, which does not have the Dock grant's states`;
          return;
        }
        expect(dock, "the app claims 0.10.0 or later on the Dock profile: give dock in the adapter (ApcDockAdapter)");
        const life = dock.lifecycle;
        expect(life, "the app claims 0.10.0 or later on the Dock profile: give dock.lifecycle in the adapter (ApcDockLifecycleAdapter)");
        for (const member of REQUIRED) expect(typeof life[member] === "function", `give dock.lifecycle.${member} in the adapter: a 0.10 Dock app needs it`);
        expect(typeof life.allowCarriesHub === "boolean", "give dock.lifecycle.allowCarriesHub in the adapter: whether the page's Allow carries the hub");
        const out = await body(life, dock);
        if (out?.note) named.note = out.note;
      },
    };
    return named;
  };

  /** A JSON-RPC message to the grant's URL: with `id: 1` unless `noId`. */
  const send = async (mcpUrl: string, method: string, params: Record<string, unknown>, noId = false): Promise<Sent> => {
    const started = Date.now();
    const response = await fetchApp(
      new Request(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify(noId ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = rpcBody(response.headers.get("content-type") ?? "", await response.text());
    return { status: response.status, body, headers: response.headers, ms: Date.now() - started };
  };
  /** A request that is not a JSON-RPC message (the spec's "any request" row): a GET, a DELETE, a POST that does not parse. */
  const sendRaw = async (mcpUrl: string, method: "GET" | "DELETE" | "POST"): Promise<Sent> => {
    const started = Date.now();
    const response = await fetchApp(
      new Request(mcpUrl, {
        method,
        headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{ not json" } : {}),
      }),
    );
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON
    }
    return { status: response.status, body, headers: response.headers, ms: Date.now() - started };
  };
  const toolCall = (mcpUrl: string, tool: string, args: Record<string, unknown> = {}) => send(mcpUrl, "tools/call", { name: tool, arguments: args });
  const resultOf = (s: Sent): ToolCallResult | undefined => (isObject(s.body) && isObject(s.body.result) ? (s.body.result as ToolCallResult) : undefined);
  const brief = (s: Sent) => `HTTP ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`;
  const served = (s: Sent) => s.status === 200 && isObject(s.body) && isObject(s.body.result);

  /** A message of the table, classified as the protocol classifies it (`dockGrantCallOf`), never by hand. */
  const entry = (label: string, method: string, params: Record<string, unknown>, noId = false): TableCall => ({
    label,
    method,
    params,
    noId,
    call: dockGrantCallOf({ method, params, ...(noId ? {} : { id: 1 }) }),
  });
  const VIEW = entry("get_current_view", "tools/call", { name: "get_current_view", arguments: {} });
  const tableCalls = (): TableCall[] => [
    entry("initialize", "initialize", INIT),
    entry("ping", "ping", {}),
    entry("tools/list", "tools/list", {}),
    VIEW,
    entry("wait_for_focus", "tools/call", { name: "wait_for_focus", arguments: { timeout_s: 10 } }),
    entry(app.probe.tool, "tools/call", { name: app.probe.tool, arguments: app.probe.args }),
    entry("resources/list", "resources/list", {}),
    entry("notifications/initialized (no id)", "notifications/initialized", {}, true),
    // A notifications/* method with an id is still a notification.
    entry("notifications/cancelled (with an id)", "notifications/cancelled", { requestId: 99, reason: "apc-conformance" }),
  ];

  /** No key of a gated answer points the agent anywhere: no attention, then or apc_link, in the structured result or the text. */
  const quiet = (r: ToolCallResult, where: string) => {
    for (const key of ["attention", "then", APC_LINK_KEY]) {
      expect(r.structuredContent?.[key] === undefined && text(r)[key] === undefined, `${where}: carries ${key}, which no answer in handoff or dormant may`);
    }
  };

  /** That `s` is what `dockGrantAnswer(state, c.call)` says `c` answers. */
  const expectAnswer = (state: DockGrantState, c: TableCall, s: Sent) => {
    const kind = dockGrantAnswer(state, c.call);
    const where = `${c.label} in ${state}`;
    switch (kind.kind) {
      case "not_found":
        expect(s.status === 404, `${where} answers HTTP 404, got ${brief(s)}`);
        return;
      case "revoked":
        expect(s.status === REVOKED_HTTP_STATUS, `${where} answers HTTP ${REVOKED_HTTP_STATUS}, got ${brief(s)}`);
        expect(isRevokedAnswer(s.body) && s.body.revoked_by.length > 0 && ISO.test(s.body.revoked_at), `${where} answers { error: "revoked", revoked_by, revoked_at }: ${brief(s)}`);
        return;
      case "ignored":
        expect(s.status === 202, `${where} is ignored with HTTP 202, got ${brief(s)}`);
        return;
      case "serve": {
        if (c.call === "notification") {
          expect(s.status >= 200 && s.status < 300, `${where} is taken as 0.8 takes it (HTTP 2xx), got ${brief(s)}`);
          return;
        }
        expect(s.status === 200, `${where} is served (HTTP 200), got ${brief(s)}`);
        expect(isObject(s.body), `${where} is served, got ${brief(s)}`);
        if (c.call === "other_method") {
          // As the app serves it: anything but the pairing and idle errors.
          const data = isObject(s.body.error) ? (s.body.error as { data?: unknown }).data : undefined;
          expect(!(isObject(data) && (data.error === PAIRING_ERROR || data.error === IDLE_ERROR)), `${where} is served as the app serves it, not with the ${String((data as { error?: unknown } | undefined)?.error)} error: ${brief(s)}`);
          return;
        }
        expect(!("error" in s.body && s.body.error) && "result" in s.body, `${where} is served with a result, got ${brief(s)}`);
        if (c.method === "tools/call") {
          const r = resultOf(s)!;
          expect(r.isError !== true, `${where} returns the app's answer, not an error: ${brief(s)}`);
          expect(r.structuredContent?.idle !== true && text(r).idle !== true, `${where} returns the app's answer, not the idle shape: ${brief(s)}`);
        }
        return;
      }
      case "tool_error": {
        expect(s.status === 200, `${where} answers the tool error ${kind.error} with HTTP 200, got ${brief(s)}`);
        const r = resultOf(s);
        expect(r && r.isError === true, `${where} is the tool error { error: "${kind.error}", message } with isError: true, got ${brief(s)}`);
        expect(isObject(r.structuredContent), `${where}: the tool error ${kind.error} is carried in structuredContent too, not only the text: ${brief(s)}`);
        const inText = text(r);
        expect(r.structuredContent.error === kind.error && typeof r.structuredContent.message === "string" && r.structuredContent.message.length > 0, `${where}: structuredContent is { error: "${kind.error}", message }: ${brief(s)}`);
        expect(sameJson(r.structuredContent, inText), `${where}: content[0].text carries the same { error, message } as structuredContent: ${brief(s)}`);
        quiet(r, where);
        return;
      }
      case "rpc_error": {
        expect(s.status === 200, `${where} answers JSON-RPC ${kind.code} with HTTP 200, got ${brief(s)}`);
        const e = isObject(s.body) ? s.body.error : undefined;
        expect(isObject(e) && e.code === kind.code, `${where} is JSON-RPC error ${kind.code}, got ${brief(s)}`);
        expect(isObject(e.data) && e.data.error === kind.error && typeof e.data.message === "string", `${where}: the JSON-RPC error's data is { error: "${kind.error}", message }: ${brief(s)}`);
        return;
      }
      case "idle_shape": {
        expect(s.status === 200, `${where} answers its idle shape with HTTP 200, got ${brief(s)}`);
        const r = resultOf(s);
        expect(r && r.isError !== true, `${where} answers its idle shape, not an error: ${brief(s)}`);
        const idle = resultKey(r, "idle");
        expect(idle.value === true, `${where} carries idle: true, in the structured result and the text: ${brief(s)}`);
        const d = r.structuredContent ?? text(r);
        expect(typeof d.note === "string" && d.note.length > 0, `${where} carries a note: ${brief(s)}`);
        if (c.label === "get_current_view") expect(d.view === null && d.focus === null, `${where} is { view: null, focus: null, idle: true, note }: ${brief(s)}`);
        else {
          expect(d.focus === null && d.timed_out === false && d.page_open === false, `${where} is { focus: null, timed_out: false, page_open: false, idle: true, note }: ${brief(s)}`);
          // Asked to wait 10 s: an answer under 5 s did not wait.
          expect(s.ms < 5000, `${where} answers at once, not after ${s.ms} ms`);
        }
        quiet(r, where);
        return;
      }
    }
  };

  /** Sends the table's calls, in order, and checks each against the oracle. Handoff sends initialize last: it commits. */
  const table = async (state: DockGrantState, mcpUrl: string, grantId?: string) => {
    const calls = tableCalls();
    const ordered = state === "handoff" ? [...calls.slice(1), calls[0]!] : calls;
    app.page.takePresence();
    for (const c of ordered) expectAnswer(state, c, await send(mcpUrl, c.method, c.params, c.noId));
    // The "any request" row: what is not a JSON-RPC message gets the state's answer too, where the state fixes one.
    if (state === "in_flight" || state === "ended" || state === "revoked") {
      for (const method of ["GET", "DELETE", "POST"] as const) {
        const s = await sendRaw(mcpUrl, method);
        const what = method === "POST" ? "a POST whose body does not parse" : `a ${method}`;
        if (state === "revoked") {
          expect(s.status === REVOKED_HTTP_STATUS && isRevokedAnswer(s.body), `${what} in revoked answers HTTP ${REVOKED_HTTP_STATUS} with RevokedAnswer, got ${brief(s)}`);
        } else expect(s.status === 404, `${what} in ${state} answers HTTP 404, got ${brief(s)}`);
      }
    }
    if (grantId && (state === "handoff" || state === "dormant")) {
      const events = app.page.takePresence().filter((e) => e.grant_id === grantId);
      expect(events.length === 0, `a grant in ${state} published ${events.length} presence event(s): no answer in ${state} may`);
    }
  };

  /** What a probe of the app's own tool says of the grant's state. */
  const stateOf = async (mcpUrl: string): Promise<string> => {
    const s = await toolCall(mcpUrl, app.probe.tool, app.probe.args);
    if (s.status === 404) return "not_found";
    if (s.status === REVOKED_HTTP_STATUS && isRevokedAnswer(s.body)) return "revoked";
    const r = resultOf(s);
    if (!r) return brief(s);
    if (r.isError) {
      const e = (r.structuredContent ?? text(r)).error;
      return e === PAIRING_ERROR ? "pairing" : e === IDLE_ERROR ? "idle" : brief(s);
    }
    return "data";
  };
  const expectState = async (mcpUrl: string, expected: string, where: string) => {
    const got = await stateOf(mcpUrl);
    const say: Record<string, string> = { data: "serves app data (live)", pairing: "answers the pairing error (handoff)", idle: "answers the idle error (dormant)", not_found: "answers 404 (in flight or ended)", revoked: "answers revoked" };
    expect(got === expected, `${where}: the grant should ${say[expected] ?? expected}, but it ${say[got] ?? `answered ${got}`}`);
  };

  let n = 0;
  const newAgent = () => `ag_010_${++n}_${Date.now().toString(36)}`;
  const giveBack = async (life: ApcDockLifecycleAdapter, body: string | ReadableStream<Uint8Array>) =>
    fetchApp(new Request(`${life.owner.origin}/apc/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body, ...(typeof body === "string" ? {} : { duplex: "half" }) } as RequestInit));
  const deadlineOf = (life: ApcDockLifecycleAdapter) => {
    const ms = life.hubDeadlineMs ?? HUB_CALL_DEADLINE_MS;
    expect(ms > 0 && ms <= HUB_CALL_DEADLINE_MS, `dock.lifecycle.hubDeadlineMs is ${ms}: the hub call's deadline is at most ${HUB_CALL_DEADLINE_MS} ms`);
    return ms;
  };
  const drop = (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, agent: string, hub = d.hub.origin, target?: FocusTarget) => life.dropAgent({ agent, ticket: d.hub.ticket(agent), hub, ...(target ? { target } : {}) });

  /** The person drops a new agent from the stand-in hub (or `hub`): the consent, which must be one. */
  const consent = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, agent = newAgent(), hub = d.hub.origin) => {
    const shown = await drop(life, d, agent, hub);
    expect(shown.page === "consent", `a drop of an agent the app holds no grant for shows the consent, got ${JSON.stringify(shown).slice(0, 200)}`);
    expect(normalizePairingCode(shown.code), `the consent shows ${JSON.stringify(shown.code)}, not a pairing code`);
    return { agent, ...shown };
  };
  /** A grant in handoff: dropped, Allowed, acknowledged by the hub, with no initialize yet. */
  const handoff = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, hub = d.hub.origin) => {
    const c = await consent(life, d, newAgent(), hub);
    const answer = await c.allow();
    expect(answer.ok, `the Allow did not pair: ${answer.error}`);
    expect(typeof answer.grantId === "string" && answer.grantId.length > 0, "the Allow gives the grant's id (ApcDockAllowAnswer.grantId)");
    const pairing = d.hub.pairings.filter((p) => p.agent === c.agent).at(-1);
    expect(pairing, "the stand-in hub holds no pairing for the agent after the Allow");
    return { agent: c.agent, code: normalizePairingCode(c.code)!, grantId: answer.grantId, mcpUrl: pairing.mcp_url, pairing };
  };
  /** A grant committed by the hub's initialize, with no served call yet. */
  const committed = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => {
    const g = await handoff(life, d);
    const decided = await d.hub.decide(g.pairing.id, "approve", g.code, { introduce: false });
    expect(decided.ok, `the code the consent showed did not approve the pairing: ${decided.error}`);
    const init = await send(g.mcpUrl, "initialize", INIT);
    expect(served(init), `the hub's initialize on a paired grant is served: ${brief(init)}`);
    return g;
  };
  /** A live grant that served a call. */
  const liveGrant = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => {
    const g = await committed(life, d);
    await expectState(g.mcpUrl, "data", "after a committed initialize");
    return g;
  };
  /** A grant in flight: the Allow sent, the stand-in hub's answer kept back. */
  const inFlight = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, agent?: string) => {
    const c = await consent(life, d, agent);
    const hold = d.hub.hold();
    const allowed = c.allow();
    allowed.catch(() => {});
    const arrived = await within(hold.arrived, 5000);
    if (arrived.timedOut) {
      hold.release();
      throw new ConformanceError("the Allow sent the hub no /apc/pair within 5 s");
    }
    const mcpUrl = arrived.value.mcp_url;
    expect(typeof mcpUrl === "string", "the app sent /apc/pair without an mcp_url");
    return { agent: c.agent, consent: c, hold, allowed, mcpUrl };
  };
  /** Releases a held answer and waits, bounded, for the Allow: its answer, or a failure when it never settles. */
  const settle = async <T>(life: ApcDockLifecycleAdapter, hold: StandInHold, allowed: Promise<T>, mode?: StandInHubMode): Promise<T> => {
    hold.release(mode);
    const r = await within(allowed, deadlineOf(life) + DEADLINE_SLACK_MS);
    expect(!r.timedOut, `the Allow had not settled ${(deadlineOf(life) + DEADLINE_SLACK_MS) / 1000} s after the hub answered`);
    return r.value;
  };
  const pairCount = (d: ApcDockAdapter, agent: string) => d.hub.received.filter((b) => b.agent === agent).length;

  /** An Allow against a broken hub (`mode`): refused, never past the hub's origin, and the grant it made answers 404. */
  const refusedWith = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, mode: StandInHubMode, rule: string) => {
    const c = await consent(life, d);
    const before = d.hub.received.length;
    const calls = d.hub.requests.length;
    const limit = deadlineOf(life) + DEADLINE_SLACK_MS;
    d.hub.mode = mode;
    try {
      const answer = await within(c.allow(), limit);
      expect(!answer.timedOut, `${rule}: with a hub that answers ${mode}, the Allow was still waiting after ${limit / 1000} s`);
      expect(!answer.value.ok, `${rule}: with a hub that answers ${mode}, the Allow says it paired: the app must refuse the answer`);
    } finally {
      d.hub.mode = "ack";
      d.hub.releaseStalls();
    }
    const elsewhere = d.hub.requests.slice(calls).filter((u) => new URL(u).origin !== d.hub.origin);
    expect(elsewhere.length === 0, `${rule}: with a hub that answers ${mode}, the app's request reached ${elsewhere.join(", ")}: the secret MCP URL and the pairing code went past the hub (call it with redirect: "error")`);
    const sent = d.hub.received.slice(before).find((b) => b.agent === c.agent);
    expect(sent && typeof sent.mcp_url === "string", `${rule}: with a hub that answers ${mode}, the app sent no /apc/pair to check`);
    for (const method of ["tools/list", "initialize"]) {
      const s = await send(sent.mcp_url, method, method === "initialize" ? INIT : {});
      expect(s.status === 404, `${rule}: with a hub that answers ${mode}, the grant the app made answers ${method} with ${brief(s)}: it must end (404)`);
    }
  };
  /** An Allow against a hub whose answer the app must take (`mode`): it pairs, and the grant is in handoff. */
  const takenWith = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, mode: StandInHubMode, rule: string) => {
    const c = await consent(life, d);
    d.hub.mode = mode;
    try {
      const answer = await c.allow();
      expect(answer.ok, `${rule}: with a hub that answers ${mode}, the Allow did not pair (${answer.error}): the app must take that answer`);
    } finally {
      d.hub.mode = "ack";
    }
    const url = d.hub.urlOf(c.agent);
    expect(url, `${rule}: the stand-in hub holds no pairing for the agent`);
    await expectState(url, "pairing", `${rule}: with a hub that answers ${mode}`);
  };
  /** The two orders of a race: `a` sent first, then `b`, in the same tick. */
  const race = async <A, B>(order: "a first" | "b first", a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> => {
    if (order === "a first") {
      const pa = a();
      const pb = b();
      return [await pa, await pb];
    }
    const pb = b();
    const pa = a();
    return [await pa, await pb];
  };
  const focusNames = (focus: unknown, target: FocusTarget) =>
    isObject(focus) && canonicalTarget({ kind: focus.kind as string, id: (focus.id ?? null) as string | null, part: (focus.part ?? null) as string | null, params: (focus.params ?? null) as FocusTarget["params"] }) === canonicalTarget(target);

  return [
    check("the lifecycle adapter is given, and its owner origin is the app's (required of an app that claims 0.10.0 or later on the Dock profile)", async (life, d) => {
      const g = await handoff(life, d);
      const grantOrigin = new URL(g.mcpUrl).origin;
      expect(grantOrigin === life.owner.origin, `dock.lifecycle.owner.origin is ${life.owner.origin}, but the app's grants live at ${grantOrigin}: the suite read the claimed standard from another origin than the app's`);
      await giveBack(life, JSON.stringify({ mcp_url: g.mcpUrl }));
    }),

    // The answer table, state by state.
    check("the answer table: in flight (from the Allow to the hub's acknowledgement), and a 404 leaves the state unchanged", async (life, d) => {
      const f = await inFlight(life, d);
      let answer;
      try {
        await table("in_flight", f.mcpUrl);
      } finally {
        answer = await settle(life, f.hold, f.allowed, "ack");
      }
      expect(answer.ok, `the acknowledgement came in time and the Allow did not pair: ${answer.error}`);
      // The initialize sent in flight changed nothing: the grant is in handoff, not live.
      await expectState(f.mcpUrl, "pairing", "after the acknowledgement, an initialize sent in flight having changed nothing");
    }),

    check("the answer table: handoff (the pairing error, no attention, then or apc_link), and initialize commits it", async (life, d) => {
      const g = await handoff(life, d);
      await app.page.setOpen(true);
      // The drop's target, or a pin now, may be pending: it must not ride as attention, nor give then.
      await app.page.pin(g.grantId, first).catch(() => false);
      try {
        await table("handoff", g.mcpUrl, g.grantId);
      } finally {
        await app.page.setOpen(false);
      }
      await expectState(g.mcpUrl, "data", "after initialize in handoff (it commits the connection)");
    }),

    check("the answer table: live", async (life, d) => {
      const g = await liveGrant(life, d);
      await app.page.setOpen(false);
      await table("live", g.mcpUrl, g.grantId);
    }),

    check("the answer table: dormant (the idle shapes and the idle error, no attention, then or apc_link)", async (life, d) => {
      if (!life.idleMs) return { note: "not checked: the adapter gives no idleMs, so the app does not sleep (dormant is a SHOULD)" };
      const g = await liveGrant(life, d);
      // An unread pin, made while live with the page open: in dormant it must not ride as attention.
      await app.page.setOpen(true);
      expect(await app.page.pin(g.grantId, first), "the app refused a pin on a live grant");
      await app.page.setOpen(false);
      await life.advance(life.idleMs + 1000);
      await table("dormant", g.mcpUrl, g.grantId);
      // initialize was served in dormant and did not wake the grant.
      await expectState(g.mcpUrl, "idle", "after initialize, ping, tools/list and tools/call in dormant");
      await life.heartbeat();
    }),

    check("the answer table: ended (a give-back on a grant in handoff)", async (life, d) => {
      const g = await handoff(life, d);
      const r = await giveBack(life, JSON.stringify({ mcp_url: g.mcpUrl }));
      expect(r.status === 200, `POST /apc/revoke answered HTTP ${r.status}`);
      await table("ended", g.mcpUrl);
    }),

    check("the answer table: revoked (Cancel on a grant in handoff)", async (life, d) => {
      const g = await handoff(life, d);
      expect(await life.cancel(g.grantId), "the app refused Cancel on a grant in handoff that served no call");
      await table("revoked", g.mcpUrl);
    }),

    // The transitions.
    check("initialize fails closed: a commit that cannot persist returns no result, and the grant stays in handoff", async (life, d) => {
      const g = await handoff(life, d);
      await life.failCommits(true);
      let s: Sent;
      try {
        s = await send(g.mcpUrl, "initialize", INIT);
      } finally {
        await life.failCommits(false);
      }
      const rpcError = isObject(s.body) && isObject(s.body.error) ? s.body.error.code : undefined;
      expect(s.status === 500 || (s.status === 200 && rpcError === -32603), `initialize whose commit failed answers HTTP 500 or JSON-RPC -32603, got ${brief(s)}`);
      expect(!(isObject(s.body) && "result" in s.body), `initialize whose commit failed returned a result: ${brief(s)}`);
      await expectState(g.mcpUrl, "pairing", "after an initialize whose commit failed");
      const again = await send(g.mcpUrl, "initialize", INIT);
      expect(served(again), `once storage works, initialize is served: ${brief(again)}`);
      await expectState(g.mcpUrl, "data", "after a committed initialize");
    }),

    check("a commit racing Cancel or a give-back ends by the state that won", async (life, d) => {
      for (const order of ["a first", "b first"] as const) {
        const g = await handoff(life, d);
        const [s, cancelled] = await race(order, () => send(g.mcpUrl, "initialize", INIT), () => life.cancel(g.grantId));
        const where = `initialize and Cancel, ${order === "a first" ? "initialize" : "Cancel"} sent first`;
        const revoked = s.status === REVOKED_HTTP_STATUS && isRevokedAnswer(s.body);
        expect(served(s) || revoked, `${where}: initialize answers by the state that won (served, or revoked), got ${brief(s)}`);
        if (served(s)) {
          expect(!cancelled, `${where}: initialize committed the grant (live), and Cancel still revoked it: the commit and Cancel are each one atomic step`);
          await expectState(g.mcpUrl, "data", `${where}: initialize won`);
        } else {
          expect(cancelled, `${where}: initialize answered revoked, but Cancel says it did not revoke`);
          await expectState(g.mcpUrl, "revoked", `${where}: Cancel won`);
        }
      }
      for (const order of ["a first", "b first"] as const) {
        const g = await handoff(life, d);
        const [s, r] = await race(order, () => send(g.mcpUrl, "initialize", INIT), () => giveBack(life, JSON.stringify({ mcp_url: g.mcpUrl })));
        const where = `initialize and a give-back, ${order === "a first" ? "initialize" : "the give-back"} sent first`;
        expect(r.status === 200, `${where}: POST /apc/revoke answered HTTP ${r.status}`);
        expect(served(s) || s.status === 404, `${where}: initialize answers by the state that won (served, or 404), got ${brief(s)}`);
        // Either way the give-back ended the grant: a commit that came after it must not bring it back.
        await expectState(g.mcpUrl, "not_found", `${where}: after both`);
      }
    }),

    check("Cancel revokes only in handoff before any served call: never a live grant (served or not) or an ended one", async (life, d) => {
      const unserved = await committed(life, d);
      expect(!(await life.cancel(unserved.grantId)), "Cancel on a live grant that has not served a call revoked it: Cancel holds only in handoff");
      await expectState(unserved.mcpUrl, "data", "after Cancel on a live grant that had not served a call");
      const live = await liveGrant(life, d);
      expect(!(await life.cancel(live.grantId)), "Cancel on a live grant that served a call revoked it: Cancel holds only in handoff, before any served call");
      await expectState(live.mcpUrl, "data", "after Cancel on a live grant");
      const ended = await handoff(life, d);
      await giveBack(life, JSON.stringify({ mcp_url: ended.mcpUrl }));
      expect(!(await life.cancel(ended.grantId)), "Cancel on an ended grant said it revoked it: ended stays ended");
      await expectState(ended.mcpUrl, "not_found", "after Cancel on an ended grant");
    }),

    check("the acknowledgement's move is conditional: a give-back or T_ack while in flight ends the grant for good", async (life, d) => {
      // A give-back while in flight.
      const a = await inFlight(life, d);
      try {
        const r = await giveBack(life, JSON.stringify({ mcp_url: a.mcpUrl }));
        expect(r.status === 200, `POST /apc/revoke answered HTTP ${r.status}`);
      } finally {
        await settle(life, a.hold, a.allowed, "ack");
      }
      await expectState(a.mcpUrl, "not_found", "the hub's acknowledgement came after a give-back (M7 ends a grant in flight)");
      // T_ack while in flight.
      const b = await inFlight(life, d);
      try {
        await life.advance(T_ACK_MAX_MS + 1000);
      } finally {
        await settle(life, b.hold, b.allowed, "ack");
      }
      await expectState(b.mcpUrl, "not_found", `the hub's acknowledgement came more than ${T_ACK_MAX_MS / 1000} s after the Allow (T_ack)`);
      const init = await send(b.mcpUrl, "initialize", INIT);
      expect(init.status === 404, `initialize on a grant T_ack ended answers 404, got ${brief(init)}`);
    }),

    check(`T_ack: a grant whose Allow never heard back ends within ${T_ACK_MAX_MS / 1000} s across a restart of the app, and a late acknowledgement does not bring it back`, async (life, d) => {
      const f = await inFlight(life, d);
      try {
        // The app dies with its call to the hub open, and comes back on the same storage.
        await life.restart();
        await life.advance(T_ACK_MAX_MS + 1000);
        // In flight and ended both answer 404; the fresh consent below is what tells them apart.
        for (const method of ["tools/list", "initialize"]) {
          const s = await send(f.mcpUrl, method, method === "initialize" ? INIT : {});
          expect(s.status === 404, `after a restart and T_ack, the grant whose Allow never heard back answers ${method} with ${brief(s)}, expected 404`);
        }
        // It ended: a new drop of the same agent asks the person again, and pairs.
        const again = await consent(life, d, f.agent);
        const answer = await again.allow();
        expect(answer.ok, `after T_ack, a new Allow of the same agent did not pair (${answer.error}): the old grant still holds its place`);
      } finally {
        // The old call hears a yes, late: whatever ran it, the grant stays ended.
        f.hold.release("ack");
        await within(f.allowed.catch(() => undefined), deadlineOf(life) + DEADLINE_SLACK_MS);
      }
      await expectState(f.mcpUrl, "not_found", "the old grant, after a late acknowledgement");
    }),

    check(`T_connect: a grant with no committed initialize ends within ${T_CONNECT_MAX_MS / 60_000} minutes of the acknowledgement`, async (life, d) => {
      const g = await handoff(life, d);
      const before = await send(g.mcpUrl, "tools/list", {});
      expect(before.status === 200, `a grant in handoff serves tools/list: ${brief(before)}`);
      await life.advance(T_CONNECT_MAX_MS + 1000);
      for (const method of ["tools/list", "initialize"]) {
        const s = await send(g.mcpUrl, method, method === "initialize" ? INIT : {});
        expect(s.status === 404, `${T_CONNECT_MAX_MS / 60_000} minutes after the acknowledgement with no initialize, the grant answers ${method} with ${brief(s)}, expected 404 (ended)`);
      }
      // A late approval and introduction does not bring it back.
      await d.hub.decide(g.pairing.id, "approve", g.code);
      await expectState(g.mcpUrl, "not_found", "after T_connect and a late approval");
    }),

    check("T_idle: a live grant with no wake action sleeps, and the wake actions (the page's heartbeat, a confirmed drop) wake it", async (life, d) => {
      if (!life.idleMs) return { note: "not checked: the adapter gives no idleMs, so the app does not sleep (dormant is a SHOULD)" };
      const g = await liveGrant(life, d);
      await app.page.setOpen(false);
      await life.heartbeat();
      await life.advance(life.idleMs + 1000);
      await expectState(g.mcpUrl, "idle", `T_idle (${life.idleMs} ms) after the last wake action`);
      expectAnswer("dormant", VIEW, await toolCall(g.mcpUrl, "get_current_view"));
      await life.heartbeat();
      await expectState(g.mcpUrl, "data", "after the page's heartbeat");
      await life.advance(life.idleMs + 1000);
      await expectState(g.mcpUrl, "idle", "T_idle after the heartbeat");
      const shown = await drop(life, d, g.agent);
      expect(shown.page === "pinned", `a drop of an agent whose grant is paired pins it, got ${JSON.stringify(shown).slice(0, 200)}`);
      await expectState(g.mcpUrl, "data", "after a confirmed drop (a wake action)");
    }),

    check("agent traffic (initialize, ping, tools/list, tools/call) never wakes a grant or extends it", async (life, d) => {
      if (!life.idleMs) return { note: "not checked: the adapter gives no idleMs, so the app does not sleep (dormant is a SHOULD)" };
      const g = await liveGrant(life, d);
      await app.page.setOpen(false);
      await life.heartbeat();
      const traffic = async () => {
        for (const [method, params] of [["initialize", INIT], ["ping", {}], ["tools/list", {}], ["tools/call", { name: "get_current_view", arguments: {} }], ["tools/call", { name: app.probe.tool, arguments: app.probe.args }]] as const) {
          await send(g.mcpUrl, method, params);
        }
      };
      const step = Math.ceil(life.idleMs * 0.6);
      await life.advance(step);
      await traffic();
      await life.advance(step);
      await expectState(g.mcpUrl, "idle", `T_idle after the last wake action, with agent traffic at ${step} ms (it must not extend the grant)`);
      await traffic();
      await expectState(g.mcpUrl, "idle", "after agent traffic on a dormant grant (it must not wake it)");
      await life.heartbeat();
      await expectState(g.mcpUrl, "data", "after the page's heartbeat");
    }),

    check("precedence: handoff, revoked and ended each win over dormant", async (life, d) => {
      if (!life.idleMs) return { note: "not checked: the adapter gives no idleMs, so the app does not sleep (dormant is a SHOULD)" };
      await app.page.setOpen(false);
      // Dormant is for live grants only: a grant in handoff past T_idle (and before T_connect) is still in handoff.
      if (life.idleMs + 1000 < T_CONNECT_MAX_MS) {
        const h = await handoff(life, d);
        await life.advance(life.idleMs + 1000);
        await expectState(h.mcpUrl, "pairing", `a grant in handoff for longer than T_idle (${life.idleMs} ms)`);
        expectAnswer("handoff", VIEW, await toolCall(h.mcpUrl, "get_current_view"));
      }
      const r = await liveGrant(life, d);
      await life.advance(life.idleMs + 1000);
      await expectState(r.mcpUrl, "idle", "T_idle after going live");
      expect(await app.page.revoke(r.grantId), "the app refused the owner's Revoke on a dormant grant");
      await table("revoked", r.mcpUrl);
      const e = await liveGrant(life, d);
      await life.advance(life.idleMs + 1000);
      await expectState(e.mcpUrl, "idle", "T_idle after going live");
      await giveBack(life, JSON.stringify({ mcp_url: e.mcpUrl }));
      await table("ended", e.mcpUrl);
      await life.heartbeat();
    }),

    // The hub call.
    check("M1: the drop's hub is parsed and compared by origin with the allowlist, on the drop and again on an Allow that carries a hub", async (life, d) => {
      const allowed = new URL(d.hub.origin);
      const host = allowed.host;
      const tricky = [
        `${d.hub.origin}.evil.example`,
        "https://evil.example",
        `${allowed.protocol}//user@${host}`,
        `${allowed.protocol}//user:secret@${host}`,
        `${d.hub.origin}/apc`,
        `${d.hub.origin}/?x=1`,
        `${d.hub.origin}/#x`,
        // http: is refused unless the allowlisted hub is itself a declared local-dev http: origin.
        ...(allowed.protocol === "https:" ? [`http://${host}`] : []),
        `${allowed.protocol}//${allowed.hostname}:8443`,
        `${allowed.protocol}//${allowed.hostname}.`,
        `${d.hub.origin}\\@evil.example`,
        host,
        "",
        "javascript:alert(1)",
      ];
      for (const hub of tricky) {
        const before = d.hub.requests.length;
        const shown = await drop(life, d, newAgent(), hub);
        expect(shown.page === "refused" && shown.error === "hub_not_allowed", `a drop with hub ${JSON.stringify(hub)} answers hub_not_allowed, with no consent: got ${JSON.stringify(shown).slice(0, 200)}`);
        expect(d.hub.requests.length === before, `a drop with hub ${JSON.stringify(hub)} called ${d.hub.requests.slice(before).join(", ")}`);
      }
      for (const hub of [`${d.hub.origin}.evil.example`, `https://user@${host}`, `${d.hub.origin}/apc`]) {
        const c = await consent(life, d);
        const before = d.hub.requests.length;
        const answer = await c.allow({ hub });
        if (life.allowCarriesHub) {
          expect(!answer.ok && answer.error === "hub_not_allowed", `an Allow sent with hub ${JSON.stringify(hub)} answers hub_not_allowed: got ${JSON.stringify(answer)}`);
          expect(d.hub.requests.length === before, `an Allow sent with hub ${JSON.stringify(hub)} called ${d.hub.requests.slice(before).join(", ")}`);
        } else {
          // The hub is bound to the consent on the server: nothing on the Allow to tamper with, so it goes to the drop's hub only.
          const off = d.hub.requests.slice(before).filter((u) => new URL(u).origin !== d.hub.origin);
          expect(off.length === 0, `an Allow (whose hub is bound to the consent) called ${off.join(", ")}`);
        }
      }
    }),

    check("M2: a hub that redirects, answers a 3xx, an opaqueredirect or a redirected answer holds no grant, and the app's request never reaches the redirect's target", async (life, d) => {
      for (const mode of ["redirect", "status_3xx", "opaque_redirect", "redirected"] as const) await refusedWith(life, d, mode, "M2");
    }),

    check(`M3: one deadline (${HUB_CALL_DEADLINE_MS / 1000} s at most) covers the headers and the body: stalled headers, a stalled body, and slow headers then a slow body each trip it`, async (life, d) => {
      d.hub.delayMs = Math.floor(deadlineOf(life) * 0.6);
      for (const mode of ["slow_headers", "slow_body", "slow_headers_then_body"] as const) await refusedWith(life, d, mode, "M3");
    }),

    check("M4: the byte cap and the content-length rules", async (life, d) => {
      for (const mode of ["length_over_cap", "length_not_digits", "body_over_cap"] as const) await refusedWith(life, d, mode, "M4");
      // Not refused: a content-length of digits within the cap, and one other than the decoded body's (gzip).
      for (const mode of ["ack_with_length", "length_mismatch"] as const) await takenWith(life, d, mode, "M4");
    }),

    check("M5: no lock across the hub call: other owner requests answer while it is held, a second Allow gets pairing_in_progress, and a second drop waits or is refused", async (life, d) => {
      const f = await inFlight(life, d);
      let waitingDrop: Promise<ApcDockDropOutcome> | undefined;
      let early: ApcDockDropOutcome | undefined;
      try {
        // Another agent's drop and Allow answer while the call is held.
        const asked = await within(consent(life, d), UNBLOCKED_MS);
        expect(!asked.timedOut, `a drop of another agent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call: no lock may be held across it`);
        const other = await within(asked.value.allow(), UNBLOCKED_MS);
        expect(!other.timedOut, `an Allow of another agent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call: no lock may be held across it`);
        expect(other.value.ok, `an Allow of another agent, while one is held, did not pair: ${other.value.error}`);
        // The person clicks Allow again on the same consent.
        const again = await within(f.consent.allow(), UNBLOCKED_MS);
        expect(!again.timedOut, `a second Allow of the same consent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call`);
        expect(!again.value.ok && again.value.error === "pairing_in_progress", `a second Allow while the first waits on the hub answers pairing_in_progress: got ${JSON.stringify(again.value)}`);
        // A new drop of the same agent: it may wait for the first to finish, or be refused; it may not start another pairing.
        waitingDrop = drop(life, d, f.agent);
        waitingDrop.catch(() => {});
        const answered = await within(waitingDrop, UNBLOCKED_MS);
        if (!answered.timedOut) {
          early = answered.value;
          expect(early.page === "refused" && early.error === "pairing_in_progress", `a drop of the same agent, answered while the first Allow waits on the hub, answers pairing_in_progress (or waits): got ${JSON.stringify(early).slice(0, 200)}`);
        }
        expect(pairCount(d, f.agent) === 1, `the app sent /apc/pair for the held agent ${pairCount(d, f.agent)} times while the first call was held: one at a time per (user, hub, agent)`);
      } finally {
        const first = await settle(life, f.hold, f.allowed, "ack");
        expect(first.ok, `the held Allow did not pair once released: ${first.error}`);
      }
      let note = "the second drop of the held agent was refused with pairing_in_progress";
      if (!early && waitingDrop) {
        const later = await within(waitingDrop, deadlineOf(life) + DEADLINE_SLACK_MS);
        expect(!later.timedOut, "the second drop of the held agent was still waiting after the first Allow settled");
        note = `the second drop of the held agent waited for the first, then answered: ${later.value.page}`;
      }
      return { note: `${note}. Serialization across instances (an advisory lock and a partial unique index, say) cannot be seen from one process` };
    }),

    check("M9: hub requests (/apc/pair and /apc/confirm) go to the parsed origin, never to the raw hub string", async (life, d) => {
      const raw = `${d.hub.origin}/`;
      const before = d.hub.requests.length;
      const where = () => `called ${JSON.stringify(d.hub.requests.slice(before))}`;
      let g: Awaited<ReturnType<typeof handoff>>;
      try {
        g = await handoff(life, d, raw);
      } catch (error) {
        throw new ConformanceError(`M9: with the drop's hub "${raw}", the Allow failed (${error instanceof Error ? error.message : String(error)}); the app ${where()}`);
      }
      const shown = await drop(life, d, g.agent, raw);
      expect(shown.page === "waiting", `M9: with the drop's hub "${raw}", a second drop shows the waiting card: got ${JSON.stringify(shown).slice(0, 200)}; the app ${where()}`);
      const called = d.hub.requests.slice(before);
      for (const path of ["/apc/pair", "/apc/confirm"]) expect(called.includes(`${d.hub.origin}${path}`), `with the drop's hub "${raw}", the app never called ${d.hub.origin}${path}: it called ${JSON.stringify(called)}`);
      const wrong = called.filter((u) => !u.startsWith(`${d.hub.origin}/apc/`));
      expect(wrong.length === 0, `with the drop's hub "${raw}", the app called ${JSON.stringify(wrong)}`);
    }),

    // The owner's endpoints.
    check("M6: the drop, the Allow, the heartbeat and Cancel refuse a foreign Origin (one matching the request's host included), Sec-Fetch-Site cross-site and same-site, a non-JSON media type and no session; a request with neither header is taken on the session", async (life, d) => {
      const { origin, session } = life.owner;
      const own = new URL(origin);
      const endpoints: Array<[string, ApcDockOwnerEndpoint | { websocket: string } | undefined]> = [
        ["the drop", life.owner.drop],
        ["the Allow", life.owner.allow],
        ["the heartbeat", life.owner.heartbeat],
        ["Cancel", life.owner.cancel],
      ];
      const json = { ...session, "content-type": "application/json" };
      const status = async (url: URL, init: RequestInit) => {
        const response = await fetchApp(new Request(url, init));
        await response.body?.cancel().catch(() => {});
        return response.status;
      };
      for (const [name, ep] of endpoints) {
        expect(ep, `give dock.lifecycle.owner.${name === "the drop" ? "drop" : name === "the Allow" ? "allow" : name === "the heartbeat" ? "heartbeat" : "cancel"}: M6 covers ${name}`);
        if ("websocket" in ep) {
          // A WebSocket heartbeat: its handshake follows the same Origin rule.
          const shake = (base: string, headers: Record<string, string>) =>
            status(new URL(ep.websocket, base), { method: "GET", headers: { ...headers, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
          const ok = await shake(origin, { ...session, origin });
          expect(ok === 101 || (ok >= 200 && ok < 300), `${name}: a WebSocket handshake with its own Origin and the owner's session is taken (101), got HTTP ${ok}`);
          for (const [what, base, headers] of [
            ["a foreign Origin", origin, { ...session, origin: "https://evil.example" }],
            ["Origin null", origin, { ...session, origin: "null" }],
            [`Origin ${INTERNAL_ORIGIN}, the request's own host, not the configured origin`, INTERNAL_ORIGIN, { ...session, origin: INTERNAL_ORIGIN }],
            ["no session", origin, { origin }],
          ] as const) {
            const got = await shake(base, headers);
            expect(got >= 400 && got < 500, `${name}: a WebSocket handshake with ${what} is refused (4xx), got HTTP ${got}`);
          }
          continue;
        }
        const post = async (base: string, headers: Record<string, string>) => status(new URL(ep.path, base), { method: "POST", headers, body: JSON.stringify(await ep.body()) });
        for (const [what, headers] of [
          ["its own Origin", { ...json, origin, "sec-fetch-site": "same-origin" }],
          ["neither Origin nor Sec-Fetch-Site (a client that is not a browser)", json],
        ] as const) {
          const got = await post(origin, headers);
          expect(got >= 200 && got < 300, `${name}: a request with ${what} and the owner's session is taken (2xx), got HTTP ${got}`);
        }
        const refused: Array<[string, string, Record<string, string>]> = [
          ["a foreign Origin", origin, { ...json, origin: "https://evil.example" }],
          ["Origin null", origin, { ...json, origin: "null" }],
          [`Origin on another scheme (http://${own.host})`, origin, { ...json, origin: `http://${own.host}` }],
          // Sent to another host with that host as Origin (as a proxy's inside sees it): the app compares with its configured origin, never the request's.
          [`Origin ${INTERNAL_ORIGIN}, the request's own host, not the configured origin`, INTERNAL_ORIGIN, { ...json, origin: INTERNAL_ORIGIN }],
          ["Sec-Fetch-Site cross-site", origin, { ...json, "sec-fetch-site": "cross-site" }],
          ["Sec-Fetch-Site same-site", origin, { ...json, "sec-fetch-site": "same-site" }],
          ["its own Origin with Sec-Fetch-Site cross-site", origin, { ...json, origin, "sec-fetch-site": "cross-site" }],
          ["the media type text/plain", origin, { ...session, "content-type": "text/plain" }],
          ["the media type application/x-www-form-urlencoded", origin, { ...session, "content-type": "application/x-www-form-urlencoded" }],
          ["no session", origin, { "content-type": "application/json" }],
        ];
        for (const [what, base, headers] of refused) {
          const got = await post(base, headers);
          expect(got >= 400 && got < 500, `${name}: a request with ${what} is refused (4xx), got HTTP ${got}`);
        }
        // Every state change is a POST: a GET with the session and the body's fields as a query may answer
        // anything, and must change nothing (no hub call, Cancel's grant still in handoff, a dormant grant still asleep).
        const received = d.hub.received.length;
        const fields = (await ep.body()) as Record<string, unknown> | null;
        const made = d.hub.received.slice(received).map((b) => b.mcp_url).filter((u): u is string => typeof u === "string");
        let asleep: string | undefined;
        if (name === "the heartbeat" && life.idleMs) {
          const g = await liveGrant(life, d);
          await app.page.setOpen(false);
          await life.advance(life.idleMs + 1000);
          await expectState(g.mcpUrl, "idle", "the heartbeat's GET probe: T_idle after going live");
          asleep = g.mcpUrl;
        }
        const url = new URL(ep.path, origin);
        for (const [k, v] of Object.entries(fields ?? {})) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
        const calls = d.hub.requests.length;
        await status(url, { method: "GET", headers: { ...session } });
        const where = `${name}: after a GET with the owner's session and the body's fields as a query (every state change is a POST)`;
        expect(d.hub.requests.length === calls, `${where}, the app called ${d.hub.requests.slice(calls).join(", ")}`);
        if (name === "Cancel") {
          expect(made.length > 0, "Cancel: owner.cancel.body() made no grant in handoff through the hub, so the suite cannot see what a Cancel does");
          for (const u of made) await expectState(u, "pairing", where);
        }
        if (asleep) {
          await expectState(asleep, "idle", where);
          await life.heartbeat();
        }
      }
    }),

    // The give-back.
    check("M7: /apc/revoke answers the same 200 to any input with its body capped, ends a matching grant (then 404), and leaves revoked and ended grants as they are", async (life, d) => {
      const answers: Array<[string, Response]> = [];
      const record = async (what: string, body: string) => {
        const r = await giveBack(life, body);
        answers.push([what, r]);
        return r;
      };
      await record("an empty object", "{}");
      await record("text that is not JSON", "not json");
      await record("mcp_url not a string", JSON.stringify({ mcp_url: 5 }));
      await record("another origin's URL", JSON.stringify({ mcp_url: "https://elsewhere.example/mcp/abc" }));
      await record("a URL no grant has", JSON.stringify({ mcp_url: `${life.owner.origin}/mcp/${"0".repeat(22)}` }));
      await record("a body of 1 MiB", JSON.stringify({ mcp_url: "x".repeat(1 << 20) }));
      // A body that never ends: the app reads up to its cap and answers.
      let stop = false;
      const endless = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // One chunk per turn of the event loop, so a reader that never stops does not starve the timers.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (stop) return controller.close();
          controller.enqueue(new Uint8Array(16384).fill(0x20));
        },
      });
      const capped = await within(giveBack(life, endless), UNBLOCKED_MS);
      stop = true;
      expect(!capped.timedOut, `POST /apc/revoke with a body that never ends had not answered after ${UNBLOCKED_MS / 1000} s: its body must be capped`);
      answers.push(["a body that never ends", capped.value]);
      const g = await handoff(life, d);
      await record("a grant in handoff", JSON.stringify({ mcp_url: g.mcpUrl }));
      await expectState(g.mcpUrl, "not_found", "after a give-back of a grant in handoff");
      await record("that grant again, ended", JSON.stringify({ mcp_url: g.mcpUrl }));
      await expectState(g.mcpUrl, "not_found", "after a second give-back of an ended grant");
      const live = await liveGrant(life, d);
      await record("a live grant", JSON.stringify({ mcp_url: live.mcpUrl }));
      await expectState(live.mcpUrl, "not_found", "after a give-back of a live grant");
      const cancelled = await handoff(life, d);
      expect(await life.cancel(cancelled.grantId), "the app refused Cancel on a grant in handoff");
      await record("a revoked grant", JSON.stringify({ mcp_url: cancelled.mcpUrl }));
      await expectState(cancelled.mcpUrl, "revoked", "after a give-back of a revoked grant (revoked stays revoked)");
      const [, firstAnswer] = answers[0]!;
      const reference = await firstAnswer.text();
      for (const [what, r] of answers) {
        expect(r.status === 200, `POST /apc/revoke with ${what} answers HTTP ${r.status}, expected 200`);
        if (r !== firstAnswer) {
          const body = await r.text();
          expect(body === reference, `POST /apc/revoke with ${what} answers ${JSON.stringify(body.slice(0, 120))}, not the same as with an empty object (${JSON.stringify(reference.slice(0, 120))}): its answer must not tell`);
        }
      }
    }),

    // apc.json.
    check(`M8: apc.json lists dock only while the app can pair, cached ${APC_JSON_PAIRING_MAX_AGE_S} s at most`, async (life) => {
      const read = async (sendTo: (request: Request) => Promise<Response>, what: string) => {
        const r = await sendTo(new Request(`${life.owner.origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }));
        expect(r.status === 200, `${what}: GET ${APC_JSON_PATH} answered HTTP ${r.status}`);
        const cache = r.headers.get("cache-control") ?? "";
        for (const m of cache.matchAll(/(?:s-)?max-age\s*=\s*"?(\d+)/gi)) {
          expect(Number(m[1]) <= APC_JSON_PAIRING_MAX_AGE_S, `${what}: ${APC_JSON_PATH} is cached ${m[1]} s (Cache-Control: ${cache}), more than ${APC_JSON_PAIRING_MAX_AGE_S}`);
        }
        const profiles = ((await r.json().catch(() => ({}))) as { profiles?: unknown }).profiles;
        expect(Array.isArray(profiles), `${what}: ${APC_JSON_PATH} has no profiles`);
        return profiles as unknown[];
      };
      expect((await read(fetchApp, "the app")).includes("dock"), "the app, which can pair, does not list dock in apc.json");
      const disabled = await life.pairingDisabled();
      expect(!(await read(disabled, "the app with pairing disabled")).includes("dock"), "the app with pairing disabled (its configuration missing) still lists dock in apc.json");
    }),

    check("the pairing code goes only in /apc/pair: never in /apc/confirm, a hub URL or an MCP answer", async (life, d) => {
      const before = d.hub.bodies.length;
      const g = await handoff(life, d);
      await drop(life, d, g.agent);
      const forms = [g.code, formatPairingCode(g.code)];
      const leaks = d.hub.bodies.slice(before).filter((b) => new URL(b.url).pathname !== "/apc/pair" && forms.some((c) => b.text.includes(c) || b.url.includes(c)));
      expect(leaks.length === 0, `the pairing code went to the hub outside /apc/pair: ${leaks.map((b) => b.url).join(", ")}`);
      const pairs = d.hub.bodies.slice(before).filter((b) => new URL(b.url).pathname === "/apc/pair");
      expect(pairs.every((b) => !forms.some((c) => b.url.includes(c))), "the pairing code went in /apc/pair's URL");
      for (const [method, params] of [["tools/list", {}], ["tools/call", { name: "get_current_view", arguments: {} }], ["tools/call", { name: app.probe.tool, arguments: app.probe.args }], ["initialize", INIT]] as const) {
        const s = await send(g.mcpUrl, method, params);
        const raw = JSON.stringify(s.body);
        expect(!forms.some((c) => raw.includes(c)), `${method} on the grant carries the pairing code: it is shown only on the owner's page`);
      }
    }),

    // One pending pairing.
    check("one pending pairing: a second drop on a pending pairing shows the same code with no new consent or /apc/pair, and its target replaces the pending pin", async (life, d) => {
      const g = await handoff(life, d);
      const before = pairCount(d, g.agent);
      const again = await drop(life, d, g.agent, d.hub.origin, second);
      expect(again.page === "waiting", `a second drop while the hub says pending shows the waiting card with the code, got ${JSON.stringify(again).slice(0, 200)}`);
      expect(normalizePairingCode(again.code) === g.code, `a second drop on a pending pairing shows ${JSON.stringify(again.code)}, not the same code as the consent (${g.code})`);
      expect(pairCount(d, g.agent) === before, "a second drop on a pending pairing sent the hub a new /apc/pair");
      await expectState(g.mcpUrl, "pairing", "after a second drop on a pending pairing");
      // Once live, the pending pin is the second drop's target.
      const init = await send(g.mcpUrl, "initialize", INIT);
      expect(served(init), `initialize is served: ${brief(init)}`);
      const view = await toolCall(g.mcpUrl, "get_current_view");
      const focus = (resultOf(view)?.structuredContent ?? text(resultOf(view) ?? {})).focus;
      expect(focusNames(focus, second), `once live, the focus is the second drop's target (${canonicalTarget(second)}): got ${JSON.stringify(focus).slice(0, 200)}`);
    }),

    check("one pending pairing: not_paired from /apc/confirm ends the grant and starts a fresh consent", async (life, d) => {
      const g = await handoff(life, d);
      d.hub.forget(g.pairing.id);
      const again = await drop(life, d, g.agent);
      expect(again.page === "consent", `a drop the hub answers not_paired starts a fresh consent, got ${JSON.stringify(again).slice(0, 200)}`);
      expect(normalizePairingCode(again.code) !== g.code, "the fresh consent shows the old code: every consent makes a new one");
      await expectState(g.mcpUrl, "not_found", "the old grant, after not_paired");
    }),

    check("one pending pairing: once the app's stored expiry has passed, a drop shows no code, ends the grant and starts a fresh consent", async (life, d) => {
      const g = await handoff(life, d);
      // The hub still says pending (the stand-in never expires a pairing by itself): the app's own expiry decides.
      await life.advance(PAIRING_CODE_TTL_MS + 1000);
      const again = await drop(life, d, g.agent);
      expect(again.page === "consent", `a drop past the stored expiry starts a fresh consent (no old code), got ${JSON.stringify(again).slice(0, 200)}`);
      expect(normalizePairingCode(again.code) !== g.code, "past the stored expiry the page still shows the old code");
      await expectState(g.mcpUrl, "not_found", "the old grant, past its stored expiry");
    }),

    check("one pending pairing: paired before the app saw initialize stays in handoff, and only initialize makes it live", async (life, d) => {
      const g = await handoff(life, d);
      const decided = await d.hub.decide(g.pairing.id, "approve", g.code, { introduce: false });
      expect(decided.ok, `the stand-in hub did not approve: ${decided.error}`);
      const again = await drop(life, d, g.agent);
      expect(again.page === "connecting", `a drop the hub answers paired, before initialize, says it is connecting (no code), got ${JSON.stringify(again).slice(0, 200)}`);
      await expectState(g.mcpUrl, "pairing", "after confirm said paired, before initialize (only initialize moves the state)");
      const init = await send(g.mcpUrl, "initialize", INIT);
      expect(served(init), `initialize is served: ${brief(init)}`);
      await expectState(g.mcpUrl, "data", "after initialize");
    }),

    check("one pending pairing: before the acknowledgement a new drop replaces the consent, and the stale Allow gets consent_expired", async (life, d) => {
      const old = await consent(life, d);
      const fresh = await consent(life, d, old.agent);
      expect(normalizePairingCode(fresh.code) !== normalizePairingCode(old.code), "the new consent shows the old code: every consent makes a new one");
      const before = pairCount(d, old.agent);
      const stale = await old.allow();
      expect(!stale.ok && stale.error === "consent_expired", `the Allow on the replaced consent answers consent_expired: got ${JSON.stringify(stale)}`);
      expect(pairCount(d, old.agent) === before, "the stale Allow sent the hub /apc/pair");
      const answer = await fresh.allow();
      expect(answer.ok, `the Allow on the new consent did not pair: ${answer.error}`);
    }),
  ];
}
