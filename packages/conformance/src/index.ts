/**
 * The APC conformance suite (APC 0.2, TIN-577; `apc_link` since 0.3, TIN-578): checks that an app
 * implements the core of the standard (`core.ts` in @tineira/apc-protocol), on either profile, through its MCP
 * endpoint, the way an agent or a dock's hub reaches it, and, for an app that offers both profiles,
 * `apc_link` (give `link` in the adapter). What happens in the person's page (the view they report, the pin they drop,
 * the presence the app shows them, Revoke in the agent bar) comes through a small adapter the app
 * provides, since only the app knows its page. Since 0.5 it also reads the app's `apc.json`
 * (`GET {origin}/.well-known/apc.json`, through the adapter's `fetch`): its shape, its origin, the
 * standard, and that its profiles and `mcp.path` match what the app serves. Since 0.6 an adapter may
 * also give `page.mobile` (the page on a phone): the suite then checks that every agent is shown in the
 * page, that the bar cannot be collapsed, and that a finger can pin and unpin with no mouse drag.
 *
 * Framework-free: `apcConformance(app)` returns named checks that throw `ConformanceError`, for any
 * test runner (`for (const c of apcConformance(app)) test(c.name, c.run)` under `node --test`), and
 * `runConformance(app)` runs them all and reports.
 *
 * Against a live app with no adapter, `httpConformance` / `runHttpConformance` (`http.ts`) run the part
 * of the suite that HTTP reaches (apc.json, and with a grant's MCP URL the core tools' shapes and timing,
 * and a revoked grant's answer); the `apc-conformance` command (`cli.ts`) runs them from a terminal.
 */
import {
  APC_AGENT_CLIENT_META,
  APC_JSON_MAX_BYTES,
  APC_JSON_PATH,
  APC_MOBILE_VIEWPORT,
  APC_STANDARD_VERSION,
  APC_LINK_KEY,
  APC_LINK_TOOL,
  APC_LINK_TTL_S,
  CORE_TOOLS,
  LINK_REFUSED_ERROR,
  REVOKED_ERROR,
  REVOKED_HTTP_STATUS,
  canonicalTarget,
  compareStandard,
  declaresMcpUrl,
  isRevokedAnswer,
  parseApcManifest,
  type ApcLinkRefusal,
  type ApcProfile,
  type FocusTarget,
  type PresenceEvent,
} from "@tineira/apc-protocol";
import { ConformanceError, ISO, attentionOf, checkCoreToolList, checkFocusShape, checkView, data, expect, isObject, resultKey, rpcBody, standardSupport, text, type ToolCallResult } from "./shared.ts";

export { ConformanceError } from "./shared.ts";
export {
  HttpConformanceUsageError,
  IN_PROCESS_ONLY,
  httpConformance,
  redactGrantUrl,
  redactSecrets,
  runHttpConformance,
  type HttpCheck,
  type HttpCheckResult,
  type HttpConformanceOptions,
  type HttpConformanceReport,
} from "./http.ts";

/** One agent's way into the app: the MCP URL its holder calls (the agent itself, or a dock's hub) and the app's id for the grant. */
export interface AgentConnection {
  mcpUrl: string;
  grantId: string;
}

/**
 * What the `apc_link` checks need (APC 0.4), from an app that offers both profiles. The suite makes the
 * connections arrive itself: an agent's own `initialize` on Direct, a hub's (naming the agent's client
 * in `_meta`) on Dock.
 */
export interface ApcLinkAdapter {
  /** A new agent with full access on this path, made the way the profile makes one, with no pin and no `initialize` yet. */
  connect(path: ApcProfile): Promise<AgentConnection>;
  /** The agents the agent bar shows: each entry's grants, two for a linked agent. */
  agents(): Promise<Array<{ grants: string[] }>>;
  /** The person's Unlink in the agent bar; false when the app refuses. */
  unlink(grantId: string): Promise<boolean>;
  /** Makes every code the app gave expire now, as if two minutes passed. Without it the check waits the code out (APC_LINK_TTL_S). */
  expireCodes?(): Promise<void>;
}

