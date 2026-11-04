/**
 * The hub as an MCP client of a paired app (TIN-382): one JSON-RPC request per call over Streamable
 * HTTP, no session (APC apps are stateless). The app's grant is the secret in its MCP URL, kept by
 * the hub only.
 */
import { APC_AGENT_CLIENT_META, APC_JSON_MAX_BYTES, APC_JSON_PATH } from "@apc/protocol";
import { LIMITS } from "./trust.ts";

export interface AppToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface AppTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

const PROTOCOL = "2025-06-18";

/**
 * How the hub talks to one app (TIN-580): a verified app (APP_ORIGINS) or not. Every answer is read up
 * to a byte cap, every call has a time limit that covers the body too, and an unverified app's
 * redirects are not followed. The default is the strict one, unverified.
 */
export interface AppTransport {
  verified: boolean;
}
const STRICT: AppTransport = { verified: false };
const maxBytes = (t: AppTransport) => (t.verified ? LIMITS.verifiedBytes : LIMITS.unverifiedBytes);

export class AppCallError extends Error {
  /** The app's HTTP status, when it answered with an error. */
  readonly status: number | undefined;
  /** The `error` of the app's JSON body, when it gave one: "revoked" when the person revoked the grant in the app (APC 0.2). */
  readonly code: string | undefined;
  /**
   * What went wrong in the hub's own words only, never the app's (TIN-580): the message may carry the
   * app's JSON-RPC error text or error code; this never does. What an unverified app's failure tells the agent.
   */
  readonly reason: string;
  constructor(message: string, status?: number, code?: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason ?? message;
  }
}

/** The hub's own words for a failed call: an AppCallError's reason, or "unreachable" for anything else (a network error's text is not the app's, but says nothing useful either). */
export function failureReason(error: unknown): string {
  return error instanceof AppCallError ? error.reason : "unreachable";
}

/** Rejects when the signal aborts: a call ends at its time limit even if the app never answers or never ends its body. */
function deadline(signal: AbortSignal, what: string, ms: number): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    const fail = () => reject(new AppCallError(`${what}: no answer within ${ms} ms`, undefined, "timeout"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  p.catch(() => {});
  return p;
}

/** The body as text, at most `cap` bytes, before the deadline; past either, the body is cancelled and the call fails. */
async function readCapped(response: Response, cap: number, ends: Promise<never>, what: string): Promise<string> {
  const tooLarge = () => new AppCallError(`${what}: answer over ${cap} bytes`, undefined, "too_large");
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), ends]);
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The `error` field of an error response's JSON body, if any, read up to a few KB. */
async function errorCode(response: Response, ends: Promise<never>): Promise<string | undefined> {
  try {
    const body = JSON.parse(await readCapped(response, LIMITS.errorBytes, ends, "error")) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

async function rpc(mcpUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, transport: AppTransport): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const ends = deadline(signal, method, timeoutMs);
  const response = await Promise.race([
    fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, "user-agent": "apc-hub/0.1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
      // An unverified app's redirect would send the hub's request, and its grant, where the app chose.
      ...(transport.verified ? {} : { redirect: "manual" as const }),
    }),
    ends,
  ]);
  if (!response.ok) {
    const code = await errorCode(response, ends);
    // The reason leaves out the app's code: it is the app's text.
    throw new AppCallError(`${method}: HTTP ${response.status}${code ? ` ${code}` : ""}`, response.status, code, `${method}: HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") ?? "";
  const text = await readCapped(response, maxBytes(transport), ends, method);
  type Reply = { result?: unknown; error?: { message?: string } } | null;
  let message: Reply = null;
  if (type.includes("text/event-stream")) {
    // The last data line that carries a response.
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5)) as Reply;
        if (parsed && ("result" in parsed || "error" in parsed)) message = parsed;
      } catch {
        // skip
      }
    }
  } else {
    try {
      message = JSON.parse(text) as Reply;
    } catch {
      throw new AppCallError(`${method}: not JSON`);
    }
  }
  if (!message || typeof message !== "object") throw new AppCallError(`${method}: no response`);
  if (message.error) throw new AppCallError(`${method}: ${String(message.error.message ?? "error").slice(0, 200)}`, undefined, undefined, `${method}: the app answered with an error`);
  return message.result;
}

/**
 * Introduce the hub to the app with the agent's mark (TIN-388): the app shows the agent as
 * "<name> via dock" with its icon, a small PNG, in clientInfo.icons as MCP defines it. With the
 * agent's own MCP client in `_meta` (APC 0.4, `APC_AGENT_CLIENT_META`), so an app the agent also
 * reaches directly can offer to show it as one agent (apc_link). The hub names it to verified apps only.
 */
export async function initializeApp(mcpUrl: string, title: string, icon: string | null, transport: AppTransport = STRICT, agentClient: string | null = null): Promise<void> {
  const icons = icon ? [{ src: icon, mimeType: "image/png", sizes: ["64x64"] }] : undefined;
  await rpc(
    mcpUrl,
    "initialize",
    {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "apc-hub", title, version: "0.1.0", ...(icons ? { icons } : {}) },
      ...(agentClient ? { _meta: { [APC_AGENT_CLIENT_META]: agentClient } } : {}),
    },
    LIMITS.initializeMs,
    transport,
  );
}

/**
 * Give a grant back (TIN-388): whoever holds a grant may return it, and the app deletes it, its pins
 * and its dock link. The MCP URL is the proof. An app that does not know the endpoint answers 404.
 */
export async function revokeGrant(mcpUrl: string, transport: AppTransport = STRICT): Promise<boolean> {
  try {
    const response = await fetch(`${new URL(mcpUrl).origin}/apc/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_url: mcpUrl }),
      signal: AbortSignal.timeout(LIMITS.revokeMs),
      ...(transport.verified ? {} : { redirect: "manual" as const }),
    });
    // Only the status counts; the body is never read.
    response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** An app's apc.json as the hub read it: the parsed JSON, or why there is none, in the hub's own words. */
