/**
 * What the in-process suite (`index.ts`) and the HTTP checks (`http.ts`) share: the error a check
 * throws, how a JSON-RPC reply is read off Streamable HTTP, and the shapes of the core's view and focus.
 */
import { parseParams, parseTarget, type FocusTarget } from "@tineira/apc-protocol";

export class ConformanceError extends Error {}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
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
