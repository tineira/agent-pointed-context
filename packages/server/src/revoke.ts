import { REVOKED_HTTP_STATUS, revokedAnswer } from "@apc/protocol";
import type { ToolResult } from "./envelope.ts";

/**
 * Revoke from the app (APC 0.2, `RevokedAnswer` in @apc/protocol): what a revoked grant's MCP URL
 * answers to every request, whatever the method. `host` is the app's own host, as the person knows it.
 */
export function revokedResponse(host: string, revokedAt: string): Response {
  return Response.json(revokedAnswer(host, revokedAt), { status: REVOKED_HTTP_STATUS, headers: { "cache-control": "no-store" } });
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
