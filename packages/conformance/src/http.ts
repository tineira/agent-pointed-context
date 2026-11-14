/**
 * The conformance checks that run over plain HTTP against a live app (what `npx @tineira/apc-conformance` runs):
 * no adapter, only the app's origin and, if the person has them, the MCP URL of a live Direct grant and
 * of one they revoked. It reads `{origin}/.well-known/apc.json` and talks JSON-RPC to the grant the way
 * an agent does. What only the person's page can do (drop a pin, open or close the page, see presence,
 * press Revoke, a phone's touch) is not reachable over HTTP: those checks are listed in
 * `IN_PROCESS_ONLY` and run with `apcConformance(adapter)` in the app's own tests.
 *
 * Safe to point at any URL: https only (http only with `allowHttp`, and then only on a loopback host),
 * no credentials in URLs, every grant URL on the app's own origin, redirects never followed (a 3xx is a
 * failure), a byte cap on every body and a timeout on every request.
 */
import {
  APC_JSON_MAX_BYTES,
  APC_JSON_PATH,
  APC_STANDARD_VERSION,
  CORE_TOOLS,
  REVOKED_HTTP_STATUS,
  REVOKED_HTTP_STATUS_BEARER,
  describeMcpCoverage,
  isRevokedAnswer,
  mcpUrlCoverage,
  parseApcManifest,
  type ApcEndpointProfile,
  type ApcManifest,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, attentionOf, checkCoreToolList, checkMcpEndpoints, checkFocusShape, checkView, data, expect, isObject, resultKey, rpcBody, standardSupport, type ToolCallResult } from "./shared.ts";

export interface HttpConformanceOptions {
  /** The app's origin, e.g. `https://pulse.example` (a trailing slash is fine; no path). */
  origin: string;
  /** The MCP URL of a live grant (an agent connected directly). Without it the MCP checks are skipped. */
  grant?: string;
  /**
   * The grant's bearer token, when the URL alone does not carry the grant (APC 0.8: OAuth, one MCP URL shared
   * by every grant). Sent as `Authorization: Bearer …`, never shown in the report.
   */
  bearer?: string;
  /** The MCP URL of a grant the person revoked in the app. Without it the revoked-answer check is skipped. */
  revoked?: string;
  /** The revoked grant's bearer token, as `bearer` (APC 0.8). */
  revokedBearer?: string;
  /**
   * The profile the app serves the grant URLs on (APC 0.11): `direct` (the default; always with a bearer token,
   * since a shared URL is never a Dock grant) or `dock`, a Dock grant's secret URL, checked exactly as a hub
   * pairing it checks it. Under `mcp.endpoints` only an entry listing that profile covers the URL.
   */
  profile?: ApcEndpointProfile;
  /** Lets `http:` through, on a loopback host only (localhost, 127.0.0.1, [::1]): a dev server. */
  allowHttp?: boolean;
  /** Per request, in ms (default 15000). */
  timeoutMs?: number;
  /** The global fetch when left out. Called with `redirect: "manual"`; a test can route it in process. */
  fetch?: (request: Request) => Promise<Response>;
}

export type HttpCheckStatus = "pass" | "fail" | "skip";

export interface HttpCheckResult {
  id: string;
  name: string;
  status: HttpCheckStatus;
  /** Why it failed, or why it was skipped. */
  detail?: string;
  /** On a pass: what it could not check (e.g. a result with no structuredContent, read from its text only). */
  note?: string;
  ms?: number;
}

export interface HttpConformanceReport {
  origin: string;
  /** What apc.json says, when it could be read. */
  app?: { name: string; standard: string; profiles: string[] };
  /** The standard this version of the checks knows. */
  checks_standard: string;
  passed: number;
  failed: number;
  skipped: number;
  results: HttpCheckResult[];
}

export interface HttpCheck {
  id: string;
  name: string;
  /**
   * Resolves to a reason string when the check does not apply (skipped), to `{ note }` when it passed with a
   * caveat; throws `ConformanceError` when it fails. Messages never carry a grant's secret.
   */
  run(): Promise<void | string | { note: string }>;
}

/**
 * The checks of the suite that need the person's page (an adapter in process), not reachable over HTTP:
 * `apcConformance(adapter)` runs them in the app's own tests.
 */
