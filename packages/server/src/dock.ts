import {
  AGENT_HANDLE_RE,
  bindingVerdict,
  hasBindingKey,
  isInitializeMessage,
  PAIRING_MISMATCH_ERROR,
  rpcMessages,
  type DockBinding,
  DOCK_GRANT_RPC_ERROR_CODE,
  DRAG_TICKET_RE,
  dockGrantAnswer,
  dockGrantCallOf,
  idleCurrentView,
  idleWaitForFocus,
  IDLE_MESSAGE,
  PAIRING_MESSAGE,
  type DockGrantAnswerKind,
  type DockGrantCall,
  type DockGrantError,
  type DockGrantState,
} from "@tineira/apc-protocol";
import { toolError, toolResult, type ToolResult } from "./envelope.ts";
import { badContentLength, bareOrigin, LOOPBACK_HOST, readCapped, utf8 } from "./util.ts";
import { revokedResponse, secretHash } from "./revoke.ts";

/**
 * The app's side of the Dock profile around the hub (APC 0.10): the drop parser with the hub allowlist (M1),
 * the give-back endpoint (M7) and the grant's answer table as a gate for the app's MCP handler.
 */

// #region M1: the drop

/** Why `parseDockDrop` refused a drop: the hub is not on the allowlist (M1), or the drop is not one. */
export type DockDropParseError = "hub_not_allowed" | "invalid_drop";

export type ParsedDockDrop = { ok: true; hub: string; agent: string; ticket: string } | { ok: false; error: DockDropParseError };

export interface DockDropOptions {
  /**
   * The app's constant allowlist of hub origins: bare `https:` origins, such as `"https://apc.tineira.com"`.
   * An entry that is not one throws, so a mistyped list fails at once rather than letting a hub through.
   */
  hubs: readonly string[];
  /**
   * Local-dev hub origins, allowed over `http:` too, such as `"http://localhost:8787"`. Only loopback hosts
   * (`localhost`, `*.localhost`, `127.0.0.1`; no IPv6, which the page's drag grammar cannot carry): any other
   * entry throws. Leave it empty in production.
   */
  localDevHubs?: readonly string[];
}

function allowlist(options: DockDropOptions): Set<string> {
  const allowed = new Set<string>();
  for (const entry of options.hubs) {
    const url = bareOrigin(entry);
    if (!url || url.protocol !== "https:") throw new TypeError(`parseDockDrop: hubs must be bare https origins, not ${JSON.stringify(entry)}`);
    allowed.add(url.origin);
  }
  for (const entry of options.localDevHubs ?? []) {
    const url = bareOrigin(entry);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK_HOST.test(url.hostname)) throw new TypeError(`parseDockDrop: localDevHubs must be loopback origins, not ${JSON.stringify(entry)}`);
    allowed.add(url.origin);
  }
  return allowed;
}

/**
 * A dock drop as the app's server takes it (M1, APC 0.10): `body` carries the drag's `agent`, `hub` and
 * `ticket` (as the page read them with `parseAgentDrag`). The hub is parsed with `new URL` and must be:
 *
 * - `https:`, but for an origin listed in `localDevHubs`;
 * - with no userinfo, a path of `/` or none, no query and no fragment, written as its own origin (no default
 *   port, upper case, dot segment or control character; a trailing dot is its own origin, refused by the allowlist), in printable ASCII (an IDN hub is written in punycode, as
 *   `location.origin` gives it);
 * - and its `origin` exactly equal to one on the allowlist: never a prefix or a suffix match.
 *
 * Otherwise `hub_not_allowed`: no consent and no grant. An agent or ticket outside the drag grammar
 * (`AGENT_HANDLE_RE`, `DRAG_TICKET_RE`) is `invalid_drop`.
 *
 * **Call it on the drop and again on the Allow**, with the same allowlist: the Allow's hub is what the app
 * pairs with, and the list may have changed in between. Send hub requests to the `hub` it returns (the
 * parsed origin, M9), never to the raw string.
 */
