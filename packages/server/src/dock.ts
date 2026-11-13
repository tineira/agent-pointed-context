import {
  AGENT_HANDLE_RE,
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
import { badContentLength, bareOrigin, readCapped, utf8 } from "./util.ts";
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
   * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`): any other entry throws. Leave it empty in production.
   */
  localDevHubs?: readonly string[];
}

const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])$/;

function allowlist(options: DockDropOptions): Set<string> {
  const allowed = new Set<string>();
  for (const entry of options.hubs) {
    const url = bareOrigin(entry);
    if (!url || url.protocol !== "https:") throw new TypeError(`parseDockDrop: hubs must be bare https origins, not ${JSON.stringify(entry)}`);
    allowed.add(url.origin);
  }
  for (const entry of options.localDevHubs ?? []) {
    const url = bareOrigin(entry);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.test(url.hostname)) throw new TypeError(`parseDockDrop: localDevHubs must be loopback origins, not ${JSON.stringify(entry)}`);
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

export interface DockGiveBackOptions {
  /** The app's own public origin: an `mcp_url` on any other origin is ignored. */
  origin: string;
  /**
   * Ends the grant whose secret hashes to `hash` (`secretHash`, the same SHA-256 hex the app stores), when it
   * is in any state but revoked or ended (in flight included): that grant then answers 404. On a revoked or
   * ended grant, or no grant, it does nothing (revoked stays revoked). It must do the check and the end in one
   * atomic step. `url` is the parsed MCP URL, for an app that routes by it (to a sandbox, a tenant): never log it.
   *
   * It **MUST NOT throw for an unknown grant** (or a revoked or ended one): it returns normally, so the answer
   * stays the same 200. Only a genuine failure of the app's store may throw; that answers 500, which depends
   * on the store, never on the input.
   */
  endGrantBySecretHash: (hash: string, url: URL) => void | Promise<void>;
  /**
   * The grant secret in an MCP URL on the app's origin, or null. By default the URL's last path segment, when
   * it is 16 to 256 of letters, digits, `_` and `-`.
   */
  secretOf?: (url: URL) => string | null;
}

const SECRET_SEGMENT = /^[A-Za-z0-9_-]{16,256}$/;

function defaultSecretOf(url: URL): string | null {
  const last = url.pathname.split("/").pop() ?? "";
  return SECRET_SEGMENT.test(last) ? last : null;
}

/** A request's body as text, at most `cap` bytes, or null past it, on a bad `content-length`, a stream error or bad UTF-8. */
async function requestText(request: Request, cap: number): Promise<string | null> {
  if (badContentLength(request.headers, cap)) {
    void request.body?.cancel().catch(() => {});
    return null;
  }
  try {
    const bytes = await readCapped(request.body, cap);
    return bytes ? utf8(bytes) : null;
  } catch {
    return null;
  }
}

/** What `/apc/revoke` answers, to any input (M7). */
function givenBack(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/**
 * `POST {app}/apc/revoke` (M7, APC 0.10): a dock's hub gives back a grant, by its MCP URL. Public, so it
 * answers the same HTTP 200 `{ ok: true }` to any input (a matching URL, an unknown one, junk, another
 * method), and tells no one whether a grant matched. The body is read up to `DOCK_GIVE_BACK_MAX_BYTES`. A
 * `mcp_url` on the app's origin has its secret hashed (`secretHash`), and `endGrantBySecretHash` ends that
 * grant unless it is revoked or ended. The URL and the secret are never logged or echoed.
 *
 * Only a failure of the app's own store answers otherwise: HTTP 500 `{ ok: false }`, so the hub can try again
 * (a grant that was not ended is not reported as given back). That answer is input-independent: it holds only
 * because `endGrantBySecretHash` MUST NOT throw for an unknown, revoked or ended grant (it returns normally);
 * a store that threw on "no such grant" would turn the 500 into an oracle for which URLs are live.
 */
export async function handleDockGiveBack(request: Request, options: DockGiveBackOptions): Promise<Response> {
  if (request.method !== "POST") return givenBack();
  const text = await requestText(request, DOCK_GIVE_BACK_MAX_BYTES);
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
  if (url.origin !== new URL(options.origin).origin || url.username || url.password || url.search || url.hash) return givenBack();
  const secret = (options.secretOf ?? defaultSecretOf)(url);
  if (!secret) return givenBack();
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
  // No id, or any notifications/* method (even with an id), is a notification (dockGrantCallOf).
  if (m.id === undefined) return { call: dockGrantCallOf({ method: m.method, params: m.params }), id: null };
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
 */
export function dockGrantGate(state: DockGrantState, message: unknown, options: DockGrantGateOptions): DockGrantGate {
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