export const IN_PROCESS_ONLY: ReadonlyArray<{ name: string; why: string }> = [
  { name: "a pin rides as attention on any result until it is read, and next reads it", why: "needs the person to drop a pin in the page" },
  { name: "get_current_view returns the view the page reported, and no focus before a pin", why: "needs the page to report a view (the CLI checks the shape of whatever view and focus it gets)" },
  { name: "wait_for_focus returns a pin dropped during the wait", why: "needs the person to drop a pin during the wait" },
  { name: "wait_for_focus ends when the person has no page open", why: "needs to open and close the person's page (the CLI accepts either outcome)" },
  { name: "then rides on results only while the person's page is open", why: "needs to open and close the person's page (the CLI checks then's shape where it appears)" },
  { name: "presence names what a read touched, with ids only", why: "presence goes to the person's page, not to the agent" },
  { name: "a wait publishes open, then closed, on the presence channel (APC 0.11)", why: "presence goes to the person's page, not to the agent" },
  { name: "a takeover publishes the old wait's closed before the new wait's open (APC 0.11)", why: "presence goes to the person's page, not to the agent" },
  { name: "a cancelled wait publishes closed (APC 0.11)", why: "presence goes to the person's page, not to the agent" },
  { name: "a wait whose grant is revoked publishes closed, and a wait on a revoked grant publishes nothing (APC 0.11)", why: "needs the person's Revoke during a wait, and presence goes to the page" },
  { name: "a refused wait publishes nothing (APC 0.11)", why: "presence goes to the person's page, not to the agent" },
  { name: "revoke from the app cuts that agent at once, and only that agent", why: "needs the person's Revoke (the CLI checks a grant you revoked, with --revoked)" },
  { name: "a call already running when the grant is revoked ends revoked, with no data", why: "needs the person's Revoke during a call" },
  { name: "mobile: every agent is shown in the page, and the agent bar cannot be collapsed", why: "needs the page on a phone (page.mobile)" },
  { name: "mobile: a person pins and unpins with a finger", why: "needs the page on a phone (page.mobile)" },
  { name: "apc_link: the offer, the code and its refusals, revoke and unlink of a linked agent", why: "needs Dock connections through a hub and the agent bar (link adapter)" },
  { name: "dock: the pairing code (APC 0.9)", why: "needs the person's drop and Allow, and a stand-in hub (dock adapter)" },
  { name: "dock: the Dock profile as built (APC 0.10): the grant's states, the transitions, M1 to M9 and one pending pairing", why: "needs the person's drop, Allow and Cancel, the app's clock, a restart and a stand-in hub (dock.lifecycle)" },
];

const DEFAULT_TIMEOUT_MS = 15_000;
/** A revoked bearer grant's challenge (APC 0.8). */
const INVALID_TOKEN = /^bearer\b.*error="?invalid_token"?/i;
/** The most bytes read of an MCP reply. */
const MCP_MAX_BYTES = 1_048_576;
const PROTOCOL_VERSION = "2025-06-18";
/**
 * The hosts `--allow-http` lets through, literally (after the URL parser's normalizing, so `127.1` is
 * `127.0.0.1`). Not `*.localhost`: Node resolves those through DNS, which may answer anything.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** `wait_for_focus({ timeout_s: 1 })` answers within this, as in the in-process suite; the request is cut there too. */
const WAIT_LIMIT_MS = 5000;

/** Why a URL the person gave cannot be used; thrown before any request is sent. */
export class HttpConformanceUsageError extends Error {}

/**
 * A URL the checks may call: https (or http on a loopback host with `allowHttp`), no credentials. The input is
 * never echoed when it does not parse: a grant URL holds a secret.
 */
export function safeUrl(raw: string, what: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpConformanceUsageError(`${what} is not a valid URL (not shown: a grant URL holds a secret)`);
  }
  if (url.username || url.password) throw new HttpConformanceUsageError(`${what} carries credentials; leave them out`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (!allowHttp) throw new HttpConformanceUsageError(`${what} is http: use https, or --allow-http for a dev server on localhost`);
    if (!LOOPBACK.has(url.hostname)) throw new HttpConformanceUsageError(`${what}: --allow-http is for a loopback host only (localhost, 127.0.0.1, [::1]), not ${url.hostname}`);
    return url;
  }
  throw new HttpConformanceUsageError(`${what} is not http(s): ${url.protocol}`);
}

