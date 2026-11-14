/**
 * One visitor's Signals (TIN-384): a Durable Object holding, for the demo's one world (the posts are
 * the same for everyone, TIN-621), the visitor's grants, the view, the pins and the page's WebSocket. Agents come both ways
 * (APC_PROFILES, TIN-578): Direct, with a grant and MCP URL the person makes on the page (the Direct
 * profile from @tineira/apc-server and @tineira/apc-web), and Dock, where a dock's hub pairs after the person says yes
 * here and in the dock, and reads with the grant Signals made for it. The same agent on both shows as
 * one (apc_link).
 */
import { DurableObject } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PAIRING_CODE_TTL_MS, waitOpenLimitMs, type ApcProfile, type FocusRow, type PresenceWaitEvent } from "@tineira/apc-protocol";
import { APC_INSTRUCTIONS, ApcLinks, attachApcLink, confirmWithHub, CONSENT_REQUIRED, DockConsent, dockGrantGate, pairWithHub, parseDockDrop, InflightCalls, MemoryWaitSlots, attachAttention, attachThen, attentionFor, cleanAgentName, initializeOf, isUnread, linkClient, newDirectGrant, parseProfiles, presenceEvent, revokedResponse, revokedToolResult, secretHash, sqlKv, toolError, toolResult, type ToolResult } from "@tineira/apc-server";
import type { Post } from "../../../demo/src/model/market.ts";
import { demoMarket } from "../../../demo/src/model/demo-world.ts";
import { anyPageOpen, loopHinted } from "../../../demo/src/worker/page.ts";
import { pickClientIcon } from "../../../demo/src/worker/client-icon.ts";
import { bodyTooLarge, DOCK_TIMES, dockStateNow, hubAllowlist, readMcpBody, hubCallOptions, pairableProfiles, type DockStored } from "../../../demo/src/worker/dock-app.ts";
import { checkPin, focusPayload, samePin, KINDS, listPosts, postAnswer, sanitizeView, viewPayload, type StoredView } from "./logic.ts";

export const FEED_TTL_MS = 6 * 60 * 60_000;
const WAIT_CEILING_S = 50;

export interface Env {
  FEED: DurableObjectNamespace<Feed>;
  ASSETS: Fetcher;
  NEW_FEED?: RateLimit;
  FEED_CALLS?: RateLimit;
  /** Comma-separated origins of the agent docks Signals may pair with: its allowlist (M1). */
  HUB_ORIGINS?: string;
  /** Signals' public origin, as configured (M6, APC 0.10): what an owner request's Origin must equal, and where its MCP URLs live. */
  PUBLIC_ORIGIN?: string;
  /** The profiles Signals offers, in one place ("direct,dock" in wrangler.jsonc). Missing: both. */
  APC_PROFILES?: string;
}

/**
 * The profiles Signals serves: what APC_PROFILES declares, with Dock only while it can pair right now (M8, APC 0.10:
 * PUBLIC_ORIGIN and HUB_ORIGINS are configured). The one source for its apc.json, its page and its own checks.
 */
export function servedProfiles(env: Pick<Env, "APC_PROFILES" | "HUB_ORIGINS" | "PUBLIC_ORIGIN">): ApcProfile[] {
  return pairableProfiles(parseProfiles(env.APC_PROFILES), env);
}

/** A dock grant waiting for the person to type the pairing code in their dock (APC 0.9): shown only on Signals' own page. */
export interface DockPairing {
  code: string;
  expires_at: string;
}

/** What a dock agent's drop answers the page. */
export interface PairHubAnswer {
  ok: boolean;
  error?: string;
  grant_id?: string;
  /** pending: the dock still wants the code; connecting: it took the code and has not connected yet (APC 0.10). */
  status?: string;
  /** consent_required: the nonce the Allow sends back, and the pairing code the consent shows (APC 0.9). */
  consent?: string;
  pairing_code?: string;
  /** The grant waits for the dock owner's code: what the page's waiting card shows. */
  pairing?: DockPairing;
  /** The grant was handed to the hub, but the pin on the drop's target failed. */
  pin_error?: string;
}

