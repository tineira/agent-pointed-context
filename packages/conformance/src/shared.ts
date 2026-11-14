/**
 * What the in-process suite (`index.ts`) and the HTTP checks (`http.ts`) share: the error a check
 * throws, how a JSON-RPC reply is read off Streamable HTTP, and the shapes of the core's view and focus.
 */
import { compareStandard, endpointRule, isRevokedAnswer, parseParams, parseTarget, type ApcEndpointProfile, type ApcManifest, type FocusTarget } from "@tineira/apc-protocol";

export class ConformanceError extends Error {}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

/**
 * `mcp.endpoints` (APC 0.11) as the file wrote it (`raw`, the JSON read) and as it parsed: throws on what readers
 * would silently read otherwise (a near-miss key, an entry they drop, a profile word they ignore there, an empty
 * list, a top-level profile no entry serves), and gives the notes an author should see. Null when the file has
 * no `mcp.endpoints` (and no near-miss key). An entry may list a profile the top level does not: that is an app
 * not pairing right now (M8), never a failure.
 */
export function checkMcpEndpoints(raw: unknown, manifest: ApcManifest): string | null {
  const file = isObject(raw) ? raw : {};
  const rawMcp = isObject(file.mcp) ? file.mcp : {};
  // A near-miss key falls back to mcp.path in silence: the author believes the file is narrower than it is.
  const nearMiss = [...Object.keys(file).filter((k) => /^endpoints?$/i.test(k)), ...Object.keys(rawMcp).filter((k) => k !== "endpoints" && /^endpoints?$/i.test(k)).map((k) => `mcp.${k}`)];
  expect(!nearMiss.length, `${nearMiss.join(", ")}: readers ignore it; the list of endpoints is mcp.endpoints`);
  const entries = manifest.mcp.endpoints;
  if (!Array.isArray(entries)) return null;
  expect(entries.length > 0, "mcp.endpoints is empty: it covers no MCP URL, and mcp.path no longer does either");
  for (const entry of entries) {
    const rule = endpointRule(entry);
    expect(rule, `mcp.endpoints ${entry.path}: readers of 0.11 drop this entry (a key other than path and profiles, or a path that is neither exact nor ends in /{secret}; no trailing /)`);
    for (const word of entry.profiles) {
      expect(rule.profiles.includes(word as ApcEndpointProfile), `mcp.endpoints ${entry.path} lists ${JSON.stringify(word)}, which readers ignore there${word === "dock" ? ": dock needs a path ending in /{secret}, one URL per grant" : " (direct or dock)"}`);
    }
  }
  for (const p of ["direct", "dock"] as const) {
    if (manifest.profiles.includes(p)) expect(entries.some((e) => endpointRule(e)?.profiles.includes(p)), `profiles lists ${p}, and no entry of mcp.endpoints serves it`);
  }
  const notes = [manifest.mcp.path === undefined ? "there is no mcp.path: readers before 0.11 (hubs, the browser extension, an older @tineira/apc-web) refuse this file" : `readers before 0.11 still cover all of mcp.path ${manifest.mcp.path}`];
  for (const e of entries.map(endpointRule)) {
    if (e?.secret) notes.push(`${e.path} declares every child of ${e.base}/ that is 16 to 128 of A-Z, a-z, 0-9, _ and - a grant: serve nothing else there but the exact entries listed`);
  }
  return notes.join("; ");
}

export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The body of an MCP reply: the JSON-RPC message of an SSE stream (the one with a result or an error), or the JSON. */
export function rpcBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let body: unknown = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5)) as unknown;
        if (isObject(parsed) && ("result" in parsed || "error" in parsed)) body = parsed;
      } catch {
        // not a message
      }
    }
    return body;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The structured result, or the JSON of the first text block (what a model that sees only text reads). */
