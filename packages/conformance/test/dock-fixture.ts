/**
 * A minimal Dock app of APC 0.10, in plain code, for testing the suite's 0.10 checks (`dock-lifecycle.test.ts`):
 * the grant's states and what each answers, the transitions, the hub call (M1 to M5, M9), the owner's endpoints
 * (M6), the give-back (M7), `apc.json` (M8) and one pending pairing. It keeps everything in memory (`Storage`,
 * which outlives a restart), and its clock is `Date.now()` plus the adapter's skew (the time seam).
 *
 * `break` makes it wrong in one way, as a real app might be: each negative test pairs one break with the check that
 * must catch it.
 */
import {
  APC_STANDARD_VERSION,
  HUB_ANSWER_MAX_BYTES,
  PAIRING_CODE_ACK,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  DOCK_GRANT_RPC_ERROR_CODE,
  dockGrantAnswer,
  dockGrantCallOf,
  idleAnswer,
  idleCurrentView,
  idleWaitForFocus,
  pairingAnswer,
  revokedAnswer,
  type DockGrantState,
  type FocusTarget,
  type PresenceEvent,
} from "@tineira/apc-protocol";
import { standInHub, type ApcAppAdapter, type ApcDockDropOutcome, type StandInHub } from "../src/index.ts";

export type FixtureBreak =
  | "in_flight_serves"
  | "any_request_405"
  | "notification_by_id_only"
  | "handoff_serves_data"
  | "attention_in_handoff"
  | "tool_error_text_only"
  | "initialize_no_commit"
  | "idle_without_flag"
  | "ended_answers_revoked"
  | "revoked_answers_404"
  | "initialize_swallows_write_error"
  | "cancel_live"
  | "ack_unconditional"
  | "t_ack_ignored"
  | "t_connect_ignored"
  | "heartbeat_does_not_wake"
  | "traffic_wakes"
  | "allowlist_by_origin_only"
  | "follows_redirects"
  | "no_deadline_on_body"
  | "trusts_content_length"
  | "lock_across_call"
  | "raw_hub_string"
  | "no_origin_check"
  | "revoke_404_unknown"
  | "dock_always_listed"
  | "max_age_300"
  | "new_code_on_pending"
  | "keeps_grant_on_not_paired"
  | "confirm_paired_goes_live"
  | "stale_allow_accepted";

export const ORIGIN = "https://fixture.test";
export const HUB = "https://dock.test";
const SESSION = { cookie: "session=owner" };
export const IDLE_MS = 60_000;
/** The fixture's deadline on a hub call: under the standard's 10 s, so the checks run fast. */
const DEADLINE_MS = 3_000;
const CODE_TTL_MS = 120_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Grant {
  id: string;
  secret: string;
  agent: string;
  hub: string;
  state: "in_flight" | "handoff" | "live" | "ended" | "revoked";
  allowedAt: number;
  ackedAt: number;
  lastWake: number;
  served: boolean;
  code: string;
  codeExpiresAt: number;
  pin: FocusTarget | null;
  pinnedAt: number;
  pinUnread: boolean;
  revokedAt: string | null;
}
interface Consent {
  agent: string;
  hub: string;
  code: string;
  expiresAt: number;
}
interface Storage {
  grants: Grant[];
  consents: Map<string, Consent>;
  failWrites: boolean;
  page: { open: boolean; presence: PresenceEvent[] };
}
interface Config {
  brk: Set<FixtureBreak>;
  pairing: boolean;
  idle: boolean;
}

const random = (n: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join("");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => Response.json(body, { status });
const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, data?: unknown) => json({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const toolResult = (payload: Record<string, unknown>, isError = false, structured = true) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  ...(structured ? { structuredContent: payload } : {}),
  ...(isError ? { isError: true } : {}),
});
const TOOLS = [
  { name: "get_current_view", inputSchema: { type: "object", properties: {} } },
  { name: "wait_for_focus", inputSchema: { type: "object", properties: { timeout_s: { type: "integer", minimum: 1 } } } },
  { name: "list_orders", inputSchema: { type: "object", properties: {} } },
];

class Fixture {
  dead = false;
  private locks = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private storage: Storage;
  private config: Config;
  private clock: { skew: number };
  private hub: StandInHub;

  constructor(storage: Storage, config: Config, clock: { skew: number }, hub: StandInHub) {
    this.storage = storage;
    this.config = config;
    this.clock = clock;
    this.hub = hub;
  }

  private has = (b: FixtureBreak) => this.config.brk.has(b);
  now = () => Date.now() + this.clock.skew;