export type ApcJsonRead = { ok: true; body: unknown } | { ok: false; error: "apc_json_missing" | "apc_json_unreachable" | "apc_json_invalid"; reason: string };

/**
 * Read `GET {origin}/.well-known/apc.json` (APC 0.5) under the transport rules of every other call
 * (TIN-580): a time limit that covers the body, a byte cap (APC_JSON_MAX_BYTES), and no redirect
 * followed for an unverified app (a redirect counts as no file). An answer that says there is none (a
 * 4xx, a redirect) is `missing`; no answer, a time limit or a 5xx is `unreachable`; too large or not
 * JSON is `invalid`.
 */
export async function readApcJson(origin: string, transport: AppTransport = STRICT): Promise<ApcJsonRead> {
  const signal = AbortSignal.timeout(LIMITS.apcJsonMs);
  const ends = deadline(signal, "apc.json", LIMITS.apcJsonMs);
  let response: Response;
  try {
    response = await Promise.race([
      fetch(`${origin}${APC_JSON_PATH}`, {
        headers: { accept: "application/json", "user-agent": "apc-hub/0.1" },
        signal,
        ...(transport.verified ? {} : { redirect: "manual" as const }),
      }),
      ends,
    ]);
  } catch (error) {
    return { ok: false, error: "apc_json_unreachable", reason: failureReason(error) };
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return { ok: false, error: response.status >= 500 ? "apc_json_unreachable" : "apc_json_missing", reason: `apc.json: HTTP ${response.status}` };
  }
  let text: string;
  try {
    text = await readCapped(response, APC_JSON_MAX_BYTES, ends, "apc.json");
  } catch (error) {
    const tooLarge = error instanceof AppCallError && error.code === "too_large";
    return { ok: false, error: tooLarge ? "apc_json_invalid" : "apc_json_unreachable", reason: failureReason(error) };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "apc_json_invalid", reason: "apc.json: not JSON" };
  }
}

export async function listAppTools(mcpUrl: string, transport: AppTransport = STRICT): Promise<AppTool[]> {
  const result = (await rpc(mcpUrl, "tools/list", {}, LIMITS.listMs, transport)) as { tools?: AppTool[] } | null;
  return Array.isArray(result?.tools) ? result.tools.slice(0, 64) : [];
}

export async function callAppTool(mcpUrl: string, name: string, args: Record<string, unknown>, timeoutMs = LIMITS.callMs, transport: AppTransport = STRICT): Promise<AppToolResult> {
  const result = await rpc(mcpUrl, "tools/call", { name, arguments: args }, timeoutMs, transport);
  return (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as AppToolResult;
}

/** A result's structured content, or the JSON of its first text block. */
export function structured(result: AppToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) return result.structuredContent;
  const text = result.content?.[0]?.text;
  try {
    const parsed = typeof text === "string" ? (JSON.parse(text) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
