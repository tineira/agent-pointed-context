/**
 * Distinct MCP agent sessions, counted in Workers Analytics Engine (TIN-347).
 * The server is stateless, so a session is one grant of one sandbox: the key is
 * HMAC(salt, sid:grant_id), and reconnects keep it. Only a successful
 * initialize is written; nothing secret leaves the sandbox (the client IP only
 * as an HMAC under the same salt). scripts/mcp-sessions.mjs reads it back.
 */

export interface SessionEvent {
  sid: string;
  grantId: string;
  label: string;
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  userAgent: string;
  ip: string | null;
  /** Where the agent connected, when not to Pulse v1: "dock" for an APC v2 dock's hub (TIN-416). */
  source?: string;
}

/** The shape of Analytics Engine's AnalyticsEngineDataPoint, kept local so tests run under plain Node. */
export interface DataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

export async function hmacHex(salt: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One data point per initialize. index1 is the session key, so sampling keeps or drops a session whole.
 * blob1 outcome, blob2 client name, blob3 client version, blob4 protocol version, blob5 grant label,
 * blob6 IP hash, blob7 user agent, blob8 the source (absent on Pulse v1's points); double1 is 1.
 */
export async function sessionPoint(salt: string, e: SessionEvent): Promise<DataPoint> {
  return {
    indexes: [await hmacHex(salt, `${e.sid}:${e.grantId}`)],
    blobs: [
      "connected",
      e.clientName ?? "",
      e.clientVersion ?? "",
      e.protocolVersion ?? "",
      e.label.slice(0, 100),
      e.ip ? await hmacHex(salt, `ip:${e.ip}`) : "",
      e.userAgent,
      ...(e.source ? [e.source] : []),
    ],
    doubles: [1],
  };
}