/** The options, checked: the origin as an origin, and every grant URL on it. Throws `HttpConformanceUsageError`. */
export function checkOptions(options: HttpConformanceOptions): { origin: string; grant?: URL; revoked?: URL } {
  const allowHttp = !!options.allowHttp;
  const o = safeUrl(options.origin, "the app's origin", allowHttp);
  if ((o.pathname !== "/" && o.pathname !== "") || o.search || o.hash) throw new HttpConformanceUsageError(`the app's origin has a path or query: give ${o.origin}`);
  const origin = o.origin;
  const onOrigin = (raw: string | undefined, what: string) => {
    if (raw === undefined) return undefined;
    const url = safeUrl(raw, what, allowHttp);
    if (url.origin !== origin) throw new HttpConformanceUsageError(`${what} is on ${url.origin}, not on the app's origin ${origin}`);
    return url;
  };
  const out: { origin: string; grant?: URL; revoked?: URL } = { origin };
  const grant = onOrigin(options.grant, "--grant");
  const revoked = onOrigin(options.revoked, "--revoked");
  if (grant) out.grant = grant;
  if (revoked) out.revoked = revoked;
  return out;
}

/** A grant's MCP URL as it may be shown: the last path segment (its secret) replaced. */
export function redactGrantUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const last = parts.findLastIndex((p) => p.length > 0);
    if (last >= 0) parts[last] = "<secret>";
    return `${u.origin}${parts.join("/")}`;
  } catch {
    return "<grant URL>";
  }
}

/** The secret of each grant URL: its last path segment, as sent and decoded. Segments under 4 characters are no secret. */
function secretsOf(urls: ReadonlyArray<string | URL | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    let path: string;
    try {
      path = new URL(String(u)).pathname;
    } catch {
      continue;
    }
    const last = path.split("/").filter(Boolean).at(-1);
    if (!last) continue;
    out.add(last);
    try {
      const decoded = decodeURIComponent(last);
      out.add(decoded);
      out.add(encodeURIComponent(decoded));
    } catch {
      // not decodable
    }
    out.add(encodeURIComponent(last));
  }
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Any text with every grant's secret (the last path segment of each URL in `urls`) replaced by `<secret>`,
 * wherever it appears (in a URL, a quoted body, an echoed error), in any letter case, as sent, decoded or
 * percent-encoded.
 */
export function redactSecrets(text: string, urls: ReadonlyArray<string | URL | undefined>): string {
  let out = text;
  // In any case (a server may echo it upper-cased) and in each of its encodings, longest first.
  for (const s of secretsOf(urls)) out = out.replace(new RegExp(escapeRegExp(s), "gi"), "<secret>");
  return out;
}

interface Fetched {
  status: number;
  contentType: string;
  text: string;
  wwwAuthenticate: string;
}

/** The HTTP checks against a live app, in order. Throws `HttpConformanceUsageError` when the options name an unsafe URL. */
export function httpConformance(options: HttpConformanceOptions): HttpCheck[] {
  return build(options).checks;
}

