import { REVOKED_HTTP_STATUS, REVOKED_HTTP_STATUS_BEARER, revokedAnswer } from "@tineira/apc-protocol";
import type { ToolResult } from "./envelope.ts";

/**
 * Revoke from the app (APC 0.2, `RevokedAnswer` in @tineira/apc-protocol): what a revoked grant's MCP URL
 * answers to every request, whatever the method. `host` is the app's own host, as the person knows it.
 *
 * The status is the binding's (APC 0.8): 403 with a secret URL (the default), and with a bearer token
 * (`{ bearer: true }`) 401 with `WWW-Authenticate: Bearer error="invalid_token"`, so an OAuth client tells
 * "taken back by the person" (this body) from an expired token and does not just authorize again.
 */
export function revokedResponse(host: string, revokedAt: string, options: { bearer?: boolean } = {}): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (options.bearer) headers["www-authenticate"] = BEARER_INVALID_TOKEN;
  return Response.json(revokedAnswer(host, revokedAt), { status: options.bearer ? REVOKED_HTTP_STATUS_BEARER : REVOKED_HTTP_STATUS, headers });
}

/** The challenge of a bearer token the app does not take (RFC 6750): on a revoked grant's 401, and on a plain 401 for an unknown token. */
export const BEARER_INVALID_TOKEN = 'Bearer error="invalid_token"';

/**
 * A bearer token the app does not know, or none (APC 0.8): a plain 401 with no `RevokedAnswer`, so the holder
 * tells "gone" from "taken back". The bearer binding's counterpart of a secret URL's 404. A request that carried
 * no token at all (`{ missing: true }`) gets the bare `Bearer` challenge, with no error code (RFC 6750, 3.1).
 */
export function unknownBearerResponse(options: { missing?: boolean } = {}): Response {
  const body = options.missing ? { error: "unauthorized" } : { error: "invalid_token" };
  return Response.json(body, { status: REVOKED_HTTP_STATUS_BEARER, headers: { "cache-control": "no-store", "www-authenticate": options.missing ? "Bearer" : BEARER_INVALID_TOKEN } });
}

/** What a call that was already running when its grant was revoked returns: the same answer, as a tool error, with no app data. */
export function revokedToolResult(host: string, revokedAt: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(revokedAnswer(host, revokedAt)) }], isError: true };
}

/** A revoked grant's secret is kept only as this hash: enough to answer "revoked" to its URL, never to read with it. */
export async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
