/**
 * The Dock profile as built (APC 0.10, TIN-884): the app-side checks. On an app that claims 0.10.0 or later on
 * the Dock profile, through the adapter's `dock.lifecycle` and the suite's stand-in hub:
 *
 * - **The answer table**: in every state the adapter can put a grant into (in flight, handoff, live, dormant for an
 *   app that sleeps, ended, revoked), the exact answer to `initialize`, `ping`, `tools/list`, the core tools, one of
 *   the app's own tools, another method and a notification, with `dockGrantAnswer` (`@tineira/apc-protocol`) as
 *   the oracle. The `pairing` and `idle` errors carry `{ error, message }` in `structuredContent` and in the text;
 *   the idle shapes carry `idle: true`; no answer in handoff or dormant carries `attention`, `then`, `apc_link` or
 *   a presence event.
 * - **The transitions**: `initialize` commits the move out of handoff and fails closed; a commit racing Cancel ends
 *   by the state that won; the acknowledgement's move is conditional; `T_ack`, `T_connect` and `T_idle` through
 *   the adapter's time seam (and `T_ack` across a restart, when the adapter can restart the app); agent traffic
 *   never wakes a grant.
 * - **The hub call** (M1 to M5, M9) through the stand-in hub, **the owner's endpoints** (M6), **the give-back**
 *   (M7), **`apc.json` with pairing disabled** (M8), and **one pending pairing** (the spec's § "One pending
 *   pairing").
 *
 * The hub's own duties (H1 to H7) are not checked here: the hub is reference-only until after 1.0.
 */
import {
  APC_JSON_PATH,
  APC_JSON_PAIRING_MAX_AGE_S,
  APC_LINK_KEY,
  DOCK_GRANT_RPC_ERROR_CODE,
  HUB_CALL_DEADLINE_MS,
  IDLE_ERROR,
  PAIRING_ERROR,
  REVOKED_HTTP_STATUS,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  compareStandard,
  dockGrantAnswer,
  isRevokedAnswer,
  normalizePairingCode,
  type DockGrantCall,
  type DockGrantState,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, expect, isObject, resultKey, rpcBody, sameJson, text, type ToolCallResult } from "./shared.ts";
import type { StandInHold, StandInHubMode } from "./hub.ts";
import type { ApcAppAdapter, ApcDockAdapter, ApcDockDropOutcome, ApcDockLifecycleAdapter } from "./index.ts";

interface Named {
  name: string;
  run(): Promise<void>;
  note?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: "apc-conformance via dock", version: "0.10.0" } };
/** How long an owner request may take while another holds the hub call (M5): it must not wait on it. */
const UNBLOCKED_MS = 1500;
/** How long a hub call may take past its deadline before the check gives up on it (M3). */
const DEADLINE_SLACK_MS = 2500;