export function parseDockDrop(body: unknown, options: DockDropOptions): ParsedDockDrop {
  const allowed = allowlist(options);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_drop" };
  const { hub, agent, ticket } = body as { hub?: unknown; agent?: unknown; ticket?: unknown };
  if (typeof hub !== "string") return { ok: false, error: "hub_not_allowed" };
  const url = bareOrigin(hub);
  if (!url) return { ok: false, error: "hub_not_allowed" };
  const local = (options.localDevHubs ?? []).some((entry) => new URL(entry).origin === url.origin);
  if (url.protocol !== "https:" && !local) return { ok: false, error: "hub_not_allowed" };
  if (!allowed.has(url.origin)) return { ok: false, error: "hub_not_allowed" };
  if (typeof agent !== "string" || !AGENT_HANDLE_RE.test(agent)) return { ok: false, error: "invalid_drop" };
  if (typeof ticket !== "string" || !DRAG_TICKET_RE.test(ticket)) return { ok: false, error: "invalid_drop" };
  return { ok: true, hub: url.origin, agent, ticket };
}

// #endregion

// #region M7: the give-back

/** The most of a give-back's body the app reads: `{ "mcp_url": "…" }` is far smaller. */
export const DOCK_GIVE_BACK_MAX_BYTES = 4096;
/** The longest the app waits for a give-back's body: a body that trickles past it is dropped (the same 200). */
export const DOCK_GIVE_BACK_BODY_DEADLINE_MS = 5000;

export interface DockGiveBackOptions {
  /** The app's own public origin: an `mcp_url` on any other origin is ignored. */
  origin: string;
  /**
   * Ends the grant whose secret hashes to `hash` (`secretHash`, the same SHA-256 hex the app stores), when it
   * is in any state but revoked or ended (in flight included): that grant then answers 404. On a revoked or
   * ended grant, or no grant, it does nothing (revoked stays revoked). It must do the check and the end in one
   * atomic step. `url` is the parsed MCP URL, for an app that routes by it (to a sandbox, a tenant): never log it.
   * The caller is unauthenticated, so routing by `url` **must only look up what exists and never create state**:
   * never instantiate a per-tenant store or sandbox for an unknown id, and answer an unknown tenant like an
   * unknown grant (return normally).
   *
   * It **MUST NOT throw for an unknown grant** (or a revoked or ended one): it returns normally, so the answer
   * stays the same 200. Only a genuine failure of the app's store may throw; that answers 500, which depends
   * on the store, never on the input.
   */
  endGrantBySecretHash: (hash: string, url: URL) => void | Promise<void>;
  /**
   * The grant secret in an MCP URL on the app's origin, or null. By default the URL's last path segment, when
   * it is 16 to 256 of letters, digits, `_` and `-`. It sees hostile input: it MUST NOT throw (return null). A
   * throw is still caught and answered with the same 200, so it cannot become an oracle.
   */
  secretOf?: (url: URL) => string | null;
  /** Milliseconds to wait for the body: `DOCK_GIVE_BACK_BODY_DEADLINE_MS` (5 s) by default, and when not a finite positive number of at most 2^31 - 1. */
  bodyDeadlineMs?: number;
}

const SECRET_SEGMENT = /^[A-Za-z0-9_-]{16,256}$/;

function defaultSecretOf(url: URL): string | null {
  const last = url.pathname.split("/").pop() ?? "";
  return SECRET_SEGMENT.test(last) ? last : null;
}

/** A request's body as text, at most `cap` bytes, or null past it, on a bad `content-length`, a stream error or bad UTF-8. */
async function requestText(request: Request, cap: number, deadlineMs: number): Promise<string | null> {
  if (badContentLength(request.headers, cap)) {
    void request.body?.cancel().catch(() => {});
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The give-back body took too long.")), deadlineMs);
  });
  expired.catch(() => {});
  try {
    const bytes = await readCapped(request.body, cap, expired);
    return bytes ? utf8(bytes) : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The give-back's body deadline: `ms` when it is a finite positive number of at most 2^31 - 1 (what a timer takes), else the default. */
function bodyDeadline(ms: number | undefined): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= 2 ** 31 - 1 ? ms : DOCK_GIVE_BACK_BODY_DEADLINE_MS;
}

