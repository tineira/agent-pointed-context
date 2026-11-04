/**
 * One visitor's Signals (TIN-384): a Durable Object holding the seed of their demo world (the posts are
 * rebuilt from it), its grants, the view, the pins and the page's WebSocket. Agents come both ways
 * (APC_PROFILES, TIN-578): Direct, with a grant and MCP URL the person makes on the page (the Direct
 * profile from @apc/server and @apc/web), and Dock, where a dock's hub pairs after the person says yes
 * here and in the dock, and reads with the grant Signals made for it. The same agent on both shows as
 * one (apc_link).
 */
import { DurableObject } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApcProfile, FocusRow } from "@apc/protocol";
import { APC_INSTRUCTIONS, ApcLinks, attachApcLink, CONSENT_REQUIRED, DockConsent, attachAttention, attachThen, attentionFor, cleanAgentName, initializeOf, isUnread, linkClient, newDirectGrant, parseProfiles, presenceEvent, revokedResponse, revokedToolResult, secretHash, sqlKv, toolError, toolResult, type ToolResult } from "@apc/server";
import { generateDataset } from "../../../demo/src/model/seed.ts";
import { buildMarket, type Post } from "../../../demo/src/model/market.ts";
import { anyPageOpen, loopHinted } from "../../../demo/src/worker/page.ts";
import { pickClientIcon } from "../../../demo/src/worker/client-icon.ts";
import { checkPin, focusPayload, samePin, KINDS, listPosts, postAnswer, sanitizeView, viewPayload, type StoredView } from "./logic.ts";

export const FEED_TTL_MS = 6 * 60 * 60_000;
const WAIT_CEILING_S = 50;