const dev = () => !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
  /**
   * A dock grant's lifecycle (APC 0.10): in_flight from the Allow, handoff from the hub's acknowledgement, live from
   * the hub's first committed initialize. Null on a Direct grant and on a dock grant from before, which is live.
   */
  state: string | null;
  /** SHA-256 of the secret: how a give-back and Cancel find a dock grant. */
  secret_hash: string | null;
  /** When the person allowed it, and when the hub acknowledged it: ms since the epoch. */
  allowed_at: number | null;
  acked_at: number | null;
  /** The code the dock owner types, while the grant waits in handoff (APC 0.9), and until when the page shows it. */
  pairing_code: string | null;
  pairing_expires_at: string | null;
}

export class Feed extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The open wait of each grant, from its wait events (APC 0.11): what a page that connects mid-wait is told first (memory only). */
  private readonly openWaits = new Map<string, PresenceWaitEvent>();
  /** MCP's notifications/cancelled, which arrives in a POST of its own, reaches the call it names (APC 0.8). */
  private readonly calls = new InflightCalls();
  /** apc_link (APC 0.4): which Direct and Dock grants are one agent. */
  private links!: ApcLinks;
  /** One wait_for_focus per grant (APC 0.8): every request of this feed runs in this object, so the places live in memory. */
  private readonly waitSlots = new MemoryWaitSlots();
  /** Consent in the app, checked here (APC 0.7): the nonce the page shows its consent with. */
  private consent!: DockConsent;
  /** Dock drops being answered, by dock and agent (memory only): one at a time per agent. */
  private pairing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.backfillSecretHashes();
    });
  }

  /** A dock grant from before APC 0.10 has no secret hash: it gets one, so its hub can still give it back (M7). */
  private async backfillSecretHashes(): Promise<void> {
    for (const g of this.grants().filter((x) => x.hub && !x.secret_hash)) this.sql.exec("update grants set secret_hash = ? where id = ? and secret_hash is null", await secretHash(g.secret), g.id);
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
      create table if not exists dock_consents (hub text not null, agent text not null, nonce text not null, primary key (hub, agent));
    `);
    // client_icon since TIN-388, the names since TIN-578; a dock grant's lifecycle, its secret's hash and the code it
    // waits on since APC 0.10 (TIN-892). The two times are ms since the epoch.
    for (const column of ["client_icon text", "client_name text", "owner_name text", "state text", "secret_hash text", "allowed_at integer", "acked_at integer", "pairing_code text", "pairing_expires_at text"]) {
      try {
        this.sql.exec(`alter table grants add column ${column}`);
      } catch {
        // already there
      }
    }
    // A dock grant from a Signals before 0.10 has no state. One whose agent was never written is an Allow the hub
    // never acknowledged (the agent was set only after /apc/pair answered): it has ended, and is not read as live.
    // The others were handed to their hub; Signals stored no code then, so a row cannot say whether its hub had
    // connected, and they stay live (a feed lives 6 hours, and the hub sends initialize before anything else, H1).
    this.sql.exec("delete from agent_focus where grant_id in (select id from grants where hub is not null and agent is null and state is null)");
    this.sql.exec("delete from grants where hub is not null and agent is null and state is null");
    this.links = new ApcLinks(sqlKv(this.sql), { appName: "Signals", grants: () => this.grants().map((g) => ({ id: g.id, path: pathOf(g) })) });
    this.consent = new DockConsent(sqlKv(this.sql));
  }

  /** Whether Signals offers this profile (APC_PROFILES). */
  private offers(profile: ApcProfile): boolean {
    return servedProfiles(this.env).includes(profile);
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0]?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }
  /** The demo's one world (TIN-621). A feed made before it kept a seed of its own; it is ignored. */
  private posts(): Post[] {
    return demoMarket().posts;
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
  /** A wait of a grant opened or closed (APC 0.11): kept for pages that connect later, and published on the presence channel. */
  private noteWait(event: PresenceWaitEvent): void {
    if (event.state === "open") this.openWaits.set(event.grant_id, event);
    else this.openWaits.delete(event.grant_id);
    this.broadcast({ type: "presence", event });
  }
  /** The waits open now, as the presence messages a page that just connected is sent; one past the ceiling and margin is left out. */
  waitsNow(now: number = Date.now()): Array<{ type: "presence"; event: PresenceWaitEvent }> {
    const limit = waitOpenLimitMs(WAIT_CEILING_S);
    return [...this.openWaits.values()].filter((e) => now - Date.parse(e.at) < limit).map((event) => ({ type: "presence" as const, event }));
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
    this.migrate();
  }

  // ---- owner RPC ----

  async init(): Promise<{ owner: string }> {
    const existing = this.meta("owner");
    if (existing) return { owner: existing };
    const owner = randomHex(16);
    this.setMeta("owner", owner);
    await this.touch();
    return { owner };
  }

  async isOwner(secret: string): Promise<boolean> {
    if (!(await this.alive()) || this.meta("owner") !== secret) return false;
    await this.touch();
    return true;
  }

  async state() {
    let n = 0;
    // A dock grant past its time has ended (APC 0.10): the page never lists it.
    this.sweepDock();
    return {
      profiles: servedProfiles(this.env),
      grants: this.grants().map((g) => {
        const path = pathOf(g);
        const fallback = path === "dock" ? "Agent via dock" : `Agent ${++n}`;
        return {
          id: g.id,
          path,
          // Where a dock grant stands (APC 0.10): in_flight (the Allow is being answered), handoff (the dock has it and
          // has not connected: with `pairing` the code is still to be typed, without it the dock said it is
          // connecting), live. The code is for this page only: never over MCP or to the hub.
          ...(path === "dock" ? { state: (g.state ?? "live") as DockStored, pairing: g.state === "handoff" && g.pairing_code && g.pairing_expires_at ? { code: g.pairing_code, expires_at: g.pairing_expires_at } : null } : {}),
          hub: g.hub,
          agent: g.agent,
          name: g.owner_name ?? g.client_title ?? g.client_name ?? fallback,
          // The person's page builds a Direct agent's MCP URL from it; a dock's grant stays the hub's.
          secret: path === "direct" ? g.secret : null,
          client: g.client_name,
          icon: g.client_icon,
          // A dock agent is connected once its hub introduced itself (live); a Direct one once its client did.
          connected: path === "dock" ? (g.state ?? "live") === "live" : !!(g.client_title || g.client_name),
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
   * Since APC 0.9 (TIN-859) the answer carries a pairing code too: the page shows it, the hub gets it with the
   * grant (`pairWithHub`, which keeps the grant only if the hub says it keeps the code), and the dock's Allow needs it.
   */
  async pairHub(sid: string, origin: string, raw: unknown): Promise<PairHubAnswer> {
    if (!this.offers("dock")) return { ok: false, error: "not_available" };
    // The hub allowlist (M1, APC 0.10), on the drop and again on the Allow: both are this request. The hub is parsed,
    // must be a bare https origin on HUB_ORIGINS, and the hub calls below go to that parsed origin (M9).
    const drop = parseDockDrop(raw, hubAllowlist(this.env));
    if (!drop.ok) return { ok: false, error: drop.error === "hub_not_allowed" ? "hub_not_allowed" : "invalid" };
    const b = raw as { target?: unknown; consent?: unknown };
    const { hub, agent, ticket } = drop;
    // One drop of an agent at a time (Grok on #123; M5): a second request while the first waits on the hub (a double-clicked
    // Allow) changes nothing, so it can neither take the grant the first is making for a link nor revoke it. The
    // grant's stored in_flight state says the same after a restart (pairHubOnce).
    const key = `${hub} ${agent}`;
    if (this.pairing.has(key)) return { ok: false, error: "pairing_in_progress" };
    this.pairing.add(key);
    try {
      return await this.pairHubOnce(sid, origin, hub, agent, ticket, b.target, b.consent);
    } finally {
      this.pairing.delete(key);
    }
  }

  private async pairHubOnce(sid: string, origin: string, hub: string, agent: string, ticket: string, target: unknown, consent: unknown): Promise<PairHubAnswer> {
    /** The person has not said yes here for this agent: the page asks, with this nonce and the pairing code (APC 0.9). */
    const askFirst = (): PairHubAnswer => {
      const asked = this.consent.ask(hub, agent);
      // This consent replaces any older one for the same dock and agent: only its nonce pairs from now on.
      this.sql.exec("insert into dock_consents (hub, agent, nonce) values (?, ?, ?) on conflict(hub, agent) do update set nonce = excluded.nonce", hub, agent, asked.nonce);
      return { ok: false, error: CONSENT_REQUIRED, consent: asked.nonce, pairing_code: asked.pairing_code };
    };
    const pinNote = (pinned: { ok: boolean; error?: string }) => (pinned.ok ? {} : { pin_error: pinned.error ?? "pin_failed" });
    this.sweepDock();
    const linkOf = () => this.grants().find((g) => g.hub === hub && g.agent === agent) ?? null;
    const linked = linkOf();
    if (linked) {
      // An Allow for this agent is still waiting on the hub (APC 0.10): one pairing at a time, also after a restart
      // lost the in-memory lock. Past T_ack the sweep above ended it, and the drop asks again.
      if (linked.state === "in_flight") return { ok: false, error: "pairing_in_progress" };
      // Already handed to the dock: the hub must still say so (TIN-389). If it does not, the grant goes and the person is asked again.
      const check = await confirmWithHub(hub, { ticket, agent, mcp_url: `${origin}/mcp/${sid}/${linked.secret}` }, hubCallOptions(this.env));
      // Everything below is synchronous: the grant is read again, since a Cancel, a Revoke, a give-back or its time
      // running out may have taken it while the hub answered.
      this.sweepDock();
      const now = this.grants().find((g) => g.secret === linked.secret) ?? null;
      if (!check.ok) {
        if (check.error !== "not_paired") return { ok: false, error: check.error };
        // The dock no longer pairs them: the grant ends, and the ticket is still good, so the person can say yes here and pair at once.
        if (now) this.endDockGrant(now.id);
        return askFirst();
      }
      // Gone while the hub answered. The ticket is spent: the person drags the agent again.
      if (!now) return { ok: false, error: "pairing_ended" };
      this.sql.exec("update grants set client_icon = coalesce(?, client_icon) where id = ?", pickClientIcon([{ src: check.agent.icon }]), now.id);
      if (now.state === "handoff") {
        if (check.status === "paired") {
          // The dock took the code and is connecting (APC 0.10): the grant stays in handoff, since only the hub's
          // initialize makes it live. The page hides the code and says so; the pin waits for the grant to be live.
          this.sql.exec("update grants set pairing_code = null, pairing_expires_at = null where id = ? and state = 'handoff'", now.id);
          this.broadcast();
          return { ok: true, grant_id: now.id, status: "connecting", ...pinNote(await this.pin(now.id, target)) };
        }
        // Still pending at the dock. With the stored expiry ahead, the page shows the same code and the time left: no
        // new consent, no new code, and the drop's target replaces the pin. Past it, the grant ends and the person is asked again.
        if (!now.pairing_code || !now.pairing_expires_at || Date.parse(now.pairing_expires_at) <= this.dockNow()) {
          this.endDockGrant(now.id);
          return askFirst();
        }
        const pairing: DockPairing = { code: now.pairing_code, expires_at: now.pairing_expires_at };
        return { ok: true, grant_id: now.id, status: "pending", pairing, ...pinNote(await this.pin(now.id, target)) };
      }
      return { ...(await this.pin(now.id, target)), grant_id: now.id, status: check.status };
    }
    // No grant for this agent: one is made only with the person's yes on this page, proven by the nonce it was shown with.
    const { id, secret, created_at } = newDirectGrant();
    // Before anything is written: the secret's hash, which the grant keeps for a give-back and for Cancel.
    const hash = await secretHash(secret);
    if (linkOf()) return { ok: false, error: "pairing_in_progress" };
    // A drop (no nonce) is asked, and its consent replaces the one before. An Allow on a consent a newer drop
    // replaced is refused before the nonce is looked at: one pending consent per dock and agent.
    if (consent === undefined || consent === null) return askFirst();
    // Used or not, a nonce that was sent goes: it works once.
    if (this.latestConsent(hub, agent) !== consent) return (this.consent.takeConsent(consent, hub, agent), { ok: false, error: "consent_expired" });
    const taken = this.consent.takeConsent(consent, hub, agent);
    this.sql.exec("delete from dock_consents where hub = ? and agent = ?", hub, agent);
    // A drop (no nonce) is asked. An Allow whose nonce does not take (used, timed out, another agent's) fails closed
    // (APC 0.10, `consent_expired`): the person drags the agent again, and that drop is asked anew.
    if (!taken.ok) return { ok: false, error: "consent_expired" };
    // In flight (APC 0.10): the grant exists before the hub hears of it, and answers 404 to everything until the
    // hub's acknowledgement. One synchronous step with the consent taken above.
    this.sql.exec(
      "insert into grants (id, secret, hub, agent, created_at, state, secret_hash, allowed_at, pairing_code) values (?, ?, ?, ?, ?, 'in_flight', ?, ?, ?)",
      id, secret, hub, agent, created_at, hash, this.dockNow(), taken.pairing_code,
    );
    // No lock is held across the call (M5): the row above is the only thing that says a pairing is under way.
    // The hub must say it keeps the code (APC 0.9): on any other answer the grant ends before the page hears back.
    const answer = await pairWithHub(hub, { ticket, agent, app: { name: "Signals", origin }, mcp_url: `${origin}/mcp/${sid}/${secret}`, pairing_code: taken.pairing_code }, hubCallOptions(this.env));
    // Synchronous from here to the answer.
    if (!answer.ok) {
      if (this.holds(secret)) this.endDockGrant(id);
      return { ok: false, error: answer.error };
    }
    // The acknowledgement moves the grant to handoff only if it is still in flight and within T_ack, in one statement
    // (APC 0.10): a give-back or a Revoke that landed during the call, or T_ack, wins, and the grant stays as they left it.
    const at = this.dockNow();
    const pairing: DockPairing = { code: taken.pairing_code, expires_at: new Date(at + PAIRING_CODE_TTL_MS).toISOString() };
    // The agent's mark from the hub, so its first pin already shows its logo.
    const name = answer.agent.name ? answer.agent.name.replace(/[\p{C}]/gu, "").trim().slice(0, 60) || null : null;
    const moved = this.sql
      .exec(
        "update grants set state = 'handoff', acked_at = ?, pairing_expires_at = ?, client_title = ?, client_icon = ? where secret = ? and state = 'in_flight' and allowed_at > ? returning id",
        at, pairing.expires_at, name, pickClientIcon([{ src: answer.agent.icon }]), secret, at - DOCK_TIMES.ackMs,
      )
      .toArray().length === 1;
    if (!moved) {
      if (this.holds(secret)) this.endDockGrant(id);
      return { ok: false, error: "pairing_ended" };
    }
    this.broadcast();
    // Handed to the hub and waiting for the code in the dock, whatever the pin does: a pin that failed is said apart.
    return { ok: true, grant_id: id, status: "pending", pairing, ...pinNote(await this.pin(id, target)) };
  }

  // ---- a dock grant's lifecycle (APC 0.10, TIN-892) ----

  /**
   * The clock of the dock grant's limits (T_ack, T_connect, the code's expiry): the wall clock, plus an offset
   * that only a test moves (`advanceDockClock`, the conformance suite's time seam). No route of the Worker
   * reaches that method, so in production the offset is always 0.
   */
  private dockSkewMs = 0;
  private dockNow(): number {
    return Date.now() + this.dockSkewMs;
  }
  /** The time seam, for tests only: the dock grant's clock moves `ms` forward. The Worker never calls it. */
  async advanceDockClock(ms: number): Promise<void> {
    this.dockSkewMs += Math.max(0, ms);
  }
  /**
   * The consent that stands for a dock agent: the newest drop's (APC 0.10, "one pending pairing"). A newer drop
   * replaces it, so the Allow on an older consent fails closed (`consent_expired`).
   */
  private latestConsent(hub: string, agent: string): string | null {
    return this.sql.exec<{ nonce: string }>("select nonce from dock_consents where hub = ? and agent = ?", hub, agent).toArray()[0]?.nonce ?? null;
  }

  /**
   * Ends every dock grant past its time (MUST, APC 0.10): still in flight T_ack after the Allow, or still in handoff
   * T_connect after the hub's acknowledgement. Synchronous, and run before anything reads a dock grant, so an overdue
   * grant is never served, listed or moved on.
   */
  private sweepDock(): void {
    const now = this.dockNow();
    for (const g of this.grants()) if (g.hub && dockStateNow(g, now) === "ended") this.endDockGrant(g.id);
  }
  /** A dock's grant ends: it goes with its pin, and its MCP URL answers 404. Synchronous. */
  private endDockGrant(grantId: string): void {
    this.links.forget(grantId);
    this.waitSlots.forget(grantId);
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.sql.exec("delete from grants where id = ?", grantId);
    this.broadcast();
  }
  /**
   * A give-back (M7, APC 0.10): ends the dock grant whose secret hashes to `hash`, in flight, in handoff or live.
   * A revoked grant is gone from this table, so it stays revoked; an ended one is gone. One synchronous step. It
   * never opens or extends a feed: it reads one table.
   */
  async endDockGrantBySecretHash(hash: string): Promise<boolean> {
    const row = this.sql.exec<{ id: string }>("select id from grants where secret_hash = ? and hub is not null", hash).toArray()[0];
    if (!row) return false;
    this.endDockGrant(row.id);
    return true;
  }
  /** A dock's hub gives back its grant (TIN-388), by the secret, for callers that hold it (tests); the Worker's /apc/revoke goes by its hash. */
  async revoke(secret: string): Promise<{ ok: boolean }> {
    return { ok: await this.endDockGrantBySecretHash(await secretHash(secret)) };
  }
  /**
   * Cancel on the waiting card (APC 0.10): a revoke, allowed only in handoff, before the dock connected and so before
   * any call was served. The state check and the revoke are one synchronous step (the grant's secret hash is on its
   * row, so nothing is awaited between them): an `initialize` that committed first wins, and Cancel is refused; a
   * Cancel that ran first wins, and that `initialize` gets the revoked answer.
   */
  async cancelDockGrant(grantId: string): Promise<{ ok: boolean; error?: string }> {
    this.sweepDock();
    const grant = this.grants().find((g) => g.id === grantId);
    if (!grant) return { ok: false, error: "unknown_grant" };
    if (!grant.hub || grant.state !== "handoff" || !grant.secret_hash) return { ok: false, error: "not_cancellable" };
    this.revokeNow(grant, grant.secret_hash, new Date().toISOString());
    this.broadcast();
    return { ok: true };
  }
  /** One grant's revoke, synchronous: the revoked record by its secret's hash, then the grant and its pin go. */
  private revokeNow(grant: Grant, hash: string, at: string): void {
    // A Direct grant has no hub or agent; the table, older than Direct, wants text there.
    this.sql.exec("insert or replace into revoked_grants (secret_hash, grant_id, hub, agent, revoked_at) values (?, ?, ?, ?, ?)", hash, grant.id, grant.hub ?? "", grant.agent ?? "", at);
    this.links.forget(grant.id);
    this.waitSlots.forget(grant.id);
    this.sql.exec("delete from agent_focus where grant_id = ?", grant.id);
    this.sql.exec("delete from grants where id = ?", grant.id);
  }

  /**
   * Revoke from the app (APC 0.2, TIN-577): the person cuts an agent from Signals itself. It holds at
   * once and calls nobody, so it holds with the dock's hub down: the grant and its pin go, and its MCP
   * URL answers 403 "revoked" from then on, with a call already running ending the same way. The hub
   * learns it on its next call and shows "Revoked by" this host; a new drop asks the person again. A dock
   * grant in flight or in handoff is revoked the same way (APC 0.10: revoked comes before every other state).
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
    // By the secret, never the id alone: a grant that went and whose id a later one took is not this one.
    for (const [grant, hash] of hashes) if (this.holds(grant.secret)) this.revokeNow(grant, hash, at);
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
      // A wait already open (APC 0.11): the new page hears its open first, as if it had been there.
      for (const message of this.waitsNow()) pair[1].send(JSON.stringify(message));
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
    // The body, before the grant is looked up: from that lookup to the gate's answer (and the commit of an
    // initialize) nothing is awaited, so no Cancel, Revoke or give-back can run in between (APC 0.10).
    // Read once and bounded (MCP_BODY_MAX_BYTES), whoever asks: a caller with no grant cannot make Signals read more.
    let rpcBody: unknown = null;
    if (request.method === "POST") {
      const read = await readMcpBody(request);
      if (!read) return bodyTooLarge();
      rpcBody = read.json;
      request = read.request;
    }
    const host = new URL(origin).host;
    /** What this URL answers once its grant is gone: the revoked answer if the person revoked it (APC 0.2), 404 otherwise (never made, or ended). */
    const gone = (): Response => {
      const revokedAt = this.revokedAt(hash);
      return revokedAt ? revokedResponse(host, revokedAt) : Response.json({ error: "unknown_grant" }, { status: 404 });
    };
    // A dock grant past T_ack or T_connect has ended (APC 0.10): it is gone before it is looked up.
    this.sweepDock();
    const grant = this.grants().find((g) => g.secret === secret);
    // Revoked: 403 with the answer, whatever the method (checked before the method), so the dock's hub can say who revoked it.
    if (!grant) return gone();
    // Agent traffic on a grant that is not live yet extends nothing (APC 0.10): the feed's life is not touched by it.
    let extendsLife = true;
    // A dock grant answers by its state (APC 0.10, dockGrantGate): 404 in flight; in handoff only initialize, ping and
    // tools/list are served, and a tools/call gets the `pairing` error; live, everything. A gated answer is built here,
    // before the links, presence and the transport, so it carries no attention, then, apc_link or app data.
    if (grant.hub) {
      const gate = dockGrantGate((grant.state ?? "live") as DockStored, request.method === "POST" ? rpcBody : null, { host });
      if (!gate.serve) return gate.response;
      if (gate.commits) {
        // The hub's first initialize (the dock owner's yes) makes the grant live: one conditional statement, and no
        // result unless it committed. A storage failure answers HTTP 500, so the hub's introduction fails visibly.
        let committed: boolean;
        try {
          committed = this.sql.exec("update grants set state = 'live', pairing_code = null, pairing_expires_at = null where secret = ? and state = 'handoff' returning id", secret).toArray().length === 1;
        } catch {
          return Response.json({ error: "internal_error" }, { status: 500, headers: { "cache-control": "no-store" } });
        }
        // Not committed: the state that won answers (a Cancel or Revoke: the revoked answer; an end: 404). Nothing runs
        // between the lookup above and this statement, so this is the fail-closed branch, not a path that is taken.
        if (!committed) return gone();
        this.broadcast();
      } else if ((grant.state ?? "live") !== "live") {
        // Served in handoff (ping, tools/list): answered, and nothing else.
        extendsLife = false;
      }
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (extendsLife) await this.touch();
    // A notifications/cancelled in this POST aborts the call it names, running in another POST (APC 0.8).
    this.calls.cancel(grant.id, rpcBody);
    try {
      const arriving = initializeOf(rpcBody);
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
      import("@tineira/apc-server"),
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
    // The calls this POST carries, so a later notifications/cancelled can end them; the client hanging up ends them too.
    const inflight = this.calls.track(grant.id, rpcBody);
    registerApcTools(server, {
      readView: async () => viewPayload(this.storedView(), origin),
      readFocus: async () => focusPayload(this.focusRow(grant.id), posts, origin),
      focusUnread: async () => isUnread(this.focusRow(grant.id)),
      // Seen once delivered (APC 0.8): the exact pin the result carried, never a newer one dropped since.
      markSeen: async (pinnedAt) => {
        const row = this.focusRow(grant.id);
        if (!row || row.pinned_at !== pinnedAt || !isUnread(row)) return;
        this.sql.exec("update agent_focus set seen_at = ? where grant_id = ? and pinned_at = ?", new Date().toISOString(), grant.id, pinnedAt);
        this.broadcast();
      },
      // A grant revoked during a wait ends it at the next poll, as a closed page does; instrument() then answers "revoked".
      pageOpen: async () => (this.holds(grant.secret) ? this.pageOpen() : false),
      waitSlot: this.waitSlots.for(grant.id),
      // The wait events (APC 0.11): the page shows the agent listening while a wait holds its place, and only then.
      waitPresence: { grantId: grant.id, publish: (event) => this.noteWait(event) },
      signal: AbortSignal.any([request.signal, inflight.signal]),
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
    try {
      return await transport.handleRequest(new Request(request, { headers }));
    } finally {
      inflight.done();
    }
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
        // The page's "waiting" comes from the wait events registerApcTools sends (APC 0.11), not from counting calls.
        let result = (await (cb as (a: unknown, e: unknown) => Promise<ToolResult>)(args, extra)) as ToolResult;
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
        result = attachThen(result, loopHinted(tool, result.structuredContent?.focus != null, this.pageOpen(), row?.pinned_at ?? null));
        // apc_link: at most once per session, the offer to show this agent as one with its other path.
        const offer = result.isError ? null : await this.links.offer(grantId, tool);
        return offer ? attachApcLink(result, offer) : result;
      });
  }
}