  /** The grant's state now, applying the limits that have passed. */
  stateOf(g: Grant): DockGrantState {
    if (g.state === "revoked" || g.state === "ended") return g.state;
    if (g.state === "in_flight") {
      if (!this.has("t_ack_ignored") && this.now() - g.allowedAt > T_ACK_MAX_MS) g.state = "ended";
      return g.state;
    }
    if (g.state === "handoff") {
      if (!this.has("t_connect_ignored") && this.now() - g.ackedAt > T_CONNECT_MAX_MS) g.state = "ended";
      return g.state;
    }
    return this.config.idle && this.now() - g.lastWake > IDLE_MS ? "dormant" : "live";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) return json({ error: "not_found" }, 404);
    if (url.pathname === "/.well-known/apc.json") return this.apcJson();
    if (url.pathname === "/apc/revoke" && request.method === "POST") return this.giveBack(request);
    if (url.pathname.startsWith("/mcp/")) return this.mcp(request, url.pathname.slice("/mcp/".length));
    if (url.pathname === "/api/drop") return this.owner(request, (b) => this.drop(b));
    if (url.pathname === "/api/heartbeat") return this.owner(request, async () => this.heartbeat());
    if (url.pathname === "/api/cancel") return this.owner(request, async (b) => ({ ok: await this.cancel(String(b.grant_id)) }));
    return json({ error: "not_found" }, 404);
  }

  private apcJson(): Response {
    const dock = this.config.pairing || this.has("dock_always_listed");
    const body = { name: "Fixture", standard: APC_STANDARD_VERSION, origin: ORIGIN, profiles: dock ? ["dock"] : ["direct"], mcp: { path: "/mcp/" }, direct: { connect: `${ORIGIN}/agents` } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${this.has("max_age_300") ? 300 : 60}` } });
  }

  /** M6: the owner's session, POST with application/json, and the Origin and Sec-Fetch-Site rules. */
  private async owner(request: Request, handler: (body: Record<string, unknown>) => Promise<unknown>): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (request.headers.get("cookie") !== SESSION.cookie) return json({ error: "unauthorized" }, 401);
    const media = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return json({ error: "unsupported_media_type" }, 415);
    if (!this.has("no_origin_check")) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== ORIGIN) return json({ error: "forbidden" }, 403);
      const site = request.headers.get("sec-fetch-site");
      if (site === "cross-site" || site === "same-site") return json({ error: "forbidden" }, 403);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return json({ error: "invalid" }, 400);
    if (this.has("lock_across_call")) {
      // One lock for every owner request, held across the hub call.
      const run = this.chain.then(() => handler(body));
      this.chain = run.catch(() => {});
      return json(await run);
    }
    return json(await handler(body));
  }

  /** M1: the drop's hub, parsed, compared by origin with the allowlist. */
  private parseHub(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!this.has("allowlist_by_origin_only") && (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash)) return null;
    return [HUB].includes(u.origin) ? u.origin : null;
  }

  private urlOf = (g: Grant) => `${ORIGIN}/mcp/${g.secret}`;

  private async drop(b: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config.pairing) return { ok: false, error: "not_available" };
    const { agent, ticket, consent } = b;
    if (typeof agent !== "string" || typeof ticket !== "string") return { ok: false, error: "invalid" };
    const hub = this.parseHub(b.hub);
    if (!hub) return { ok: false, error: "hub_not_allowed" };
    const base = this.has("raw_hub_string") ? String(b.hub) : hub;
    const triple = `${hub}|${agent}`;
    const target = (b.target as FocusTarget | undefined) ?? null;
    if (consent !== undefined) return this.allow(String(consent), agent, ticket, hub, base, triple, target);
    if (this.locks.has(triple)) return { ok: false, error: "pairing_in_progress" };
    const g = this.storage.grants.filter((x) => x.hub === hub && x.agent === agent && !["revoked", "ended"].includes(this.stateOf(x))).at(-1);
    if (g) {
      const st = this.stateOf(g);
      if (st === "in_flight") return { ok: false, error: "pairing_in_progress" };
      this.locks.add(triple);
      try {
        const answer = await this.hubCall(base, "/apc/confirm", { ticket, agent, mcp_url: this.urlOf(g) });
        if (this.dead) return { ok: false, error: "gone" };
        const a = answer.body as { ok?: unknown; status?: unknown; error?: unknown } | undefined;
        const status = a?.ok === true ? a.status : a?.error === "not_paired" ? "not_paired" : null;
        if (status === null) return { ok: false, error: "hub_unreachable" };
        if (st === "handoff") {
          if (status === "pending" && this.now() < g.codeExpiresAt && !this.has("new_code_on_pending")) {
            if (target) g.pin = target;
            return { ok: true, status: "pending", grant_id: g.id, pairing: { code: g.code, expires_at: new Date(g.codeExpiresAt).toISOString() } };
          }
          if (status === "paired") {
            if (this.has("confirm_paired_goes_live")) {
              g.state = "live";
              g.lastWake = this.now();
            }
            return { ok: true, status: "paired", grant_id: g.id };
          }
          if (!(status === "pending" && this.has("new_code_on_pending")) && !this.has("keeps_grant_on_not_paired")) g.state = "ended";
        } else if (status === "paired") {
          if (target) this.pinGrant(g, target);
          return { ok: true, status: "paired", grant_id: g.id, pinned: true };
        } else g.state = "ended";
      } finally {
        this.locks.delete(triple);
      }
    }
    // A new consent replaces the pending one, before the acknowledgement.
    if (!this.has("stale_allow_accepted")) for (const [nonce, c] of this.storage.consents) if (c.hub === hub && c.agent === agent) this.storage.consents.delete(nonce);
    const nonce = random(32);
    const code = random(6, CROCKFORD);
    this.storage.consents.set(nonce, { agent, hub, code, expiresAt: this.now() + CODE_TTL_MS });
    return { ok: false, error: "consent_required", consent: nonce, pairing_code: code };
  }

  private async allow(nonce: string, agent: string, ticket: string, hub: string, base: string, triple: string, target: FocusTarget | null): Promise<Record<string, unknown>> {
    if (this.locks.has(triple)) return { ok: false, error: "pairing_in_progress" };
    const c = this.storage.consents.get(nonce);
    if (!c || c.agent !== agent || c.hub !== hub || this.now() > c.expiresAt) return { ok: false, error: "consent_expired" };
    this.locks.add(triple);
    try {
      this.storage.consents.delete(nonce);
      const now = this.now();
      const g: Grant = { id: `g_${random(8)}`, secret: random(22), agent, hub, state: "in_flight", allowedAt: now, ackedAt: 0, lastWake: now, served: false, code: c.code, codeExpiresAt: 0, pin: null, pinnedAt: 0, pinUnread: false, revokedAt: null };
      this.storage.grants.push(g);
      const answer = await this.hubCall(base, "/apc/pair", { ticket, agent, app: { name: "Fixture", origin: ORIGIN }, mcp_url: this.urlOf(g), pairing_code: c.code });
      if (this.dead) return { ok: false, error: "gone" };
      const a = answer.body as { ok?: unknown; pairing_code?: unknown; error?: unknown } | undefined;
      if (!(answer.status === 200 && a?.ok === true && a.pairing_code === PAIRING_CODE_ACK)) {
        if (g.state !== "revoked") g.state = "ended";
        return { ok: false, error: typeof a?.error === "string" ? a.error : "hub_refused" };
      }
      // The acknowledgement's move, conditional on the grant being still in flight.
      if (!this.has("ack_unconditional") && this.stateOf(g) !== "in_flight") return { ok: false, error: "pairing_ended" };
      g.state = "handoff";
      g.ackedAt = this.now();
      g.codeExpiresAt = g.ackedAt + CODE_TTL_MS;
      g.pin = target;
      return { ok: true, status: "pending", grant_id: g.id, pairing: { code: g.code, expires_at: new Date(g.codeExpiresAt).toISOString() } };
    } finally {
      this.locks.delete(triple);
    }
  }

  /** M2 to M4 and M9: the hub call, to the parsed origin, refusing redirects, under one deadline and the byte cap. */
  private async hubCall(base: string, path: string, body: unknown): Promise<{ status: number; body?: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("deadline")), DEADLINE_MS)));
    deadline.catch(() => {});
    const follows = this.has("follows_redirects");
    const trusts = this.has("trusts_content_length");
    try {
      const response = await Promise.race([this.hub.fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: follows ? "follow" : "error" }), deadline]);
      const bodyDeadline = this.has("no_deadline_on_body") ? new Promise<never>(() => {}) : deadline;
      if (!follows && (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400))) return { status: 0 };
      const length = response.headers.get("content-length");
      if (!trusts && length !== null && (!/^\d+$/.test(length) || Number(length) > HUB_ANSWER_MAX_BYTES)) return { status: 0 };
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), bodyDeadline]);
        if (done) break;
        total += value.length;
        if (!trusts && total > HUB_ANSWER_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { status: 0 };
        }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** M7: the same 200 for any input; ends a matching grant unless it is revoked or ended. */
  private async giveBack(request: Request): Promise<Response> {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 4096) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    let g: Grant | undefined;
    try {
      const mcpUrl = (JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as { mcp_url?: unknown }).mcp_url;
      if (typeof mcpUrl === "string" && mcpUrl.startsWith(`${ORIGIN}/mcp/`)) g = this.storage.grants.find((x) => x.secret === mcpUrl.slice(`${ORIGIN}/mcp/`.length));
    } catch {
      // not JSON: the same answer
    }
    if (g && !["revoked", "ended"].includes(this.stateOf(g))) g.state = "ended";
    if (!g && this.has("revoke_404_unknown")) return json({ ok: false }, 404);
    return json({ ok: true });
  }

  private heartbeat(): Record<string, unknown> {
    if (!this.has("heartbeat_does_not_wake")) for (const g of this.storage.grants) if (["live", "dormant"].includes(this.stateOf(g))) g.lastWake = this.now();
    return { ok: true };
  }

  /** Cancel on the waiting card: a revoke, only in handoff before any served call, checked and done in one step. */
  async cancel(grantId: string): Promise<boolean> {
    await tick();
    const g = this.storage.grants.find((x) => x.id === grantId);
    if (!g) return false;
    const st = this.stateOf(g);
    const allowed = this.has("cancel_live") ? st !== "revoked" && st !== "ended" : st === "handoff" && !g.served;
    if (!allowed) return false;
    g.state = "revoked";
    g.revokedAt = new Date(this.now()).toISOString();
    return true;
  }

  revoke(grantId: string): boolean {
    const g = this.storage.grants.find((x) => x.id === grantId);
    if (!g || g.state === "revoked") return false;
    g.state = "revoked";
    g.revokedAt = new Date(this.now()).toISOString();
    return true;
  }

  private pinGrant(g: Grant, target: FocusTarget) {
    g.pin = target;
    g.pinnedAt = this.now();
    g.pinUnread = true;
    // A confirmed drop is a wake action.
    if (["live", "dormant"].includes(this.stateOf(g))) g.lastWake = this.now();
  }

  pin(grantId: string, target: FocusTarget): boolean {
    const g = this.storage.grants.find((x) => x.id === grantId);
    if (!g || ["revoked", "ended", "in_flight"].includes(this.stateOf(g))) return false;
    this.pinGrant(g, target);
    return true;
  }

  private focusOf(g: Grant) {
    return { ...g.pin!, app_url: `${ORIGIN}/`, pinned_at: new Date(g.pinnedAt).toISOString(), next: "list_orders", next_args: {} };
  }

  private async mcp(request: Request, secret: string): Promise<Response> {
    const g = this.storage.grants.find((x) => x.secret === secret);
    if (!g) return json({ error: "not_found" }, 404);
    let st = this.stateOf(g);
    // A request that is not a JSON-RPC POST, checked before the state: the "any request" row broken.
    if (this.has("any_request_405") && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (st === "revoked" || (st === "ended" && this.has("ended_answers_revoked"))) return json(revokedAnswer("fixture.test", g.revokedAt ?? new Date(this.now()).toISOString()), this.has("revoked_answers_404") && st === "revoked" ? 404 : 403);
    if (st === "ended" || (st === "in_flight" && !this.has("in_flight_serves"))) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const rpc = (await request.json().catch(() => null)) as { id?: string | number | null; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null;
    if (!rpc || typeof rpc.method !== "string") return json({ error: "invalid" }, 400);
    const tool = rpc.params?.name;
    // A notification has no id, or is any notifications/* method (broken: by the id alone).
    const call = this.has("notification_by_id_only") && rpc.id !== undefined && rpc.method.startsWith("notifications/") ? "other_method" : dockGrantCallOf({ method: rpc.method, ...(rpc.id !== undefined ? { id: rpc.id } : {}), params: rpc.params });
    const notification = call === "notification";
    if (st === "in_flight") st = "handoff";
    const commits = st === "handoff" && call === "initialize";
    const as = st === "handoff" && this.has("handoff_serves_data") && !commits ? "live" : st;
    const answer = dockGrantAnswer(as, call);
    if (this.has("traffic_wakes") && (as === "live" || as === "dormant")) g.lastWake = this.now();
    switch (answer.kind) {
      case "not_found":
        return json({ error: "not_found" }, 404);
      case "revoked":
        return json(revokedAnswer("fixture.test", g.revokedAt!), 403);
      case "ignored":
        return new Response(null, { status: 202 });
      case "tool_error": {
        const a = answer.error === "pairing" ? pairingAnswer() : idleAnswer();
        const payload: Record<string, unknown> = { ...a };
        if (this.has("attention_in_handoff") && g.pin) payload.attention = { focus: this.focusOf(g), note: "The person pointed you." };
        return rpcResult(rpc.id, toolResult(payload, true, !this.has("tool_error_text_only")));
      }
      case "rpc_error": {
        const a = answer.error === "pairing" ? pairingAnswer() : idleAnswer();
        return rpcError(rpc.id, DOCK_GRANT_RPC_ERROR_CODE, a.message, a);
      }
      case "idle_shape": {
        const shape: Record<string, unknown> = { ...(tool === "get_current_view" ? idleCurrentView() : idleWaitForFocus()) };
        if (this.has("idle_without_flag")) delete shape.idle;
        return rpcResult(rpc.id, toolResult(shape));
      }
      case "serve":
        break;
    }
    if (notification) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") {
      if (answer.commits && !this.has("initialize_no_commit")) {
        await tick();
        if (this.storage.failWrites && !this.has("initialize_swallows_write_error")) return rpcError(rpc.id, -32603, "the connection could not be saved");
        if (!this.storage.failWrites) {
          // The commit, conditional on the grant being neither revoked nor ended, in one step.
          const now = this.stateOf(g);
          if (now === "revoked") return json(revokedAnswer("fixture.test", g.revokedAt!), 403);
          if (now === "ended") return json({ error: "not_found" }, 404);
          if (now === "handoff") {
            g.state = "live";
            g.lastWake = this.now();
          }
        }
      }
      return rpcResult(rpc.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    }
    if (rpc.method === "ping") return rpcResult(rpc.id, {});
    if (rpc.method === "tools/list") return rpcResult(rpc.id, { tools: TOOLS });
    if (rpc.method !== "tools/call") return rpcError(rpc.id, -32601, "Method not found");
    return rpcResult(rpc.id, await this.serveTool(g, tool ?? "", rpc.params?.arguments ?? {}));
  }

  private async serveTool(g: Grant, tool: string, args: Record<string, unknown>) {
    g.served = true;
    let payload: Record<string, unknown>;
    let ends = false;
    if (tool === "get_current_view") {
      payload = { view: null, focus: g.pinUnread ? this.focusOf(g) : null };
      g.pinUnread = false;
    } else if (tool === "wait_for_focus") {
      if (g.pinUnread) {
        payload = { focus: this.focusOf(g), timed_out: false };
        g.pinUnread = false;
      } else if (!this.storage.page.open) {
        payload = { focus: null, timed_out: false, page_open: false, note: "The person has no page open." };
        ends = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(args.timeout_s ?? 25), 3) * 1000));
        payload = { focus: null, timed_out: true, note: "No pin." };
        ends = true;
      }
    } else if (tool === "list_orders") {
      payload = { orders: [{ id: "ord_1" }, { id: "ord_2" }] };
    } else return toolResult({ error: "unknown_tool", message: tool }, true);
    if (g.pinUnread) payload.attention = { focus: this.focusOf(g), note: "The person pointed you: call get_current_view." };
    if (!ends && this.storage.page.open && g.pin && this.now() - g.pinnedAt < 30 * 60_000) payload.then = "After you answer, call wait_for_focus.";
    this.storage.page.presence.push({ v: 1, grant_id: g.id, at: new Date(this.now()).toISOString(), tool, kind: "read", targets: [], count: 0 });
    return toolResult(payload);
  }
}

/** The fixture and its adapter: `break` makes it wrong in one way; `idle: false` makes an app that does not sleep. */
export function dockFixture(options: { break?: FixtureBreak; idle?: boolean } = {}): { adapter: ApcAppAdapter; hub: StandInHub } {
  const config: Config = { brk: new Set(options.break ? [options.break] : []), pairing: true, idle: options.idle ?? true };
  const fresh = (): Storage => ({ grants: [], consents: new Map(), failWrites: false, page: { open: false, presence: [] } });
  const storage = fresh();
  const clock = { skew: 0 };
  let current: Fixture;
  const hub = standInHub({ origin: HUB, app: (request) => current.fetch(request) });
  current = new Fixture(storage, config, clock, hub);
  const targets: [FocusTarget, FocusTarget] = [
    { kind: "order", id: "ord_1", part: null, params: null },
    { kind: "order", id: "ord_2", part: null, params: null },
  ];
  const post = async (path: string, body: unknown) =>
    (await (await current.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...SESSION, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }))).json()) as Record<string, unknown>;

  const dropAgent = async (d: { agent: string; ticket: string; hub: string }): Promise<ApcDockDropOutcome> => {
    const drop = { hub: d.hub, agent: d.agent, ticket: d.ticket, target: targets[0] };
    const r = await post("/api/drop", drop);
    if (r.error === "consent_required") {
      return {
        page: "consent",
        code: String(r.pairing_code),
        async allow(over) {
          const a = await post("/api/drop", { ...drop, ...(over?.hub !== undefined ? { hub: over.hub } : {}), consent: r.consent });
          return { ok: a.ok === true, ...(typeof a.error === "string" ? { error: a.error } : {}), ...(typeof a.grant_id === "string" ? { grantId: a.grant_id } : {}) };
        },
      };
    }
    if (r.ok === true && r.status === "pending") return { page: "waiting", code: String((r.pairing as { code: string }).code) };
    if (r.ok === true && r.status === "paired") return r.pinned ? { page: "pinned" } : { page: "connecting" };
    return { page: "refused", error: String(r.error) };
  };
  let agents = 0;
  const newAgent = () => `ag_fixture_${++agents}`;
  const handoffGrant = async () => {
    const agent = newAgent();
    const shown = await dropAgent({ agent, ticket: hub.ticket(agent), hub: HUB });
    if (shown.page !== "consent") throw new Error(`expected a consent, got ${shown.page}`);
    const allowed = await shown.allow();
    if (!allowed.ok) throw new Error(`the Allow did not pair: ${allowed.error}`);
    return { agent, code: shown.code, grantId: allowed.grantId! };
  };

  const adapter: ApcAppAdapter = {
    name: "Fixture",
    profile: "dock",
    fetch: (request) => current.fetch(request),
    async connect() {
      const g = await handoffGrant();
      const pairing = hub.pairings.find((p) => p.agent === g.agent)!;
      await hub.decide(pairing.id, "approve", g.code);
      return { grantId: g.grantId, mcpUrl: pairing.mcp_url };
    },
    targets,
    probe: { tool: "list_orders", args: {} },
    page: {
      setOpen(open) {
        storage.page.open = open;
      },
      async showView() {},
      pin: async (grantId, target) => current.pin(grantId, target),
      takePresence: () => storage.page.presence.splice(0),
      revoke: async (grantId) => current.revoke(grantId),
    },
    dock: {
      hub,
      async drop(agent, ticket) {
        const shown = await dropAgent({ agent, ticket, hub: HUB });
        if (shown.page !== "consent") throw new Error(`expected a consent, got ${shown.page}`);
        return { shown: shown.code, allow: () => shown.allow() };
      },
      lifecycle: {
        dropAgent,
        cancel: async (grantId) => (await post("/api/cancel", { grant_id: grantId })).ok === true,
        heartbeat: async () => void (await post("/api/heartbeat", {})),
        async advance(ms) {
          clock.skew += ms;
        },
        failCommits(fail) {
          storage.failWrites = fail;
        },
        async restart() {
          current.dead = true;
          current = new Fixture(storage, config, clock, hub);
        },
        ...(config.idle ? { idleMs: IDLE_MS } : {}),
        owner: {
          origin: ORIGIN,
          session: SESSION,
          endpoints: [
            {
              name: "the drop",
              path: "/api/drop",
              body: () => {
                const agent = newAgent();
                return { hub: HUB, agent, ticket: hub.ticket(agent) };
              },
            },
            {
              name: "the Allow",
              path: "/api/drop",
              body: async () => {
                const agent = newAgent();
                const ticket = hub.ticket(agent);
                const asked = await post("/api/drop", { hub: HUB, agent, ticket });
                return { hub: HUB, agent, ticket, consent: asked.consent };
              },
            },
            { name: "the heartbeat", path: "/api/heartbeat", body: () => ({}) },
            { name: "Cancel", path: "/api/cancel", body: async () => ({ grant_id: (await handoffGrant()).grantId }) },
          ],
        },
        async pairingDisabled() {
          const off = new Fixture(fresh(), { ...config, pairing: false }, clock, hub);
          return (request) => off.fetch(request);
        },
      },
    },
  };
  return { adapter, hub };
}