/** What `/apc/revoke` answers, to any input (M7). */
function givenBack(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/**
 * `POST {app}/apc/revoke` (M7, APC 0.10): a dock's hub gives back a grant, by its MCP URL. Public, so it
 * answers the same HTTP 200 `{ ok: true }` to any input (a matching URL, an unknown one, junk, another
 * method), and tells no one whether a grant matched. The body is read up to `DOCK_GIVE_BACK_MAX_BYTES`, within
 * `DOCK_GIVE_BACK_BODY_DEADLINE_MS` (a body that trickles past either is dropped, with the same 200). A
 * `mcp_url` on the app's origin has its secret hashed (`secretHash`), and `endGrantBySecretHash` ends that
 * grant unless it is revoked or ended. The URL and the secret are never logged or echoed.
 *
 * Only a failure of the app's own store answers otherwise: HTTP 500 `{ ok: false }`, so the hub can try again
 * (a grant that was not ended is not reported as given back). That answer is input-independent: it holds only
 * because `endGrantBySecretHash` MUST NOT throw for an unknown, revoked or ended grant (it returns normally);
 * a store that threw on "no such grant" would turn the 500 into an oracle for which URLs are live.
 */
export async function handleDockGiveBack(request: Request, options: DockGiveBackOptions): Promise<Response> {
  // The app's own origin is configuration, not input: a bad one throws whatever the request, never per input.
  const own = bareOrigin(options.origin);
  if (!own) throw new TypeError(`handleDockGiveBack: origin must be a bare origin, not ${JSON.stringify(options.origin)}`);
  if (request.method !== "POST") return givenBack();
  const text = await requestText(request, DOCK_GIVE_BACK_MAX_BYTES, bodyDeadline(options.bodyDeadlineMs));
  if (text === null) return givenBack();
  let mcpUrl: unknown;
  try {
    const body = JSON.parse(text) as unknown;
    mcpUrl = body && typeof body === "object" && !Array.isArray(body) ? (body as { mcp_url?: unknown }).mcp_url : undefined;
  } catch {
    return givenBack();
  }
  if (typeof mcpUrl !== "string" || mcpUrl.length > 2048) return givenBack();
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return givenBack();
  }
  if (url.origin !== own.origin || url.username || url.password || url.search || url.hash) return givenBack();
  let secret: string | null;
  try {
    secret = (options.secretOf ?? defaultSecretOf)(url);
  } catch {
    return givenBack();
  }
  if (typeof secret !== "string" || !secret) return givenBack();
  try {
    await options.endGrantBySecretHash(await secretHash(secret), url);
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return givenBack();
}

// #endregion

// #region the state table

/** What an app's MCP handler is told to do with one message on a dock grant (`dockGrantGate`). */
export type DockGrantGate =
  /** Serve it as 0.8 does. `commits`: an `initialize` in handoff; answer it only once the move to live committed (and the grant was neither revoked nor ended in that same step), else -32603 or HTTP 500. */
  | { serve: true; commits: boolean; answer: DockGrantAnswerKind }
  /** Answer with `response`, as built: no app data, no `attention`, `then`, `apc_link` or presence event. */
  | { serve: false; answer: DockGrantAnswerKind; response: Response };

export interface DockGrantGateOptions {
  /** The app's own host, as the person knows it: for the revoked answer. */
  host: string;
  /** When the grant was revoked (ISO 8601): for the revoked answer; now if absent. */
  revokedAt?: string | null;
  /** What a grant in handoff tells the agent; `PAIRING_MESSAGE` by default. */
  pairingMessage?: string;
  /** What a dormant grant tells the agent; `IDLE_MESSAGE` by default. */
  idleMessage?: string;
  /**
   * The grant's binding (M10, APC 0.12): what the app stored when the hub acknowledged it. With it, every
   * `initialize` in the request (a batch, one without an `id`) is checked (M11, `bindingVerdict`), and one that
   * does not hold it gets HTTP 404 `{ error: "pairing_mismatch" }` in handoff, live or dormant, the state
   * unchanged. Leave it out only for an app before 0.12.
   */
  binding?: DockBinding;
  /** The app allows more than one hub (M11, SHOULD): a missing `pairing_id` on a declared grant is a mismatch in every state. */
  multiHub?: boolean;
}

/** The 404 of M11 and M12 (APC 0.12): nothing about the grant or its binding, only the token. */
function pairingMismatch(): Response {
  return Response.json({ error: PAIRING_MISMATCH_ERROR }, { status: 404, headers: { "cache-control": "no-store" } });
}

/**
 * M12 (APC 0.12): on a grant that is **not** a Dock grant, a request carrying an `initialize` (in a batch, or
 * without an `id`) with either binding key, whatever its value, is a hub introducing itself to a grant that was
 * never handed to a dock: HTTP 404 `{ error: "pairing_mismatch" }`, before any other answer (revoked
 * included), and the grant is unchanged. Null when the request carries none: serve it as before. Whether the
 * grant is a Dock grant is the app's own record (M10), never this request.
 */
export function directGrantGate(body: unknown): Response | null {
  return rpcMessages(body).some((m) => isInitializeMessage(m) && hasBindingKey(m)) ? pairingMismatch() : null;
}

type RpcId = string | number | null;

/** The call a JSON-RPC message is, for the table, and its id. A batch or junk (no string `method`, unless a client's response) is an "other method" with id null: it never gets data. */
function callOf(message: unknown): { call: DockGrantCall; id: RpcId; tool?: string } {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { call: "other_method", id: null };
  const m = message as { id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (typeof m.method !== "string") {
    // No method: only a genuine client response (an id and a result or an error) passes as a notification; anything else is junk.
    const response = m.id !== undefined && ("result" in m || "error" in m);
    return { call: response ? "notification" : "other_method", id: null };
  }
  // No id: a notifications/* method is a notification; any other method (tools/call, initialize, resources/*,
  // prompts/*) is a request sent without an id, not a notification, so it is "another method" and a grant that
  // is not live never serves it (a dispatcher that routes on the method alone would otherwise run a tool).
  if (m.id === undefined) return { call: m.method.startsWith("notifications/") ? "notification" : "other_method", id: null };
  const tool = m.method === "tools/call" && m.params && typeof m.params === "object" ? (m.params as { name?: unknown }).name : undefined;
  return { call: dockGrantCallOf({ method: m.method, id, params: m.params }), id, ...(typeof tool === "string" ? { tool } : {}) };
}

const noStore = { "cache-control": "no-store" };

function rpcResult(id: RpcId, result: ToolResult): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: noStore });
}

