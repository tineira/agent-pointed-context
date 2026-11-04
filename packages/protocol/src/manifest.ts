/**
 * `apc.json` (APC 0.5): what an origin says about itself. Every APC app, and every hub, serves it at
 * `GET {origin}/.well-known/apc.json` (`APC_JSON_PATH`), from its own origin:
 *
 * ```json
 * { "name": "Signals", "standard": "0.5.0", "origin": "https://signals.example",
 *   "profiles": ["direct", "dock"], "mcp": { "path": "/mcp/" },
 *   "direct": { "connect": "https://signals.example/?connect" } }
 * ```
 *
 * - **`name`**: what the app (or hub) calls itself.
 * - **`standard`**: the version of the APC standard it implements (`APC_STANDARD_VERSION`).
 * - **`origin`**: the origin it is served from, exactly. A file that names another origin is refused.
 * - **`profiles`**: how agents reach it. An app lists `"direct"`, `"dock"` or both; a hub lists
 *   `"hub"` alone, so apps and tools can tell a dock from an app. Words a reader does not know are ignored.
 * - **`mcp.path`**: where its MCP URLs live. Every grant's MCP URL on this origin starts with
 *   `origin + mcp.path`. A hub pairs only an MCP URL under it, so a path the domain did not declare in
 *   its own `/.well-known/` (another tenant's, on a shared host) is never paired.
 * - **`direct.connect`** (with `"direct"`): the page, on the same origin, where the person connects an
 *   agent directly: what a person is shown when they drop a dock agent on a Direct-only app.
 * - **`dock`** (a hub): where it takes pairings, `pair` and `confirm`, as absolute URLs on its origin.
 *
 * A hub reads an app's `apc.json` when the app asks to pair (`POST {hub}/apc/pair`) and refuses the
 * pairing when it is missing (`apc_json_missing`), cannot be read as one (`apc_json_invalid`), names
 * another origin (`apc_json_wrong_origin`), does not list the Dock profile (`dock_not_offered`), or
 * does not cover the MCP URL the app sent (`mcp_url_not_declared`); see `ApcJsonRefusal`.
 */
import type { ApcProfile } from "./core.ts";

/** Where an origin serves its `apc.json`. */
export const APC_JSON_PATH = "/.well-known/apc.json";
/** The most bytes a reader takes of an `apc.json`. */
export const APC_JSON_MAX_BYTES = 16_384;

/** A word of `profiles`: an app's profiles, or `"hub"` for a dock's hub. */
export type ApcRole = ApcProfile | "hub";
export const APC_ROLES: readonly ApcRole[] = ["direct", "dock", "hub"];

export interface ApcManifest {
  name: string;
  /** The version of the APC standard it implements, e.g. "0.5.0". */
  standard: string;
  /** The origin it is served from. */
  origin: string;
  /** "direct", "dock" or both for an app; "hub" alone for a hub. */
  profiles: ApcRole[];
  /** Every grant's MCP URL on this origin starts with origin + path. */
  mcp: { path: string };
  /** With "direct": where the person connects an agent directly, on the same origin. */
  direct?: { connect: string };
  /** A hub's pairing endpoints, on its origin. */
  dock?: { pair: string; confirm: string };
}

/** Why a hub refuses a pairing over the app's `apc.json` (APC 0.5). */
export type ApcJsonRefusal = "apc_json_missing" | "apc_json_unreachable" | "apc_json_invalid" | "apc_json_wrong_origin" | "dock_not_offered" | "mcp_url_not_declared";

const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
const PATH_RE = /^\/([A-Za-z0-9._~!$&'()*+,;=:@-]+\/)*$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An absolute http(s) URL on `origin`, or null. */
function onOrigin(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Compares two versions of the standard: negative, zero or positive. */
export function compareStandard(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * An `apc.json` as read from `origin`, checked: the manifest, or why it is not one. `wrong_origin` when
 * it names another origin than the one it was read from; `invalid` for anything else that is wrong
 * (a missing or malformed field, no profile this reader knows, a hub listing an app's profile too, a
 * Direct app with no connect page, a URL off its origin).
 */
export function parseApcManifest(raw: unknown, origin: string): { ok: true; manifest: ApcManifest } | { ok: false; error: "apc_json_invalid" | "apc_json_wrong_origin"; detail: string } {
  const bad = (detail: string) => ({ ok: false as const, error: "apc_json_invalid" as const, detail });
  if (!isObject(raw)) return bad("not a JSON object");
  const name = typeof raw.name === "string" ? raw.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
  if (!name || name.length > 60) return bad("name is not a short string");
  if (typeof raw.standard !== "string" || !VERSION_RE.test(raw.standard)) return bad("standard is not a version like 0.5.0");
  if (typeof raw.origin !== "string") return bad("origin is missing");
  let declared: string;
  try {
    declared = new URL(raw.origin).origin;
  } catch {
    return bad("origin is not an origin");
  }
  if (declared !== raw.origin) return bad("origin is not an origin (scheme, host and port, no path or trailing slash)");
  if (declared !== origin) return { ok: false, error: "apc_json_wrong_origin", detail: `it names ${declared}, it was read from ${origin}` };
  if (!Array.isArray(raw.profiles) || raw.profiles.length > 8) return bad("profiles is not a short list");
  const profiles = APC_ROLES.filter((r) => (raw.profiles as unknown[]).includes(r));
  if (!profiles.length) return bad("profiles lists none of direct, dock, hub");
  if (profiles.includes("hub") && profiles.length > 1) return bad("a hub lists only hub");
  const mcp = raw.mcp;
  if (!isObject(mcp) || typeof mcp.path !== "string" || mcp.path.length > 200 || !PATH_RE.test(mcp.path) || mcp.path.split("/").some((s) => s === "." || s === "..")) return bad("mcp.path is not a path that starts and ends with /");
  const manifest: ApcManifest = { name, standard: raw.standard, origin, profiles, mcp: { path: mcp.path } };
  if (profiles.includes("direct")) {
    const connect = isObject(raw.direct) ? onOrigin(raw.direct.connect, origin) : null;
    if (!connect) return bad("direct.connect is not a URL on its origin");
    manifest.direct = { connect };
  }
  if (profiles.includes("hub")) {
    const dock = isObject(raw.dock) ? raw.dock : {};
    const pair = onOrigin(dock.pair, origin);
    const confirm = onOrigin(dock.confirm, origin);
    if (!pair || !confirm) return bad("dock.pair and dock.confirm are not URLs on its origin");
    manifest.dock = { pair, confirm };
  }
  return { ok: true, manifest };
}

/** Whether an MCP URL lies under what the manifest declares: its origin and `mcp.path`. */
export function declaresMcpUrl(manifest: ApcManifest, mcpUrl: string): boolean {
  try {
    const url = new URL(mcpUrl);
    return url.origin === manifest.origin && !url.username && !url.password && url.pathname.startsWith(manifest.mcp.path) && url.pathname.length > manifest.mcp.path.length;
  } catch {
    return false;
  }
}

/**
 * What an app tells a person who drops an agent from their dock on it when it connects agents only
 * directly (its `apc.json` lists no `"dock"`): the drop is answered, never lost. These are the app's
 * own words, on its own page (`@apc/web`); the browser extension, which speaks for itself, puts the
 * domain first and the name only as what the page says it is.
 */
export function directOnlyNote(name: string): string {
  return `${name} connects agents directly, not through a dock. Connect your agent to ${name} on its own URL, then drag its mark from the agent bar there.`;
}
