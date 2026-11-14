/**
 * The APC conformance suite (APC 0.2, TIN-577; `apc_link` since 0.3, TIN-578): checks that an app
 * implements the core of the standard (`core.ts` in @tineira/apc-protocol), on either profile, through its MCP
 * endpoint, the way an agent or a dock's hub reaches it, and, for an app that offers both profiles,
 * `apc_link` (give `link` in the adapter). What happens in the person's page (the view they report, the pin they drop,
 * the presence the app shows them, Revoke in the agent bar) comes through a small adapter the app
 * provides, since only the app knows its page. Since 0.5 it also reads the app's `apc.json`
 * (`GET {origin}/.well-known/apc.json`, through the adapter's `fetch`): its shape, its origin, the
 * standard, and that its profiles and `mcp.path` match what the app serves. Since 0.6 an adapter may
 * also give `page.mobile` (the page on a phone): the suite then checks that every agent is shown in the
 * page, that the bar cannot be collapsed, and that a finger can pin and unpin with no mouse drag. Since 0.9
 * an app on the Dock profile gives `dock` too: the suite pairs it with a stand-in hub (`standInHub`) and checks
 * the pairing code (the consent shows one, new each time, and sends that one to the hub; the app keeps no grant
 * when the hub does not acknowledge the code; wrong codes and the code's time running out give the grant back;
 * the right code pairs). Since 0.10 an app on the Dock profile also gives `dock.lifecycle`, and the suite checks
 * the Dock profile as built (`dock-lifecycle.ts`): what a grant answers in each state, the transitions and their
 * time limits, the app's rules on the hub call (M1 to M9) and one pending pairing.
 *
 * Framework-free: `apcConformance(app)` returns named checks that throw `ConformanceError`, for any
 * test runner (`for (const c of apcConformance(app)) test(c.name, c.run)` under `node --test`), and
 * `runConformance(app)` runs them all and reports.
 *
 * Against a live app with no adapter, `httpConformance` / `runHttpConformance` (`http.ts`) run the part
 * of the suite that HTTP reaches (apc.json, and with a grant's MCP URL the core tools' shapes and timing,
 * and a revoked grant's answer); the `apc-conformance` command (`cli.ts`) runs them from a terminal.
 */
import {
  APC_AGENT_CLIENT_META,
  APC_JSON_MAX_BYTES,
  APC_JSON_PATH,
  APC_MOBILE_VIEWPORT,
  APC_STANDARD_VERSION,
  APC_LINK_KEY,
  APC_LINK_TOOL,
  APC_LINK_TTL_S,
  CORE_TOOLS,
  LINK_REFUSED_ERROR,
  REVOKED_ERROR,
  REVOKED_HTTP_STATUS,
  REVOKED_HTTP_STATUS_BEARER,
  WAIT_CLAIM_GAP_S,
  canonicalTarget,
  compareStandard,
  describeMcpCoverage,
  mcpUrlCoverage,
  normalizePairingCode,
  PAIRING_CODE_MAX_ATTEMPTS,
  parseApcManifest,
  type ApcLinkRefusal,
  type ApcProfile,
  type FocusTarget,
  type PresenceEvent,
  type PresenceMessage,
  type PresenceWaitEvent,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, REVOKED_PROBES, attentionOf, checkCoreToolList, checkNothingButGrants, checkFocusShape, checkMcpEndpoints, checkRevokedBody, checkView, data, expect, isObject, resultKey, rpcBody, sameJson, standardSupport, text, type ToolCallResult } from "./shared.ts";
import type { StandInHub } from "./hub.ts";
import { dockLifecycleChecks } from "./dock-lifecycle.ts";

export { ConformanceError } from "./shared.ts";
export { standInHub, type StandInHold, type StandInHub, type StandInHubMode, type StandInHubOptions, type StandInPairing } from "./hub.ts";
export {
  HttpConformanceUsageError,
  IN_PROCESS_ONLY,
  IN_PROCESS_REASON,
  coverageLines,
  coverageOf,
  httpConformance,
  redactGrantUrl,
  redactSecrets,
  runHttpConformance,
  type HttpCheck,
  type HttpCheckResult,
  type HttpConformanceOptions,
  type HttpConformanceReport,
  type HttpCoverage,
} from "./http.ts";

/**
 * One agent's way into the app: the MCP URL its holder calls (the agent itself, or a dock's hub), the
 * app's id for the grant, and (APC 0.8) the headers that carry the grant when the URL alone does not: an
 * app whose grants share one MCP URL gives `{ authorization: "Bearer …" }`. With a secret URL, leave
 * `headers` out.
 */
export interface AgentConnection {
  mcpUrl: string;
  grantId: string;
  headers?: Record<string, string>;
}

/** A grant's credential travels in a header (a bearer token), not in its URL: several grants may share the URL (APC 0.8). */
const sharesUrl = (conn: AgentConnection) => !!conn.headers && Object.keys(conn.headers).some((h) => h.toLowerCase() === "authorization");

/**
 * What the `apc_link` checks need (APC 0.4), from an app that offers both profiles. The suite makes the
 * connections arrive itself: an agent's own `initialize` on Direct, a hub's (naming the agent's client
 * in `_meta`) on Dock.
 */
export interface ApcLinkAdapter {
  /** A new agent with full access on this path, made the way the profile makes one, with no pin and no `initialize` yet. */
  connect(path: ApcProfile): Promise<AgentConnection>;
  /** The agents the agent bar shows: each entry's grants, two for a linked agent. */
  agents(): Promise<Array<{ grants: string[] }>>;
  /** The person's Unlink in the agent bar; false when the app refuses. */
  unlink(grantId: string): Promise<boolean>;
  /** Makes every code the app gave expire now, as if two minutes passed. Without it the check waits the code out (APC_LINK_TTL_S). */
  expireCodes?(): Promise<void>;
}

/**
 * The person's page on a phone (APC 0.6): a viewport of `APC_MOBILE_VIEWPORT` with a touch pointer and no
 * mouse. Optional in the adapter; with it the suite runs the mobile checks. An app's own test can model
 * the page with the pieces of @tineira/apc-web (the bar's collapse rule, tap to pin); the real thing is a browser
 * with touch emulation (`scripts/mobile-e2e.mjs` does that for Pulse and Signals).
 */
export interface ApcMobilePage {
  /**
   * What the page shows at that viewport, with these agents connected: the grants whose mark is visible in
   * the page and can be pinned from, and whether the person can collapse or hide the agent bar there.
   */
  agentBar(): Promise<{ visible: string[]; collapsible: boolean }>;
  /** The person pins with a finger, with no mouse drag: taps the agent's mark, then the target. False when the app refuses the pin. */
  pinByTouch(grantId: string, target: FocusTarget): Promise<boolean>;
  /** The person removes the agent's pin with a finger (the × beside the agent in the bar). False when the page offers no way. */
  unpinByTouch(grantId: string): Promise<boolean>;
}

/**
 * The Dock profile's pairing (APC 0.9), from an app on that profile: required of one that claims 0.9.0 or later.
 * The app pairs with `hub`, a stand-in from this package (`standInHub({ app })`, whose `app` routes to the app's
 * handler), which the app's server reaches as its hub.
 */
export interface ApcDockAdapter {
  hub: StandInHub;
  /**
   * The person drops an agent the app holds no grant for, with a ticket from `hub.ticket(agent)`: the pairing code
   * the app's consent shows, as the person sees it (formatted or not), and their Allow on that consent, with what
   * the app answered the page.
   */
  drop(agent: string, ticket: string): Promise<{ shown: string; allow(): Promise<{ ok: boolean; error?: string }> }>;
  /** The Dock profile as built (APC 0.10): required of an app that claims 0.10.0 or later on the Dock profile. */
  lifecycle?: ApcDockLifecycleAdapter;
}

/** What the app answered the person's Allow (APC 0.10): `grantId` is the grant it made, when it made one. */
export interface ApcDockAllowAnswer {
  ok: boolean;
  error?: string;
  grantId?: string;
}

/**
 * What the app's page shows on a drop (APC 0.10):
 *
 * - `consent`: the consent with its pairing code (as the person sees it, formatted or not), and the Allow on it.
 *   `allow({ hub })` sends the Allow with another `hub` than the drop's, as a tampered page would (M1).
 * - `waiting`: the grant is pending at the hub, and the page shows the waiting card with this code.
 * - `connecting`: the hub says paired but the app has not seen `initialize`: no code.
 * - `pinned`: a live grant, and the drop pinned it.
 * - `refused`: the app answered `error` (`hub_not_allowed`, `pairing_in_progress`, …), with no consent.
 */
export type ApcDockDropOutcome =
  | { page: "consent"; code: string; allow(over?: { hub?: string }): Promise<ApcDockAllowAnswer> }
  | { page: "waiting"; code: string }
  | { page: "connecting" }
  | { page: "pinned" }
  | { page: "refused"; error: string };