function errorMessage(error: DockGrantError, options: { pairingMessage?: string; idleMessage?: string }): string {
  return error === "pairing" ? (options.pairingMessage ?? PAIRING_MESSAGE) : (options.idleMessage ?? IDLE_MESSAGE);
}

/**
 * A dock grant's answer to a `tools/call` of `tool`, for an app that gates inside its tool handlers (APC
 * 0.10): the `pairing` or `idle` tool error (`toolError`: `{ error, message }` in `structuredContent` and the
 * text, `isError: true`), a core tool's idle shape, or null when the call is served. In flight, ended and
 * revoked are not tool answers (404 and `RevokedAnswer` are HTTP answers): it throws on them, so the gate
 * must run before the transport (`dockGrantGate`).
 *
 * **Return a non-null answer as is, before any wrapper code**: no activity stamp, no grant extension, no
 * presence or broadcast, no `attention`, `then` or `apc_link` (design § 1: agent traffic never wakes or
 * extends a grant, and no answer in handoff or dormant carries those). The `attach*` helpers do not check for
 * it: the app gates first and returns the answer without passing it through its wrapper. Prefer
 * `dockGrantGate`, which answers before the app's code runs.
 */
export function dockGrantToolResult(state: DockGrantState, tool: string, options: { pairingMessage?: string; idleMessage?: string } = {}): ToolResult | null {
  const answer = dockGrantAnswer(state, dockGrantCallOf({ method: "tools/call", id: 0, params: { name: tool } }));
  if (answer.kind === "serve") return null;
  if (answer.kind === "tool_error") return toolError(answer.error, errorMessage(answer.error, options));
  if (answer.kind === "idle_shape") {
    const note = options.idleMessage ?? IDLE_MESSAGE;
    return toolResult({ ...(tool === "wait_for_focus" ? idleWaitForFocus(note) : idleCurrentView(note)) });
  }
  throw new Error(`dockGrantToolResult: a ${state} grant answers before the transport (dockGrantGate)`);
}