function build(options: HttpConformanceOptions): { origin: string; checks: HttpCheck[]; manifest: () => ApcManifest | null } {
  const { origin, grant, revoked } = checkOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const [token, what] of [[options.bearer, "the bearer token"], [options.revokedBearer, "the revoked grant's bearer token"]] as const) {
    if (token !== undefined && (!token || /[\s,"]/.test(token) || token.length > 8192)) throw new HttpConformanceUsageError(`${what} is empty or not a token (not shown)`);
  }
  if (options.profile !== undefined && options.profile !== "direct" && options.profile !== "dock") throw new HttpConformanceUsageError(`the profile is direct or dock, not ${JSON.stringify(options.profile)}`);
  // A shared URL (a bearer names the grant) is never a Dock grant: a hub pairs one URL per grant.
  if (options.profile === "dock" && (options.bearer !== undefined || options.revokedBearer !== undefined)) throw new HttpConformanceUsageError("--profile dock checks a Dock grant's secret URL, which takes no bearer token: leave out --bearer-env and --revoked-bearer-env");
  const profile: ApcEndpointProfile = options.profile ?? "direct";
  /** The credential headers of the live grant and of the revoked one (APC 0.8): the two may share one URL, so each check says which it sends. */
  const bearer = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
  const liveAuth = bearer(options.bearer);
  const revokedAuth = bearer(options.revokedBearer);
  const doFetch = options.fetch ?? ((request: Request) => fetch(request));
  let manifest: ApcManifest | null = null;
  let manifestRaw: unknown = undefined;

  /** One request: no redirect followed, a timeout (`abortMs`, or the run's), at most `maxBytes` read. */
  async function get(url: string, init: RequestInit, maxBytes: number, abortMs = timeoutMs): Promise<Fetched> {
    const signal = AbortSignal.timeout(abortMs);
    let response: Response;
    try {
      response = await doFetch(new Request(url, { ...init, redirect: "manual", credentials: "omit", signal }));
    } catch (error) {
      const why = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? `no answer within ${abortMs} ms` : `the request failed (${error instanceof Error ? error.message : String(error)})`;
      throw new ConformanceError(`${init.method ?? "GET"} ${shown(url)}: ${why}`);
    }
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel().catch(() => {});
      throw new ConformanceError(`${init.method ?? "GET"} ${shown(url)}: answered with a redirect (HTTP ${response.status}); APC never follows one`);
    }
    return { status: response.status, contentType: response.headers.get("content-type") ?? "", wwwAuthenticate: response.headers.get("www-authenticate") ?? "", text: await readCapped(response, maxBytes, url) };
  }

  async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ConformanceError(`${shown(url)}: the answer is ${declared} bytes, over the ${maxBytes} this check reads`);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ConformanceError(`${shown(url)}: the answer is over the ${maxBytes} bytes this check reads`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  /** A grant URL is never shown whole: its last segment may be the secret, even when a bearer token is given too. */
  function shown(url: string): string {
    return url === `${origin}${APC_JSON_PATH}` ? url : redactGrantUrl(url);
  }

  /** A JSON-RPC call; with the live grant's credential unless `headers` names another (the revoked grant's). */
  async function rpc(url: URL, method: string, params: Record<string, unknown>, abortMs?: number, headers: Record<string, string> = liveAuth): Promise<{ status: number; body: unknown; ms: number; wwwAuthenticate: string }> {
    const started = Date.now();
    const r = await get(
      url.href,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      MCP_MAX_BYTES,
      abortMs,
    );
    return { status: r.status, body: rpcBody(r.contentType, r.text), ms: Date.now() - started, wwwAuthenticate: r.wwwAuthenticate };
  }

  async function result(url: URL, method: string, params: Record<string, unknown> = {}, abortMs?: number): Promise<{ value: unknown; ms: number }> {
    const { status, body, ms } = await rpc(url, method, params, abortMs);
    expect(status === 200, `${method}: HTTP ${status}, expected 200 (${JSON.stringify(body).slice(0, 200)})`);
    expect(isObject(body) && !("error" in body && body.error), `${method}: JSON-RPC error ${JSON.stringify(body).slice(0, 200)}`);
    return { value: (body as { result?: unknown }).result, ms };
  }

  async function call(url: URL, tool: string, args: Record<string, unknown> = {}, abortMs?: number): Promise<{ r: ToolCallResult; ms: number }> {
    const { value, ms } = await result(url, "tools/call", { name: tool, arguments: args }, abortMs);
    expect(isObject(value), `${tool}: no result`);
    return { r: value as ToolCallResult, ms };
  }

  const noGrant = "give --grant <mcp-url>: the MCP URL of an agent connected directly (Direct profile)";
  const withGrant = (run: (g: URL) => ReturnType<HttpCheck["run"]>) => () => (grant ? run(grant) : Promise.resolve(noGrant));
  const textOnly = "the result has no structuredContent: attention and then were read from the text alone, with nothing to compare them to";

  /** `then` where it appears: a string, the same in the structured result and the text. */
  const checkThen = (r: ToolCallResult, where: string) => {
    const { value } = resultKey(r, "then");
    if (value !== undefined) expect(typeof value === "string", `${where}: then is not a string`);
  };

  const checks: HttpCheck[] = [
    {
      id: "apc-json-served",
      name: `serves ${APC_JSON_PATH}: HTTP 200, no redirect, application/json, at most ${APC_JSON_MAX_BYTES} bytes, JSON`,
      async run() {
        const r = await get(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } }, APC_JSON_MAX_BYTES);
        expect(r.status === 200, `GET ${APC_JSON_PATH}: HTTP ${r.status}, expected 200`);
        expect(r.contentType.includes("application/json"), `${APC_JSON_PATH} is served as ${r.contentType || "no content type"}, not application/json`);
        try {
          manifestRaw = JSON.parse(r.text);
        } catch {
          throw new ConformanceError(`${APC_JSON_PATH} is not JSON`);
        }
      },
    },
    {
      id: "apc-json-valid",
      name: "apc.json has the shape of the standard and names the origin it is served from",
      async run() {
        if (manifestRaw === undefined) return "apc.json could not be read";
        const parsed = parseApcManifest(manifestRaw, origin);
        expect(parsed.ok, parsed.ok ? "" : `${parsed.error}: ${parsed.detail}`);
        manifest = parsed.manifest;
      },
    },
    {
      id: "apc-json-standard",
      name: `its standard is one these checks know (0.5.0 to ${APC_STANDARD_VERSION}, or a newer patch of it)`,
      async run() {
        if (!manifest) return "apc.json did not parse";
        const support = standardSupport(manifest.standard, APC_STANDARD_VERSION);
        if (!support.ok) throw new ConformanceError(support.reason);
        if (support.note) return { note: support.note };
      },
    },
    {
      id: "apc-json-profiles",
      name: "it is an app: its profiles are direct, dock or both, and a Direct app names its connect page on its origin",
      async run() {
        if (!manifest) return "apc.json did not parse";
        expect(!manifest.profiles.includes("hub"), "it declares itself a hub (a dock), not an app: run the checks on an app's origin");
        if (manifest.profiles.includes("direct")) expect(manifest.direct && new URL(manifest.direct.connect).origin === origin, "direct.connect is not the app's own page");
      },
    },
    {
      id: "apc-json-endpoints",
      name: "mcp.endpoints (APC 0.11), when there: every entry is one readers use, and every profile offered has one",
      async run() {
        if (!manifest) return "apc.json did not parse";
        const note = checkMcpEndpoints(manifestRaw, manifest);
        // Without mcp.endpoints only the near-miss keys are checked: a pass.
        if (note !== null) return { note };
      },
    },
    {
      id: "grant-declared",
      name: `the grant's MCP URL is covered by the apc.json of its origin, for the ${profile} profile`,
      run: withGrant(async (g) => {
        if (!manifest) return "apc.json did not parse";
        // With a bearer token the grants may share one URL (APC 0.8). As --profile dock, the hub's own check.
        const covered = mcpUrlCoverage(manifest, g.href, { profile, shared: !!options.bearer });
        if (!covered.covered) throw new ConformanceError(`the grant's MCP URL ${shown(g.href)} is not covered for ${profile} by ${describeMcpCoverage(manifest)}: ${covered.reason}`);
        return { note: `covered by ${covered.by}, for ${profile}` };
      }),
    },
    {
      id: "mcp-initialize",
      name: "initialize answers as an MCP server with tools",
      run: withGrant(async (g) => {
        const { value } = await result(g, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "apc-conformance", version: APC_STANDARD_VERSION } });
        expect(isObject(value), "initialize has no result");
        expect(typeof value.protocolVersion === "string", "initialize names no protocolVersion");
        expect(isObject(value.capabilities) && isObject(value.capabilities.tools), "initialize offers no tools capability");
        expect(isObject(value.serverInfo) && typeof value.serverInfo.name === "string", "initialize names no serverInfo");
      }),
    },
    {
      id: "mcp-tools-list",
      name: "lists the core tools (get_current_view, wait_for_focus), with their arguments",
      run: withGrant(async (g) => {
        checkCoreToolList((await result(g, "tools/list")).value, CORE_TOOLS);
      }),
    },
    {
      id: "core-get-current-view",
      name: "get_current_view answers view and focus in the core's format, with attention and then the same in the structured result and the text",
      run: withGrant(async (g) => {
        const { r } = await call(g, "get_current_view");
        expect(!r.isError, `get_current_view failed: ${JSON.stringify(r.content).slice(0, 200)}`);
        const d = data(r);
        expect("view" in d && "focus" in d, "the result has view and focus");
        if (d.view !== null) checkView(d.view, "get_current_view");
        if (d.focus !== null) checkFocusShape(d.focus, "get_current_view");
        const attention = attentionOf(r);
        if (attention !== undefined) {
          expect(isObject(attention) && typeof attention.note === "string", "attention is { focus, note }");
          checkFocusShape(attention.focus, "attention");
        }
        checkThen(r, "get_current_view");
        if (!r.structuredContent) return { note: textOnly };
      }),
    },
    {
      id: "core-wait-for-focus",
      name: `wait_for_focus({ timeout_s: 1 }) with no pin times out at 1 s (900 to ${WAIT_LIMIT_MS} ms), or ends at once when no page is open, with a note and no then`,
      run: withGrant(async (g) => {
        // Cut at the limit: a wait that runs past it fails as "no answer", not after the run's own timeout.
        const { r, ms } = await call(g, "wait_for_focus", { timeout_s: 1 }, WAIT_LIMIT_MS);
        expect(!r.isError, `wait_for_focus failed: ${JSON.stringify(r.content).slice(0, 200)}`);
        expect(ms < WAIT_LIMIT_MS, `it came back at ${ms} ms for timeout_s 1, past ${WAIT_LIMIT_MS} ms`);
        const d = data(r);
        if (d.focus !== null && d.focus !== undefined) {
          // The person pinned the agent during the wait: that is the other answer of the core.
          checkFocusShape(d.focus, "wait_for_focus");
          expect(d.timed_out === false, "a wait that got a pin did not time out");
          return;
        }
        expect(d.focus === null, `focus is null when no pin came: ${JSON.stringify(d).slice(0, 200)}`);
        expect(typeof d.note === "string" && d.note.length > 0, "a wait with no pin carries a note for the agent");
        expect(resultKey(r, "then").value === undefined, "a wait that came back empty ends the loop: no then");
        if (d.page_open === false) {
          expect(d.timed_out === false, "a wait ended by a closed page has timed_out false");
        } else {
          expect(d.timed_out === true, `a wait with no pin and a page open (or not told) times out: ${JSON.stringify(d).slice(0, 200)}`);
          expect(d.page_open === undefined || d.page_open === true, "page_open is true or left out on a timeout");
          expect(ms >= 900, `it came back at ${ms} ms, before timeout_s 1`);
        }
      }),
    },
    {
      id: "grant-unknown-404",
      name: "an unknown grant answers HTTP 404, told apart from a revoked one (403)",
      run: withGrant(async (g) => {
        if (options.bearer) return "with a bearer token the grants share the URL: an unknown token is the auth's own 401, not a URL to try";
        const unknown = new URL(g.href);
        const parts = unknown.pathname.split("/");
        const last = parts.findLastIndex((p) => p.length > 0);
        const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
        parts[last] = random;
        unknown.pathname = parts.join("/");
        const { status } = await rpc(unknown, "tools/list", {});
        expect(status === 404, `the grant's URL with another secret (its last path segment) answers HTTP ${status}, expected 404`);
      }),
    },
    {
      id: "revoked-answers",
      name: `a revoked grant answers { error: "revoked", revoked_by, revoked_at } to every method, POST, GET and DELETE: HTTP ${REVOKED_HTTP_STATUS} with a secret URL, ${REVOKED_HTTP_STATUS_BEARER} with a bearer token`,
      async run() {
        if (!revoked) return "give --revoked <mcp-url>: the MCP URL of a grant you revoked in the app";
        const bearer = !!options.revokedBearer;
        const expected = bearer ? REVOKED_HTTP_STATUS_BEARER : REVOKED_HTTP_STATUS;
        if (manifest) {
          // The revoked grant's own credential says whether it shares its URL; the profile is the run's.
          const covered = mcpUrlCoverage(manifest, revoked.href, { profile, shared: bearer });
          if (!covered.covered) throw new ConformanceError(`the revoked grant's MCP URL is not covered for ${profile} by ${describeMcpCoverage(manifest)}: ${covered.reason}`);
        }
        for (const [method, params] of [
          ["initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "apc-conformance", version: APC_STANDARD_VERSION } }],
          ["tools/list", {}],
          ["tools/call", { name: "get_current_view", arguments: {} }],
        ] as const) {
          const { status, body, wwwAuthenticate } = await rpc(revoked, method, params, undefined, revokedAuth);
          expect(status === expected, `${method} on the revoked grant: HTTP ${status}, expected ${expected}`);
          if (bearer) expect(INVALID_TOKEN.test(wwwAuthenticate), `${method} on the revoked grant: no WWW-Authenticate: Bearer error="invalid_token"`);
          expect(isRevokedAnswer(body) && body.revoked_by.length > 0 && ISO.test(body.revoked_at), `${method} on the revoked grant answers ${JSON.stringify(body).slice(0, 200)}, not { error: "revoked", revoked_by, revoked_at }`);
        }
        for (const method of ["GET", "DELETE"]) {
          const r = await get(revoked.href, { method, headers: { ...revokedAuth, accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION } }, MCP_MAX_BYTES);
          let body: unknown = null;
          try {
            body = JSON.parse(r.text);
          } catch {
            // not JSON
          }
          expect(r.status === expected, `${method} on the revoked grant: HTTP ${r.status}, expected ${expected}`);
          if (bearer) expect(INVALID_TOKEN.test(r.wwwAuthenticate), `${method} on the revoked grant: no WWW-Authenticate: Bearer error="invalid_token"`);
          expect(isRevokedAnswer(body), `${method} on the revoked grant answers ${r.text.slice(0, 200)}, not { error: "revoked", ... }`);
        }
      },
    },
  ];
  // Whatever a check says (a quoted body, an echoed URL, a skip reason, a note), never a grant's secret or token.
  const tokens = [options.bearer, options.revokedBearer].filter((t): t is string => !!t);
  const hide = (s: string) => {
    let out = redactSecrets(s, [grant, revoked]);
    // Messages cut a quoted body at 200 characters, so a token may appear cut short: any run of 8 or more of
    // its first characters goes too, and anything sent as a Bearer credential.
    for (const t of tokens) {
      out = out.split(t).join("<token>");
      if (t.length >= 8) out = out.replace(new RegExp(`${escapeRegExp(t.slice(0, 8))}[^\\s"'<]*`, "g"), "<token>");
    }
    return out.replace(/(bearer\s+)[^\s"'<]+/gi, "$1<token>");
  };
  const safe = checks.map<HttpCheck>((c) => ({
    ...c,
    async run() {
      try {
        const out = await c.run();
        if (typeof out === "string") return hide(out);
        if (out && typeof out === "object") return { note: hide(out.note) };
        return out;
      } catch (error) {
        throw error instanceof ConformanceError ? new ConformanceError(hide(error.message)) : new Error(hide(error instanceof Error ? error.message : String(error)));
      }
    },
  }));
  return { origin, checks: safe, manifest: () => manifest };
}

/** Every HTTP check, one after another, then the in-process ones as skipped: the report. */
export async function runHttpConformance(options: HttpConformanceOptions): Promise<HttpConformanceReport> {
  const { origin, checks, manifest } = build(options);
  const results: HttpCheckResult[] = [];
  for (const c of checks) {
    const started = Date.now();
    try {
      const out = await c.run();
      if (typeof out === "string") results.push({ id: c.id, name: c.name, status: "skip", detail: out });
      else results.push({ id: c.id, name: c.name, status: "pass", ...(out ? { note: out.note } : {}), ms: Date.now() - started });
    } catch (error) {
      results.push({ id: c.id, name: c.name, status: "fail", detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
  }
  for (const c of IN_PROCESS_ONLY) results.push({ id: "in-process", name: c.name, status: "skip", detail: `in process only: ${c.why}` });
  const m = manifest();
  const app = m ? { name: m.name, standard: m.standard, profiles: [...m.profiles] } : undefined;
  const count = (s: HttpCheckStatus) => results.filter((r) => r.status === s).length;
  return { origin, ...(app ? { app } : {}), checks_standard: APC_STANDARD_VERSION, passed: count("pass"), failed: count("fail"), skipped: count("skip"), results };
}