/** What a check of a 0.10 rule says of an app that claims an earlier standard: passed, not checked. */
const NOT_010 = { note: "not checked: the app's apc.json claims a standard before 0.10.0, which does not have the Dock grant's states" };

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
  notification?: boolean;
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
  const [first] = app.targets;
  const fetchApp = (request: Request) => (app.fetch ? app.fetch(request) : fetch(request));
  const check = (name: string, body: (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => Promise<void | { note: string }>): Named => {
    const named: Named = {
      name: `${app.name} (dock): 0.10: ${name}`,
      async run() {
        const claimed = await standard(dock?.lifecycle);
        if (!(typeof claimed === "string" && compareStandard(claimed, "0.10.0") >= 0)) {
          named.note = NOT_010.note;
          return;
        }
        expect(dock, "the app claims 0.10.0 or later on the Dock profile: give dock in the adapter (ApcDockAdapter)");
        expect(dock.lifecycle, "the app claims 0.10.0 or later on the Dock profile: give dock.lifecycle in the adapter (ApcDockLifecycleAdapter)");
        const out = await body(dock.lifecycle, dock);
        if (out?.note) named.note = out.note;
      },
    };
    return named;
  };

  /** The standard the app's apc.json claims: from the owner's origin when the adapter gives it, else from a grant's. */
  const standard = async (life: ApcDockLifecycleAdapter | undefined): Promise<unknown> => {
    const origin = life?.owner.origin ?? new URL((await app.connect()).mcpUrl).origin;
    const response = await fetchApp(new Request(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }));
    return ((await response.json().catch(() => ({}))) as { standard?: unknown }).standard;
  };

  const send = async (mcpUrl: string, method: string, params: Record<string, unknown>, notification = false): Promise<Sent> => {
    const started = Date.now();
    const response = await fetchApp(
      new Request(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = rpcBody(response.headers.get("content-type") ?? "", await response.text());
    return { status: response.status, body, headers: response.headers, ms: Date.now() - started };
  };
  const toolCall = (mcpUrl: string, tool: string, args: Record<string, unknown> = {}) => send(mcpUrl, "tools/call", { name: tool, arguments: args });
  const resultOf = (s: Sent): ToolCallResult | undefined => (isObject(s.body) && isObject(s.body.result) ? (s.body.result as ToolCallResult) : undefined);
  const brief = (s: Sent) => `HTTP ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`;

  const tableCalls = (): TableCall[] => [
    { label: "initialize", call: "initialize", method: "initialize", params: INIT },
    { label: "ping", call: "ping", method: "ping", params: {} },
    { label: "tools/list", call: "tools/list", method: "tools/list", params: {} },
    { label: "get_current_view", call: "core_tool", method: "tools/call", params: { name: "get_current_view", arguments: {} } },
    { label: "wait_for_focus", call: "core_tool", method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: 3 } } },
    { label: app.probe.tool, call: "app_tool", method: "tools/call", params: { name: app.probe.tool, arguments: app.probe.args } },
    { label: "resources/list", call: "other_method", method: "resources/list", params: {} },
    { label: "notifications/initialized", call: "notification", method: "notifications/initialized", params: {}, notification: true },
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
        if (c.notification) {
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
          expect(s.ms < 2000, `${where} answers at once, not after ${s.ms} ms`);
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
    for (const c of ordered) expectAnswer(state, c, await send(mcpUrl, c.method, c.params, c.notification));
    if (grantId && (state === "handoff" || state === "dormant")) {
      const events = app.page.takePresence().filter((e) => e.grant_id === grantId);
      expect(events.length === 0, `a grant in ${state} published ${events.length} presence event(s): no answer in ${state} may`);
    }
  };

  /** What a probe of the app's own tool says of the grant's state. */
  const stateOf = async (mcpUrl: string): Promise<"data" | "pairing" | "idle" | "not_found" | "revoked" | string> => {
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
  const giveBack = async (life: ApcDockLifecycleAdapter, body: string) =>
    fetchApp(new Request(`${life.owner.origin}/apc/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body }));

  /** The person drops a new agent from the stand-in hub (or `hub`): the consent, which must be one. */
  const consent = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, agent = newAgent(), hub = d.hub.origin) => {
    const shown = await life.dropAgent({ agent, ticket: d.hub.ticket(agent), hub });
    expect(shown.page === "consent", `a drop of an agent the app holds no grant for shows the consent, got ${JSON.stringify(shown).slice(0, 200)}`);
    expect(normalizePairingCode(shown.code), `the consent shows ${JSON.stringify(shown.code)}, not a pairing code`);
    return { agent, ...shown };
  };
  /** A grant in handoff: dropped, Allowed, acknowledged by the hub, with no initialize yet. */
  const handoff = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => {
    const c = await consent(life, d);
    const answer = await c.allow();
    expect(answer.ok, `the Allow did not pair: ${answer.error}`);
    expect(typeof answer.grantId === "string" && answer.grantId.length > 0, "the Allow gives the grant's id (ApcDockAllowAnswer.grantId)");
    const pairing = d.hub.pairings.filter((p) => p.agent === c.agent).at(-1);
    expect(pairing, "the stand-in hub holds no pairing for the agent after the Allow");
    return { agent: c.agent, code: normalizePairingCode(c.code)!, grantId: answer.grantId, mcpUrl: pairing.mcp_url, pairing };
  };
  /** A live grant: in handoff, approved with the code, and introduced (the hub's committed initialize). */
  const liveGrant = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter) => {
    const g = await handoff(life, d);
    const decided = await d.hub.decide(g.pairing.id, "approve", g.code);
    expect(decided.ok, `the code the consent showed did not approve the pairing: ${decided.error}`);
    // The stand-in introduced itself through its `app` route when it has one; this is the introduction otherwise (served either way).
    const init = await send(g.mcpUrl, "initialize", INIT);
    expect(init.status === 200 && isObject(init.body) && isObject(init.body.result), `the hub's initialize on a paired grant is served: ${brief(init)}`);
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
    return { agent: c.agent, hold, allowed, mcpUrl };
  };
  const settle = async (hold: StandInHold, allowed: Promise<unknown>, mode?: StandInHubMode) => {
    hold.release(mode);
    await within(allowed.catch(() => undefined), HUB_CALL_DEADLINE_MS + DEADLINE_SLACK_MS);
  };
  const pairCount = (d: ApcDockAdapter, agent: string) => d.hub.received.filter((b) => b.agent === agent).length;

  /** An Allow against a broken hub (`mode`): refused, and the grant it made answers 404. */
  const refusedWith = async (life: ApcDockLifecycleAdapter, d: ApcDockAdapter, mode: StandInHubMode, rule: string) => {
    const c = await consent(life, d);
    const before = d.hub.received.length;
    d.hub.mode = mode;
    try {
      const answer = await within(c.allow(), HUB_CALL_DEADLINE_MS + DEADLINE_SLACK_MS);
      expect(!answer.timedOut, `${rule}: with a hub that answers ${mode}, the Allow was still waiting after ${(HUB_CALL_DEADLINE_MS + DEADLINE_SLACK_MS) / 1000} s`);
      expect(!answer.value.ok, `${rule}: with a hub that answers ${mode}, the Allow says it paired: the app must refuse the answer`);
    } finally {
      d.hub.mode = "ack";
      d.hub.releaseStalls();
    }
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

  return [
    check("the lifecycle adapter is given (required of an app that claims 0.10.0 or later on the Dock profile)", async () => {}),

    // The answer table, state by state.
    check("the answer table: in flight (from the Allow to the hub's acknowledgement), and a 404 leaves the state unchanged", async (life, d) => {
      const f = await inFlight(life, d);
      try {
        await table("in_flight", f.mcpUrl);
      } finally {
        f.hold.release("ack");
      }
      const answer = await f.allowed;
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
      // An unread pin, made while live: in dormant it must not ride as attention.
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
      expect(again.status === 200 && isObject(again.body) && isObject(again.body.result), `once storage works, initialize is served: ${brief(again)}`);
      await expectState(g.mcpUrl, "data", "after a committed initialize");
    }),

    check("a commit racing Cancel ends by the state that won, and Cancel never revokes a live grant", async (life, d) => {
      for (const order of ["initialize first", "Cancel first"] as const) {
        const g = await handoff(life, d);
        // Both sent in the same tick, in this order.
        const [s, cancelled] =
          order === "initialize first"
            ? await (async () => {
                const init = send(g.mcpUrl, "initialize", INIT);
                const cancel = life.cancel(g.grantId);
                return [await init, await cancel] as const;
              })()
            : await (async () => {
                const cancel = life.cancel(g.grantId);
                const init = send(g.mcpUrl, "initialize", INIT);
                return [await init, await cancel] as const;
              })();
        const committed = s.status === 200 && isObject(s.body) && isObject(s.body.result);
        const revoked = s.status === REVOKED_HTTP_STATUS && isRevokedAnswer(s.body);
        expect(committed || revoked, `${order}: initialize racing Cancel answers by the state that won (served, or revoked), got ${brief(s)}`);
        if (committed) {
          expect(!cancelled, `${order}: initialize committed the grant (live), and Cancel still revoked it: Cancel holds only in handoff, in the same atomic step`);
          await expectState(g.mcpUrl, "data", `${order}: initialize won`);
        } else {
          expect(cancelled, `${order}: initialize answered revoked, but Cancel says it did not revoke`);
          await expectState(g.mcpUrl, "revoked", `${order}: Cancel won`);
        }
      }
      const live = await liveGrant(life, d);
      expect(!(await life.cancel(live.grantId)), "Cancel on a live grant that served a call revoked it: Cancel holds only in handoff, before any served call");
      await expectState(live.mcpUrl, "data", "after Cancel on a live grant");
    }),

    check("the acknowledgement's move is conditional: a give-back or T_ack while in flight ends the grant for good", async (life, d) => {
      // A give-back while in flight.
      const a = await inFlight(life, d);
      try {
        const r = await giveBack(life, JSON.stringify({ mcp_url: a.mcpUrl }));
        expect(r.status === 200, `POST /apc/revoke answered HTTP ${r.status}`);
      } finally {
        await settle(a.hold, a.allowed, "ack");
      }
      await expectState(a.mcpUrl, "not_found", "the hub's acknowledgement came after a give-back (M7 ends a grant in flight)");
      // T_ack while in flight.
      const b = await inFlight(life, d);
      try {
        await life.advance(T_ACK_MAX_MS + 1000);
      } finally {
        await settle(b.hold, b.allowed, "ack");
      }
      await expectState(b.mcpUrl, "not_found", `the hub's acknowledgement came more than ${T_ACK_MAX_MS / 1000} s after the Allow (T_ack)`);
      const init = await send(b.mcpUrl, "initialize", INIT);
      expect(init.status === 404, `initialize on a grant T_ack ended answers 404, got ${brief(init)}`);
    }),

    check(`T_ack: a grant whose Allow never heard back ends within ${T_ACK_MAX_MS / 1000} s, across a restart of the app`, async (life, d) => {
      if (!life.restart) return { note: "not checked across a restart: the adapter gives no restart (T_ack through the time seam is checked with the acknowledgement's move)" };
      const f = await inFlight(life, d);
      try {
        // The app dies with its call to the hub open, and comes back on the same storage.
        await life.restart();
        await life.advance(T_ACK_MAX_MS + 1000);
        for (const method of ["tools/list", "initialize"]) {
          const s = await send(f.mcpUrl, method, method === "initialize" ? INIT : {});
          expect(s.status === 404, `after a restart and T_ack, the grant whose Allow never heard back answers ${method} with ${brief(s)}, expected 404`);
        }
        // It ended: a new drop of the same agent asks the person again, and pairs.
        const again = await consent(life, d, f.agent);
        const answer = await again.allow();
        expect(answer.ok, `after T_ack, a new Allow of the same agent did not pair (${answer.error}): the old grant still holds its place`);
      } finally {
        // The dead process's call: let it end without a yes.
        await settle(f.hold, f.allowed, "error_500");
      }
      await expectState(f.mcpUrl, "not_found", "the old grant, after its dead call ended");
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

    check("T_idle: a live grant with no wake action sleeps, and a wake action (the page's heartbeat) wakes it", async (life, d) => {
      if (!life.idleMs) return { note: "not checked: the adapter gives no idleMs, so the app does not sleep (dormant is a SHOULD)" };
      const g = await liveGrant(life, d);
      await app.page.setOpen(false);
      await life.heartbeat();
      await life.advance(life.idleMs + 1000);
      await expectState(g.mcpUrl, "idle", `T_idle (${life.idleMs} ms) after the last wake action`);
      const view = await toolCall(g.mcpUrl, "get_current_view");
      expectAnswer("dormant", tableCalls()[3]!, view);
      await life.heartbeat();
      await expectState(g.mcpUrl, "data", "after the page's heartbeat");
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

    // The hub call.
    check("M1: the drop's hub is parsed and compared by origin with the allowlist, on the drop and again on the Allow", async (life, d) => {
      const allowed = new URL(d.hub.origin);
      const host = allowed.host;
      const tricky = [
        `${d.hub.origin}.evil.example`,
        "https://evil.example",
        `https://user@${host}`,
        `https://user:secret@${host}`,
        `${d.hub.origin}/apc`,
        `${d.hub.origin}/?x=1`,
        `${d.hub.origin}/#x`,
        `http://${host}`,
        `https://${allowed.hostname}:8443`,
        `https://${allowed.hostname}.`,
        `${d.hub.origin}\\@evil.example`,
        host,
        "",
        "javascript:alert(1)",
      ];
      for (const hub of tricky) {
        const before = d.hub.requests.length;
        const agent = newAgent();
        const shown = await life.dropAgent({ agent, ticket: d.hub.ticket(agent), hub });
        expect(shown.page === "refused" && shown.error === "hub_not_allowed", `a drop with hub ${JSON.stringify(hub)} answers hub_not_allowed, with no consent: got ${JSON.stringify(shown).slice(0, 200)}`);
        expect(d.hub.requests.length === before, `a drop with hub ${JSON.stringify(hub)} called ${d.hub.requests.slice(before).join(", ")}`);
      }
      for (const hub of [`${d.hub.origin}.evil.example`, `https://user@${host}`, `${d.hub.origin}/apc`]) {
        const c = await consent(life, d);
        const before = d.hub.requests.length;
        const answer = await c.allow({ hub });
        expect(!answer.ok && answer.error === "hub_not_allowed", `an Allow sent with hub ${JSON.stringify(hub)} answers hub_not_allowed: got ${JSON.stringify(answer)}`);
        expect(d.hub.requests.length === before, `an Allow sent with hub ${JSON.stringify(hub)} called ${d.hub.requests.slice(before).join(", ")}`);
      }
    }),

    check("M2: a hub that redirects, answers a 3xx, an opaqueredirect or a redirected answer holds no grant", async (life, d) => {
      for (const mode of ["redirect", "status_3xx", "opaque_redirect", "redirected"] as const) await refusedWith(life, d, mode, "M2");
    }),

    check(`M3: a hub whose body stalls trips the one deadline (${HUB_CALL_DEADLINE_MS / 1000} s at most, headers and body)`, async (life, d) => {
      await refusedWith(life, d, "slow_body", "M3");
    }),

    check("M4: the byte cap and the content-length rules", async (life, d) => {
      for (const mode of ["length_over_cap", "length_not_digits", "body_over_cap"] as const) await refusedWith(life, d, mode, "M4");
      // Not refused: a content-length of digits within the cap, and one other than the decoded body's (gzip).
      for (const mode of ["ack_with_length", "length_mismatch"] as const) await takenWith(life, d, mode, "M4");
    }),

    check("M5: no lock across the hub call: owner requests answer while it is held, and a second Allow of the same agent gets pairing_in_progress", async (life, d) => {
      const f = await inFlight(life, d);
      let drop: ApcDockDropOutcome | undefined;
      try {
        // While the hub holds the first call: another agent's drop and Allow, and a new drop of the same agent.
        const asked = await within(consent(life, d), UNBLOCKED_MS);
        expect(!asked.timedOut, `a drop of another agent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call: no lock may be held across it`);
        const c = asked.value;
        const again = await within(life.dropAgent({ agent: f.agent, ticket: d.hub.ticket(f.agent), hub: d.hub.origin }), UNBLOCKED_MS);
        expect(!again.timedOut, `a drop of the same agent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call: no lock may be held across it`);
        drop = again.value;
        const other = await within(c.allow(), UNBLOCKED_MS);
        expect(!other.timedOut, `an Allow of another agent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call: no lock may be held across it`);
        expect(other.value.ok, `an Allow of another agent, while one is held, did not pair: ${other.value.error}`);
        expect(pairCount(d, f.agent) === 1, `the app sent /apc/pair for the held agent ${pairCount(d, f.agent)} times while the first call was held: one at a time per (user, hub, agent)`);
      } finally {
        await settle(f.hold, f.allowed, "ack");
      }
      const first = await f.allowed;
      expect(first.ok, `the held Allow did not pair once released: ${first.error}`);
      // A double-clicked Allow: the second while the first waits gets pairing_in_progress.
      const c2 = await consent(life, d);
      const hold = d.hub.hold();
      const firstAllow = c2.allow();
      firstAllow.catch(() => {});
      let second: Awaited<ReturnType<typeof c2.allow>> | undefined;
      try {
        const arrived = await within(hold.arrived, 5000);
        expect(!arrived.timedOut, "the Allow sent the hub no /apc/pair within 5 s");
        const r = await within(c2.allow(), UNBLOCKED_MS);
        expect(!r.timedOut, `a second Allow of the same consent waited more than ${UNBLOCKED_MS / 1000} s on the held hub call`);
        second = r.value;
      } finally {
        await settle(hold, firstAllow, "ack");
      }
      expect(second, "no second Allow was sent");
      expect(!second.ok && second.error === "pairing_in_progress", `a second Allow while the first waits on the hub answers pairing_in_progress: got ${JSON.stringify(second)}`);
      expect(pairCount(d, c2.agent) === 1, `a double-clicked Allow sent /apc/pair ${pairCount(d, c2.agent)} times`);
      drop = drop!;
      const shown = drop.page === "refused" ? `refused (${drop.error})` : drop.page;
      return {
        note: `in process the held call blocked nothing; a new drop of the agent whose Allow was held answered: ${shown}. Serialization across instances (an advisory lock and a partial unique index, say) cannot be seen from one process`,
      };
    }),

    check("M9: hub requests go to the parsed origin, never to the raw hub string", async (life, d) => {
      const c = await consent(life, d, newAgent(), `${d.hub.origin}/`);
      const before = d.hub.requests.length;
      const answer = await c.allow();
      const called = d.hub.requests.slice(before);
      expect(called.length > 0 && called.every((u) => u === `${d.hub.origin}/apc/pair`), `with the drop's hub "${d.hub.origin}/", the app called ${JSON.stringify(called)}, expected ${d.hub.origin}/apc/pair`);
      expect(answer.ok, `with the drop's hub "${d.hub.origin}/", the Allow did not pair: ${answer.error}`);
    }),

    // The owner's endpoints.
    check("M6: the owner endpoints refuse a foreign Origin, Sec-Fetch-Site cross-site and same-site, a non-JSON media type, a GET and no session; a request with neither header is taken on the session", async (life) => {
      const { origin, session, endpoints } = life.owner;
      expect(endpoints.length > 0, "the adapter gives no owner endpoints (lifecycle.owner.endpoints): the drop, the Allow, the heartbeat and Cancel");
      const own = new URL(origin);
      const sendTo = async (ep: (typeof endpoints)[number], headers: Record<string, string>, method = "POST") => {
        const body = JSON.stringify(await ep.body());
        const response = await fetchApp(new Request(new URL(ep.path, origin), { method, headers, ...(method === "GET" ? {} : { body }) }));
        await response.body?.cancel().catch(() => {});
        return response.status;
      };
      const json = { ...session, "content-type": "application/json" };
      for (const ep of endpoints) {
        const taken: Array<[string, Record<string, unknown>]> = [
          ["its own Origin", { ...json, origin, "sec-fetch-site": "same-origin" }],
          ["neither Origin nor Sec-Fetch-Site (a client that is not a browser)", json],
        ];
        for (const [what, headers] of taken) {
          const status = await sendTo(ep, headers as Record<string, string>);
          expect(status >= 200 && status < 300, `${ep.name}: a request with ${what} and the owner's session is taken (2xx), got HTTP ${status}`);
        }
        const refused: Array<[string, Record<string, string>, string?]> = [
          ["a foreign Origin", { ...json, origin: "https://evil.example" }],
          ["Origin null", { ...json, origin: "null" }],
          [`Origin on another scheme (http://${own.host})`, { ...json, origin: `http://${own.host}` }],
          ["Sec-Fetch-Site cross-site", { ...json, "sec-fetch-site": "cross-site" }],
          ["Sec-Fetch-Site same-site", { ...json, "sec-fetch-site": "same-site" }],
          ["its own Origin with Sec-Fetch-Site cross-site", { ...json, origin, "sec-fetch-site": "cross-site" }],
          ["the media type text/plain", { ...session, "content-type": "text/plain" }],
          ["the media type application/x-www-form-urlencoded", { ...session, "content-type": "application/x-www-form-urlencoded" }],
          ["no session", { "content-type": "application/json" }],
          ["the method GET", { ...session }, "GET"],
        ];
        for (const [what, headers, method] of refused) {
          const status = await sendTo(ep, headers, method);
          expect(status >= 400 && status < 500, `${ep.name}: a request with ${what} is refused (4xx), got HTTP ${status}`);
        }
      }
    }),

    // The give-back.
    check("M7: /apc/revoke answers the same 200 to any input, ends a matching grant (then 404), and leaves revoked and ended grants as they are", async (life, d) => {
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
      const read = async (send: (request: Request) => Promise<Response>, what: string) => {
        const r = await send(new Request(`${life.owner.origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }));
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

    // One pending pairing.
    check("one pending pairing: a second drop on a pending pairing shows the same code, with no new consent and no new /apc/pair", async (life, d) => {
      const g = await handoff(life, d);
      const before = pairCount(d, g.agent);
      const again = await life.dropAgent({ agent: g.agent, ticket: d.hub.ticket(g.agent), hub: d.hub.origin });
      expect(again.page === "waiting", `a second drop while the hub says pending shows the waiting card with the code, got ${JSON.stringify(again).slice(0, 200)}`);
      expect(normalizePairingCode(again.code) === g.code, `a second drop on a pending pairing shows ${JSON.stringify(again.code)}, not the same code as the consent (${g.code})`);
      expect(pairCount(d, g.agent) === before, "a second drop on a pending pairing sent the hub a new /apc/pair");
      await expectState(g.mcpUrl, "pairing", "after a second drop on a pending pairing");
    }),

    check("one pending pairing: not_paired from /apc/confirm ends the grant and starts a fresh consent", async (life, d) => {
      const g = await handoff(life, d);
      d.hub.forget(g.pairing.id);
      const again = await life.dropAgent({ agent: g.agent, ticket: d.hub.ticket(g.agent), hub: d.hub.origin });
      expect(again.page === "consent", `a drop the hub answers not_paired starts a fresh consent, got ${JSON.stringify(again).slice(0, 200)}`);
      expect(normalizePairingCode(again.code) !== g.code, "the fresh consent shows the old code: every consent makes a new one");
      await expectState(g.mcpUrl, "not_found", "the old grant, after not_paired");
    }),

    check("one pending pairing: paired before the app saw initialize stays in handoff, and only initialize makes it live", async (life, d) => {
      const g = await handoff(life, d);
      const decided = await d.hub.decide(g.pairing.id, "approve", g.code, { introduce: false });
      expect(decided.ok, `the stand-in hub did not approve: ${decided.error}`);
      const again = await life.dropAgent({ agent: g.agent, ticket: d.hub.ticket(g.agent), hub: d.hub.origin });
      expect(again.page === "connecting", `a drop the hub answers paired, before initialize, says it is connecting (no code), got ${JSON.stringify(again).slice(0, 200)}`);
      await expectState(g.mcpUrl, "pairing", "after confirm said paired, before initialize (only initialize moves the state)");
      const init = await send(g.mcpUrl, "initialize", INIT);
      expect(init.status === 200 && isObject(init.body) && isObject(init.body.result), `initialize is served: ${brief(init)}`);
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