export function data(r: ToolCallResult): Record<string, unknown> {
  if (r.structuredContent) return r.structuredContent;
  return text(r);
}
export function text(r: ToolCallResult): Record<string, unknown> {
  const first = r.content?.[0];
  try {
    const parsed = first?.type === "text" && first.text ? (JSON.parse(first.text) as unknown) : null;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A focus in the core's format, whatever it names: the target it names. */
export function checkFocusShape(focus: unknown, where: string): FocusTarget {
  expect(isObject(focus), `${where}: focus is ${JSON.stringify(focus)}, expected an object`);
  const parsed = parseTarget({ kind: focus.kind, id: focus.id, part: focus.part, params: focus.params });
  expect(parsed, `${where}: the focus is not a valid target: ${JSON.stringify({ kind: focus.kind, id: focus.id, part: focus.part, params: focus.params })}`);
  expect(typeof focus.app_url === "string" && URL.canParse(focus.app_url), `${where}: app_url is not a URL`);
  expect(typeof focus.pinned_at === "string" && ISO.test(focus.pinned_at), `${where}: pinned_at is not an ISO time`);
  expect(typeof focus.next === "string" && focus.next.length > 0, `${where}: next is not a tool name`);
  expect(isObject(focus.next_args), `${where}: next_args is not an object`);
  return parsed;
}

/** A view in the core's format: identifiers only. */
export function checkView(view: unknown, where: string): void {
  expect(isObject(view), `${where}: view is ${JSON.stringify(view)}, expected the screen the page reported`);
  expect(typeof view.screen === "string" && view.screen.length > 0, `${where}: screen is not a name`);
  expect(isObject(view.params) && parseParams(view.params) !== null, `${where}: params are not keys only: ${JSON.stringify(view.params)}`);
  const s = view.selection;
  expect(s === null || (isObject(s) && typeof s.kind === "string" && typeof s.id === "string"), `${where}: selection is neither null nor { kind, id }`);
  expect(typeof view.app_url === "string" && URL.canParse(view.app_url), `${where}: app_url is not a URL`);
  expect(typeof view.updated_at === "string" && ISO.test(view.updated_at), `${where}: updated_at is not an ISO time`);
  expect(typeof view.age_seconds === "number" && view.age_seconds >= 0, `${where}: age_seconds is not a number of seconds`);
  expect(typeof view.stale === "boolean", `${where}: stale is not a boolean`);
  expect(view.next === null || typeof view.next === "string", `${where}: next is neither null nor a tool name`);
}

/** The same JSON value, whatever the order of object keys. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(a[k], b[k]));
}

/**
 * A top-level key of a tool result where the model sees it: when the result has `structuredContent`, the key is
 * in both or in neither, with the same value in the structured result and the text (a text that says something
 * else is what a text-only model would follow). With no `structuredContent` there is only the text to read; the
 * caller can tell by `structured`.
 */
export function resultKey(r: ToolCallResult, key: string): { value: unknown; structured: boolean } {
  const inText = text(r)[key];
  if (!r.structuredContent) return { value: inText, structured: false };
  const inData = r.structuredContent[key];
  expect((inText === undefined) === (inData === undefined), `${key} is in the structured result or the text, not both`);
  if (inData !== undefined && !sameJson(inData, inText)) {
    throw new ConformanceError(`${key} differs between the structured result and the text: ${String(JSON.stringify(inData)).slice(0, 120)} vs ${String(JSON.stringify(inText)).slice(0, 120)}`);
  }
  return { value: inData, structured: true };
}

/** The attention key, where the model sees it: in the structured result and in the text, the same. */
export function attentionOf(r: ToolCallResult): unknown {
  return resultKey(r, "attention").value;
}

/** What `tools/list` must say about the core tools (shared by the suite and the CLI). */
export function checkCoreToolList(listed: unknown, coreTools: readonly string[]): void {
  const tools = (listed as { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> } | null)?.tools;
  expect(Array.isArray(tools), "tools/list has no tools");
  for (const name of coreTools) expect(tools.some((t) => t.name === name), `${name} is not listed`);
  const view = tools.find((t) => t.name === "get_current_view")!;
  expect(!(view.inputSchema?.required as unknown[] | undefined)?.length, "get_current_view takes no required arguments");
  const wait = tools.find((t) => t.name === "wait_for_focus")!;
  const timeout = (wait.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined)?.timeout_s;
  expect(timeout && (timeout.type === "integer" || timeout.type === "number") && timeout.minimum === 1, "wait_for_focus takes timeout_s, a whole number from 1");
  expect(!((wait.inputSchema?.required as unknown[] | undefined) ?? []).includes("timeout_s"), "timeout_s is optional");
}

/**
 * Whether checks written for the standard `own` can judge an app that claims `claimed` in its apc.json:
 * any version from 0.5.0 (apc.json exists since) up to `own`, and also a newer patch of the same minor
 * (`own` 0.7.0, `claimed` 0.7.1), since a patch never changes the contract: that passes with a note. A newer
 * minor or major may change the contract, so it fails: the checks need updating.
 */
export function standardSupport(claimed: string, own: string): { ok: true; note?: string } | { ok: false; reason: string } {
  if (!/^\d+\.\d+\.\d+$/.test(claimed)) return { ok: false, reason: `standard is ${claimed}, not a version` };
  if (compareStandard(claimed, "0.5.0") < 0) return { ok: false, reason: `standard is ${claimed}: apc.json exists since 0.5.0` };
  if (compareStandard(claimed, own) <= 0) return { ok: true };
  const [cMajor, cMinor] = claimed.split(".");
  const [oMajor, oMinor] = own.split(".");
  if (cMajor === oMajor && cMinor === oMinor) {
    return { ok: true, note: `standard ${claimed} is a newer patch of the ${own} these checks know; a patch never changes the contract, so they apply (update @tineira/apc-conformance when you can)` };
  }
  return { ok: false, reason: `standard is ${claimed}, newer than the ${own} these checks know: update @tineira/apc-conformance` };
}

/** A `RevokedAnswer` body, `revoked_by` being the app's host (the host of the grant's MCP URL). */
export function checkRevokedBody(body: unknown, host: string, what: string): void {
  expect(isRevokedAnswer(body) && ISO.test(body.revoked_at) && typeof body.message === "string" && body.message.length > 0, `${what} on a revoked grant answers { error: "revoked", revoked_by, revoked_at, message }: ${JSON.stringify(body).slice(0, 200)}`);
  expect(body.revoked_by === host, `${what} on a revoked grant: revoked_by is ${JSON.stringify(body.revoked_by)}, not the app's host ${host}`);
}

/**
 * What a revoked grant is sent besides `initialize`, `tools/list` and the tool calls: every request with the grant, whatever
 * the method, is answered revoked (spec, "Revoke from the app"). A JSON-RPC body each, as `[label, body]`; a notification has no id.
 */
export const REVOKED_PROBES: ReadonlyArray<readonly [string, string]> = [
  ["ping", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })],
  ["resources/list", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} })],
  ["prompts/list", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} })],
  ["a notification (notifications/initialized)", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })],
  ["a body that is not JSON-RPC", "{ not json"],
];

