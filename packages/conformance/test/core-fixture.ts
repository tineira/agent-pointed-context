/**
 * A minimal Direct app of the core, in plain code, for testing the suite's core checks (`core.test.ts`): apc.json with
 * a `{secret}` entry, the core tools, one pin per grant, attention, then, presence, one wait per grant (takeover,
 * refusal, cancel by `notifications/cancelled` or an HTTP abort) and revoke. It keeps everything in memory and sends
 * no wait events (they are optional).
 *
 * `break` makes it wrong in one way, as a real app might be: each negative test pairs one break with the check that
 * must catch it. The variant `structuredRevokedError` (the revoked tool error carries the RevokedAnswer as
 * structuredContent too) is a design the spec allows, which must pass.
 */
import { APC_STANDARD_VERSION, WAIT_CLAIM_GAP_S, revokedAnswer, type FocusTarget, type PresenceMessage } from "@tineira/apc-protocol";
import type { ApcAppAdapter } from "../src/index.ts";

export type CoreBreak =
  // Revoke (REV-2) and the revoked tool error.
  | "revoked_serves_ping"
  | "revoked_takes_notifications"
  | "revoked_parses_first"
  | "revoked_by_other_host"
  | "revoked_error_with_data"
  | "revoke_cuts_everyone"
  // then (THEN-3, and the loop hint).
  | "then_on_timeout"
  | "then_on_taken_over"
  | "then_on_refused"
  | "then_on_cancelled"
  | "then_page_closed"
  // The pin, attention and presence.
  | "attention_structured_only"
  | "presence_no_target"
  | "pin_marked_seen_by_poll"
  // One wait per grant.
  | "no_takeover"
  | "cancel_ignored"
  // Under P/{secret} (EP-5).
  | "spa_fallback";

export interface CoreFixtureOptions {
  break?: CoreBreak;
  /** The revoked tool error carries the RevokedAnswer in structuredContent too (allowed). */
  structuredRevokedError?: boolean;
}

export const CORE_ORIGIN = "https://core.test";
const HOST = new URL(CORE_ORIGIN).host;
const POLL_MS = 100;

interface Grant {
  id: string;
  secret: string;
  revokedAt: string | null;
  pin: FocusTarget | null;
  pinnedAt: number;
  unread: boolean;
  /** The one place for a wait: its token and when it was claimed. */
  slot: { token: number; at: number } | null;
  /** Calls in flight, by JSON-RPC id: cancelled by notifications/cancelled. */
  inflight: Map<string, { cancelled: boolean }>;
}

