/**
 * One visitor's Signals (TIN-384): a Durable Object holding the seed of their Pulse sandbox (the
 * posts are rebuilt from it), the grants it gave agent docks, the view, the pins and the page's
 * WebSocket. Agents never connect directly: a dock's hub pairs, after the person says yes here and
 * in the dock, and reads with the grant Signals made for it.
 */
import { DurableObject } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FocusRow } from "@apc/protocol";
import { APC_INSTRUCTIONS, attachAttention, attachThen, attentionFor, isUnread, toolError, toolResult, type ToolResult } from "@apc/server";
import { generateDataset } from "../../../demo/src/model/seed.ts";
import { buildMarket, type Post } from "../../../demo/src/model/market.ts";
import { anyPageOpen } from "../../../demo/src/worker/page.ts";
import { pickClientIcon } from "../../../demo/src/worker/client-icon.ts";
import { checkPin, focusPayload, KINDS, listPosts, postAnswer, sanitizeView, viewPayload, type StoredView } from "./logic.ts";

export const FEED_TTL_MS = 6 * 60 * 60_000;
const WAIT_CEILING_S = 50;

export interface Env {
  FEED: DurableObjectNamespace<Feed>;
  ASSETS: Fetcher;
  NEW_FEED?: RateLimit;
  FEED_CALLS?: RateLimit;
  /** Comma-separated origins of the agent docks Signals may pair with. */
  HUB_ORIGINS?: string;
}

