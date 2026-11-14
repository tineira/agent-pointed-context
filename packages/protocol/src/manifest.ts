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
 *   its own `/.well-known/` (another tenant's, on a shared host) is never paired. Since APC 0.8 a Direct
 *   app whose grants share one MCP URL (a bearer token names the grant, as with OAuth) may serve it at
 *   `mcp.path` itself, or at `mcp.path` without its last `/` (`/api/mcp` for `"/api/mcp/"`); one origin
 *   may serve several such endpoints under the path, one per role (`declaresMcpUrl` with `shared`).
 * - **`mcp.endpoints`** (APC 0.11): the exact MCP endpoints of the origin, each with the profiles it
 *   serves: `[{ "path": "/mcp", "profiles": ["direct"] }, { "path": "/mcp/{secret}", "profiles": ["dock"] }]`.
 *   A path is exact; `{secret}` as its last segment stands for one grant's secret (`APC_SECRET_RE`). When
 *   the list is there, `mcp.path` covers nothing for a 0.11 reader: only the endpoints do, and anything
 *   else on the origin is not APC. `mcp.path` may stay beside it for older readers, and every endpoint
 *   then lies inside it. An entry a reader does not fully understand (another key, another path form) is
 *   left out whole, never in part, so a later version can add forms without widening. See
 *   `mcpUrlCoverage` for the match.
 * - **`direct.connect`** (with `"direct"`): the page, on the same origin, where the person connects an
 *   agent directly: what a person is shown when they drop a dock agent on a Direct-only app.
 * - **`direct.auth`** (APC 0.8, optional, information only): how a Direct agent authenticates, a short
 *   word such as `"url"` (the secret URL) or `"oauth"`; with OAuth, `direct.resource_metadata` may give
 *   the URL of its OAuth protected-resource metadata, on its origin. A reader never requires either: the
 *   standard does not fix how agents authenticate (`GrantRequirement`).
 * - **`dock`** (a hub): where it takes pairings, `pair` and `confirm`, as absolute URLs on its origin.
 *
 * A hub reads an app's `apc.json` when the app asks to pair (`POST {hub}/apc/pair`) and refuses the
 * pairing when it is missing (`apc_json_missing`), answered with a redirect (`apc_json_redirected`), cannot be read as one (`apc_json_invalid`), names
 * another origin (`apc_json_wrong_origin`), does not list the Dock profile (`dock_not_offered`), or
 * does not cover the MCP URL the app sent (`mcp_url_not_declared`); see `ApcJsonRefusal`.
 */
import type { ApcProfile } from "./core.ts";

/** Where an origin serves its `apc.json`. */
export const APC_JSON_PATH = "/.well-known/apc.json";
/** The most bytes a reader takes of an `apc.json`. */
export const APC_JSON_MAX_BYTES = 16_384;
/**
 * Where an app's MCP URLs live when it says nothing else: `@tineira/apc-server`'s default `mcp.path`, and the
 * path a hub holds a verified app to when it pairs it without a file (its file out of reach, no copy).
 */
export const APC_DEFAULT_MCP_PATH = "/mcp/";

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
  /**
   * Where its MCP URLs live. `path` (APC 0.5): every grant's MCP URL on this origin starts with origin + path.
   * `endpoints` (APC 0.11): the exact endpoints, as written; when present, only they cover a URL. At least one
   * of the two is there.
   */
  mcp: { path?: string; endpoints?: ApcMcpEndpointEntry[] };
  /**
   * With "direct": where the person connects an agent directly, on the same origin; and, as information
   * only (APC 0.8), how agents authenticate (`auth`, e.g. "url" or "oauth") and, with OAuth, the URL of
   * the protected-resource metadata (`resource_metadata`, on the same origin).
   */
  direct?: { connect: string; auth?: string; resource_metadata?: string };
  /** A hub's pairing endpoints, on its origin. */
  dock?: { pair: string; confirm: string };
}