/**
 * The person's page on a phone (APC 0.6): a viewport of `APC_MOBILE_VIEWPORT` with a touch pointer and no
 * mouse. Optional in the adapter; with it the suite runs the mobile checks. An app's own test can model
 * the page with the pieces of @tineira/apc-web (the bar's collapse rule, tap to pin); the real thing is a browser
 * with touch emulation (`scripts/mobile-e2e.mjs` does that for Pulse and Signals).
 */
export interface ApcMobilePage {
  /**
   * What the page shows at that viewport, with these agents connected: the grants whose mark is visible in
   * the page and can be pinned from, and whether the person can collapse or hide the agent bar there.
   */
  agentBar(): Promise<{ visible: string[]; collapsible: boolean }>;
  /** The person pins with a finger, with no mouse drag: taps the agent's mark, then the target. False when the app refuses the pin. */
  pinByTouch(grantId: string, target: FocusTarget): Promise<boolean>;
  /** The person removes the agent's pin with a finger (the × beside the agent in the bar). False when the page offers no way. */
  unpinByTouch(grantId: string): Promise<boolean>;
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
    /** The page on a phone (APC 0.6). Left out: the mobile checks are skipped. */
    mobile?: ApcMobilePage;
  };
  /** An app that offers both profiles: the `apc_link` checks run too. */
  link?: ApcLinkAdapter;
}

export interface ConformanceCheck {
  name: string;
  /** Throws when the check fails. */
  run(): Promise<void>;
  /** Set by `run()` when the check passed with something worth saying (a newer patch of the standard, say). */
  note?: string;
}

/** A check whose body may resolve to `{ note }`: the note lands on the check, and `run()` stays a test body. */
function noted(name: string, body: () => Promise<void | { note: string }>): ConformanceCheck {
  const check: ConformanceCheck = {
    name,
    async run() {
      const out = await body();
      if (out?.note) check.note = out.note;
    },
  };
  return check;
}