const dev = () => !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** One call to a dock's hub, server to server. Any failure is an answer, never a throw. */
async function hubCall(hub: string, path: string, body: unknown): Promise<{ ok?: boolean; error?: string; agent?: { name?: unknown; icon?: unknown } }> {
  try {
    const response = await fetch(`${hub}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return (await response.json().catch(() => ({ ok: false, error: "hub_refused" }))) as Awaited<ReturnType<typeof hubCall>>;
  } catch {
    return { ok: false, error: "hub_unreachable" };
  }
}

interface Grant {
  id: string;
  secret: string;
  hub: string;
  agent: string;
  client_title: string | null;
  /** The agent's mark from the dock (TIN-388): a small PNG, drawn on its pins. */
  client_icon: string | null;
  created_at: string;
  last_active_at: string | null;
}

export class Feed extends DurableObject<Env> {
  private sql: SqlStorage;
  private cached: { seed: number; posts: Post[] } | null = null;
  /** Grants with a wait_for_focus in flight, for the agent bar's floating mark (memory only). */
  private waiting = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists grants (
        id text primary key, secret text not null unique, hub text not null, agent text not null,
        client_title text, created_at text not null, last_active_at text, unique (hub, agent));
      create table if not exists view_state (id integer primary key check (id = 1), data text not null);
      create table if not exists agent_focus (
        grant_id text primary key references grants(id) on delete cascade,
        kind text not null, target_id text, part text, pinned_at text not null, seen_at text);
    `);
    try {
      this.sql.exec("alter table grants add column client_icon text");
    } catch {
      // already there (TIN-388)
    }
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0]?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }
  private posts(): Post[] {
    const seed = Number(this.meta("seed"));
    if (this.cached?.seed !== seed) this.cached = { seed, posts: buildMarket(generateDataset(seed)).posts };
    return this.cached.posts;
  }
  private grants(): Grant[] {
    return this.sql.exec<Record<string, string | null>>("select * from grants order by created_at").toArray() as unknown as Grant[];
  }
  private focusRow(grantId: string): FocusRow | null {
    const r = this.sql.exec<Record<string, string | null>>("select * from agent_focus where grant_id = ?", grantId).toArray()[0];
    return r ? { grant_id: r.grant_id!, kind: r.kind!, id: r.target_id ?? null, part: r.part ?? null, params: null, pinned_at: r.pinned_at!, seen_at: r.seen_at ?? null } : null;
  }
  private storedView(): StoredView | null {
    const r = this.sql.exec<{ data: string }>("select data from view_state where id = 1").toArray()[0];
    return r ? (JSON.parse(r.data) as StoredView) : null;
  }
  private broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: "state" }));
      } catch {
        // closed
      }
    }
  }
  private pageOpen(): boolean {
    const sockets = this.ctx.getWebSockets().map((ws) => ({
      open: ws.readyState === WebSocket.OPEN,
      lastPongAt: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      acceptedAt: Number((ws.deserializeAttachment() as { accepted_at?: number } | null)?.accepted_at ?? 0),
    }));
    return anyPageOpen(sockets, Date.now());
  }
  private async touch(): Promise<void> {
    const expiresAt = Date.now() + FEED_TTL_MS;
    this.setMeta("expires_at", String(expiresAt));
    if (!dev()) await this.ctx.storage.setAlarm(expiresAt);
  }
  private async alive(): Promise<boolean> {
    if (!this.meta("owner")) return false;
    if (Number(this.meta("expires_at") ?? 0) > Date.now()) return true;
    await this.alarm();
    return false;
  }
  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "expired");
    await this.ctx.storage.deleteAll();
    this.cached = null;
    this.migrate();
  }

  // ---- owner RPC ----

  async init(seed: number): Promise<{ owner: string }> {
    const existing = this.meta("owner");
    if (existing) return { owner: existing };
    const owner = randomHex(16);
    this.setMeta("owner", owner);
    this.setMeta("seed", String(seed));
    await this.touch();
    return { owner };
  }

  async isOwner(secret: string): Promise<boolean> {
    if (!(await this.alive()) || this.meta("owner") !== secret) return false;
    await this.touch();
    return true;
  }

  /** Follow the Pulse sandbox the person came from: a new seed is a new market, so the pins go. */
  async useSeed(seed: number): Promise<void> {
    if (Number(this.meta("seed")) === seed) return;
    this.setMeta("seed", String(seed));
    this.sql.exec("delete from agent_focus");
    this.sql.exec("delete from view_state");
    this.broadcast();
  }

  async state() {
    return {
      seed: Number(this.meta("seed")),
      grants: this.grants().map((g) => ({ id: g.id, hub: g.hub, agent: g.agent, name: g.client_title ?? "Agent via dock", icon: g.client_icon, connected: !!g.client_title, waiting: this.waiting.has(g.id), pin: this.focusRow(g.id) })),
    };
  }

  async reportView(raw: unknown): Promise<{ ok: boolean }> {
    const view = sanitizeView(raw, this.posts());
    if (!view) return { ok: false };
    this.sql.exec("insert into view_state (id, data) values (1, ?) on conflict(id) do update set data = excluded.data", JSON.stringify(view));
    return { ok: true };
  }

  async pin(grantId: string, raw: unknown): Promise<{ ok: boolean; error?: string }> {
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const checked = checkPin(raw, this.posts());
    if ("error" in checked) return { ok: false, error: checked.error };
    const t = checked.target;
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.sql.exec("insert into agent_focus (grant_id, kind, target_id, part, pinned_at, seen_at) values (?, ?, ?, ?, ?, null)", grantId, t.kind, t.id, t.part, new Date().toISOString());
    this.broadcast();
    return { ok: true };
  }

  async unpin(grantId: string): Promise<void> {
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.broadcast();
  }

  /**
   * The person dropped an agent from a dock here and said yes (DESIGN.md 12.1, as in Pulse's v2):
   * a grant for it, handed to the dock's hub server to server with the drag's ticket, and the pin.
   */
  async pairHub(sid: string, origin: string, raw: unknown): Promise<{ ok: boolean; error?: string; grant_id?: string }> {
    const b = raw as { hub?: unknown; agent?: unknown; ticket?: unknown; target?: unknown } | null;
    const hub = typeof b?.hub === "string" ? b.hub : "";
    const allowed = (this.env.HUB_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (!allowed.includes(hub) && !(dev() && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(hub))) return { ok: false, error: "hub_not_allowed" };
    if (typeof b?.agent !== "string" || !/^[\w.:-]{1,128}$/.test(b.agent) || typeof b.ticket !== "string" || !/^[\w.-]{16,200}$/.test(b.ticket)) return { ok: false, error: "invalid" };
    const linked = this.grants().find((g) => g.hub === hub && g.agent === b.agent);
    if (linked) {
      // Already paired here: the hub must still say so (TIN-389). If it does not, the grant goes and the person is asked again.
      const check = await hubCall(hub, "/apc/confirm", { ticket: b.ticket, agent: b.agent, mcp_url: `${origin}/mcp/${sid}/${linked.secret}` });
      if (!check.ok) {
        if (check.error === "not_paired") await this.revoke(linked.secret);
        return { ok: false, error: check.error ?? "hub_refused" };
      }
      this.sql.exec("update grants set client_icon = coalesce(?, client_icon) where id = ?", pickClientIcon([{ src: check.agent?.icon }]), linked.id);
      return { ...(await this.pin(linked.id, b.target)), grant_id: linked.id };
    }
    const id = `g_${randomHex(4)}`;
    const secret = randomHex(16);
    this.sql.exec("insert into grants (id, secret, hub, agent, created_at) values (?, ?, ?, ?, ?)", id, secret, hub, b.agent, new Date().toISOString());
    const answer = await hubCall(hub, "/apc/pair", { ticket: b.ticket, agent: b.agent, app: { name: "Signals", origin }, mcp_url: `${origin}/mcp/${sid}/${secret}` });
    if (!answer.ok) {
      this.sql.exec("delete from grants where id = ?", id);
      return { ok: false, error: answer.error ?? "hub_refused" };
    }
    // The agent's mark from the hub, so its first pin already shows its logo.
    const name = typeof answer.agent?.name === "string" ? answer.agent.name.replace(/[\p{C}]/gu, "").trim().slice(0, 60) || null : null;
    this.sql.exec("update grants set client_title = ?, client_icon = ? where id = ?", name, pickClientIcon([{ src: answer.agent?.icon }]), id);
    this.broadcast();
    return { ...(await this.pin(id, b.target)), grant_id: id };
  }

  /** A dock's hub gives back its grant (TIN-388): the grant and its pin go, and the next drop asks again. */
  async revoke(secret: string): Promise<{ ok: boolean }> {
    const grant = this.grants().find((g) => g.secret === secret);
    if (!grant) return { ok: false };
    this.sql.exec("delete from agent_focus where grant_id = ?", grant.id);
    this.sql.exec("delete from grants where id = ?", grant.id);
    this.broadcast();
    return { ok: true };
  }

  // ---- fetch: the page's WebSocket and the hub's MCP endpoint ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      const owner = this.meta("owner");
      if (!owner || request.headers.get("x-apc-owner") !== owner) return new Response("forbidden", { status: 403 });
      if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ accepted_at: Date.now() });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const match = url.pathname.match(/^\/mcp\/[0-9a-f]{32}\/([0-9a-f]{32})$/);
    if (match) return this.mcp(request, match[1]!, url.origin);
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(): Promise<void> {
    // The page only listens.
  }

  private async mcp(request: Request, secret: string, origin: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (!(await this.alive())) return Response.json({ error: "expired" }, { status: 404 });
    const grant = this.grants().find((g) => g.secret === secret);
    if (!grant) return Response.json({ error: "unknown_grant" }, { status: 404 });
    await this.touch();
    try {
      const body = (await request.clone().json()) as { method?: string; params?: { clientInfo?: { title?: unknown; icons?: unknown } } } | null;
      const info = body?.method === "initialize" ? body.params?.clientInfo : undefined;
      if (typeof info?.title === "string") {
        this.sql.exec("update grants set client_title = ?, client_icon = ? where id = ?", info.title.replace(/[\p{C}]/gu, "").trim().slice(0, 60) || null, pickClientIcon(info.icons), grant.id);
        this.broadcast();
      }
    } catch {
      // not JSON: the transport answers the error
    }

    const [{ McpServer }, { WebStandardStreamableHTTPServerTransport }, { CfWorkerJsonSchemaValidator }, { registerApcTools }, { z }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
      import("@modelcontextprotocol/sdk/validation/cfworker"),
      import("@apc/server"),
      import("zod"),
    ]);
    const posts = this.posts();
    const server = new McpServer(
      { name: "signals-apc-demo", version: "0.1.0" },
      {
        instructions: `${APC_INSTRUCTIONS} Signals is a market feed for a fictional SaaS (Pulse): competitor offers, each with the segment it targets (region, plan) and the months it ran, and our own ads, each with a promo code. It knows nothing about customers; who churned or signed up, and with which code, is in Pulse.`,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    );
    this.instrument(server, grant.id, posts, origin);
    registerApcTools(server, {
      readView: async () => viewPayload(this.storedView(), origin),
      readFocus: async () => focusPayload(this.focusRow(grant.id), posts, origin),
      focusUnread: async () => isUnread(this.focusRow(grant.id)),
      markSeen: async () => {
        const row = this.focusRow(grant.id);
        if (!row || !isUnread(row)) return;
        this.sql.exec("update agent_focus set seen_at = ? where grant_id = ?", new Date().toISOString(), grant.id);
        this.broadcast();
      },
      pageOpen: async () => this.pageOpen(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      waitCeilingS: WAIT_CEILING_S,
    });
    server.registerTool(
      "list_posts",
      {
        title: "List the feed's posts",
        description: "The posts in the feed: competitor offers (author, the segment they target as audience.region and audience.plan, the months they ran, the offer) and our ads (channel, promo code, the offer). Filters: kind (competitor_offer, our_ad), month (YYYY-MM).",
        inputSchema: { kind: z.enum(KINDS).optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
        annotations: { readOnlyHint: true },
      },
      async (filter) => toolResult(listPosts(posts, filter)),
    );
    server.registerTool(
      "get_post",
      {
        title: "Read one post",
        description: "One post by id (post_NNN): its kind, author, month (and ends_month for an offer), audience, offer, text, and for our ads the channel and promo code. Usually called with the next_args of a focus.",
        inputSchema: { id: z.string().regex(/^post_\d{3}$/) },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const answer = postAnswer(posts, id, origin);
        return "error" in answer ? toolError(answer.error!, answer.message!) : toolResult(answer);
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    return transport.handleRequest(new Request(request, { headers }));
  }

  /** The attention envelope while the grant's pin is unread, and then while the person's page is open. */
  private instrument(server: McpServer, grantId: string, posts: Post[], origin: string): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
      register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
        this.sql.exec("update grants set last_active_at = ? where id = ?", new Date().toISOString(), grantId);
        const waits = name === "wait_for_focus";
        if (waits) {
          this.waiting.add(grantId);
          this.broadcast();
        }
        let result: ToolResult;
        try {
          result = (await (cb as (a: unknown, e: unknown) => Promise<ToolResult>)(args, extra)) as ToolResult;
        } finally {
          if (waits) {
            this.waiting.delete(grantId);
            this.broadcast();
          }
        }
        const row = this.focusRow(grantId);
        const focus = focusPayload(row, posts, origin);
        if (isUnread(row) && focus) result = attachAttention(result, attentionFor(focus));
        return attachThen(result, this.pageOpen());
      });
  }
}