/** A profile an MCP endpoint serves (APC 0.11). */
export type ApcEndpointProfile = "direct" | "dock";
/** An entry of `mcp.endpoints` as the file wrote it (APC 0.11), kept whole: `endpointRule` interprets it. */
export interface ApcMcpEndpointEntry {
  path: string;
  profiles: string[];
  [key: string]: unknown;
}
/**
 * An entry of `mcp.endpoints` a 0.11 reader understands: its `path` as written, `base` (the path without
 * its `/{secret}`, or the whole exact path), whether it takes a grant's secret, and the profiles it serves.
 */
export interface ApcMcpEndpoint {
  path: string;
  base: string;
  secret: boolean;
  profiles: ApcEndpointProfile[];
}
/** The most entries `mcp.endpoints` may hold. */
export const APC_MCP_ENDPOINTS_MAX = 16;
/** A grant's secret where an endpoint's path ends in `/{secret}`: 16 to 128 of A-Z, a-z, 0-9, `_` and `-`. */
export const APC_SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** The last segment that marks an endpoint path as taking a grant's secret. */
export const APC_SECRET_SEGMENT = "{secret}";

/** Why a hub refuses a pairing over the app's `apc.json` (APC 0.5). */
export type ApcJsonRefusal = "apc_json_missing" | "apc_json_redirected" | "apc_json_unreachable" | "apc_json_invalid" | "apc_json_wrong_origin" | "dock_not_offered" | "mcp_url_not_declared";

