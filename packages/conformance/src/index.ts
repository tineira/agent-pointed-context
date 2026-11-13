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
  declaresMcpUrl,
  isRevokedAnswer,
  normalizePairingCode,
  PAIRING_CODE_MAX_ATTEMPTS,
  parseApcManifest,
  type ApcLinkRefusal,
  type ApcProfile,
  type FocusTarget,
  type PresenceEvent,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, attentionOf, checkCoreToolList, checkFocusShape, checkView, data, expect, isObject, resultKey, rpcBody, standardSupport, text, type ToolCallResult } from "./shared.ts";
import type { StandInHub } from "./hub.ts";
import { dockLifecycleChecks } from "./dock-lifecycle.ts";

export { ConformanceError } from "./shared.ts";
export { standInHub, type StandInHold, type StandInHub, type StandInHubMode, type StandInHubOptions, type StandInPairing } from "./hub.ts";
export {
  HttpConformanceUsageError,
  IN_PROCESS_ONLY,
  httpConformance,
  redactGrantUrl,
  redactSecrets,
  runHttpConformance,
  type HttpCheck,
  type HttpCheckResult,
  type HttpConformanceOptions,
  type HttpConformanceReport,
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
 * `ApcDockAdapter`; its `apc.json` is read at `owner.origin`.
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
  /** The app's deadline on a hub call (M3), in ms of real time: at most 10 000, the default. The time seam does not move it. */
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
    /** The presence events the app published to the person's page since the last call, oldest first. */
    takePresence(): PresenceEvent[];
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
  expect(isRevokedAnswer(body) && body.revoked_by.length > 0 && ISO.test(body.revoked_at), `${what} on a revoked grant answers { error: "revoked", revoked_by, revoked_at }: ${JSON.stringify(body).slice(0, 200)}`);
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
export function apcConformance(app: ApcAppAdapter): ConformanceCheck[] {
  const [first, second] = app.targets;
  const check = (name: string, run: () => Promise<void | { note: string }>): ConformanceCheck => noted(`${app.name} (${app.profile}): ${name}`, run);
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
      expect(declaresMcpUrl(m, conn.mcpUrl, { shared }), `the grant's MCP URL is not under ${origin}${m.mcp.path} (mcp.path)${shared ? ", nor that path itself" : ""}`);
      if (m.profiles.includes("direct")) expect(m.direct && new URL(m.direct.connect).origin === origin, "direct.connect is the app's own page");
      if (support.note) return { note: support.note };
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
      expect(ms < 9000, `it returned at ${ms} ms, not soon after the pin`);
      const after = await call(app, conn, app.probe.tool, app.probe.args);
      expect(attentionOf(after) === undefined, "the wait marks the pin seen");
    }),

    check("wait_for_focus times out cleanly", async () => {
      const conn = await app.connect();
      await app.page.setOpen(true);
      const { value: r, ms } = await timed(call(app, conn, "wait_for_focus", { timeout_s: 1 }));
      expect(!r.isError, "wait_for_focus failed");
      const d = data(r);
      expect(d.focus === null && d.timed_out === true, `a wait with no pin times out: ${JSON.stringify(d)}`);
      expect(typeof d.note === "string" && d.note.length > 0, "a wait with no pin carries a note for the agent");
      expect(d.page_open === undefined || d.page_open === true, "the page is open, so page_open is true or left out");
      expect(ms >= 900 && ms < 5000, `it took ${ms} ms for timeout_s 1`);
      expect(text(r).then === undefined && d.then === undefined, "a wait that came back empty ends the loop: no then");
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
      const events = app.page.takePresence().filter((e) => e.grant_id === grantId && e.tool === focus.next);
      expect(events.length === 1, `one presence event for the read, got ${events.length}`);
      const e = events[0]!;
      expect(Object.keys(e).sort().join() === "at,count,grant_id,kind,targets,tool,v", `presence carries ids only: ${Object.keys(e).join()}`);
      expect(e.v === 1 && (e.kind === "read" || e.kind === "write") && ISO.test(e.at), "presence is v 1, read or write, with an ISO time");
      expect(Array.isArray(e.targets) && e.targets.length <= 20 && e.count >= e.targets.length, "at most 20 targets, and count covers them");
      expect(e.targets.every((t) => Object.keys(t).sort().join() === "id,kind"), "a presence target is { kind, id }");
      if (first.id) expect(e.targets.some((t) => t.kind === first.kind && t.id === first.id), `the read of ${first.kind}:${first.id} names it`);
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
      expect(!("focus" in d) && !("view" in d) && r.structuredContent === undefined, "it carries no focus, view or other data");
      expect(ms < 9000, `it ended at ${ms} ms, not soon after the revoke`);
    }),
    check("one wait per grant: a newer wait takes over, and the older one delivers nothing (APC 0.8)", async () => {
      const conn = await app.connect();
      if (!(await claims(conn, "0.8.0"))) return NOT_08;
      await app.page.setOpen(true);
      const older = call(app, conn, "wait_for_focus", { timeout_s: 10 });
      await sleep((WAIT_CLAIM_GAP_S + 0.3) * 1000);
      const newer = timed(call(app, conn, "wait_for_focus", { timeout_s: 10 }));
      const old = data(await older);
      expect(old.focus === null && old.timed_out === false && typeof old.note === "string", `the wait a newer one took over ends with focus null, timed_out false and a note: ${JSON.stringify(old).slice(0, 200)}`);
      expect(await app.page.pin(conn.grantId, first), "the app refused the pin");
      const { value: got, ms } = await newer;
      checkFocus(data(got).focus, first, "the newer wait");
      expect(ms < 9000, `the newer wait returned at ${ms} ms, not soon after the pin`);
    }),

    check("a second wait started right after the first is refused with retry_after_s, and the first still delivers (APC 0.8)", async () => {
      const conn = await app.connect();
      if (!(await claims(conn, "0.8.0"))) return NOT_08;
      await app.page.setOpen(true);
      const running = call(app, conn, "wait_for_focus", { timeout_s: 10 });
      await sleep(200);
      const refused = data(await call(app, conn, "wait_for_focus", { timeout_s: 10 }));
      expect(refused.focus === null && refused.timed_out === false, `the second wait is refused: ${JSON.stringify(refused).slice(0, 200)}`);
      expect(typeof refused.retry_after_s === "number" && refused.retry_after_s >= 1 && refused.retry_after_s <= WAIT_CLAIM_GAP_S + 1, `with retry_after_s, 1 to ${WAIT_CLAIM_GAP_S + 1}: ${JSON.stringify(refused).slice(0, 200)}`);
      expect(typeof refused.note === "string" && refused.note.length > 0, "and a note");
      expect(await app.page.pin(conn.grantId, second), "the app refused the pin");
      checkFocus(data(await running).focus, second, "the first wait, still running");
    }),

    ...(["notifications/cancelled", "an HTTP abort"] as const).map((how) =>
      check(`a pin is never lost to a cancelled wait (${how}): it marks nothing seen and frees its place at once (APC 0.8)`, async () => {
        const conn = await app.connect();
        if (!(await claims(conn, "0.8.0"))) return NOT_08;
        await app.page.setOpen(true);
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
        await Promise.race([waiting, sleep(11_000)]);
      }),
    ),
    ...mobileChecks(app, app.page.mobile),
    ...(app.profile === "dock" ? dockChecks(app, app.dock) : []),
    ...(app.profile === "dock" ? dockLifecycleChecks(app, app.dock) : []),
    ...(app.link ? linkChecks(app, app.link) : []),
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
  ];
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
