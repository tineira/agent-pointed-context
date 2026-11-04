/**
 * The APC conformance suite (APC 0.2, TIN-577): checks that an app implements the core of the standard
 * (`core.ts` in @apc/protocol), on either profile, through its MCP endpoint, the way an agent or a
 * dock's hub reaches it. What happens in the person's page (the view they report, the pin they drop,
 * the presence the app shows them, Revoke in the agent bar) comes through a small adapter the app
 * provides, since only the app knows its page.
 *
 * Framework-free: `apcConformance(app)` returns named checks that throw `ConformanceError`, for any
 * test runner (`for (const c of apcConformance(app)) test(c.name, c.run)` under `node --test`), and
 * `runConformance(app)` runs them all and reports.
 */
import {
  CORE_TOOLS,
  REVOKED_ERROR,
  REVOKED_HTTP_STATUS,
  canonicalTarget,
  isRevokedAnswer,
  parseParams,
  parseTarget,
  type ApcProfile,
  type FocusTarget,
  type PresenceEvent,
} from "@apc/protocol";

/** One agent's way into the app: the MCP URL its holder calls (the agent itself, or a dock's hub) and the app's id for the grant. */
export interface AgentConnection {
  mcpUrl: string;
  grantId: string;
}

/** What the suite needs from an app. */
export interface ApcAppAdapter {
  /** The app's name, for the report. */
  name: string;
  profile: ApcProfile;
  /** Sends one HTTP request to the app; the global fetch when left out (a deployed app). An app run in process routes to its handler. */
  fetch?: (request: Request) => Promise<Response>;
  /** A new agent with full access, made the way the profile makes one (a grant in the app, or a pairing through a hub), with no pin yet. */
  connect(): Promise<AgentConnection>;
  /** Two different targets on the person's screen that a full-access agent may be pinned to. */
  targets: readonly [FocusTarget, FocusTarget];
  /** One of the app's own read tools that does not read the pin, with valid arguments: the suite checks that `attention` rides on any result. */
  probe: { tool: string; args: Record<string, unknown> };
  /** The person's page, as the app sees it. */
  page: {
    /** The person has a page of the app open (true) or none (false). */
    setOpen(open: boolean): void | Promise<void>;
    /** The page reports the screen the person is on. */
    showView(): Promise<void>;
    /** The person drops the agent's mark on a target; false when the app refuses the pin. */
    pin(grantId: string, target: FocusTarget): Promise<boolean>;
    /** The presence events the app published to the person's page since the last call, oldest first. */
    takePresence(): PresenceEvent[];
    /** The person's Revoke in the agent bar; false when the app refuses. */
    revoke(grantId: string): Promise<boolean>;
  };
}

export class ConformanceError extends Error {}

export interface ConformanceCheck {
  name: string;
  run(): Promise<void>;
}

export interface ConformanceReport {
  app: string;
  profile: ApcProfile;
  passed: number;
  failed: number;
  results: Array<{ name: string; ok: boolean; error?: string }>;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** One JSON-RPC request over Streamable HTTP, stateless, as a dock's hub sends it: the HTTP status and the reply. */
async function send(app: ApcAppAdapter, url: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await (app.fetch ? app.fetch(request) : fetch(request));
  const text = await response.text();
  let body: unknown = null;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5)) as unknown;
        if (isObject(parsed) && ("result" in parsed || "error" in parsed)) body = parsed;
      } catch {
        // not a message
      }
    }
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function result(app: ApcAppAdapter, url: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const { status, body } = await send(app, url, method, params);
  expect(status === 200, `${method}: HTTP ${status}, expected 200 (${JSON.stringify(body).slice(0, 200)})`);
  expect(isObject(body) && !("error" in body && body.error), `${method}: JSON-RPC error ${JSON.stringify(body).slice(0, 200)}`);
  return (body as { result?: unknown }).result;
}

async function call(app: ApcAppAdapter, url: string, tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const r = await result(app, url, "tools/call", { name: tool, arguments: args });
  expect(isObject(r), `${tool}: no result`);
  return r as ToolCallResult;
}