/**
 * Gates one MCP message (the parsed JSON-RPC body of a POST) on a dock grant by its state (APC 0.10,
 * `dockGrantAnswer` in @tineira/apc-protocol), before the app's MCP transport sees it:
 *
 * - **serve**: `{ serve: true }`; hand the message to the transport. On `commits` (an `initialize` in
 *   handoff) commit the move to live first, atomically and only if the grant is neither revoked nor ended;
 *   if that fails, answer -32603 or HTTP 500, never a result.
 * - **otherwise** `{ serve: false, response }`, the exact answer: HTTP 404 (in flight, ended; the state is
 *   unchanged), the 403 `RevokedAnswer` (revoked), HTTP 202 (a notification in handoff), a JSON-RPC result
 *   carrying the `pairing` or `idle` tool error or a core tool's idle shape, or JSON-RPC error -32000 with
 *   `data: { error, message }`.
 *
 * A request that is not a POST with one JSON-RPC message (a GET for a stream, a batch, junk) is gated as
 * "another method", so it never gets data from a grant that is not live. Nothing it answers wakes the grant.
 *
 * With `options.binding` (APC 0.12, M11), an `initialize` anywhere in the request that does not hold the grant's
 * binding answers HTTP 404 `{ error: "pairing_mismatch" }` in handoff, live or dormant, the state unchanged.
 */
export function dockGrantGate(state: DockGrantState, message: unknown, options: DockGrantGateOptions): DockGrantGate {
  // M11 (APC 0.12): every initialize in the request holds the grant's binding, or the request is a 404 wherever an
  // initialize would be served (revoked, ended and in flight answer first, below).
  if (options.binding && (state === "handoff" || state === "live" || state === "dormant")) {
    const binding = options.binding;
    const mismatch = rpcMessages(message).some((m) => isInitializeMessage(m) && bindingVerdict(m, binding, state, { multiHub: options.multiHub }) === "mismatch");
    if (mismatch) return { serve: false, answer: dockGrantAnswer(state, "initialize", { binding: "mismatch" }), response: pairingMismatch() };
  }
  const { call, id, tool } = callOf(message);
  const answer = dockGrantAnswer(state, call);
  switch (answer.kind) {
    case "serve":
      return { serve: true, commits: answer.commits, answer };
    case "not_found":
      return { serve: false, answer, response: Response.json({ error: "not_found" }, { status: 404, headers: noStore }) };
    case "revoked":
      return { serve: false, answer, response: revokedResponse(options.host, options.revokedAt ?? new Date().toISOString()) };
    case "ignored":
      return { serve: false, answer, response: new Response(null, { status: 202, headers: noStore }) };
    case "tool_error":
      return { serve: false, answer, response: rpcResult(id, toolError(answer.error, errorMessage(answer.error, options))) };
    case "idle_shape": {
      const note = options.idleMessage ?? IDLE_MESSAGE;
      return { serve: false, answer, response: rpcResult(id, toolResult({ ...(tool === "wait_for_focus" ? idleWaitForFocus(note) : idleCurrentView(note)) })) };
    }
    case "rpc_error": {
      const data = { error: answer.error, message: errorMessage(answer.error, options) };
      return { serve: false, answer, response: Response.json({ jsonrpc: "2.0", id, error: { code: DOCK_GRANT_RPC_ERROR_CODE, message: data.message, data } }, { headers: noStore }) };
    }
  }
}

// #endregion