const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
const PATH_RE = /^\/([A-Za-z0-9._~!$&'()*+,;=:@-]+\/)*$/;
const AUTH_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * An absolute http(s) URL on `origin`, with no credentials, as its href; null otherwise. The scheme is
 * checked as well as the origin: `blob:https://app.example/…` has that origin too, and is no page of it.
 */
export function urlOnOrigin(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
const onOrigin = urlOnOrigin;

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
  if (!isObject(mcp)) return bad("mcp is not an object");
  const hasPath = Object.hasOwn(mcp, "path");
  const hasEndpoints = Object.hasOwn(mcp, "endpoints");
  if (!hasPath && !hasEndpoints) return bad("mcp has neither path nor endpoints");
  // A present mcp.path is checked by the 0.5 rule whether or not endpoints are there.
  if (hasPath && (typeof mcp.path !== "string" || mcp.path.length > 200 || !PATH_RE.test(mcp.path) || mcp.path.split("/").some((s) => s === "." || s === ".."))) return bad("mcp.path is not a path that starts and ends with /");
  const manifestMcp: ApcManifest["mcp"] = {};
  if (hasPath) manifestMcp.path = mcp.path as string;
  if (hasEndpoints) {
    const endpoints = parseEndpoints(mcp.endpoints, hasPath ? (mcp.path as string) : null);
    if (typeof endpoints === "string") return bad(endpoints);
    manifestMcp.endpoints = endpoints;
  }
  const manifest: ApcManifest = { name, standard: raw.standard, origin, profiles, mcp: manifestMcp };
  if (profiles.includes("direct")) {
    const connect = isObject(raw.direct) ? onOrigin(raw.direct.connect, origin) : null;
    if (!connect) return bad("direct.connect is not a URL on its origin");
    manifest.direct = { connect };
    // Information only (APC 0.8): kept when well formed, otherwise left out, never a reason to refuse.
    const direct = raw.direct as Record<string, unknown>;
    if (typeof direct.auth === "string" && AUTH_RE.test(direct.auth)) manifest.direct.auth = direct.auth;
    const metadata = onOrigin(direct.resource_metadata, origin);
    if (metadata) manifest.direct.resource_metadata = metadata;
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

// A malformed entry path, in any version: these never become a valid form later.
const ENTRY_PATH_MALFORMED = /[%?#\\\s\p{Cc}\p{Cf}]/u;
// The 0.11 grammar of an entry path: fixed segments, and at most a final /{secret} after one of them.
const ENTRY_PATH_RE = /^(\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)+(\/\{secret\})?$/;

/** `mcp.endpoints` checked (APC 0.11): the entries as written, or why the file is invalid. */
function parseEndpoints(raw: unknown, mcpPath: string | null): ApcMcpEndpointEntry[] | string {
  if (!Array.isArray(raw)) return "mcp.endpoints is not a list";
  if (raw.length > APC_MCP_ENDPOINTS_MAX) return `mcp.endpoints has more than ${APC_MCP_ENDPOINTS_MAX} entries`;
  const seen = new Set<string>();
  const entries: ApcMcpEndpointEntry[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) return "an entry of mcp.endpoints is not an object";
    const path = entry.path;
    if (typeof path !== "string" || path.length > 200 || !path.startsWith("/") || ENTRY_PATH_MALFORMED.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
      return "an entry of mcp.endpoints has no path that starts with / (with no %, ?, #, \\, space, . or .. segment)";
    }
    if (!Array.isArray(entry.profiles) || entry.profiles.length > 8 || entry.profiles.some((p) => typeof p !== "string")) return "an entry of mcp.endpoints has no profiles list";
    if (seen.has(path)) return `mcp.endpoints lists ${path} twice`;
    seen.add(path);
    // Kept as written, a plain JSON copy: a later read interprets it the same (the parse is idempotent).
    const kept = JSON.parse(JSON.stringify(entry)) as ApcMcpEndpointEntry;
    const rule = endpointRule(kept);
    // I2: with mcp.path beside them, every usable endpoint lies inside it, so a 0.11 reader never covers more.
    if (rule && mcpPath !== null && !(rule.secret ? `${rule.base}/`.startsWith(mcpPath) : rule.path.startsWith(mcpPath) || rule.path === mcpPath.slice(0, -1))) {
      return `mcp.endpoints: ${path} is not inside mcp.path ${mcpPath}`;
    }
    entries.push(kept);
  }
  return entries;
}

/**
 * How a 0.11 reader understands an entry of `mcp.endpoints`, or null when it does not fully understand it
 * (any key but `path` and `profiles`, a path outside the 0.11 grammar: a trailing `/`, `//`, another `{…}`,
 * `{secret}` not last): such an entry covers nothing, and is never read in part. Profile words other than
 * `direct` and `dock` are left out one by one (a profile only grants), and so is `dock` on an exact path, which
 * cannot be one URL per grant.
 */
export function endpointRule(entry: unknown): ApcMcpEndpoint | null {
  if (!isObject(entry) || typeof entry.path !== "string" || !Array.isArray(entry.profiles)) return null;
  if (Object.keys(entry).some((k) => k !== "path" && k !== "profiles")) return null;
  const path = entry.path;
  if (path.length > 200 || ENTRY_PATH_MALFORMED.test(path) || !ENTRY_PATH_RE.test(path) || path.split("/").some((s) => s === "." || s === "..")) return null;
  const secret = path.endsWith(`/${APC_SECRET_SEGMENT}`);
  const base = secret ? path.slice(0, -APC_SECRET_SEGMENT.length - 1) : path;
  const words = entry.profiles as unknown[];
  const profiles = (["direct", "dock"] as const).filter((p) => words.includes(p) && (p !== "dock" || secret));
  return { path, base, secret, profiles };
}

/** The entries of `mcp.endpoints` a 0.11 reader understands (APC 0.11); empty when there are none or no list. */
export function usableEndpoints(manifest: Pick<ApcManifest, "mcp">): ApcMcpEndpoint[] {
  const entries = manifest.mcp.endpoints;
  return Array.isArray(entries) ? entries.map(endpointRule).filter((r): r is ApcMcpEndpoint => r !== null) : [];
}

/** What covers MCP URLs on the origin, in words for a report: "mcp.endpoints /mcp (direct), /mcp/{secret} (dock)" or "mcp.path /mcp/". */
export function describeMcpCoverage(manifest: Pick<ApcManifest, "mcp">): string {
  if (Array.isArray(manifest.mcp.endpoints)) {
    const usable = usableEndpoints(manifest);
    return usable.length ? `mcp.endpoints ${usable.map((e) => `${e.path} (${e.profiles.join(", ") || "no profile"})`).join(", ")}` : "mcp.endpoints, with no entry this reader can use";
  }
  return typeof manifest.mcp.path === "string" ? `mcp.path ${manifest.mcp.path}` : "nothing";
}

/** How a URL is checked against `apc.json`: the profile it is for (required) and whether its grants share it. */
export interface McpUrlCheck {
  /** The profile the URL is for. A hub pairing a Dock app checks `"dock"`. */
  profile: ApcEndpointProfile;
  /** The grants share this one URL (a bearer token names the grant, APC 0.8). */
  shared?: boolean;
}

/** A manifest as `declaresMcpUrl` reads it: the origin, `mcp`, and (for `mcp.endpoints`) the top-level profiles. */
export type McpCoverageManifest = Pick<ApcManifest, "origin" | "mcp"> & { profiles?: readonly string[] };

/**
 * Whether an MCP URL is covered by what the manifest declares, and if not, why (in words for a report).
 *
 * **With `mcp.endpoints` (APC 0.11)**, a URL is covered for profile R only if every step holds:
 * 1. It is an absolute http(s) URL on the manifest's origin, with no userinfo.
 * 2. As a string it holds no `?`, `#` or `%`, and equals its own parsed `href`: it is exactly origin + path.
 *    So no dot segment, backslash, upper-case host, written default port or encoding gets through.
 * 3. The top-level `profiles` and a usable entry E both list R, and either E is exact, the path equals it
 *    (case-sensitive), and the URL is `shared`; or E is `P/{secret}`, the path is `P/s` with s matching
 *    `APC_SECRET_RE`, and no entry's path equals it or begins with it followed by `/` (exact wins), compared
 *    without ASCII case, whether or not this reader can use that entry.
 *
 * **Without `endpoints`**, the 0.10 rule under `mcp.path` (`declaresMcpUrl`), where `profile` plays no part.
 */
export function mcpUrlCoverage(manifest: McpCoverageManifest, mcpUrl: string, options: McpUrlCheck): { covered: true; by: string } | { covered: false; reason: string } {
  const no = (reason: string) => ({ covered: false as const, reason });
  const mcp = manifest?.mcp;
  const check: Partial<McpUrlCheck> = options ?? {};
  // A manifest that skipped the parser, with an endpoints key that is not a list, covers nothing: never mcp.path.
  if (mcp && Object.hasOwn(mcp, "endpoints") && !Array.isArray(mcp.endpoints)) return no("mcp.endpoints is not a list");
  if (!mcp || !Array.isArray(mcp.endpoints)) {
    if (typeof mcp?.path !== "string") return no("the manifest declares neither mcp.path nor mcp.endpoints");
    if (legacyDeclares(manifest.origin, mcp.path, mcpUrl, !!check.shared)) return { covered: true, by: `mcp.path ${mcp.path}` };
    return no(`not under ${manifest.origin}${mcp.path} (mcp.path)${check.shared ? ", nor that path itself" : ""}, or it carries an encoded /, \\, . or % after it`);
  }
  const profile = check.profile;
  if (profile !== "direct" && profile !== "dock") return no("no profile to check it for (direct or dock)");
  if (!Array.isArray(manifest.profiles) || !manifest.profiles.includes(profile)) return no(`the top-level profiles do not list ${profile}`);
  if (typeof mcpUrl !== "string" || /[?#%]/.test(mcpUrl)) return no("it carries a ?, # or %: an endpoint URL is exactly origin + path");
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return no("it is not a URL");
  }
  if (!urlOnOrigin(url.href, manifest.origin)) return no(`it is not an http(s) URL on ${manifest.origin} without credentials`);
  if (url.href !== mcpUrl) return no(`it is not written as ${url.href}: an endpoint URL is exactly origin + path`);
  const path = url.pathname;
  const rules = mcp.endpoints.map(endpointRule);
  for (const rule of rules) {
    if (rule && !rule.secret && rule.path === path && rule.profiles.includes(profile)) {
      return check.shared ? { covered: true, by: `mcp.endpoints ${rule.path}` } : no(`${rule.path} is an exact endpoint, one URL its grants share: it covers a grant with a bearer token (shared) only`);
    }
  }
  const lower = path.toLowerCase();
  const named = mcp.endpoints.some((e) => {
    const p = isObject(e) && typeof e.path === "string" ? e.path.toLowerCase() : null;
    return p !== null && (p === lower || p.startsWith(`${lower}/`));
  });
  if (named) return no(`${path} is named by an entry of mcp.endpoints that does not cover it for ${profile}`);
  for (const rule of rules) {
    if (!rule || !rule.secret || !rule.profiles.includes(profile) || !path.startsWith(`${rule.base}/`)) continue;
    if (APC_SECRET_RE.test(path.slice(rule.base.length + 1))) return { covered: true, by: `mcp.endpoints ${rule.path}` };
  }
  return no(`no entry covers it for ${profile} (${describeMcpCoverage(manifest)}); a secret is one segment of 16 to 128 of A-Z, a-z, 0-9, _ and -`);
}

/**
 * Whether an MCP URL is covered by what the manifest declares (`mcpUrlCoverage` also says why not).
 * `profile` is required: the hub pairing a Dock app checks `{ profile: "dock" }`. Called without one on a file
 * with `mcp.endpoints`, it answers false.
 *
 * Without `mcp.endpoints`, the 0.10 rule, unchanged: an http(s) URL on its origin, with no credentials, under
 * `mcp.path`. The URL parser removes literal `.` and `..` segments, but not encoded ones, which a server may
 * decode afterwards: so the rest of the path after `mcp.path` may hold no encoded slash, backslash or dot
 * (`%2f`, `%5c`, `%2e`), no encoded percent (`%25`, a second round of encoding), and no backslash. With
 * `shared` (APC 0.8: a Direct endpoint whose grants share one URL, the credential naming the grant), the URL
 * may also be `mcp.path` itself or `mcp.path` without its last `/`. Without it, as a hub pairing a Dock app
 * checks, the URL must lie strictly under `mcp.path`: one URL per grant.
 */
export function declaresMcpUrl(manifest: McpCoverageManifest, mcpUrl: string, options: McpUrlCheck): boolean {
  return mcpUrlCoverage(manifest, mcpUrl, options).covered;
}

/** The 0.10 rule under `mcp.path`, unchanged. */
function legacyDeclares(origin: string, path: string, mcpUrl: string, shared: boolean): boolean {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return false;
  }
  if (!urlOnOrigin(url.href, origin)) return false;
  if (shared && path !== "/" && (url.pathname === path || url.pathname === path.slice(0, -1))) return !/%(2f|5c|2e|25)/i.test(mcpUrl.split(/[?#]/, 1)[0]!);
  if (!url.pathname.startsWith(path) || url.pathname.length <= path.length) return false;
  const rest = url.pathname.slice(path.length);
  // Checked on the URL as sent too: the parser turns some encoded dots into segments it then removes.
  const sent = mcpUrl.split(/[?#]/, 1)[0]!;
  const encoded = /%(2f|5c|2e|25)/i;
  return !encoded.test(rest) && !encoded.test(sent) && !rest.includes("\\") && !rest.split("/").some((s) => s === "." || s === "..");
}

/**
 * What an app tells a person who drops an agent from their dock on it when it connects agents only
 * directly (its `apc.json` lists no `"dock"`): the drop is answered, never lost. These are the app's
 * own words, on its own page (`@tineira/apc-web`); the browser extension, which speaks for itself, puts the
 * domain first and the name only as what the page says it is.
 */
export function directOnlyNote(name: string): string {
  return `${name} connects agents directly, not through a dock. Connect your agent to ${name} on its own URL, then drag its mark from the agent bar there.`;
}

/**
 * What an app tells a person who drops a dock agent on it when its page could not read its own
 * `apc.json`: it cannot tell whether it takes dock agents, so it pairs nothing and says so.
 */
export function couldNotCheckNote(name: string): string {
  return `${name} could not check how it connects agents just now, so your agent was not paired. Drop it again in a moment, or connect your agent to ${name} directly on its own URL.`;
}