/**
 * One owner-session endpoint (M6, APC 0.10): its path on the app's origin, and `body()`, a fresh body the app takes
 * with a 2xx each time (a drop with a new ticket, an Allow with a new consent, a Cancel on a new grant in handoff).
 *
 * Cancel's `body()` should make its grant during the call, through `dock.hub` (a drop and an Allow the stand-in
 * acknowledges): the suite finds the grant by the `/apc/pair` the hub received while `body()` ran, to see that a
 * Cancel sent as a GET changed nothing. For a grant paired beforehand it watches every grant in handoff the stand-in
 * ever paired instead; with none in handoff, that probe is left unchecked, with a note.
 *
 * The Allow's `body()` has, besides the drop's members, the member(s) that carry the consent's nonce: the suite puts
 * a token from a GET drop's answer there to see that a GET made no consent.
 */
export interface ApcDockOwnerEndpoint {
  path: string;
  body(): unknown | Promise<unknown>;
}

/**
 * The owner-session endpoints (M6, APC 0.10), all four required: the drop, the Allow, the heartbeat and Cancel. The
 * suite sends each to the app's `fetch` with the headers it checks. A heartbeat over a WebSocket is
 * `{ websocket: path }`: the suite sends its handshake (a GET with `Upgrade: websocket`), which the app takes with
 * 101 (or a 2xx in process) or refuses with a 4xx.
 */
export interface ApcDockOwnerEndpoints {
  /** The app's configured public origin, bare (`https://host[:port]`): the only `Origin` its owner endpoints take, and where its `apc.json` is read. */
  origin: string;
  /** The headers that carry the owner's authenticated session (a cookie, say). */
  session: Record<string, string>;
  drop: ApcDockOwnerEndpoint;
  allow: ApcDockOwnerEndpoint;
  heartbeat: ApcDockOwnerEndpoint | { websocket: string };
  cancel: ApcDockOwnerEndpoint;
}

/**
 * The Dock profile as built (APC 0.10), from an app that claims 0.10.0 or later on the Dock profile: what the suite
 * needs to put a grant into each state, and to reach the owner's endpoints. The app pairs with the `hub` of
 * `ApcDockAdapter`; its `apc.json` is read at `owner.origin`. Every hub call the app makes goes through `hub.fetch`
 * (as the app's fetch, or routed there). While a check runs, the suite also wraps the global `fetch`: an `/apc/pair`
 * or `/apc/confirm` sent through it to any origin but the stand-in's is logged as a call past the hub and not sent.
 * A request that leaves another way (another HTTP client) is not seen.
 */
export interface ApcDockLifecycleAdapter {
  /**
   * The person drops `agent` from the dock at `hub` (the drag's `hub` string, as the page read it), with `ticket`, on
   * `target` (one of the adapter's `targets` when left out): what the page shows.
   */
  dropAgent(drop: { agent: string; ticket: string; hub: string; target?: FocusTarget }): Promise<ApcDockDropOutcome>;
  /**
   * Whether the page's Allow carries the hub (true: the app re-checks it against the allowlist, M1), or the server
   * binds the hub to the consent (false: `allow({ hub })` is ignored, and the suite checks the Allow calls only the
   * drop's hub).
   */
  allowCarriesHub: boolean;
  /**
   * The app's deadline on a hub call (M3), in ms of real time: at most 10 000, the default. The time seam does not
   * move it. A refused call must end by the deadline plus 30% of it, at least 1 s and at most 2.5 s: under about
   * 3.3 s the 1 s floor applies, so a second deadline shorter than 1 s goes unseen.
   */
  hubDeadlineMs?: number;
  /** The person's Cancel on the waiting card; false when the app refuses it. */
  cancel(grantId: string): Promise<boolean>;
  /** The page's heartbeat: a wake action of the owner. */
  heartbeat(): Promise<void>;
  /** The time seam: the app's clock moves `ms` forward, for every limit it keeps (T_ack, T_connect, T_idle, the stored expiry); not the hub call's deadline. */
  advance(ms: number): Promise<void>;
  /** While true, the app's storage fails every write: the commit out of handoff cannot persist. */
  failCommits(fail: boolean): void | Promise<void>;
  /** The app's process dies, with whatever calls it had open, and comes back on the same storage (T_ack across a restart). */
  restart(): Promise<void>;
  /** The app's T_idle in ms. Left out: the app does not sleep (dormant is a SHOULD), and the dormant checks say so. */
  idleMs?: number;
  /**
   * The app's T_connect in ms, when shorter than the standard's 10 minutes (`T_CONNECT_MAX_MS`, the default): the
   * T_connect check ends a grant past it, and a grant in handoff is held past `idleMs` only while it is shorter.
   */
  connectMs?: number;
  /**
   * Long dormancy, for an app that sleeps and ends a grant that stays dormant (30 days is recommended): how long a
   * grant stays dormant before it ends, counted from when it fell asleep (`idleMs` after the last wake action). Left
   * out, long dormancy is not checked.
   */
  dormancyMs?: number;
  owner: ApcDockOwnerEndpoints;
  /** The same app with pairing disabled (its dock configuration missing): its `fetch`, for `apc.json` (M8). */
  pairingDisabled(): Promise<(request: Request) => Promise<Response>>;
}

/** What the suite needs from an app. */
export interface ApcAppAdapter {
  /** The app's name, for the report. */
  name: string;
  profile: ApcProfile;
  /** Sends one HTTP request to the app; the global fetch when left out (a deployed app). An app run in process routes to its handler. */
  fetch?: (request: Request) => Promise<Response>;
  /** A new agent with full access, made the way the profile makes one (a grant in the app, or a pairing through a hub), with no pin yet. */
  connect(): Promise<AgentConnection>;
  /** Two different targets on the person's screen that a full-access agent may be pinned to. */
  targets: readonly [FocusTarget, FocusTarget];
  /** One of the app's own read tools that does not read the pin, with valid arguments: the suite checks that `attention` rides on any result. */
  probe: { tool: string; args: Record<string, unknown> };
  /** The person's page, as the app sees it. */
  page: {
    /** The person has a page of the app open (true) or none (false). */
    setOpen(open: boolean): void | Promise<void>;
    /** The page reports the screen the person is on. */
    showView(): Promise<void>;
    /** The person drops the agent's mark on a target; false when the app refuses the pin. */
    pin(grantId: string, target: FocusTarget): Promise<boolean>;
    /** The presence messages the app published to the person's page since the last call, oldest first: calls and (APC 0.11) waits. */
    takePresence(): PresenceMessage[];
    /** The person's Revoke in the agent bar; false when the app refuses. */
    revoke(grantId: string): Promise<boolean>;
    /** The page on a phone (APC 0.6). Left out: the mobile checks are skipped. */
    mobile?: ApcMobilePage;
  };
  /** An app that offers both profiles: the `apc_link` checks run too. */
  link?: ApcLinkAdapter;
  /** The Dock profile's pairing code (APC 0.9): required with `profile: "dock"` of an app that claims 0.9.0 or later. */
  dock?: ApcDockAdapter;
}

export interface ConformanceCheck {
  name: string;
  /** Throws when the check fails. */
  run(): Promise<void>;
  /** Set by `run()` when the check passed with something worth saying (a newer patch of the standard, say). */
  note?: string;
}

/** A check whose body may resolve to `{ note }`: the note lands on the check, and `run()` stays a test body. */
function noted(name: string, body: () => Promise<void | { note: string }>): ConformanceCheck {
  const check: ConformanceCheck = {
    name,
    async run() {
      const out = await body();
      if (out?.note) check.note = out.note;
    },
  };
  return check;
}