export interface Env {
  FEED: DurableObjectNamespace<Feed>;
  ASSETS: Fetcher;
  NEW_FEED?: RateLimit;
  FEED_CALLS?: RateLimit;
  /** Comma-separated origins of the agent docks Signals may pair with. */
  HUB_ORIGINS?: string;
  /** The profiles Signals offers, in one place ("direct,dock" in wrangler.jsonc). Missing: both. */
  APC_PROFILES?: string;
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

const pathOf = (g: { hub: string | null }): ApcProfile => (g.hub ? "dock" : "direct");

interface Grant {
  id: string;
  secret: string;
  /** The dock's hub and its agent handle (Dock); both null for an agent the person connected directly. */
  hub: string | null;
  agent: string | null;
  /** clientInfo.name of a Direct agent's initialize. */
  client_name: string | null;
  /** The person's own name for it. */
  owner_name: string | null;
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
  /** apc_link (APC 0.4): which Direct and Dock grants are one agent. */
  private links!: ApcLinks;
  /** Consent in the app, checked here (APC 0.7): the nonce the page shows its consent with. */
  private consent!: DockConsent;
  /** Dock drops being answered, by dock and agent (memory only): one at a time per agent. */
  private pairing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    // A feed made before Signals took Direct agents (TIN-578) had hub and agent not null: its grants
    // table is made again with both nullable (a Direct grant has neither). Its pins go with the old table.
    // Crash-safe (TIN-607): the steps may stop anywhere, and the next start finishes or redoes them. A
    // grants_direct left with no grants table was copied in full (the copy comes before the drop): it only
    // needs its name. One left beside a grants table is a copy that never finished (or an old rename): dropped.
    const tableSql = (name: string) => this.sql.exec<{ sql: string }>("select sql from sqlite_master where type = 'table' and name = ?", name).toArray()[0]?.sql;
    const old = tableSql("grants");
    if (!old && tableSql("grants_direct")) this.sql.exec("alter table grants_direct rename to grants");
    else if (old) this.sql.exec("drop table if exists grants_direct");
    if (old && /hub text not null/i.test(old)) {
      this.sql.exec("create table grants_direct (id text primary key, secret text not null unique, hub text, agent text, client_title text, created_at text not null, last_active_at text, client_icon text, unique (hub, agent))");
      this.sql.exec("insert into grants_direct (id, secret, hub, agent, client_title, created_at, last_active_at, client_icon) select id, secret, hub, agent, client_title, created_at, last_active_at, client_icon from grants");
      this.sql.exec("drop table grants");
      this.sql.exec("alter table grants_direct rename to grants");
    }
    this.sql.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists grants (
        id text primary key, secret text not null unique, hub text, agent text,
        client_title text, created_at text not null, last_active_at text, client_icon text, unique (hub, agent));
      create table if not exists view_state (id integer primary key check (id = 1), data text not null);
      create table if not exists agent_focus (
        grant_id text primary key references grants(id) on delete cascade,
        kind text not null, target_id text, part text, pinned_at text not null, seen_at text);
      create table if not exists revoked_grants (
        secret_hash text primary key, grant_id text not null, hub text not null, agent text not null, revoked_at text not null);
    `);
    for (const column of ["client_icon", "client_name", "owner_name"]) {
      try {
        this.sql.exec(`alter table grants add column ${column} text`);
      } catch {
        // already there (client_icon since TIN-388, the names since TIN-578)
      }
    }
    this.links = new ApcLinks(sqlKv(this.sql), { appName: "Signals", grants: () => this.grants().map((g) => ({ id: g.id, path: pathOf(g) })) });
    this.consent = new DockConsent(sqlKv(this.sql));
  }

  /** Whether Signals offers this profile (APC_PROFILES). */
  private offers(profile: ApcProfile): boolean {
    return parseProfiles(this.env.APC_PROFILES).includes(profile);
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
    return this.sql.exec<Record<string, string | null>>("select * from grants order by created_at, id").toArray() as unknown as Grant[];
  }
  private focusRow(grantId: string): FocusRow | null {
    const r = this.sql.exec<Record<string, string | null>>("select * from agent_focus where grant_id = ?", grantId).toArray()[0];
    return r ? { grant_id: r.grant_id!, kind: r.kind!, id: r.target_id ?? null, part: r.part ?? null, params: null, pinned_at: r.pinned_at!, seen_at: r.seen_at ?? null } : null;
  }
  private storedView(): StoredView | null {
    const r = this.sql.exec<{ data: string }>("select data from view_state where id = 1").toArray()[0];
    return r ? (JSON.parse(r.data) as StoredView) : null;
  }
  private broadcast(message: Record<string, unknown> = { type: "state" }): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
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
  /** Start over (TIN-411): delete everything, as when the feed expires. A dock reading it gets 404 and drops it. */
  async reset(): Promise<void> {
    await this.alarm();
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

  /** Follow the world the dock opened Signals on: a new seed is a new market, so the pins go. */
  async useSeed(seed: number): Promise<void> {
    if (Number(this.meta("seed")) === seed) return;
    this.setMeta("seed", String(seed));
    this.sql.exec("delete from agent_focus");
    this.sql.exec("delete from view_state");
    this.broadcast();
  }

  async state() {
    let n = 0;
    return {
      seed: Number(this.meta("seed")),
      profiles: parseProfiles(this.env.APC_PROFILES),
      grants: this.grants().map((g) => {
        const path = pathOf(g);
        const fallback = path === "dock" ? "Agent via dock" : `Agent ${++n}`;
        return {
          id: g.id,
          path,
          hub: g.hub,
          agent: g.agent,
          name: g.owner_name ?? g.client_title ?? g.client_name ?? fallback,
          // The person's page builds a Direct agent's MCP URL from it; a dock's grant stays the hub's.
          secret: path === "direct" ? g.secret : null,
          client: g.client_name,
          icon: g.client_icon,
          connected: !!(g.client_title || g.client_name),
          waiting: this.waiting.has(g.id),
          pin: this.focusRow(g.id),
          linked_with: this.links.partnerOf(g.id),
        };
      }),
    };
  }

  /** A new agent connected directly (the Direct profile): its own grant and MCP URL, made by the person. */
  async addDirectGrant(): Promise<{ ok: boolean; error?: string; grant_id?: string }> {
    if (!this.offers("direct")) return { ok: false, error: "dock_only" };
    if (this.grants().filter((g) => !g.hub).length >= 20) return { ok: false, error: "too_many" };
    const g = newDirectGrant();
    this.sql.exec("insert into grants (id, secret, hub, agent, created_at) values (?, ?, null, null, ?)", g.id, g.secret, g.created_at);
    this.broadcast();
    return { ok: true, grant_id: g.id };
  }

  /** The person's own name for an agent; empty gives it back its own. */
  async renameGrant(grantId: string, raw: unknown): Promise<{ ok: boolean }> {
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false };
    this.sql.exec("update grants set owner_name = ? where id = ?", cleanAgentName(raw), grantId);
    this.broadcast();
    return { ok: true };
  }

  /** The person unlinks an agent shown as one (apc_link): the link goes, both grants stay. */
  async unlinkGrant(grantId: string): Promise<{ ok: boolean }> {
    const partner = this.links.unlink(grantId);
    this.broadcast();
    return { ok: !!partner };
  }

  async reportView(raw: unknown): Promise<{ ok: boolean }> {
    const view = sanitizeView(raw, this.posts());
    if (!view) return { ok: false };
    this.sql.exec("insert into view_state (id, data) values (1, ?) on conflict(id) do update set data = excluded.data", JSON.stringify(view));
    return { ok: true };
  }

  /** keepRead: a badge dropped on its own target changes nothing (the /pin route); a dock drop (pairHub) always pins again and wakes the agent. */
  async pin(grantId: string, raw: unknown, keepRead = false): Promise<{ ok: boolean; error?: string }> {
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const checked = checkPin(raw, this.posts());
    if ("error" in checked) return { ok: false, error: checked.error };
    const t = checked.target;
    if (keepRead && samePin(this.focusRow(grantId), t)) return { ok: true };
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
   * The person dropped an agent from a dock here (DESIGN.md 12.1, as in Pulse's v2): a grant for it,
   * handed to the dock's hub server to server with the drag's ticket, and the pin. An agent Signals holds
   * no grant for gets one only with the person's yes on this page, checked here (APC 0.7, TIN-606): the
   * answer is `consent_required` with a nonce, and only a request that brings the nonce back pairs.
   */
  async pairHub(sid: string, origin: string, raw: unknown): Promise<{ ok: boolean; error?: string; grant_id?: string; consent?: string }> {
    if (!this.offers("dock")) return { ok: false, error: "not_available" };
    const b = raw as { hub?: unknown; agent?: unknown; ticket?: unknown; target?: unknown; consent?: unknown } | null;
    const hub = typeof b?.hub === "string" ? b.hub : "";
    const allowed = (this.env.HUB_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (!allowed.includes(hub) && !(dev() && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(hub))) return { ok: false, error: "hub_not_allowed" };
    if (typeof b?.agent !== "string" || !/^[\w.:-]{1,128}$/.test(b.agent) || typeof b.ticket !== "string" || !/^[\w.-]{16,200}$/.test(b.ticket)) return { ok: false, error: "invalid" };
    const agent = b.agent;
    // One drop of an agent at a time (Grok on #123): a second request while the first waits on the hub (a double-clicked
    // Allow) changes nothing, so it can neither take the grant the first is making for a link nor revoke it.
    const key = `${hub} ${agent}`;
    if (this.pairing.has(key)) return { ok: false, error: "pairing_in_progress" };
    this.pairing.add(key);
    try {
      return await this.pairHubOnce(sid, origin, hub, agent, b.ticket, b.target, b.consent);
    } finally {
      this.pairing.delete(key);
    }
  }

  private async pairHubOnce(sid: string, origin: string, hub: string, agent: string, ticket: string, target: unknown, consent: unknown): Promise<{ ok: boolean; error?: string; grant_id?: string; consent?: string }> {
    /** The person has not said yes here for this agent: the page asks, with this nonce. */
    const askFirst = () => ({ ok: false, error: CONSENT_REQUIRED, consent: this.consent.ask(hub, agent) });
    const linked = this.grants().find((g) => g.hub === hub && g.agent === agent);
    if (linked) {
      // Already paired here: the hub must still say so (TIN-389). If it does not, the grant goes and the person is asked again.
      const check = await hubCall(hub, "/apc/confirm", { ticket, agent, mcp_url: `${origin}/mcp/${sid}/${linked.secret}` });
      if (!check.ok) {
        if (check.error !== "not_paired") return { ok: false, error: check.error ?? "hub_refused" };
        // The ticket is still good: the person can say yes here and pair at once.
        await this.revoke(linked.secret);
        return askFirst();
      }
      this.sql.exec("update grants set client_icon = coalesce(?, client_icon) where id = ?", pickClientIcon([{ src: check.agent?.icon }]), linked.id);
      return { ...(await this.pin(linked.id, target)), grant_id: linked.id };
    }
    // No grant for this agent: one is made only with the person's yes on this page, proven by the nonce it was shown with.
    if (!this.consent.take(consent, hub, agent)) return askFirst();
    const { id, secret, created_at } = newDirectGrant();
    // The grant exists (its MCP URL answers), but it is linked to the agent only once the hub took it, as Pulse writes
    // its hub link after /apc/pair: until then no drop finds it as this agent's.
    this.sql.exec("insert into grants (id, secret, hub, agent, created_at) values (?, ?, ?, null, ?)", id, secret, hub, created_at);
    const answer = await hubCall(hub, "/apc/pair", { ticket, agent, app: { name: "Signals", origin }, mcp_url: `${origin}/mcp/${sid}/${secret}` });
    if (!answer.ok) {
      this.sql.exec("delete from grants where id = ?", id);
      return { ok: false, error: answer.error ?? "hub_refused" };
    }
    // The agent's mark from the hub, so its first pin already shows its logo.
    const name = typeof answer.agent?.name === "string" ? answer.agent.name.replace(/[\p{C}]/gu, "").trim().slice(0, 60) || null : null;
    this.sql.exec("update grants set agent = ?, client_title = ?, client_icon = ? where id = ?", agent, name, pickClientIcon([{ src: answer.agent?.icon }]), id);
    this.broadcast();
    return { ...(await this.pin(id, target)), grant_id: id };
  }

  /** A dock's hub gives back its grant (TIN-388): the grant and its pin go, and the next drop asks again. */
  async revoke(secret: string): Promise<{ ok: boolean }> {
    const grant = this.grants().find((g) => g.secret === secret);
    if (!grant?.hub) return { ok: false };
    this.links.forget(grant.id);
    this.sql.exec("delete from agent_focus where grant_id = ?", grant.id);
    this.sql.exec("delete from grants where id = ?", grant.id);
    this.broadcast();
    return { ok: true };
  }

  /**
   * Revoke from the app (APC 0.2, TIN-577): the person cuts an agent from Signals itself. It holds at
   * once and calls nobody, so it holds with the dock's hub down: the grant and its pin go, and its MCP
   * URL answers 403 "revoked" from then on, with a call already running ending the same way. The hub
   * learns it on its next call and shows "Revoked by" this host; a new drop asks the person again.
   */
  async revokeGrant(grantId: string): Promise<{ ok: boolean; error?: string }> {
    // A linked agent (apc_link) is one agent with two grants: Revoke cuts both.
    const partner = this.links.partnerOf(grantId);
    const targets = this.grants().filter((g) => g.id === grantId || g.id === partner);
    if (!targets.some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const hashes = await Promise.all(targets.map(async (g) => [g, await secretHash(g.secret)] as const));
    // Everything below is synchronous storage work: nothing runs between the check and the deletes.
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const at = new Date().toISOString();
    for (const [grant, hash] of hashes) {
      // A Direct grant has no hub or agent; the table, older than Direct, wants text there.
      this.sql.exec("insert or replace into revoked_grants (secret_hash, grant_id, hub, agent, revoked_at) values (?, ?, ?, ?, ?)", hash, grant.id, grant.hub ?? "", grant.agent ?? "", at);
      this.links.forget(grant.id);
      this.sql.exec("delete from agent_focus where grant_id = ?", grant.id);
      this.sql.exec("delete from grants where id = ?", grant.id);
    }
    this.broadcast();
    return { ok: true };
  }

  /** When the grant with this secret was revoked here, or null: by the secret's hash only, never a grant id a later grant may reuse (TIN-606). */
  private revokedAt(hash: string): string | null {
    return this.sql.exec<{ revoked_at: string }>("select revoked_at from revoked_grants where secret_hash = ?", hash).toArray()[0]?.revoked_at ?? null;
  }
  /** The grant with this secret is still live: this grant, never a later one that took its id. */
  private holds(secret: string): boolean {
    return this.sql.exec("select 1 from grants where secret = ?", secret).toArray().length > 0;
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
    if (!(await this.alive())) return Response.json({ error: "expired" }, { status: 404 });
    // The secret's hash, before the grant is looked up: what says whether this grant was revoked, now and during its calls.
    const hash = await secretHash(secret);
    const grant = this.grants().find((g) => g.secret === secret);
    if (!grant) {
      // Revoked in the app (APC 0.2): 403 with the answer, whatever the method (checked before the
      // method), so the dock's hub can say who revoked it.
      const revokedAt = this.revokedAt(hash);
      if (revokedAt) return revokedResponse(new URL(origin).host, revokedAt);
      return Response.json({ error: "unknown_grant" }, { status: 404 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    await this.touch();
    try {
      const arriving = initializeOf(await request.clone().json());
      if (arriving) {
        // The hub introduces a dock agent by its title; a Direct agent's client names itself.
        const title = arriving.title?.replace(/[\p{C}]/gu, "").trim().slice(0, 60) || null;
        if (title || !grant.hub) this.sql.exec("update grants set client_title = coalesce(?, client_title), client_icon = coalesce(?, client_icon), client_name = ? where id = ?", title, pickClientIcon(arriving.icons), grant.hub ? grant.client_name : arriving.name, grant.id);
        // apc_link: a new MCP session of this grant, by its client (on the Dock path, the one its hub names).
        this.links.arrived(grant.id, linkClient(arriving, pathOf(grant)));
        this.broadcast();
      }
    } catch {
      // not JSON: the transport answers the error
    }

    const [{ McpServer }, { WebStandardStreamableHTTPServerTransport }, { CfWorkerJsonSchemaValidator }, { registerApcLinkTool, registerApcTools }, { z }] = await Promise.all([
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
    this.instrument(server, grant, hash, posts, origin);
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
      // A grant revoked during a wait ends it at the next poll, as a closed page does; instrument() then answers "revoked".
      pageOpen: async () => (this.holds(grant.secret) ? this.pageOpen() : false),
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
    // apc_link: where Signals offers both profiles, the same agent on both paths can show as one.
    if (this.offers("direct") && this.offers("dock")) {
      registerApcLinkTool(server, {
        appName: "Signals",
        redeem: async (code) => {
          const r = await this.links.redeem(grant.id, code);
          if (r.ok) this.broadcast();
          return r;
        },
      });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    return transport.handleRequest(new Request(request, { headers }));
  }

  /**
   * Around every tool: the revoked answer for a grant revoked since its request came in, the attention
   * envelope while the grant's pin is unread, then while the person's page is open (not on a wait that
   * came back empty, which ends the loop), and presence on the page after each successful call.
   */
  private instrument(server: McpServer, grant: Grant, hash: string, posts: Post[], origin: string): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    const grantId = grant.id;
    // By the grant's secret and its hash, never its id, which a later grant may reuse (TIN-606).
    const cut = (): ToolResult | null => {
      if (this.holds(grant.secret)) return null;
      const revokedAt = this.revokedAt(hash);
      return revokedAt ? revokedToolResult(new URL(origin).host, revokedAt) : toolError("unknown_grant", "This grant no longer exists.");
    };
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
      register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
        const before = cut();
        if (before) return before;
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
        const after = cut();
        if (after) return after;
        const row = this.focusRow(grantId);
        const focus = focusPayload(row, posts, origin);
        if (isUnread(row) && focus) result = attachAttention(result, attentionFor(focus));
        const tool = String(name);
        if (!result.isError) {
          // Presence (the core, APC 0.2): ids only, the post a read named.
          const targets = tool === "get_post" && typeof args.id === "string" ? [{ kind: "post", id: args.id }] : [];
          this.broadcast({ type: "presence", event: presenceEvent({ grantId, tool, kind: "read", targets }) });
        }
        // Signals shares the view always (it has no switch), so attendance is the page itself.
        result = attachThen(result, loopHinted(tool, result.structuredContent?.focus != null, this.pageOpen()));
        // apc_link: at most once per session, the offer to show this agent as one with its other path.
        const offer = result.isError ? null : await this.links.offer(grantId, tool);
        return offer ? attachApcLink(result, offer) : result;
      });
  }
}