/**
 * EP-5 (APC 0.11): `P/{secret}` claims every child of `P` that fits a secret, so the app serves nothing there but its
 * grants (and the exact entries it declares). Two children no grant has (random, one with a dash and an underscore) are
 * sent a JSON-RPC POST and a plain GET, and neither may be served (no 2xx, no redirect): a single-page app's fallback
 * page, a catch-all route or a login redirect there is what the rule forbids. That an unknown grant answers 404, not
 * another 4xx, is the unknown-grant check's.
 * `status` sends one request and gives its HTTP status (a sender that throws on a redirect fails the check its own way).
 */
export async function checkNothingButGrants(origin: string, manifest: ApcManifest, status: (url: string, init: RequestInit) => Promise<number>): Promise<string | null> {
  const entries = Array.isArray(manifest.mcp.endpoints) ? manifest.mcp.endpoints.map(endpointRule).filter((e) => e !== null) : [];
  const bases = entries.filter((e) => e.secret).map((e) => e.base);
  if (!bases.length) return null;
  const declared = (Array.isArray(manifest.mcp.endpoints) ? manifest.mcp.endpoints : []).map((e) => String((e as { path?: unknown }).path ?? "").toLowerCase());
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const base of bases) {
    for (const child of [hex(16), `apc-conformance_${hex(6)}`]) {
      const path = `${base}/${child}`;
      if (declared.some((d) => d === path.toLowerCase() || d.startsWith(`${path.toLowerCase()}/`))) continue;
      const url = `${origin}${path}`;
      const post = await status(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      expect(post >= 400, `${base}/{secret}: a JSON-RPC POST to ${base}/<a secret no grant has> answers HTTP ${post}: P/{secret} claims every child of ${base}/ that fits a secret, so one that names no grant is an unknown grant, never served`);
      const get = await status(url, { method: "GET", headers: { accept: "text/html, application/json, */*" } });
      expect(get >= 400, `${base}/{secret}: a GET of ${base}/<a secret no grant has> answers HTTP ${get}: the app serves nothing but its grants on a child of ${base}/ that fits a secret, other than the exact entries it declares`);
    }
  }
  return `${bases.map((b) => `${b}/{secret}`).join(", ")}: a child that names no grant is not served`;
}