/** The structured result, or the JSON of the first text block (what a model that sees only text reads). */
function data(r: ToolCallResult): Record<string, unknown> {
  if (r.structuredContent) return r.structuredContent;
  return text(r);
}
function text(r: ToolCallResult): Record<string, unknown> {
  const first = r.content?.[0];
  try {
    const parsed = first?.type === "text" && first.text ? (JSON.parse(first.text) as unknown) : null;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A focus in the core's format, naming `target`. */
function checkFocus(focus: unknown, target: FocusTarget, where: string): Record<string, unknown> {
  expect(isObject(focus), `${where}: focus is ${JSON.stringify(focus)}, expected an object`);
  const parsed = parseTarget({ kind: focus.kind, id: focus.id, part: focus.part, params: focus.params });
  expect(parsed, `${where}: the focus is not a valid target: ${JSON.stringify({ kind: focus.kind, id: focus.id, part: focus.part, params: focus.params })}`);
  expect(canonicalTarget(parsed) === canonicalTarget(target), `${where}: the focus names ${canonicalTarget(parsed)}, the pin was ${canonicalTarget(target)}`);
  expect(typeof focus.app_url === "string" && URL.canParse(focus.app_url), `${where}: app_url is not a URL`);
  expect(typeof focus.pinned_at === "string" && ISO.test(focus.pinned_at), `${where}: pinned_at is not an ISO time`);
  expect(typeof focus.next === "string" && focus.next.length > 0, `${where}: next is not a tool name`);
  expect(isObject(focus.next_args), `${where}: next_args is not an object`);
  return focus;
}

/** A view in the core's format: identifiers only. */
function checkView(view: unknown, where: string): void {
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

/** The attention key, where the model sees it: in the structured result and in the text. */
function attentionOf(r: ToolCallResult): unknown {
  const inText = text(r).attention;
  const inData = data(r).attention;
  expect((inText === undefined) === (inData === undefined), "attention is in the structured result or the text, not both");
  return inData;
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work;
  return { value, ms: Date.now() - started };
}

/** The checks of the core, in order. Each makes its own agents, so any one can run alone. */
export function apcConformance(app: ApcAppAdapter): ConformanceCheck[] {
  const [first, second] = app.targets;
  const check = (name: string, run: () => Promise<void>): ConformanceCheck => ({ name: `${app.name} (${app.profile}): ${name}`, run });

  return [
    check("lists the core tools, with their arguments", async () => {
      const { mcpUrl } = await app.connect();
      const listed = (await result(app, mcpUrl, "tools/list")) as { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> };
      expect(Array.isArray(listed?.tools), "tools/list has no tools");
      for (const name of CORE_TOOLS) expect(listed.tools.some((t) => t.name === name), `${name} is not listed`);
      const view = listed.tools.find((t) => t.name === "get_current_view")!;
      expect(!(view.inputSchema?.required as unknown[] | undefined)?.length, "get_current_view takes no required arguments");
      const wait = listed.tools.find((t) => t.name === "wait_for_focus")!;
      const timeout = (wait.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined)?.timeout_s;
      expect(timeout && (timeout.type === "integer" || timeout.type === "number") && timeout.minimum === 1, "wait_for_focus takes timeout_s, a whole number from 1");
      expect(!((wait.inputSchema?.required as unknown[] | undefined) ?? []).includes("timeout_s"), "timeout_s is optional");
    }),

    check("get_current_view returns the view as identifiers, and no focus before a pin", async () => {
      const { mcpUrl } = await app.connect();
      await app.page.setOpen(true);
      await app.page.showView();
      const r = await call(app, mcpUrl, "get_current_view");
      expect(!r.isError, "get_current_view failed");
      const d = data(r);
      expect("view" in d && "focus" in d, "the result has view and focus");
      expect(d.focus === null, "no pin yet, so no focus");
      checkView(d.view, "get_current_view");
      expect(attentionOf(r) === undefined, "no pin, so no attention");
    }),

    check("a pin rides as attention on any result until it is read, and next reads it", async () => {
      const { mcpUrl, grantId } = await app.connect();
      expect(await app.page.pin(grantId, first), "the app refused a pin on the first target");
      const probed = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(!probed.isError, `${app.probe.tool} failed`);
      const attention = attentionOf(probed);
      expect(isObject(attention) && typeof attention.note === "string", "an unread pin puts attention { focus, note } on the result");
      checkFocus(attention.focus, first, "attention");

      const view = await call(app, mcpUrl, "get_current_view");
      const focus = checkFocus(data(view).focus, first, "get_current_view");
      const after = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(attentionOf(after) === undefined, "reading the focus marks it seen: no attention after");

      const read = await call(app, mcpUrl, focus.next as string, focus.next_args as Record<string, unknown>);
      expect(!read.isError, `next (${String(focus.next)}) with next_args failed: ${JSON.stringify(read.content).slice(0, 200)}`);

      // One pin per grant: a new drop replaces it, unread again.
      expect(await app.page.pin(grantId, second), "the app refused a pin on the second target");
      const again = attentionOf(await call(app, mcpUrl, app.probe.tool, app.probe.args));
      expect(isObject(again), "a new pin is unread again");
      checkFocus(again.focus, second, "attention after a second pin");
    }),

    check("wait_for_focus returns a pin dropped during the wait", async () => {
      const { mcpUrl, grantId } = await app.connect();
      await app.page.setOpen(true);
      const waiting = timed(call(app, mcpUrl, "wait_for_focus", { timeout_s: 10 }));
      await sleep(300);
      expect(await app.page.pin(grantId, second), "the app refused the pin");
      const { value: r, ms } = await waiting;
      expect(!r.isError, "wait_for_focus failed");
      const d = data(r);
      expect(d.timed_out === false, "a wait that got a pin did not time out");
      checkFocus(d.focus, second, "wait_for_focus");
      expect(ms < 9000, `it returned at ${ms} ms, not soon after the pin`);
      const after = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(attentionOf(after) === undefined, "the wait marks the pin seen");
    }),

    check("wait_for_focus times out cleanly", async () => {
      const { mcpUrl } = await app.connect();
      await app.page.setOpen(true);
      const { value: r, ms } = await timed(call(app, mcpUrl, "wait_for_focus", { timeout_s: 1 }));
      expect(!r.isError, "wait_for_focus failed");
      const d = data(r);
      expect(d.focus === null && d.timed_out === true, `a wait with no pin times out: ${JSON.stringify(d)}`);
      expect(typeof d.note === "string" && d.note.length > 0, "a wait with no pin carries a note for the agent");
      expect(d.page_open === undefined || d.page_open === true, "the page is open, so page_open is true or left out");
      expect(ms >= 900 && ms < 5000, `it took ${ms} ms for timeout_s 1`);
      expect(text(r).then === undefined && d.then === undefined, "a wait that came back empty ends the loop: no then");
    }),

    check("wait_for_focus ends when the person has no page open", async () => {
      const { mcpUrl } = await app.connect();
      await app.page.setOpen(false);
      const { value: r, ms } = await timed(call(app, mcpUrl, "wait_for_focus", { timeout_s: 3 }));
      const d = data(r);
      expect(d.focus === null, "no pin, no focus");
      if (d.page_open === undefined) expect(d.timed_out === true, "an app that cannot tell runs to the timeout");
      else {
        expect(d.page_open === false && d.timed_out === false, `a closed page: page_open false, timed_out false (${JSON.stringify(d)})`);
        expect(ms < 2900, `a closed page ends the wait before its timeout (${ms} ms)`);
      }
      await app.page.setOpen(true);
    }),

    check("then rides on results only while the person's page is open", async () => {
      const { mcpUrl } = await app.connect();
      await app.page.setOpen(true);
      const open = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(typeof data(open).then === "string" && typeof text(open).then === "string", "with the page open, a result carries then, structured and in the text");
      await app.page.setOpen(false);
      const closed = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(data(closed).then === undefined && text(closed).then === undefined, "with no page open, no then");
      await app.page.setOpen(true);
    }),

    check("presence names what a read touched, with ids only", async () => {
      const { mcpUrl, grantId } = await app.connect();
      await app.page.setOpen(true);
      expect(await app.page.pin(grantId, first), "the app refused the pin");
      const focus = checkFocus(data(await call(app, mcpUrl, "get_current_view")).focus, first, "get_current_view");
      app.page.takePresence();
      const read = await call(app, mcpUrl, focus.next as string, focus.next_args as Record<string, unknown>);
      expect(!read.isError, "next failed");
      const events = app.page.takePresence().filter((e) => e.grant_id === grantId && e.tool === focus.next);
      expect(events.length === 1, `one presence event for the read, got ${events.length}`);
      const e = events[0]!;
      expect(Object.keys(e).sort().join() === "at,count,grant_id,kind,targets,tool,v", `presence carries ids only: ${Object.keys(e).join()}`);
      expect(e.v === 1 && (e.kind === "read" || e.kind === "write") && ISO.test(e.at), "presence is v 1, read or write, with an ISO time");
      expect(Array.isArray(e.targets) && e.targets.length <= 20 && e.count >= e.targets.length, "at most 20 targets, and count covers them");
      expect(e.targets.every((t) => Object.keys(t).sort().join() === "id,kind"), "a presence target is { kind, id }");
      if (first.id) expect(e.targets.some((t) => t.kind === first.kind && t.id === first.id), `the read of ${first.kind}:${first.id} names it`);
    }),

    check("revoke from the app cuts that agent at once, and only that agent", async () => {
      const a = await app.connect();
      const b = await app.connect();
      await app.page.setOpen(true);
      expect(await app.page.pin(a.grantId, first), "the app refused the pin");
      expect(await app.page.revoke(a.grantId), "the app refused to revoke");
      for (const [method, params] of [["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-conformance", version: "0" } }], ["tools/list", {}], ["tools/call", { name: "get_current_view", arguments: {} }], ["tools/call", { name: app.probe.tool, arguments: app.probe.args }]] as const) {
        const { status, body } = await send(app, a.mcpUrl, method, params);
        expect(status === REVOKED_HTTP_STATUS, `${method} on a revoked grant: HTTP ${status}, expected ${REVOKED_HTTP_STATUS}`);
        expect(isRevokedAnswer(body) && body.revoked_by.length > 0 && ISO.test(body.revoked_at), `${method} on a revoked grant answers { error: "revoked", revoked_by, revoked_at }: ${JSON.stringify(body).slice(0, 200)}`);
      }
      // Whatever the HTTP method: a GET (the SSE stream) or a DELETE (ending a session) is answered "revoked" too, not 405.
      for (const method of ["GET", "DELETE"]) {
        const request = new Request(a.mcpUrl, { method, headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });
        const response = await (app.fetch ? app.fetch(request) : fetch(request));
        const text = await response.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        expect(response.status === REVOKED_HTTP_STATUS, `${method} on a revoked grant: HTTP ${response.status}, expected ${REVOKED_HTTP_STATUS}`);
        expect(isRevokedAnswer(body), `${method} on a revoked grant answers { error: "revoked", revoked_by, revoked_at }: ${text.slice(0, 200)}`);
      }
      expect(!(await app.page.pin(a.grantId, second)), "a revoked agent cannot be pinned");
      const other = await call(app, b.mcpUrl, "get_current_view");
      expect(!other.isError && "view" in data(other), "another agent is not touched");
    }),

    check("a call already running when the grant is revoked ends revoked, with no data", async () => {
      const { mcpUrl, grantId } = await app.connect();
      await app.page.setOpen(true);
      const waiting = timed(call(app, mcpUrl, "wait_for_focus", { timeout_s: 10 }));
      await sleep(300);
      expect(await app.page.revoke(grantId), "the app refused to revoke");
      const { value: r, ms } = await waiting;
      expect(r.isError === true, `the wait ends as an error: ${JSON.stringify(r).slice(0, 200)}`);
      const d = text(r);
      expect(d.error === REVOKED_ERROR, `its error is "revoked": ${JSON.stringify(d).slice(0, 200)}`);
      expect(!("focus" in d) && !("view" in d) && r.structuredContent === undefined, "it carries no focus, view or other data");
      expect(ms < 9000, `it ended at ${ms} ms, not soon after the revoke`);
    }),
  ];
}

/** Every check, one after another: what passed and what failed, with why. */
export async function runConformance(app: ApcAppAdapter): Promise<ConformanceReport> {
  const results: ConformanceReport["results"] = [];
  for (const c of apcConformance(app)) {
    try {
      await c.run();
      results.push({ name: c.name, ok: true });
    } catch (error) {
      results.push({ name: c.name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return { app: app.name, profile: app.profile, passed: results.length - failed, failed, results };
}