export interface ConformanceReport {
  app: string;
  profile: ApcProfile;
  passed: number;
  failed: number;
  results: Array<{ name: string; ok: boolean; error?: string; note?: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON-RPC request over Streamable HTTP, stateless, as a dock's hub sends it: the HTTP status and the reply. */
async function send(app: ApcAppAdapter, url: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await (app.fetch ? app.fetch(request) : fetch(request));
  const body = rpcBody(response.headers.get("content-type") ?? "", await response.text());
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

/** A focus in the core's format, naming `target`. */
function checkFocus(focus: unknown, target: FocusTarget, where: string): Record<string, unknown> {
  const parsed = checkFocusShape(focus, where);
  expect(canonicalTarget(parsed) === canonicalTarget(target), `${where}: the focus names ${canonicalTarget(parsed)}, the pin was ${canonicalTarget(target)}`);
  return focus as Record<string, unknown>;
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work;
  return { value, ms: Date.now() - started };
}

/** The checks of the core, in order. Each makes its own agents, so any one can run alone. */
export function apcConformance(app: ApcAppAdapter): ConformanceCheck[] {
  const [first, second] = app.targets;
  const check = (name: string, run: () => Promise<void | { note: string }>): ConformanceCheck => noted(`${app.name} (${app.profile}): ${name}`, run);

  return [
    check("serves apc.json from its own origin, naming the profiles it serves and where its MCP URLs live", async () => {
      const { mcpUrl } = await app.connect();
      const origin = new URL(mcpUrl).origin;
      const request = new Request(`${origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
      const response = await (app.fetch ? app.fetch(request) : fetch(request));
      expect(response.status === 200, `GET ${APC_JSON_PATH}: HTTP ${response.status}, expected 200`);
      expect((response.headers.get("content-type") ?? "").includes("application/json"), `${APC_JSON_PATH} is not served as application/json`);
      const text = await response.text();
      expect(new TextEncoder().encode(text).length <= APC_JSON_MAX_BYTES, `${APC_JSON_PATH} is over ${APC_JSON_MAX_BYTES} bytes`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ConformanceError(`${APC_JSON_PATH} is not JSON`);
      }
      const parsed = parseApcManifest(body, origin);
      expect(parsed.ok, `${APC_JSON_PATH}: ${parsed.ok ? "" : `${parsed.error}, ${parsed.detail}`}`);
      const m = parsed.manifest;
      const support = standardSupport(m.standard, APC_STANDARD_VERSION);
      expect(support.ok, support.ok ? "" : `${support.reason} (this suite checks 0.5.0 up to ${APC_STANDARD_VERSION}, and newer patches of it)`);
      expect(!m.profiles.includes("hub"), "an app's profiles are direct, dock or both, never hub");
      expect(m.profiles.includes(app.profile), `profiles ${JSON.stringify(m.profiles)} leave out ${app.profile}, which the app serves`);
      if (app.link) expect(m.profiles.includes("direct") && m.profiles.includes("dock"), `profiles ${JSON.stringify(m.profiles)}: an app that links both paths offers both`);
      expect(declaresMcpUrl(m, mcpUrl), `the grant's MCP URL is not under ${origin}${m.mcp.path} (mcp.path)`);
      if (m.profiles.includes("direct")) expect(m.direct && new URL(m.direct.connect).origin === origin, "direct.connect is the app's own page");
      if (support.note) return { note: support.note };
    }),

    check("lists the core tools, with their arguments", async () => {
      const { mcpUrl } = await app.connect();
      checkCoreToolList(await result(app, mcpUrl, "tools/list"), CORE_TOOLS);
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
      // resultKey: the same value in the structured result and the text (a text-only model follows the text).
      const then = resultKey(open, "then");
      expect(typeof then.value === "string" && typeof text(open).then === "string", "with the page open, a result carries then, structured and in the text");
      await app.page.setOpen(false);
      const closed = await call(app, mcpUrl, app.probe.tool, app.probe.args);
      expect(resultKey(closed, "then").value === undefined && text(closed).then === undefined, "with no page open, no then");
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
    ...mobileChecks(app, app.page.mobile),
    ...(app.link ? linkChecks(app, app.link) : []),
  ];
}

/** The mobile rule (APC 0.6): on a phone the agents are in the page, never collapsed, and a finger can pin and unpin. */
function mobileChecks(app: ApcAppAdapter, mobile: ApcMobilePage | undefined): ConformanceCheck[] {
  const [first, second] = app.targets;
  const { width, height } = APC_MOBILE_VIEWPORT;
  const check = (name: string, run: () => Promise<void>): ConformanceCheck => ({ name: `${app.name} (${app.profile}): mobile ${width}x${height}: ${name}`, run });
  return [
    check("the page adapter for a phone is given (required of an app that claims 0.6.0 or later)", async () => {
      if (mobile) return;
      const { mcpUrl } = await app.connect();
      const request = new Request(`${new URL(mcpUrl).origin}${APC_JSON_PATH}`, { headers: { accept: "application/json" } });
      const response = await (app.fetch ? app.fetch(request) : fetch(request));
      const claimed = ((await response.json().catch(() => ({}))) as { standard?: unknown }).standard;
      expect(typeof claimed === "string" && compareStandard(claimed, "0.6.0") < 0, `apc.json claims standard ${String(claimed)}, which requires the mobile rule to be checked: give page.mobile in the adapter (ApcMobilePage: agentBar, pinByTouch, unpinByTouch)`);
    }),

    check("every agent is shown in the page, and the agent bar cannot be collapsed or hidden", async () => {
      if (!mobile) return;
      const a = await app.connect();
      const b = await app.connect();
      await app.page.setOpen(true);
      const bar = await mobile.agentBar();
      for (const { grantId } of [a, b]) expect(bar.visible.includes(grantId), `the agent ${grantId} is not shown in the page on a phone: the page shows ${JSON.stringify(bar.visible)}`);
      expect(bar.collapsible === false, "the agent bar can be collapsed or hidden on a phone: there the agent in the page is the only way to point it");
    }),

    check("a person pins with a finger, no mouse drag, and the agent reads the pin; unpin works by touch too", async () => {
      if (!mobile) return;
      const { mcpUrl, grantId } = await app.connect();
      await app.page.setOpen(true);
      await app.page.showView();
      expect(await mobile.pinByTouch(grantId, first), "the page refused a pin made by tapping the agent and then the target");
      const r = await call(app, mcpUrl, "get_current_view");
      expect(!r.isError, "get_current_view failed");
      checkFocus(data(r).focus, first, "get_current_view after a pin by touch");
      // The same again on another target: one pin per grant, replaced.
      expect(await mobile.pinByTouch(grantId, second), "the page refused a second pin by touch");
      checkFocus(data(await call(app, mcpUrl, "get_current_view")).focus, second, "get_current_view after a second pin by touch");
      expect(await mobile.unpinByTouch(grantId), "the page offers no way to remove the pin with a finger");
      const after = await call(app, mcpUrl, "get_current_view");
      expect(data(after).focus === null, "the pin is still there after the person removed it by touch");
    }),
  ];
}

/** A connection arrives: the agent's own initialize on Direct; on Dock, its hub's, naming the agent's client. */
async function arrive(app: ApcAppAdapter, conn: AgentConnection & { path: ApcProfile }, client: string): Promise<void> {
  const params =
    conn.path === "direct"
      ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1.0.0" } }
      : { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: `${client} via dock`, version: "0.1.0" }, _meta: { [APC_AGENT_CLIENT_META]: client } };
  await result(app, conn.mcpUrl, "initialize", params);
}

/** The offer on a result, where the model sees it: in the structured result and the same in the text. */
function offerOf(r: ToolCallResult): { code: string; expires_in: number; note: string } | undefined {
  const inData = data(r)[APC_LINK_KEY];
  const inText = text(r)[APC_LINK_KEY];
  expect(JSON.stringify(inData) === JSON.stringify(inText), "apc_link is the same in the structured result and the text");
  if (inData === undefined) return undefined;
  expect(isObject(inData) && typeof inData.code === "string" && inData.code.length >= 16, `apc_link is { code, expires_in, note }: ${JSON.stringify(inData)}`);
  expect(typeof inData.expires_in === "number" && inData.expires_in > 0 && inData.expires_in <= APC_LINK_TTL_S, `expires_in is 1 to ${APC_LINK_TTL_S} s`);
  expect(typeof inData.note === "string" && inData.note.includes(APC_LINK_TOOL), "its note names the apc_link tool");
  return inData as { code: string; expires_in: number; note: string };
}

/** `apc_link` (APC 0.4): the checks of an app that offers both profiles. */
function linkChecks(app: ApcAppAdapter, link: ApcLinkAdapter): ConformanceCheck[] {
  const check = (name: string, run: () => Promise<void>): ConformanceCheck => ({ name: `${app.name} (apc_link): ${name}`, run });
  let clients = 0;
  const client = () => `conformance-agent-${++clients}`;
  const connect = async (path: ApcProfile) => ({ ...(await link.connect(path)), path });
  /** The same agent, connected directly and then through a dock: the dock's connection is the new one, and gets the offer. */
  const pair = async () => {
    const name = client();
    const direct = await connect("direct");
    await arrive(app, direct, name);
    const dock = await connect("dock");
    await arrive(app, dock, name);
    const offered = await call(app, dock.mcpUrl, app.probe.tool, app.probe.args);
    expect(!offered.isError, `${app.probe.tool} failed`);
    const offer = offerOf(offered);
    expect(offer, `the second connection of ${name}, on the other path, gets apc_link on a result of one of the app's own tools`);
    return { name, direct, dock, offer };
  };
  const redeem = (conn: AgentConnection, code: string) => call(app, conn.mcpUrl, APC_LINK_TOOL, { code });
  const refused = (r: ToolCallResult, reason: ApcLinkRefusal, where: string) => {
    expect(r.isError === true, `${where}: refused, as a tool error (${JSON.stringify(r).slice(0, 200)})`);
    const d = text(r);
    expect(d.error === LINK_REFUSED_ERROR && d.reason === reason, `${where}: { error: "link_refused", reason: "${reason}" }, got ${JSON.stringify(d).slice(0, 200)}`);
  };
  const linkedEntry = async (a: string, b: string) => (await link.agents()).find((e) => e.grants.includes(a) && e.grants.includes(b));
  const works = async (conn: AgentConnection, where: string) => {
    const r = await call(app, conn.mcpUrl, "get_current_view");
    expect(!r.isError && "view" in data(r), `${where} still reads the app`);
  };

  return [
    check("the same client on the other path is offered a code once per session, and the code links them", async () => {
      const { direct, dock, offer } = await pair();
      const again = await call(app, dock.mcpUrl, app.probe.tool, app.probe.args);
      expect(offerOf(again) === undefined, "asked at most once per MCP session");
      const done = await redeem(direct, offer.code);
      expect(!done.isError && data(done).linked === true, `the other connection redeems it: ${JSON.stringify(done).slice(0, 200)}`);
      expect(await linkedEntry(direct.grantId, dock.grantId), "the agent bar shows one agent with both grants");
      // Linking grants nothing: each connection keeps its own grant.
      await works(direct, "the Direct connection");
      await works(dock, "the Dock connection");
    }),

    check("a code is refused on the connection that got it, on the same path, on another client, and once used", async () => {
      const { name, direct, dock, offer } = await pair();
      const sameSide = await connect("dock");
      await arrive(app, sameSide, name);
      const stranger = await connect("direct");
      await arrive(app, stranger, client());
      refused(await redeem(dock, offer.code), "same_connection", "on the connection that got it");
      refused(await redeem(sameSide, offer.code), "same_path", "on another connection of the same path");
      refused(await redeem(stranger, offer.code), "not_offered", "on the other path, by another client");
      refused(await redeem(direct, "lk_000000000000000000000000"), "unknown_code", "a code the app never gave");
      const done = await redeem(direct, offer.code);
      expect(!done.isError, "the right connection still redeems it");
      refused(await redeem(direct, offer.code), "used", "a second time");
      expect(!(await linkedEntry(direct.grantId, sameSide.grantId)), "nothing else was linked");
    }),

    check("an expired code is refused, and the app does not ask again in that session", async () => {
      const { direct, dock, offer } = await pair();
      if (link.expireCodes) await link.expireCodes();
      else await sleep((APC_LINK_TTL_S + 1) * 1000);
      refused(await redeem(direct, offer.code), "expired", "after expires_in");
      expect(!(await linkedEntry(direct.grantId, dock.grantId)), "it stays two agents");
      expect(offerOf(await call(app, dock.mcpUrl, app.probe.tool, app.probe.args)) === undefined, "not asked again in that session");
    }),

    check("a connection of another client is offered nothing", async () => {
      const direct = await connect("direct");
      await arrive(app, direct, client());
      const dock = await connect("dock");
      await arrive(app, dock, client());
      expect(offerOf(await call(app, dock.mcpUrl, app.probe.tool, app.probe.args)) === undefined, "no offer between two clients");
    }),

    check("revoke on a linked agent cuts both grants", async () => {
      const { direct, dock, offer } = await pair();
      expect(!(await redeem(direct, offer.code)).isError, "linked");
      expect(await app.page.revoke(dock.grantId), "the app refused to revoke");
      for (const [conn, where] of [[direct, "Direct"], [dock, "Dock"]] as const) {
        const { status, body } = await send(app, conn.mcpUrl, "tools/call", { name: "get_current_view", arguments: {} });
        expect(status === REVOKED_HTTP_STATUS && isRevokedAnswer(body), `the ${where} grant answers 403 revoked: HTTP ${status}`);
      }
    }),

    check("unlink shows two agents again, each with its own grant", async () => {
      const { direct, dock, offer } = await pair();
      expect(!(await redeem(direct, offer.code)).isError, "linked");
      expect(await link.unlink(direct.grantId), "the app refused to unlink");
      expect(!(await linkedEntry(direct.grantId, dock.grantId)), "two agents again");
      await works(direct, "the Direct connection");
      await works(dock, "the Dock connection");
      expect(await app.page.revoke(direct.grantId), "the app refused to revoke");
      await works(dock, "once unlinked, revoking one leaves the other: the Dock connection");
    }),
  ];
}

/** Every check, one after another: what passed and what failed, with why. */
export async function runConformance(app: ApcAppAdapter): Promise<ConformanceReport> {
  const results: ConformanceReport["results"] = [];
  for (const c of apcConformance(app)) {
    try {
      await c.run();
      results.push({ name: c.name, ok: true, ...(c.note ? { note: c.note } : {}) });
    } catch (error) {
      results.push({ name: c.name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return { app: app.name, profile: app.profile, passed: results.length - failed, failed, results };
}