const random = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) => Response.json(body, { status });
const TOOLS = [
  { name: "get_current_view", inputSchema: { type: "object", properties: {} } },
  { name: "wait_for_focus", inputSchema: { type: "object", properties: { timeout_s: { type: "integer", minimum: 1, maximum: 50 } } } },
  { name: "list_orders", inputSchema: { type: "object", properties: {} } },
  { name: "get_order", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

/** The fixture and its adapter. */
export function coreFixture(options: CoreFixtureOptions = {}): { adapter: ApcAppAdapter } {
  const has = (b: CoreBreak) => options.break === b;
  const grants: Grant[] = [];
  const page = { open: false, viewAt: 0, presence: [] as PresenceMessage[] };
  let tokens = 0;
  const now = () => Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const focusOf = (g: Grant) => ({ ...g.pin!, app_url: `${CORE_ORIGIN}/orders`, pinned_at: iso(g.pinnedAt), next: "get_order", next_args: { id: g.pin!.id } });
  const revokedBody = (g: Grant) => revokedAnswer(has("revoked_by_other_host") ? "elsewhere.test" : HOST, g.revokedAt!);
  const thenRides = (g: Grant) => has("then_page_closed") ? !!g.pin : page.open && !!g.pin && now() - g.pinnedAt < 30 * 60_000;
  const THEN = "After you answer, call wait_for_focus.";

  const result = (payload: Record<string, unknown>, isError = false) => {
    const inText = has("attention_structured_only") ? Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "attention")) : payload;
    return { content: [{ type: "text", text: JSON.stringify(inText) }], structuredContent: payload, ...(isError ? { isError: true } : {}) };
  };

  const apcJson = () =>
    new Response(JSON.stringify({ name: "Core", standard: APC_STANDARD_VERSION, origin: CORE_ORIGIN, profiles: ["direct"], mcp: { path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["direct"] }] }, direct: { connect: `${CORE_ORIGIN}/agents` } }), {
      headers: { "content-type": "application/json" },
    });

  /** wait_for_focus: one place per grant; a newer wait takes over; a second within the gap is refused. */
  async function wait(g: Grant, timeoutS: number, call: { cancelled: boolean }, signal: AbortSignal): Promise<{ payload: Record<string, unknown>; isError?: boolean; noFocus: "timeout" | "taken" | "refused" | "cancelled" | "closed" | null }> {
    if (g.unread) {
      g.unread = false;
      return { payload: { focus: focusOf(g), timed_out: false }, noFocus: null };
    }
    if (!page.open) return { payload: { focus: null, timed_out: false, page_open: false, note: "The person has no page of Core open." }, noFocus: "closed" };
    if (g.slot && now() - g.slot.at < WAIT_CLAIM_GAP_S * 1000) return { payload: { focus: null, timed_out: false, retry_after_s: WAIT_CLAIM_GAP_S, note: "Another wait just started on this agent." }, noFocus: "refused" };
    const token = ++tokens;
    if (!has("no_takeover") || !g.slot) g.slot = { token, at: now() };
    const end = now() + timeoutS * 1000;
    const release = () => {
      if (g.slot?.token === token) g.slot = null;
    };
    for (;;) {
      await sleep(POLL_MS);
      if (g.revokedAt) {
        release();
        return { payload: { ...revokedBody(g) }, isError: true, noFocus: null };
      }
      if ((call.cancelled || signal.aborted) && !has("cancel_ignored")) {
        release();
        return { payload: { focus: null, timed_out: false, note: "Cancelled." }, noFocus: "cancelled" };
      }
      if (g.slot?.token !== token && !has("no_takeover")) return { payload: { focus: null, timed_out: false, note: "A newer wait took over." }, noFocus: "taken" };
      if (g.unread) {
        release();
        g.unread = false;
        return { payload: { focus: focusOf(g), timed_out: false }, noFocus: null };
      }
      if (!page.open) {
        release();
        return { payload: { focus: null, timed_out: false, page_open: false, note: "The person closed the page." }, noFocus: "closed" };
      }
      if (now() >= end) {
        release();
        return { payload: { focus: null, timed_out: true, note: "No pin came." }, noFocus: "timeout" };
      }
    }
  }

  async function tool(g: Grant, name: string, args: Record<string, unknown>, call: { cancelled: boolean }, signal: AbortSignal) {
    let payload: Record<string, unknown>;
    let targets: Array<{ kind: string; id: string }> = [];
    let noThen = false;
    if (name === "get_current_view") {
      const view = page.viewAt ? { screen: "orders", params: {}, selection: null, app_url: `${CORE_ORIGIN}/orders`, updated_at: iso(page.viewAt), age_seconds: Math.floor((now() - page.viewAt) / 1000), stale: false, next: "list_orders" } : null;
      payload = { view, focus: g.unread ? focusOf(g) : null };
      g.unread = false;
    } else if (name === "wait_for_focus") {
      const w = await wait(g, Math.min(Math.max(Number(args.timeout_s ?? 25), 1), 50), call, signal);
      if (w.isError) return revokedToolError(g);
      payload = w.payload;
      noThen = w.noFocus !== null;
      const brokenThen = (w.noFocus === "timeout" && has("then_on_timeout")) || (w.noFocus === "taken" && has("then_on_taken_over")) || (w.noFocus === "refused" && has("then_on_refused")) || (w.noFocus === "cancelled" && has("then_on_cancelled"));
      if (brokenThen && thenRides(g)) payload.then = THEN;
    } else if (name === "list_orders") {
      payload = { orders: [{ id: "ord_1" }, { id: "ord_2" }] };
      if (has("pin_marked_seen_by_poll")) g.unread = false;
    } else if (name === "get_order" && typeof args.id === "string") {
      payload = { order: { id: args.id, total: "12.50" } };
      targets = has("presence_no_target") ? [] : [{ kind: "order", id: args.id }];
    } else return result({ error: "unknown_tool", message: name }, true);
    if (g.revokedAt) return revokedToolError(g);
    if (g.unread) payload.attention = { focus: focusOf(g), note: "The person pointed you at something: call get_current_view." };
    if (!noThen && thenRides(g)) payload.then = THEN;
    page.presence.push({ v: 1, grant_id: g.id, at: iso(now()), tool: name, kind: "read", targets, count: targets.length });
    return result(payload);
  }

  function revokedToolError(g: Grant) {
    const body = { ...revokedBody(g), ...(has("revoked_error_with_data") ? { view: null, focus: null } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(body) }], ...(options.structuredRevokedError ? { structuredContent: body } : {}), isError: true };
  }

  async function mcp(request: Request, secret: string): Promise<Response> {
    const g = grants.find((x) => x.secret === secret);
    if (!g) return json({ error: "not_found" }, 404);
    if (g.revokedAt) {
      // (revoked_*: a request served before the grant is checked, as a careless app's router does.)
      if (request.method === "POST" && (has("revoked_serves_ping") || has("revoked_takes_notifications") || has("revoked_parses_first"))) {
        const raw = await request.clone().text();
        let rpc: { id?: unknown; method?: unknown } | null = null;
        try {
          rpc = JSON.parse(raw) as { id?: unknown; method?: unknown };
        } catch {
          if (has("revoked_parses_first")) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
        }
        if (has("revoked_serves_ping") && rpc?.method === "ping") return json({ jsonrpc: "2.0", id: rpc.id, result: {} });
        if (has("revoked_takes_notifications") && rpc && rpc.id === undefined) return new Response(null, { status: 202 });
      }
      return json(revokedBody(g), 403);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const rpc = (await request.json().catch(() => null)) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; requestId?: unknown } } | null;
    if (!rpc || typeof rpc.method !== "string") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") {
        const call = g.inflight.get(String(rpc.params?.requestId));
        if (call) call.cancelled = true;
      }
      return new Response(null, { status: 202 });
    }
    const reply = (r: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result: r });
    if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "core", version: "1" } });
    if (rpc.method === "ping") return reply({});
    if (rpc.method === "tools/list") return reply({ tools: TOOLS });
    if (rpc.method !== "tools/call") return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    const call = { cancelled: false };
    const key = String(rpc.id);
    g.inflight.set(key, call);
    try {
      return reply(await tool(g, rpc.params?.name ?? "", rpc.params?.arguments ?? {}, call, request.signal));
    } finally {
      if (g.inflight.get(key) === call) g.inflight.delete(key);
    }
  }

  async function fetchApp(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/apc.json") return apcJson();
    if (url.pathname.startsWith("/mcp/")) {
      const rest = url.pathname.slice("/mcp/".length);
      // (spa_fallback: a GET the router does not know gets the app's page, as a static host serves it.)
      if (has("spa_fallback") && request.method === "GET" && !grants.some((x) => x.secret === rest)) return new Response("<!doctype html><title>Core</title>", { headers: { "content-type": "text/html" } });
      return mcp(request, rest);
    }
    return json({ error: "not_found" }, 404);
  }

  const revoke = (grantId: string) => {
    const hit = grants.filter((x) => (has("revoke_cuts_everyone") ? true : x.id === grantId) && !x.revokedAt);
    if (!hit.some((x) => x.id === grantId)) return false;
    for (const x of hit) x.revokedAt = iso(now());
    return true;
  };
  const pin = (grantId: string, target: FocusTarget) => {
    const g = grants.find((x) => x.id === grantId);
    if (!g || g.revokedAt) return false;
    g.pin = target;
    g.pinnedAt = now();
    g.unread = true;
    return true;
  };

  const adapter: ApcAppAdapter = {
    name: "Core",
    profile: "direct",
    fetch: fetchApp,
    async connect() {
      const g: Grant = { id: `g_${random(8)}`, secret: random(22), revokedAt: null, pin: null, pinnedAt: 0, unread: false, slot: null, inflight: new Map() };
      grants.push(g);
      return { grantId: g.id, mcpUrl: `${CORE_ORIGIN}/mcp/${g.secret}` };
    },
    targets: [
      { kind: "order", id: "ord_1", part: null, params: null },
      { kind: "order", id: "ord_2", part: null, params: null },
    ],
    probe: { tool: "list_orders", args: {} },
    page: {
      setOpen(open) {
        page.open = open;
      },
      async showView() {
        page.viewAt = now();
      },
      pin: async (grantId, target) => pin(grantId, target),
      takePresence: () => page.presence.splice(0),
      revoke: async (grantId) => revoke(grantId),
      mobile: {
        async agentBar() {
          return { visible: grants.filter((x) => !x.revokedAt).map((x) => x.id), collapsible: false };
        },
        pinByTouch: async (grantId, target) => pin(grantId, target),
        async unpinByTouch(grantId) {
          const g = grants.find((x) => x.id === grantId);
          if (!g) return false;
          g.pin = null;
          g.unread = false;
          return true;
        },
      },
    },
  };
  return { adapter };
}
