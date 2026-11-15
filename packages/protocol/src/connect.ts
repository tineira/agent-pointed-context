/** Origin-bound first pairing (APC 0.13). A drop requests a connection; only owner approval mints a connect ticket. */
export const CONNECT_REQUEST_TTL_MS = 120_000;
export type ConnectError = "ticket_not_for_pairing" | "ticket_origin_mismatch" | "too_many_requests";
export type DockConnectRequest =
  | { ticket: string; agent: string; app: { origin: string }; reader?: never }
  | { ticket: string; agent: string; reader: true; label?: string; app?: never };
export type DockConnectAnswer =
  | { ok: true; status: "connect_requested"; claim?: never; check?: never }
  | { ok: true; status: "connect_requested"; claim: string; check: string }
  | { ok: false; error: string };
export interface ApcConnectFragment { v: 1; hub: string; agent: string; ticket: string }

function valid(value: unknown): value is ApcConnectFragment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Partial<ApcConnectFragment>;
  if (b.v !== 1 || typeof b.hub !== "string" || typeof b.agent !== "string" || !/^[\w.:-]{1,128}$/.test(b.agent) || typeof b.ticket !== "string" || !/^[0-9a-f]{32}\.[0-9a-f]{32}$/.test(b.ticket)) return false;
  try {
    const url = new URL(b.hub);
    return url.origin === b.hub && !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)));
  } catch { return false; }
}
/** A complete #apc_connect fragment; contains no query parameters. */
export function encodeApcConnect(value: ApcConnectFragment): string {
  if (!valid(value)) throw new Error("Invalid APC connect fragment");
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, hub: value.hub, agent: value.agent, ticket: value.ticket }));
  return "#apc_connect=" + btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeApcConnect(hash: string): ApcConnectFragment | null {
  if (typeof hash !== "string" || hash.length > 4096 || !/^#apc_connect=[A-Za-z0-9_-]+$/.test(hash)) return null;
  try {
    const base = hash.slice("#apc_connect=".length).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base), (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return valid(value) ? { v: 1, hub: value.hub, agent: value.agent, ticket: value.ticket } : null;
  } catch { return null; }
}
