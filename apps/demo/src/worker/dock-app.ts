/**
 * What Pulse and Signals share as apps on the Dock profile (APC 0.10, TIN-892): where their pairing
 * configuration comes from, the rule on the owner's endpoints (M6), and the times a dock grant may wait.
 * The grant's own lifecycle lives with each app's storage (sandbox.ts, Signals' feed.ts).
 */
import { T_ACK_MAX_MS, T_CONNECT_MAX_MS, type ApcProfile } from "@tineira/apc-protocol";
import type { DockDropOptions, HubCallOptions } from "@tineira/apc-server";

/** What both apps read their Dock configuration from (wrangler.jsonc `vars`). */
export interface DockAppEnv {
  /** The app's public origin, as the person's browser names it: "https://pulse.apc.tineira.com". Never derived from a request. */
  PUBLIC_ORIGIN?: string;
  /** Comma-separated origins of the docks (hubs) the app pairs with: its constant allowlist (M1). */
  HUB_ORIGINS?: string;
}

/** The docks a local `pnpm dev` may pair with, besides HUB_ORIGINS: the dock's own dev server (apps/dock/vite.config.ts, port 5200). */
export const LOCAL_DEV_HUBS: readonly string[] = ["http://localhost:5200", "http://127.0.0.1:5200"];

const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])$/;
const dev = () => !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