export interface ConformanceReport {
  app: string;
  profile: ApcProfile;
  passed: number;
  failed: number;
  results: Array<{ name: string; ok: boolean; error?: string; note?: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How soon "at once" and "as soon as" are taken to be: a wait returns within this of a pin, a revoke or a takeover
 * (the reference polls every 2 s; this leaves room for a slower poll and a loaded test machine). The spec gives no
 * number; see the conformance page.
 */
const SOON_MS = 8700;
/** How late past its `timeout_s` a wait with no pin may return (one poll and its last checks). */
const TIMEOUT_LATE_MS = 4000;
/** The keys of a `RevokedAnswer`: a revoked tool error carries these and no app data. */
const REVOKED_KEYS: readonly string[] = ["error", "revoked_by", "revoked_at", "message"];

/** One JSON-RPC request over Streamable HTTP, stateless, as a dock's hub sends it: the HTTP status and the reply. */
async function send(app: ApcAppAdapter, to: AgentConnection, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown; headers: Headers }> {
  const request = new Request(to.mcpUrl, {
    method: "POST",
    headers: { ...to.headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...(signal ? { signal } : {}),
  });
  const response = await (app.fetch ? app.fetch(request) : fetch(request));
  const body = rpcBody(response.headers.get("content-type") ?? "", await response.text());
  return { status: response.status, body, headers: response.headers };
}

/** A JSON-RPC notification (no id) in a POST of its own: the HTTP status (202 for a Streamable HTTP server). */
async function notify(app: ApcAppAdapter, to: AgentConnection, method: string, params: Record<string, unknown>): Promise<number> {
  const request = new Request(to.mcpUrl, {
    method: "POST",
    headers: { ...to.headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  const response = await (app.fetch ? app.fetch(request) : fetch(request));
  await response.body?.cancel().catch(() => {});
  return response.status;
}

/** What a check of a 0.8 rule says of an app that claims an earlier standard: passed, not checked. */
const NOT_08 = { note: "not checked: the app's apc.json claims a standard before 0.8.0, which does not have this rule" };
const NOT_011 = { note: "not checked: the app's apc.json claims a standard before 0.11.0, which has no wait events" };
const NO_WAIT_EVENTS = { note: "not checked: the app sends no wait events (APC 0.11: optional, and only for an app that claims and releases its place for a wait atomically), so its page shows no waiting" };
const PROBE_FAILED = { note: "not checked: the wait-event probe failed in an earlier check, which reports why" };
const DOCK_WAITS = { note: "not checked on the Dock profile: a dock agent waits on the hub, so the page shows no waiting for a dock grant (APC 0.11)" };

/** The wait events of one grant among presence messages, checked for their exact shape (APC 0.11), oldest first. */
function waitEventsOf(messages: PresenceMessage[], grantId: string): Array<PresenceWaitEvent["state"]> {
  const waits = messages.filter((m) => m.grant_id === grantId && m.kind === "wait") as PresenceWaitEvent[];
  for (const e of waits) {
    expect(Object.keys(e).sort().join() === "at,grant_id,kind,state,v", `a wait event is { v, grant_id, at, kind, state }, ids only: ${Object.keys(e).join()}`);
    expect(e.v === 1 && ISO.test(e.at) && (e.state === "open" || e.state === "closed"), `a wait event is v 1, with an ISO time and state open or closed: ${JSON.stringify(e)}`);
  }
  return waits.map((e) => e.state);
}

async function result(app: ApcAppAdapter, to: AgentConnection, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
  const { status, body } = await send(app, to, method, params, signal);
  expect(status === 200, `${method}: HTTP ${status}, expected 200 (${JSON.stringify(body).slice(0, 200)})`);
  expect(isObject(body) && !("error" in body && body.error), `${method}: JSON-RPC error ${JSON.stringify(body).slice(0, 200)}`);
  return (body as { result?: unknown }).result;
}

async function call(app: ApcAppAdapter, to: AgentConnection, tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ToolCallResult> {
  const r = await result(app, to, "tools/call", { name: tool, arguments: args }, signal);
  expect(isObject(r), `${tool}: no result`);
  return r as ToolCallResult;
}

/**
 * A revoked grant's answer (APC 0.8): a `RevokedAnswer` body, with the binding's status: 403 for a secret URL, 401 with
 * `WWW-Authenticate: Bearer error="invalid_token"` for a bearer token.
 */
function checkRevoked(conn: AgentConnection, status: number, body: unknown, what: string, headers: Headers): void {
  const bearer = sharesUrl(conn);
  const expected = bearer ? REVOKED_HTTP_STATUS_BEARER : REVOKED_HTTP_STATUS;
  expect(status === expected, `${what} on a revoked grant: HTTP ${status}, expected ${expected}`);
  if (bearer) expect(/^bearer\b.*error="?invalid_token"?/i.test(headers.get("www-authenticate") ?? ""), `${what} on a revoked bearer grant: no WWW-Authenticate: Bearer error="invalid_token"`);
  checkRevokedBody(body, new URL(conn.mcpUrl).host, what);
}


/** A focus in the core's format, naming `target`. */
function checkFocus(focus: unknown, target: FocusTarget, where: string): Record<string, unknown> {
  const parsed = checkFocusShape(focus, where);
  expect(canonicalTarget(parsed) === canonicalTarget(target), `${where}: the focus names ${canonicalTarget(parsed)}, the pin was ${canonicalTarget(target)}`);
  return focus as Record<string, unknown>;
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work;
  return { value, ms: Date.now() - started };
}

/** The checks of the core, in order. Each makes its own agents, so any one can run alone. */
export function apcConformance(adapter: ApcAppAdapter): ConformanceCheck[] {
  /**
   * Any wait event the page got anywhere in the run, on any agent, in any check (APC 0.11). Every drain of the page's
   * presence goes through here, so an app that sends wait events on some path only is still seen to send them.
   */
  let sawWait = false;
  // The adapter itself, read live (an app's test may swap `fetch` after building the checks), with the drain tracked.
  // A method is called on the adapter's own object, so a class adapter with private fields still works.
  const live = <T extends object>(target: T, own: Partial<Record<keyof T, unknown>>): T =>
    new Proxy(target, {
      get(t, key) {
        if (Object.prototype.hasOwnProperty.call(own, key)) return own[key as keyof T];
        const value = Reflect.get(t, key, t) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
      },
    });
  const takePresence = (): PresenceMessage[] => {
    const messages = adapter.page.takePresence();
    if (messages.some((m) => m.kind === "wait")) sawWait = true;
    return messages;
  };
  const app: ApcAppAdapter = live(adapter, { page: live(adapter.page, { takePresence }) });
  const [first, second] = app.targets;
  const check = (name: string, run: () => Promise<void | { note: string }>): ConformanceCheck => noted(`${app.name} (${app.profile}): ${name}`, run);
  /**
   * The grant pinned now and its pin read (so no pin is unread): with the page open, every later result on it is one
   * then rides on (APC 0.8: pinned in the last 30 minutes), so a check that a result carries no then means something.
   * On the other target than the check pins next: an app may take a drop on the target already pinned as no new pin.
   */
  const pinnedAndRead = async (conn: AgentConnection, target: FocusTarget) => {
    expect(await app.page.pin(conn.grantId, target), "the app refused the pin");
    const read = await call(app, conn, "get_current_view");
    expect(!read.isError, "get_current_view failed");
  };
  /** A `wait_for_focus` result with no focus ends the loop: no then, structured or in the text (spec: then). */
  const noThen = (r: ToolCallResult, where: string) =>
    expect(resultKey(r, "then").value === undefined && text(r).then === undefined, `${where} came back with no focus, and carries then: a result with no focus ends the loop`);
  /**
   * Whether the app claims 0.11.0, asked once per run, with one short wait on the first wait-event check's agent so the
   * page has had a chance to get a wait event. A probe that fails fails that check; the others then say so in a note,
   * rather than report the same error four more times.
   */
  let probe: Promise<boolean> | null = null;
  let probeFailed = false;
  const probeWaits = (conn: AgentConnection): Promise<boolean> =>
    (probe ??= (async () => {
      if (!(await claims(conn, "0.11.0"))) return false;
      await app.page.setOpen(true);
      app.page.takePresence();
      await call(app, conn, "wait_for_focus", { timeout_s: 1 });
      await sleep(300);
      app.page.takePresence();
      return true;
    })().catch((error: unknown) => {
      probeFailed = true;
      throw error;
    }));
  /** A wait-event check passed with a note because the app had sent no wait event by then: the last check holds it to that. */
  let waitSkipped = false;
  /**
   * A wait-event check: Direct, an app that claims 0.11.0 and has sent a wait event somewhere in the run (APC 0.11: the
   * events are a MAY, and an app that sends any follows every rule). Its one agent is revoked when it ends, so the
   * checks stay under an app's cap on agents (Signals keeps at most 20 Direct ones).
   */
  const waitCheck = (name: string, run: (conn: AgentConnection) => Promise<void | { note: string }>): ConformanceCheck =>
    check(name, async () => {
      if (app.profile === "dock") return DOCK_WAITS;
      if (probeFailed) return PROBE_FAILED;
      const conn = await app.connect();
      try {
        if (!(await probeWaits(conn))) return NOT_011;
        if (!sawWait) {
          waitSkipped = true;
          return NO_WAIT_EVENTS;
        }
        return await run(conn);
      } finally {
        try {
          await app.page.revoke(conn.grantId);
        } catch {
          // A revoke that fails here must not hide the check's own result.
        }
      }
    });
  /** Whether the app's apc.json claims `version` or later: a rule added in a version is checked only of apps that claim it. */
  const claims = async (conn: AgentConnection, version: string): Promise<boolean> => {
    const request = new Request(`${new URL(conn.mcpUrl).origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
    const response = await (app.fetch ? app.fetch(request) : fetch(request));
    const standard = ((await response.json().catch(() => ({}))) as { standard?: unknown }).standard;
    return typeof standard === "string" && compareStandard(standard, version) >= 0;
  };

  return [
    check("serves apc.json from its own origin, naming the profiles it serves and where its MCP URLs live", async () => {
      const conn = await app.connect();
      const origin = new URL(conn.mcpUrl).origin;
      const request = new Request(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
      const response = await (app.fetch ? app.fetch(request) : fetch(request));
      expect(response.status === 200, `GET ${APC_JSON_PATH}: HTTP ${response.status}, expected 200`);
      expect((response.headers.get("content-type") ?? "").includes("application/json"), `${APC_JSON_PATH} is not served as application/json`);
      const text = await response.text();
      expect(new TextEncoder().encode(text).length <= APC_JSON_MAX_BYTES, `${APC_JSON_PATH} is over ${APC_JSON_MAX_BYTES} bytes`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ConformanceError(`${APC_JSON_PATH} is not JSON`);
      }
      const parsed = parseApcManifest(body, origin);
      expect(parsed.ok, `${APC_JSON_PATH}: ${parsed.ok ? "" : `${parsed.error}, ${parsed.detail}`}`);
      const m = parsed.manifest;
      const support = standardSupport(m.standard, APC_STANDARD_VERSION);
      expect(support.ok, support.ok ? "" : `${support.reason} (this suite checks 0.5.0 up to ${APC_STANDARD_VERSION}, and newer patches of it)`);
      expect(!m.profiles.includes("hub"), "an app's profiles are direct, dock or both, never hub");
      expect(m.profiles.includes(app.profile), `profiles ${JSON.stringify(m.profiles)} leave out ${app.profile}, which the app serves`);
      if (app.link) expect(m.profiles.includes("direct") && m.profiles.includes("dock"), `profiles ${JSON.stringify(m.profiles)}: an app that links both paths offers both`);
      // A Direct app whose grants share one URL (a bearer token names the grant) may serve it at mcp.path itself (APC 0.8).
      const shared = app.profile === "direct" && sharesUrl(conn);
      // The profile the adapter serves, exactly as a hub pairing a Dock app checks it (APC 0.11).
      const covered = mcpUrlCoverage(m, conn.mcpUrl, { profile: app.profile, shared });
      expect(covered.covered, `the grant's MCP URL is not covered for ${app.profile} by ${describeMcpCoverage(m)}${covered.covered ? "" : `: ${covered.reason}`}`);
      if (m.profiles.includes("direct")) expect(m.direct && new URL(m.direct.connect).origin === origin, "direct.connect is the app's own page");
      const endpoints = checkMcpEndpoints(body, m);
      const notes = [support.note, endpoints].filter((n): n is string => !!n);
      if (notes.length) return { note: notes.join("; ") };
    }),

    check("nothing but grants is served under a {secret} entry of mcp.endpoints: a child that names no grant is not served (APC 0.11)", async () => {
      const conn = await app.connect();
      const origin = new URL(conn.mcpUrl).origin;
      const send = (request: Request) => (app.fetch ? app.fetch(request) : fetch(request));
      const response = await send(new Request(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }));
      const parsed = parseApcManifest(await response.json().catch(() => null), origin);
      if (!parsed.ok) return { note: "not checked: apc.json did not parse (the apc.json check says why)" };
      const checked = await checkNothingButGrants(origin, parsed.manifest, async (url, init) => {
        const r = await send(new Request(url, init));
        await r.body?.cancel().catch(() => {});
        return r.status;
      });
      if (checked === null) return { note: "not checked: apc.json declares no {secret} entry in mcp.endpoints" };
    }),

    check("lists the core tools, with their arguments", async () => {
      const conn = await app.connect();
      checkCoreToolList(await result(app, conn, "tools/list"), CORE_TOOLS);
    }),

    check("get_current_view returns the view as identifiers, and no focus before a pin", async () => {
      const conn = await app.connect();
      await app.page.setOpen(true);
      await app.page.showView();
      const r = await call(app, conn, "get_current_view");
      expect(!r.isError, "get_current_view failed");
      const d = data(r);
      expect("view" in d && "focus" in d, "the result has view and focus");
      expect(d.focus === null, "no pin yet, so no focus");
      checkView(d.view, "get_current_view");
      expect(attentionOf(r) === undefined, "no pin, so no attention");
    }),

    check("a pin rides as attention on any result until it is read, and next reads it", async () => {
      const conn = await app.connect();
      const { grantId } = conn;
      expect(await app.page.pin(grantId, first), "the app refused a pin on the first target");
      const probed = await call(app, conn, app.probe.tool, app.probe.args);
      expect(!probed.isError, `${app.probe.tool} failed`);
      const attention = attentionOf(probed);
      expect(isObject(attention) && typeof attention.note === "string", "an unread pin puts attention { focus, note } on the result");
      checkFocus(attention.focus, first, "attention");

      const view = await call(app, conn, "get_current_view");
      const focus = checkFocus(data(view).focus, first, "get_current_view");
      const after = await call(app, conn, app.probe.tool, app.probe.args);
      expect(attentionOf(after) === undefined, "reading the focus marks it seen: no attention after");

      const read = await call(app, conn, focus.next as string, focus.next_args as Record<string, unknown>);
      expect(!read.isError, `next (${String(focus.next)}) with next_args failed: ${JSON.stringify(read.content).slice(0, 200)}`);

      // One pin per grant: a new drop replaces it, unread again.
      expect(await app.page.pin(grantId, second), "the app refused a pin on the second target");
      const again = attentionOf(await call(app, conn, app.probe.tool, app.probe.args));
      expect(isObject(again), "a new pin is unread again");
      checkFocus(again.focus, second, "attention after a second pin");
    }),

    check("wait_for_focus returns a pin dropped during the wait", async () => {
      const conn = await app.connect();
      const { grantId } = conn;
      await app.page.setOpen(true);
      const waiting = timed(call(app, conn, "wait_for_focus", { timeout_s: 10 }));
      await sleep(300);
      expect(await app.page.pin(grantId, second), "the app refused the pin");
      const { value: r, ms } = await waiting;
      expect(!r.isError, "wait_for_focus failed");
      const d = data(r);
      expect(d.timed_out === false, "a wait that got a pin did not time out");
      checkFocus(d.focus, second, "wait_for_focus");
      expect(ms < 300 + SOON_MS, `it returned at ${ms} ms, not soon after the pin`);
      const after = await call(app, conn, app.probe.tool, app.probe.args);
      expect(attentionOf(after) === undefined, "the wait marks the pin seen");
    }),

    check("wait_for_focus times out cleanly", async () => {
      const conn = await app.connect();
      await app.page.setOpen(true);
      // Pinned lately and read, with the page open: then rides on this grant's results, so its absence below is the rule's.
      await pinnedAndRead(conn, first);
      const { value: r, ms } = await timed(call(app, conn, "wait_for_focus", { timeout_s: 1 }));
      expect(!r.isError, "wait_for_focus failed");
      const d = data(r);
      expect(d.focus === null && d.timed_out === true, `a wait with no pin times out: ${JSON.stringify(d)}`);
      expect(typeof d.note === "string" && d.note.length > 0, "a wait with no pin carries a note for the agent");
      expect(d.page_open === undefined || d.page_open === true, "the page is open, so page_open is true or left out");
      expect(ms >= 900 && ms < 1000 + TIMEOUT_LATE_MS, `it took ${ms} ms for timeout_s 1`);
      noThen(r, "a wait that timed out");
    }),

    check("wait_for_focus ends when the person has no page open", async () => {
      const conn = await app.connect();
      await app.page.setOpen(false);
      const { value: r, ms } = await timed(call(app, conn, "wait_for_focus", { timeout_s: 3 }));
      const d = data(r);
      expect(d.focus === null, "no pin, no focus");
      if (d.page_open === undefined) expect(d.timed_out === true, "an app that cannot tell runs to the timeout");
      else {
        expect(d.page_open === false && d.timed_out === false, `a closed page: page_open false, timed_out false (${JSON.stringify(d)})`);
        expect(ms < 2900, `a closed page ends the wait before its timeout (${ms} ms)`);
      }
      await app.page.setOpen(true);
    }),

    check("then rides on results only while the person's page is open and the agent was pinned lately", async () => {
      const conn = await app.connect();
      await app.page.setOpen(true);
      const v08 = await claims(conn, "0.8.0");
      if (v08) {
        const unpinned = await call(app, conn, app.probe.tool, app.probe.args);
        expect(resultKey(unpinned, "then").value === undefined && text(unpinned).then === undefined, "an open page with no pin gives no then (APC 0.8): the agent does not wait after every answer");
      }
      expect(await app.page.pin(conn.grantId, first), "the app refused the pin");
      expect(!(await call(app, conn, "get_current_view")).isError, "get_current_view failed");
      const open = await call(app, conn, app.probe.tool, app.probe.args);
      // resultKey: the same value in the structured result and the text (a text-only model follows the text).
      const then = resultKey(open, "then");
      expect(typeof then.value === "string" && typeof text(open).then === "string", "with the page open, a result carries then, structured and in the text");
      await app.page.setOpen(false);
      const closed = await call(app, conn, app.probe.tool, app.probe.args);
      expect(resultKey(closed, "then").value === undefined && text(closed).then === undefined, "with no page open, no then");
      await app.page.setOpen(true);
    }),

    check("presence names what a read touched, with ids only", async () => {
      const conn = await app.connect();
      const { grantId } = conn;
      await app.page.setOpen(true);
      expect(await app.page.pin(grantId, first), "the app refused the pin");
      const focus = checkFocus(data(await call(app, conn, "get_current_view")).focus, first, "get_current_view");
      app.page.takePresence();
      const read = await call(app, conn, focus.next as string, focus.next_args as Record<string, unknown>);
      expect(!read.isError, "next failed");
      const events = app.page.takePresence().filter((e): e is PresenceEvent => e.grant_id === grantId && e.kind !== "wait" && e.tool === focus.next);
      expect(events.length === 1, `one presence event for the read, got ${events.length}`);
      const e = events[0]!;
      expect(Object.keys(e).sort().join() === "at,count,grant_id,kind,targets,tool,v", `presence carries ids only: ${Object.keys(e).join()}`);
      expect(e.v === 1 && (e.kind === "read" || e.kind === "write") && ISO.test(e.at), "presence is v 1, read or write, with an ISO time");
      expect(Array.isArray(e.targets) && e.targets.length <= 20 && e.count >= e.targets.length, "at most 20 targets, and count covers them");
      expect(e.targets.every((t) => Object.keys(t).sort().join() === "id,kind"), "a presence target is { kind, id }");
      if (first.id) expect(e.targets.some((t) => t.kind === first.kind && t.id === first.id), `the read of ${first.kind}:${first.id} names it`);
    }),

    waitCheck("a wait publishes open, then closed, on the presence channel (APC 0.11)", async (conn) => {
      await app.page.setOpen(true);
      app.page.takePresence();
      const waiting = call(app, conn, "wait_for_focus", { timeout_s: 2 });
      await sleep(400);
      expect(waitEventsOf(app.page.takePresence(), conn.grantId).join() === "open", "while the wait runs, the page has its open, and only that");
      const done = data(await waiting);
      expect(done.focus === null, "no pin, no focus");
      const states = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(states.join() === "closed", `once the wait returned, the page has its closed, and only that: got [${states.join()}]`);
    }),

    waitCheck("a takeover publishes the old wait's closed before the new wait's open (APC 0.11)", async (conn) => {
      await app.page.setOpen(true);
      app.page.takePresence();
      const older = call(app, conn, "wait_for_focus", { timeout_s: 10 });
      await sleep((WAIT_CLAIM_GAP_S + 0.3) * 1000);
      const newer = call(app, conn, "wait_for_focus", { timeout_s: 2 });
      await older;
      await newer;
      // The old wait, finding it was taken over, sends nothing: its place was given up when the newer one claimed it.
      const states = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(states.join() === "open,closed,open,closed", `open, then at the takeover closed and open, then closed: got [${states.join()}]`);
    }),

    waitCheck("a cancelled wait publishes closed (APC 0.11)", async (conn) => {
      await app.page.setOpen(true);
      app.page.takePresence();
      const waiting = call(app, conn, "wait_for_focus", { timeout_s: 10 }).catch(() => null);
      await sleep(300);
      // MCP's cancel, in a POST of its own, as a client of a stateless server sends it (the core's cancel check).
      expect((await notify(app, conn, "notifications/cancelled", { requestId: 1, reason: "apc-conformance" })) < 300, "notifications/cancelled was not accepted");
      await waiting;
      await sleep(300);
      const states = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(states.join() === "open,closed", `a cancelled wait sends open, then closed when it stops: got [${states.join()}]`);
    }),

    waitCheck("a wait whose grant is revoked publishes closed, and a wait on a revoked grant publishes nothing (APC 0.11)", async (conn) => {
      await app.page.setOpen(true);
      app.page.takePresence();
      const waiting = send(app, conn, "tools/call", { name: "wait_for_focus", arguments: { timeout_s: 10 } }).catch(() => null);
      await sleep(300);
      expect(await app.page.revoke(conn.grantId), "the app refused to revoke");
      await waiting;
      // A wait on the revoked grant is answered revoked: it claims no place, so it sends nothing.
      await send(app, conn, "tools/call", { name: "wait_for_focus", arguments: { timeout_s: 2 } }).catch(() => null);
      await sleep(300);
      const states = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(states.join() === "open,closed", `a wait cut by a revoke sends open, then closed, and a wait on the revoked grant nothing: got [${states.join()}]`);
    }),

    waitCheck("a refused wait publishes nothing (APC 0.11)", async (conn) => {
      await app.page.setOpen(true);
      app.page.takePresence();
      const running = call(app, conn, "wait_for_focus", { timeout_s: 2 });
      await sleep(200);
      const refused = data(await call(app, conn, "wait_for_focus", { timeout_s: 2 }));
      expect(typeof refused.retry_after_s === "number", `the second wait is refused with retry_after_s: ${JSON.stringify(refused).slice(0, 200)}`);
      const during = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(during.join() === "open", `the refused wait claimed no place, so the page has only the first wait's open: got [${during.join()}]`);
      await running;
      const after = waitEventsOf(app.page.takePresence(), conn.grantId);
      expect(after.join() === "closed", `then only the first wait's closed: got [${after.join()}]`);
    }),

    check("revoke from the app cuts that agent at once, and only that agent", async () => {
      const a = await app.connect();
      const b = await app.connect();
      await app.page.setOpen(true);
      expect(await app.page.pin(a.grantId, first), "the app refused the pin");
      expect(await app.page.revoke(a.grantId), "the app refused to revoke");
      for (const [method, params] of [["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-conformance", version: "0" } }], ["tools/list", {}], ["tools/call", { name: "get_current_view", arguments: {} }], ["tools/call", { name: app.probe.tool, arguments: app.probe.args }]] as const) {
        const { status, body, headers } = await send(app, a, method, params);
        checkRevoked(a, status, body, method, headers);
      }
      // Whatever the HTTP method: a GET (the SSE stream) or a DELETE (ending a session) is answered "revoked" too, not 405.
      for (const method of ["GET", "DELETE"]) {
        const request = new Request(a.mcpUrl, { method, headers: { ...a.headers, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });
        const response = await (app.fetch ? app.fetch(request) : fetch(request));
        const text = await response.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        checkRevoked(a, response.status, body, method, response.headers);
      }
      // Whatever the JSON-RPC method, a notification, or a body that does not parse: an answer that serves any of them
      // tells the caller the grant's secret is still known.
      for (const [what, raw] of REVOKED_PROBES) {
        const request = new Request(a.mcpUrl, { method: "POST", headers: { ...a.headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: raw });
        const response = await (app.fetch ? app.fetch(request) : fetch(request));
        const text = await response.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        checkRevoked(a, response.status, body, what, response.headers);
      }
      expect(!(await app.page.pin(a.grantId, second)), "a revoked agent cannot be pinned");
      const other = await call(app, b, "get_current_view");
      expect(!other.isError && "view" in data(other), "another agent is not touched");
    }),

    check("a call already running when the grant is revoked ends revoked, with no data", async () => {
      const conn = await app.connect();
      const { grantId } = conn;
      await app.page.setOpen(true);
      const waiting = timed(call(app, conn, "wait_for_focus", { timeout_s: 10 }));
      await sleep(300);
      expect(await app.page.revoke(grantId), "the app refused to revoke");
      const { value: r, ms } = await waiting;
      expect(r.isError === true, `the wait ends as an error: ${JSON.stringify(r).slice(0, 200)}`);
      const d = text(r);
      expect(d.error === REVOKED_ERROR, `its error is "revoked": ${JSON.stringify(d).slice(0, 200)}`);
      // The RevokedAnswer and nothing else: in the text, and in structuredContent when there is one (an MCP SDK client
      // validates structuredContent even on isError, as with the pairing and idle errors).
      const extra = Object.keys(d).filter((k) => !REVOKED_KEYS.includes(k));
      expect(extra.length === 0, `it carries no focus, view or other data: ${extra.join(", ")}`);
      expect(r.structuredContent === undefined || sameJson(r.structuredContent, d), `its structuredContent, when there, is the same RevokedAnswer as the text: ${String(JSON.stringify(r.structuredContent)).slice(0, 200)}`);
      expect(ms < 300 + SOON_MS, `it ended at ${ms} ms, not soon after the revoke`);
    }),
    check("one wait per grant: a newer wait takes over, and the older one delivers nothing (APC 0.8)", async () => {
      const conn = await app.connect();
      if (!(await claims(conn, "0.8.0"))) return NOT_08;
      await app.page.setOpen(true);
      await pinnedAndRead(conn, second);
      const older = call(app, conn, "wait_for_focus", { timeout_s: 10 });
      await sleep((WAIT_CLAIM_GAP_S + 0.3) * 1000);
      const newer = timed(call(app, conn, "wait_for_focus", { timeout_s: 10 }));
      const taken = await older;
      const old = data(taken);
      expect(old.focus === null && old.timed_out === false && typeof old.note === "string", `the wait a newer one took over ends with focus null, timed_out false and a note: ${JSON.stringify(old).slice(0, 200)}`);
      noThen(taken, "the wait a newer one took over");
      expect(await app.page.pin(conn.grantId, first), "the app refused the pin");
      const { value: got, ms } = await newer;
      checkFocus(data(got).focus, first, "the newer wait");
      expect(ms < SOON_MS, `the newer wait returned at ${ms} ms, not soon after the pin`);
    }),

    check("a second wait started right after the first is refused with retry_after_s, and the first still delivers (APC 0.8)", async () => {
      const conn = await app.connect();
      if (!(await claims(conn, "0.8.0"))) return NOT_08;
      await app.page.setOpen(true);
      await pinnedAndRead(conn, first);
      const running = call(app, conn, "wait_for_focus", { timeout_s: 10 });
      await sleep(200);
      const refusedResult = await call(app, conn, "wait_for_focus", { timeout_s: 10 });
      const refused = data(refusedResult);
      expect(refused.focus === null && refused.timed_out === false, `the second wait is refused: ${JSON.stringify(refused).slice(0, 200)}`);
      expect(typeof refused.retry_after_s === "number" && refused.retry_after_s >= 1 && refused.retry_after_s <= WAIT_CLAIM_GAP_S + 1, `with retry_after_s, 1 to ${WAIT_CLAIM_GAP_S + 1}: ${JSON.stringify(refused).slice(0, 200)}`);
      expect(typeof refused.note === "string" && refused.note.length > 0, "and a note");
      noThen(refusedResult, "the refused wait");
      expect(await app.page.pin(conn.grantId, second), "the app refused the pin");
      checkFocus(data(await running).focus, second, "the first wait, still running");
    }),

    ...(["notifications/cancelled", "an HTTP abort"] as const).map((how) =>
      check(`a pin is never lost to a cancelled wait (${how}): it marks nothing seen and frees its place at once (APC 0.8)`, async () => {
        const conn = await app.connect();
        if (!(await claims(conn, "0.8.0"))) return NOT_08;
        await app.page.setOpen(true);
        await pinnedAndRead(conn, second);
        const controller = new AbortController();
        // Not awaited before the pin: a handler that ignores the cancel would still be waiting, and would take the pin.
        const waiting = call(app, conn, "wait_for_focus", { timeout_s: 10 }, how === "an HTTP abort" ? controller.signal : undefined).catch(() => null);
        await sleep(300);
        if (how === "an HTTP abort") controller.abort();
        // MCP's cancel, in a POST of its own, as a client of a stateless server sends it.
        else expect((await notify(app, conn, "notifications/cancelled", { requestId: 1, reason: "apc-conformance" })) < 300, "notifications/cancelled was not accepted");
        await sleep(300);
        expect(await app.page.pin(conn.grantId, first), "the app refused the pin");
        // Past a poll of a wait that ignored the cancel (2 s in @tineira/apc-server), so it would have taken the pin by now.
        await sleep(2500);
        const attention = attentionOf(await call(app, conn, app.probe.tool, app.probe.args));
        expect(isObject(attention), `the pin dropped after the cancelled wait is still unread: it rides as attention (the cancelled wait took it)`);
        checkFocus(attention.focus, first, "attention after a cancelled wait");
        const again = data(await call(app, conn, "wait_for_focus", { timeout_s: 2 }));
        expect(again.retry_after_s === undefined, `a cancelled wait frees its place at once: ${JSON.stringify(again).slice(0, 200)}`);
        checkFocus(again.focus, first, "the next wait gets the pin");
        // A cancelled wait that still answers (nothing obliges a client to stop reading) answers with no focus, so with no then.
        const late = await Promise.race([waiting, sleep(11_000).then(() => null)]);
        if (late && data(late).focus === null) noThen(late, "the cancelled wait");
      }),
    ),
    ...mobileChecks(app, app.page.mobile),
    ...(app.profile === "dock" ? dockChecks(app, app.dock) : []),
    ...(app.profile === "dock" ? dockLifecycleChecks(app, app.dock) : []),
    ...(app.link ? linkChecks(app, app.link) : []),

    // Last, after every check that can make the app send a wait event (a takeover, a cancel, a revoke, a longer wait).
    check("an app whose wait-event checks were not checked sends no wait event anywhere in the run (APC 0.11)", async () => {
      app.page.takePresence();
      if (!waitSkipped) return;
      expect(!sawWait, "the app sent wait events in this run, so it is held to every wait-event rule, but the wait-event checks ran before any came and passed as not checked: an app that sends any wait event sends them on every wait");
    }),
  ];
}

/** What a check of a 0.9 rule says of an app that claims an earlier standard: passed, not checked. */
const NOT_09 = { note: "not checked: the app's apc.json claims a standard before 0.9.0, which does not have the pairing code" };

/** The standard an app's apc.json claims, read from the origin of one of its grants. */
async function claimedStandard(app: ApcAppAdapter, conn: AgentConnection): Promise<unknown> {
  const request = new Request(`${new URL(conn.mcpUrl).origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
  const response = await (app.fetch ? app.fetch(request) : fetch(request));
  return ((await response.json().catch(() => ({}))) as { standard?: unknown }).standard;
}

/**
 * The pairing code (APC 0.9), on the Dock profile: the consent shows a well-formed code, new for every consent,
 * and the app sends that code to the hub; the app keeps no grant unless the hub acknowledges the code with a
 * plain 200; five wrong codes, or the code's time running out, give the grant back; the right code pairs.
 */
function dockChecks(app: ApcAppAdapter, dock: ApcDockAdapter | undefined): ConformanceCheck[] {
  const check = (name: string, run: () => Promise<void | { note: string }>): ConformanceCheck => noted(`${app.name} (dock): pairing code: ${name}`, run);
  let n = 0;
  /** A new agent's drop, Allowed: what the consent showed, the app's answer, and the pairing the hub got. */
  const allowNew = async (d: ApcDockAdapter) => {
    const agent = `ag_code_${++n}_${Date.now().toString(36)}`;
    const drop = await d.drop(agent, d.hub.ticket(agent));
    const answer = await drop.allow();
    return { agent, shown: drop.shown, answer, sent: d.hub.received.at(-1), pairing: d.hub.pairings.find((p) => p.agent === agent) };
  };
  /** The HTTP status the app gives a grant's MCP URL: 404 once it holds no grant there. */
  const statusOf = async (mcpUrl: string) =>
    (await send(app, { mcpUrl, grantId: "" }, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-conformance", version: "1" } })).status;
  /** Whether the app claims 0.9.0 or later, read through a grant made the usual way. */
  const claims09 = async () => {
    const claimed = await claimedStandard(app, await app.connect());
    return typeof claimed === "string" && compareStandard(claimed, "0.9.0") >= 0;
  };
  return [
    check("the dock adapter is given (required of an app that claims 0.9.0 or later on the Dock profile)", async () => {
      if (dock) return;
      const claimed = await claimedStandard(app, await app.connect());
      expect(typeof claimed === "string" && compareStandard(claimed, "0.9.0") < 0, `apc.json claims standard ${String(claimed)}, which requires the pairing code to be checked: give dock in the adapter (ApcDockAdapter: hub, drop)`);
    }),

    check("the consent shows a well-formed code, and the app sends that code, raw, to the hub", async () => {
      if (!dock) return;
      if (!(await claims09())) return NOT_09;
      const { shown, answer, sent } = await allowNew(dock);
      const code = normalizePairingCode(shown);
      expect(code, `the consent shows ${JSON.stringify(shown)}, not a pairing code (6 characters of Crockford base32)`);
      expect(answer.ok, `the Allow did not pair: ${answer.error}`);
      expect(isObject(sent), "the app sent the hub no /apc/pair");
      expect(sent.pairing_code !== undefined, "the app sent /apc/pair without pairing_code: an app of 0.9 must send the code its consent showed");
      expect(normalizePairingCode(sent.pairing_code) === sent.pairing_code, `the app sent pairing_code ${JSON.stringify(sent.pairing_code)}: send it raw, 6 characters, no dash`);
      expect(sent.pairing_code === code, "the app sent the hub another code than the one its consent showed");
    }),

    check("every consent shows a new code", async () => {
      if (!dock) return;
      if (!(await claims09())) return NOT_09;
      const a = `ag_two_${++n}`;
      const b = `ag_two_${++n}`;
      const first = normalizePairingCode((await dock.drop(a, dock.hub.ticket(a))).shown);
      const second = normalizePairingCode((await dock.drop(b, dock.hub.ticket(b))).shown);
      expect(first && second, "a consent shows no pairing code");
      expect(first !== second, `two consents showed the same code, ${first}`);
    }),

    check("a hub that does not acknowledge the code, redirects, or says yes with HTTP 500 holds no grant", async () => {
      if (!dock) return;
      if (!(await claims09())) return NOT_09;
      try {
        for (const mode of ["no_ack", "redirect", "error_500"] as const) {
          dock.hub.mode = mode;
          const { answer, sent } = await allowNew(dock);
          expect(!answer.ok, `with a hub that answers ${mode}, the Allow says it paired: the app must refuse it`);
          expect(isObject(sent) && typeof sent.mcp_url === "string", `with a hub that answers ${mode}, the app sent no MCP URL to check`);
          const status = await statusOf(sent.mcp_url);
          expect(status === 404, `with a hub that answers ${mode}, the grant the app made still answers (HTTP ${status}): it must be deleted before the app answers its page`);
        }
      } finally {
        dock.hub.mode = "ack";
      }
    }),

    check(`${PAIRING_CODE_MAX_ATTEMPTS} wrong codes, or the code's time running out, give the grant back`, async () => {
      if (!dock) return;
      if (!(await claims09())) return NOT_09;
      const wrong = await allowNew(dock);
      expect(wrong.answer.ok && wrong.pairing, `the Allow did not pair: ${wrong.answer.error}`);
      const code = normalizePairingCode(wrong.shown)!;
      const other = code.startsWith("A") ? "BBBBBB" : "AAAAAA";
      for (let i = 1; i <= PAIRING_CODE_MAX_ATTEMPTS; i++) await dock.hub.decide(wrong.pairing.id, "approve", other);
      expect(!dock.hub.pairings.includes(wrong.pairing), "the stand-in hub kept a pairing after the last wrong code");
      const afterWrong = await statusOf(wrong.pairing.mcp_url);
      expect(afterWrong === 404, `after ${PAIRING_CODE_MAX_ATTEMPTS} wrong codes the hub gave the grant back, and it still answers (HTTP ${afterWrong})`);

      const late = await allowNew(dock);
      expect(late.answer.ok && late.pairing, `the Allow did not pair: ${late.answer.error}`);
      await dock.hub.expire();
      const afterExpiry = await statusOf(late.pairing.mcp_url);
      expect(afterExpiry === 404, `the code's time ran out and the hub gave the grant back, and it still answers (HTTP ${afterExpiry})`);
    }),

    check("the right code pairs, and the grant answers", async () => {
      if (!dock) return;
      if (!(await claims09())) return NOT_09;
      const { shown, answer, pairing } = await allowNew(dock);
      expect(answer.ok && pairing, `the Allow did not pair: ${answer.error}`);
      const decided = await dock.hub.decide(pairing.id, "approve", shown);
      expect(decided.ok, `the code the consent showed did not approve the pairing: ${decided.error}`);
      const conn = { mcpUrl: pairing.mcp_url, grantId: "" };
      const listed = await send(app, conn, "tools/list", {});
      expect(listed.status === 200, `the paired grant answers tools/list with HTTP ${listed.status}`);
    }),

    consentCheck(app, dock),
  ];
}

/**
 * Consent in the app (APC 0.7): the server answers `consent_required` with a nonce and makes a grant only for an Allow
 * that brings it back; the nonce works once, for its own agent. Through the owner's endpoints of `dock.lifecycle`
 * (APC 0.10): an Allow is `owner.allow.body()`, and the members it has that a drop (`owner.drop.body()`) lacks carry the
 * nonce. An Allow pairs when the app sends the hub `/apc/pair`; so does none of these: the nonce left out, a forged one,
 * another agent's, and the same Allow again once it paired. The right Allow must pair, or the refusals prove nothing.
 */
function consentCheck(app: ApcAppAdapter, dock: ApcDockAdapter | undefined): ConformanceCheck {
  return noted(`${app.name} (dock): consent: an Allow pairs only with its own consent's nonce, once: not with none, a forged one, another agent's, or one already used`, async () => {
    if (!dock) return;
    const life = dock.lifecycle;
    if (!life) return { note: "not checked: the consent's nonce is reached through dock.lifecycle.owner (APC 0.10), which the adapter does not give" };
    const { origin, session, allow, drop } = life.owner;
    const hub = dock.hub;
    const fromPairing = hub.pairings.length;
    const post = async (body: unknown) => {
      const before = hub.received.length;
      const request = new Request(new URL(allow.path, origin), { method: "POST", headers: { ...session, "content-type": "application/json", origin, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
      const response = await (app.fetch ? app.fetch(request) : fetch(request));
      await response.text().catch(() => "");
      return hub.received.length > before;
    };
    try {
      // A consent of its own for each probe: an app may drop a consent that saw a bad Allow, and an Allow with no
      // nonce is a drop, which replaces the agent's consent (one pending pairing). The right one stays untouched.
      const bodies: unknown[] = [await drop.body()];
      for (let i = 0; i < 5; i++) bodies.push(await allow.body());
      if (!bodies.every(isObject)) return { note: "not checked: owner.drop.body() or owner.allow.body() is not a JSON object" };
      const [fields, right, forgedOn, other, mine, bare] = bodies as Array<Record<string, unknown>> as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
      const nonceKeys = Object.keys(right).filter((k) => !(k in fields));
      if (!nonceKeys.length) return { note: "not checked: owner.allow.body() has no member the drop's body lacks, so the suite cannot tell where the nonce goes" };
      const nonceOf = (body: Record<string, unknown>) => Object.fromEntries(nonceKeys.map((k) => [k, body[k]]));
      const forged = Object.fromEntries(nonceKeys.map((k) => [k, typeof forgedOn[k] === "string" ? randomLike(forgedOn[k] as string) : "apc-conformance-forged-nonce-0000"]));
      expect(!(await post({ ...forgedOn, ...forged })), "an Allow with a forged nonce paired: the app sent the hub /apc/pair");
      const notes: string[] = [];
      // Another agent's nonce: only when the Allow names its agent; an Allow that carries the consent alone has no agent to mismatch.
      if ("agent" in mine && "agent" in other && mine.agent !== other.agent) {
        expect(!(await post({ ...mine, ...nonceOf(other) })), "an Allow with another agent's nonce paired: a nonce works only for the dock and the agent it was given for");
      } else notes.push("another agent's nonce not checked: the Allow does not name its agent (the consent alone carries it)");
      const without = Object.fromEntries(Object.entries(bare).filter(([k]) => !nonceKeys.includes(k)));
      expect(!(await post(without)), `an Allow with no nonce (${nonceKeys.join(", ")} left out) paired: the app sent the hub /apc/pair`);
      expect(await post(right), "the Allow with its own consent's nonce did not pair (the app sent the hub no /apc/pair): the refusals above prove nothing");
      expect(!(await post(right)), "the same Allow, sent again once it paired, paired again: a nonce works once");
      if (notes.length) return { note: `not checked: ${notes.join("; ")}` };
    } finally {
      // Every pairing the check made, given back.
      for (const p of hub.pairings.slice(fromPairing)) await hub.decide(p.id, "deny").catch(() => {});
    }
  });
}

/** A string of the same length and alphabet class as `like`, random: a forged nonce the app's parser takes as one. */
function randomLike(like: string): string {
  const alphabet = /^[0-9a-f]+$/.test(like) ? "0123456789abcdef" : "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(Math.max(like.length, 16))), (x) => alphabet[x % alphabet.length]).join("");
}

/** The mobile rule (APC 0.6): on a phone the agents are in the page, never collapsed, and a finger can pin and unpin. */
function mobileChecks(app: ApcAppAdapter, mobile: ApcMobilePage | undefined): ConformanceCheck[] {
  const [first, second] = app.targets;
  const { width, height } = APC_MOBILE_VIEWPORT;
  const check = (name: string, run: () => Promise<void>): ConformanceCheck => ({ name: `${app.name} (${app.profile}): mobile ${width}x${height}: ${name}`, run });
  return [
    check("the page adapter for a phone is given (required of an app that claims 0.6.0 or later)", async () => {
      if (mobile) return;
      const conn = await app.connect();
      const request = new Request(`${new URL(conn.mcpUrl).origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
      const response = await (app.fetch ? app.fetch(request) : fetch(request));
      const claimed = ((await response.json().catch(() => ({}))) as { standard?: unknown }).standard;
      expect(typeof claimed === "string" && compareStandard(claimed, "0.6.0") < 0, `apc.json claims standard ${String(claimed)}, which requires the mobile rule to be checked: give page.mobile in the adapter (ApcMobilePage: agentBar, pinByTouch, unpinByTouch)`);
    }),

    check("every agent is shown in the page, and the agent bar cannot be collapsed or hidden", async () => {
      if (!mobile) return;
      const a = await app.connect();
      const b = await app.connect();
      await app.page.setOpen(true);
      const bar = await mobile.agentBar();
      for (const { grantId } of [a, b]) expect(bar.visible.includes(grantId), `the agent ${grantId} is not shown in the page on a phone: the page shows ${JSON.stringify(bar.visible)}`);
      expect(bar.collapsible === false, "the agent bar can be collapsed or hidden on a phone: there the agent in the page is the only way to point it");
    }),

    check("a person pins with a finger, no mouse drag, and the agent reads the pin; unpin works by touch too", async () => {
      if (!mobile) return;
      const conn = await app.connect();
      const { grantId } = conn;
      await app.page.setOpen(true);
      await app.page.showView();
      expect(await mobile.pinByTouch(grantId, first), "the page refused a pin made by tapping the agent and then the target");
      const r = await call(app, conn, "get_current_view");
      expect(!r.isError, "get_current_view failed");
      checkFocus(data(r).focus, first, "get_current_view after a pin by touch");
      // The same again on another target: one pin per grant, replaced.
      expect(await mobile.pinByTouch(grantId, second), "the page refused a second pin by touch");
      checkFocus(data(await call(app, conn, "get_current_view")).focus, second, "get_current_view after a second pin by touch");
      expect(await mobile.unpinByTouch(grantId), "the page offers no way to remove the pin with a finger");
      const after = await call(app, conn, "get_current_view");
      expect(data(after).focus === null, "the pin is still there after the person removed it by touch");
    }),
  ];
}

/** A connection arrives: the agent's own initialize on Direct; on Dock, its hub's, naming the agent's client. */
async function arrive(app: ApcAppAdapter, conn: AgentConnection & { path: ApcProfile }, client: string): Promise<void> {
  const params =
    conn.path === "direct"
      ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1.0.0" } }
      : { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: `${client} via dock`, version: "0.1.0" }, _meta: { [APC_AGENT_CLIENT_META]: client } };
  await result(app, conn, "initialize", params);
}

/** The offer on a result, where the model sees it: in the structured result and the same in the text. */
function offerOf(r: ToolCallResult): { code: string; expires_in: number; note: string } | undefined {
  const inData = data(r)[APC_LINK_KEY];
  const inText = text(r)[APC_LINK_KEY];
  expect(JSON.stringify(inData) === JSON.stringify(inText), "apc_link is the same in the structured result and the text");
  if (inData === undefined) return undefined;
  expect(isObject(inData) && typeof inData.code === "string" && inData.code.length >= 16, `apc_link is { code, expires_in, note }: ${JSON.stringify(inData)}`);
  expect(typeof inData.expires_in === "number" && inData.expires_in > 0 && inData.expires_in <= APC_LINK_TTL_S, `expires_in is 1 to ${APC_LINK_TTL_S} s`);
  expect(typeof inData.note === "string" && inData.note.includes(APC_LINK_TOOL), "its note names the apc_link tool");
  return inData as { code: string; expires_in: number; note: string };
}

/** `apc_link` (APC 0.4): the checks of an app that offers both profiles. */
function linkChecks(app: ApcAppAdapter, link: ApcLinkAdapter): ConformanceCheck[] {
  const check = (name: string, run: () => Promise<void>): ConformanceCheck => ({ name: `${app.name} (apc_link): ${name}`, run });
  let clients = 0;
  const client = () => `conformance-agent-${++clients}`;
  const connect = async (path: ApcProfile) => ({ ...(await link.connect(path)), path });
  /** The same agent, connected directly and then through a dock: the dock's connection is the new one, and gets the offer. */
  const pair = async () => {
    const name = client();
    const direct = await connect("direct");
    await arrive(app, direct, name);
    const dock = await connect("dock");
    await arrive(app, dock, name);
    const offered = await call(app, dock, app.probe.tool, app.probe.args);
    expect(!offered.isError, `${app.probe.tool} failed`);
    const offer = offerOf(offered);
    expect(offer, `the second connection of ${name}, on the other path, gets apc_link on a result of one of the app's own tools`);
    return { name, direct, dock, offer };
  };
  const redeem = (conn: AgentConnection, code: string) => call(app, conn, APC_LINK_TOOL, { code });
  const refused = (r: ToolCallResult, reason: ApcLinkRefusal, where: string) => {
    expect(r.isError === true, `${where}: refused, as a tool error (${JSON.stringify(r).slice(0, 200)})`);
    const d = text(r);
    expect(d.error === LINK_REFUSED_ERROR && d.reason === reason, `${where}: { error: "link_refused", reason: "${reason}" }, got ${JSON.stringify(d).slice(0, 200)}`);
  };
  const linkedEntry = async (a: string, b: string) => (await link.agents()).find((e) => e.grants.includes(a) && e.grants.includes(b));
  const works = async (conn: AgentConnection, where: string) => {
    const r = await call(app, conn, "get_current_view");
    expect(!r.isError && "view" in data(r), `${where} still reads the app`);
  };

  return [
    check("the same client on the other path is offered a code once per session, and the code links them", async () => {
      const { direct, dock, offer } = await pair();
      const again = await call(app, dock, app.probe.tool, app.probe.args);
      expect(offerOf(again) === undefined, "asked at most once per MCP session");
      const done = await redeem(direct, offer.code);
      expect(!done.isError && data(done).linked === true, `the other connection redeems it: ${JSON.stringify(done).slice(0, 200)}`);
      expect(await linkedEntry(direct.grantId, dock.grantId), "the agent bar shows one agent with both grants");
      // Linking grants nothing: each connection keeps its own grant.
      await works(direct, "the Direct connection");
      await works(dock, "the Dock connection");
    }),

    check("a code is refused on the connection that got it, on the same path, on another client, and once used", async () => {
      const { name, direct, dock, offer } = await pair();
      const sameSide = await connect("dock");
      await arrive(app, sameSide, name);
      const stranger = await connect("direct");
      await arrive(app, stranger, client());
      refused(await redeem(dock, offer.code), "same_connection", "on the connection that got it");
      refused(await redeem(sameSide, offer.code), "same_path", "on another connection of the same path");
      refused(await redeem(stranger, offer.code), "not_offered", "on the other path, by another client");
      refused(await redeem(direct, "lk_000000000000000000000000"), "unknown_code", "a code the app never gave");
      const done = await redeem(direct, offer.code);
      expect(!done.isError, "the right connection still redeems it");
      refused(await redeem(direct, offer.code), "used", "a second time");
      expect(!(await linkedEntry(direct.grantId, sameSide.grantId)), "nothing else was linked");
    }),

    check("an expired code is refused, and the app does not ask again in that session", async () => {
      const { direct, dock, offer } = await pair();
      if (link.expireCodes) await link.expireCodes();
      else await sleep((APC_LINK_TTL_S + 1) * 1000);
      refused(await redeem(direct, offer.code), "expired", "after expires_in");
      expect(!(await linkedEntry(direct.grantId, dock.grantId)), "it stays two agents");
      expect(offerOf(await call(app, dock, app.probe.tool, app.probe.args)) === undefined, "not asked again in that session");
    }),

    check("a connection of another client is offered nothing", async () => {
      const direct = await connect("direct");
      await arrive(app, direct, client());
      const dock = await connect("dock");
      await arrive(app, dock, client());
      expect(offerOf(await call(app, dock, app.probe.tool, app.probe.args)) === undefined, "no offer between two clients");
    }),

    check("revoke on a linked agent cuts both grants", async () => {
      const { direct, dock, offer } = await pair();
      expect(!(await redeem(direct, offer.code)).isError, "linked");
      expect(await app.page.revoke(dock.grantId), "the app refused to revoke");
      for (const [conn, where] of [[direct, "Direct"], [dock, "Dock"]] as const) {
        const { status, body, headers } = await send(app, conn, "tools/call", { name: "get_current_view", arguments: {} });
        checkRevoked(conn, status, body, `get_current_view on the ${where} grant`, headers);
      }
    }),

    check("unlink shows two agents again, each with its own grant", async () => {
      const { direct, dock, offer } = await pair();
      expect(!(await redeem(direct, offer.code)).isError, "linked");
      expect(await link.unlink(direct.grantId), "the app refused to unlink");
      expect(!(await linkedEntry(direct.grantId, dock.grantId)), "two agents again");
      await works(direct, "the Direct connection");
      await works(dock, "the Dock connection");
      expect(await app.page.revoke(direct.grantId), "the app refused to revoke");
      await works(dock, "once unlinked, revoking one leaves the other: the Dock connection");
    }),
  ];
}

/** Every check, one after another: what passed and what failed, with why. */
export async function runConformance(app: ApcAppAdapter): Promise<ConformanceReport> {
  const results: ConformanceReport["results"] = [];
  for (const c of apcConformance(app)) {
    try {
      await c.run();
      results.push({ name: c.name, ok: true, ...(c.note ? { note: c.note } : {}) });
    } catch (error) {
      results.push({ name: c.name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return { app: app.name, profile: app.profile, passed: results.length - failed, failed, results };
}