/** A string that is exactly one http(s) origin, as `URL.origin` writes it; null otherwise. */
function originOf(raw: string, schemes: readonly string[]): string | null {
  try {
    const url = new URL(raw);
    return schemes.includes(url.protocol) && raw === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The hub allowlist for `parseDockDrop` (M1): the bare https origins in HUB_ORIGINS, and under `vite dev`
 * only, the dock's dev server. An entry that is not a bare https origin is left out (it allows nothing),
 * so a typo never lets a hub through and never fails every drop.
 */
export function hubAllowlist(env: DockAppEnv): DockDropOptions & { hubs: string[] } {
  const hubs = (env.HUB_ORIGINS ?? "")
    .split(",")
    .map((h) => originOf(h.trim(), ["https:"]))
    .filter((h): h is string => h !== null);
  return { hubs: [...new Set(hubs)], localDevHubs: dev() ? LOCAL_DEV_HUBS : [] };
}

/**
 * The options of every call to a hub (`pairWithHub`, `confirmWithHub`), in one place for both apps. The hub client
 * takes an https origin; when it also takes local-dev origins as an option, they are named here, from the same
 * list the allowlist uses (`hubAllowlist(env).localDevHubs`).
 */
export function hubCallOptions(_env: DockAppEnv): HubCallOptions {
  return {};
}

/**
 * The app's public origin (M6): PUBLIC_ORIGIN as configured, an http(s) origin written as itself. Under
 * `vite dev` only, a request that reached the dev server on a loopback host names its own origin (the
 * deploy's PUBLIC_ORIGIN is in wrangler.jsonc there too, and is not where the page is). Null: not configured.
 */
export function publicOrigin(env: DockAppEnv, requestUrl?: string): string | null {
  if (dev() && requestUrl) {
    try {
      const url = new URL(requestUrl);
      if (LOOPBACK.test(url.hostname)) return url.origin;
    } catch {
      // not a URL: fall through to the configured origin
    }
  }
  return originOf((env.PUBLIC_ORIGIN ?? "").trim(), ["https:", "http:"]);
}

/** Whether the app can pair with a dock right now (M8): its public origin and at least one hub are configured. */
export function pairingConfigured(env: DockAppEnv): boolean {
  return publicOrigin(env) !== null && (hubAllowlist(env).hubs.length > 0 || dev());
}

/** `profiles` without Dock unless the app can pair right now (M8): what its apc.json and its page list. */
export function pairableProfiles(profiles: readonly ApcProfile[], env: DockAppEnv): ApcProfile[] {
  return profiles.filter((p) => p !== "dock" || pairingConfigured(env));
}

/** Why an owner request is refused (M6). */
export type OwnerRequestRefusal = "origin_not_allowed" | "cross_site_request" | "json_required";

/**
 * The rule on the owner's endpoints (M6, APC 0.10), for every state-changing POST and the WebSocket
 * handshake, on top of the session cookie:
 *
 * - a request that carries `Origin` is refused unless it equals the app's configured public origin
 *   (`origin`; null when none is configured, which refuses every request with an `Origin`);
 * - `Sec-Fetch-Site` of `cross-site` or `same-site` is refused;
 * - a POST must have the media type `application/json`;
 * - a request with neither header is a non-browser client (Pulse for Windows' HttpClient) and is taken on
 *   its session alone: a browser always sends `Origin` on a cross-origin POST and on a WebSocket handshake.
 */
export function ownerRequestRefusal(request: Request, origin: string | null): OwnerRequestRefusal | null {
  const sent = request.headers.get("origin");
  if (sent !== null && (origin === null || sent !== origin)) return "origin_not_allowed";
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return "cross_site_request";
  if (request.method === "POST") {
    const media = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return "json_required";
  }
  return null;
}

/** Whether M6 applies to this request: a state change (POST) under /api, or the page's WebSocket handshake. */
export function isOwnerStateRequest(request: Request): boolean {
  if (request.method === "POST") return true;
  return request.method === "GET" && new URL(request.url).pathname.endsWith("/ws");
}

/** What a dock's give-back answers when the app cannot route it (pairing not configured, a URL of another shape): the same 200 as every other (M7). */
export function givenBack(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/** A dock grant's stored state: revoked is the app's revoked list, ended is the row gone. */
export type DockStored = "in_flight" | "handoff" | "live";

/** How long a grant may stay in flight after the Allow (T_ack), and in handoff after the acknowledgement (T_connect): the standard's most. */
export const DOCK_TIMES = { ackMs: T_ACK_MAX_MS, connectMs: T_CONNECT_MAX_MS };

/**
 * A dock grant's state now, from its stored state and its two times (ms since the epoch): in flight past
 * T_ack, or in handoff past T_connect, it has ended, whether or not the sweep deleted it yet. A row from
 * before APC 0.10 has no state: it was read by its hub already, so it is live.
 */
export function dockStateNow(row: { state: string | null; allowed_at: number | null; acked_at: number | null }, now: number): DockStored | "ended" {
  if (row.state === "in_flight") return now - (row.allowed_at ?? 0) >= DOCK_TIMES.ackMs ? "ended" : "in_flight";
  if (row.state === "handoff") return now - (row.acked_at ?? 0) >= DOCK_TIMES.connectMs ? "ended" : "handoff";
  return "live";
}

/** The most of an MCP request's body an app reads before it knows who is asking: 1 MiB, far above any real MCP message of these apps. */
export const MCP_BODY_MAX_BYTES = 1_048_576;

/**
 * An MCP POST's body, read once and bounded (APC 0.10 keeps the parse before the grant's lookup, so nothing is
 * awaited between the lookup and the gate; this bounds what a caller with no grant can make the app read). A
 * `content-length` that is not digits, or is over `cap`, is refused before a byte is read; the stream is cut at
 * `cap`. Null: too large (HTTP 413). Otherwise the parsed JSON (null when it is not JSON) and the same request
 * with its body again, for the MCP transport.
 */
export async function readMcpBody(request: Request, cap = MCP_BODY_MAX_BYTES): Promise<{ json: unknown; request: Request } | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap)) {
    void request.body?.cancel().catch(() => {});
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // not JSON: the transport answers the error
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return { json, request: new Request(request.url, { method: request.method, headers, body: bytes, signal: request.signal }) };
}

/** What an MCP URL answers to a body over the cap, whoever holds it. */
export function bodyTooLarge(): Response {
  return Response.json({ error: "body_too_large" }, { status: 413, headers: { "cache-control": "no-store" } });
}
