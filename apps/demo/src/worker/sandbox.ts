/**
 * One visitor's sandbox: a Durable Object that holds its grants, view, pins and
 * event log, serves its MCP endpoint and its presence WebSocket. The data is the
 * demo's one world (demo-world.ts, TIN-621), the same for everyone and read-only;
 * the rest is the visitor's alone: a URL leads to exactly one sandbox.
 */
import { DurableObject } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APC_LINK_TOOL, PAIRING_CODE_TTL_MS, waitOpenLimitMs, type ApcProfile, type FocusRow, type FocusTarget, type PresenceWaitEvent } from "@tineira/apc-protocol";
import { APC_INSTRUCTIONS, ApcLinks, attachApcLink, confirmWithHub, CONSENT_REQUIRED, DockConsent, dockGrantGate, pairWithHub, parseDockDrop, InflightCalls, MemoryWaitSlots, attachAttention, attachThen, attentionFor, envelopeBytes, initializeOf, isUnread, linkClient, newDirectGrant, parseProfiles, presenceEvent, revokedResponse, revokedToolResult, secretHash, sqlKv, thenBytes, toolError, toolResult, type ToolResult } from "@tineira/apc-server";
import { DEMO_SEED, REGIONS, type Dataset, type Region } from "../model/seed.ts";
import { demoDataset, demoMarket } from "../model/demo-world.ts";
import { compatSummary, type CompatRow, type LoggedEvent } from "./compat.ts";
import { anyPageOpen, attendance, loopHinted } from "./page.ts";
import { bodyTooLarge, DOCK_TIMES, dockStateNow, hubAllowlist, readMcpBody, hubCallOptions, pairableProfiles, type DockAppEnv, type DockStored } from "./dock-app.ts";
import { checkPin, resolveFocus, sanitizeView, trimView, type ClientConflict, type Grant, type StoredView } from "./domain.ts";
import { pickClientIcon } from "./client-icon.ts";
import { cleanName } from "./names.ts";
import { tourStep, type TourStep } from "./tour.ts";
import { productOf, sameProduct } from "../model/products.ts";
import { sessionPoint } from "./sessions.ts";

export const SANDBOX_TTL_MS = 6 * 60 * 60_000;
/** The most Direct agents one sandbox holds, as in Signals (TIN-607). Dock-paired grants have their own cap in the hub. */
export const MAX_DIRECT_GRANTS = 20;

/**
 * The profiles Pulse serves (APC 0.5): the one source for its apc.json, its page (state.profiles) and its
 * own checks. What APC_PROFILES declares, with Dock only on the standard's deploy (APC_V2), where it pairs with a
 * dock's hub, and only while that pairing is configured (PUBLIC_ORIGIN and HUB_ORIGINS; M8, APC 0.10).
 */
export function servedProfiles(env: { APC_PROFILES?: string; APC_V2?: string } & DockAppEnv): ApcProfile[] {
  return pairableProfiles(parseProfiles(env.APC_PROFILES).filter((p) => p !== "dock" || env.APC_V2 === "1"), env);
}
const SERVER_VERSION = "0.2.0";
/** wait_for_focus ceiling on this host (TIN-95 measurement in DESIGN.md). WAIT_CEILING_S in .dev.vars overrides it for a local probe. */
export const WAIT_CEILING_S = 50;

export interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
  NEW_SANDBOX?: RateLimit;
  SANDBOX_CALLS?: RateLimit;
  /** Secret (wrangler secret put LOADTEST_KEY): a request carrying it in x-apc-loadtest skips the new-sandbox limit. */
  LOADTEST_KEY?: string;
  /** Local probes only (scripts/wait-ceiling.mjs): a higher wait_for_focus ceiling than WAIT_CEILING_S. */
  WAIT_CEILING_S?: string;
  /** Analytics Engine dataset of distinct agent sessions (sessions.ts). Written only when ANALYTICS_SALT is set too. */
  MCP_SESSIONS?: AnalyticsEngineDataset;
  /** Secret (wrangler secret put ANALYTICS_SALT): the HMAC key for session keys and IP hashes. */
  ANALYTICS_SALT?: string;
  /** "1" on Pulse's APC v2 deploy (TIN-382): agents from a dock's hub can pair. Never set on apc.tineira.com. */
  APC_V2?: string;
  /** Comma-separated origins of the agent docks (hubs) Pulse may pair with, under APC_V2: its allowlist (M1). */
  HUB_ORIGINS?: string;
  /** Pulse's public origin, as configured (M6, APC 0.10): what an owner request's Origin must equal, and where its MCP URLs live. */
  PUBLIC_ORIGIN?: string;
  /**
   * The profiles Pulse offers (APC 0.4, TIN-578), declared in one place: "direct,dock" in
   * wrangler.jsonc. Direct: the person makes agents here, each with its own MCP URL. Dock: agents
   * dropped from a dock's hub (with APC_V2). Missing or empty: both.
   */
  APC_PROFILES?: string;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value ?? null)).length;
/** A dock grant waiting for the person to type the pairing code in their dock (APC 0.9): shown only on Pulse's own page. */
export interface DockPairing {
  code: string;
  expires_at: string;
}

/** A dock grant's link as stored: the hub and agent it is for, where it stands (APC 0.10) and the code it waits on. */
interface DockLink {
  [key: string]: SqlStorageValue;
  hub: string;
  agent: string;
  grant_id: string;
  /** in_flight, handoff or live; null on a link from before APC 0.10, which is live. */
  state: string | null;
  secret_hash: string | null;
  /** When the person allowed it, and when the hub acknowledged it: ms since the epoch. */
  allowed_at: number | null;
  acked_at: number | null;
  pairing_code: string | null;
  pairing_expires_at: string | null;
}

/** What a dock agent's drop answers the page (or Pulse for Windows). */
export interface PairHubAnswer {
  ok: boolean;
  error?: string;
  grant_id?: string;
  status?: string;
  /** consent_required: the nonce the Allow sends back, and the pairing code the consent shows (APC 0.9). */
  consent?: string;
  pairing_code?: string;
  /** The grant waits for the dock owner's code: what the page's waiting card shows. */
  pairing?: DockPairing;
  /** The grant was made and handed to the hub, but the pin on the drop's target failed. */
  pin_error?: string;
}

export class Sandbox extends DurableObject<Env> {
  private sql: SqlStorage;
  /** apc_link (APC 0.4): which Direct and Dock grants are one agent. Its table is made again with the others (migrate). */
  private links!: ApcLinks;
  /** One wait_for_focus per grant (APC 0.8): every request of this sandbox runs in this object, so the places live in memory. */
  private readonly waitSlots = new MemoryWaitSlots();
  /** MCP's notifications/cancelled, which arrives in a POST of its own, reaches the call it names (APC 0.8). */
  private readonly calls = new InflightCalls();
  /** The open wait of each grant, from its wait events (APC 0.11): what a page that connects mid-wait is told first. */
  private readonly openWaits = new Map<string, PresenceWaitEvent>();
  /** Consent in the app, checked here (APC 0.7): the nonce the page shows its consent with. In the same table as the links. */
  private consent!: DockConsent;
  /** Dock drops being answered, by dock and agent (memory only): one at a time per agent. */
  private pairing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The page's heartbeat is answered by the runtime without waking the object: it never reaches the log or the presence channel.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.backfillSecretHashes();
    });
  }

  /** A dock link from before APC 0.10 has no secret hash: it gets one, so its hub can still give the grant back (M7). */
  private async backfillSecretHashes(): Promise<void> {
    const rows = this.sql.exec<{ grant_id: string; secret: string }>("select l.grant_id as grant_id, g.secret as secret from hub_links l join grants g on g.id = l.grant_id where l.secret_hash is null").toArray();
    for (const r of rows) this.sql.exec("update hub_links set secret_hash = ? where grant_id = ? and secret_hash is null", await secretHash(r.secret), r.grant_id);
  }

  private migrate(): void {
    this.sql.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists grants (
        id text primary key, secret text not null unique, label text not null, client_name text,
        regions text, created_at text not null, last_active_at text);
      create table if not exists view_state (id integer primary key check (id = 1), data text not null);
      create table if not exists agent_focus (
        grant_id text primary key references grants(id) on delete cascade,
        kind text not null, target_id text, part text, params text,
        pinned_at text not null, seen_at text,
        check (target_id is not null or params is not null),
        check (params is null or length(params) <= 1024));
      create table if not exists events (
        id integer primary key autoincrement, at text not null, type text not null, grant_id text, data text not null);
      create table if not exists hub_links (
        hub text not null, agent text not null, grant_id text not null references grants(id) on delete cascade,
        pairing_id text, created_at text not null, primary key (hub, agent));
      create table if not exists revoked_grants (
        secret_hash text primary key, grant_id text not null, hub text, agent text, revoked_at text not null);
      create table if not exists dock_consents (hub text not null, agent text not null, nonce text not null, primary key (hub, agent));
    `);
    // Columns added after the table: client_icon (TIN-350), the names (TIN-356). A sandbox made before lacks them.
    for (const column of ["client_icon", "client_title", "agent_name", "owner_name", "conflict", "client_ua"]) {
      try {
        this.sql.exec(`alter table grants add column ${column} text`);
      } catch {
        // already there
      }
    }
    // The pairing code a dock grant waits on (APC 0.9, TIN-859), until its hub connects or the grant goes.
    for (const column of ["pairing_code", "pairing_expires_at"]) {
      try {
        this.sql.exec(`alter table hub_links add column ${column} text`);
      } catch {
        // already there
      }
    }
    // A dock grant's lifecycle (APC 0.10, TIN-892): in_flight from the Allow, handoff from the hub's acknowledgement,
    // live from the hub's first committed initialize. A link from before has no state: its hub read it already (live).
    // The times are ms since the epoch; secret_hash is how a give-back and Cancel find the grant without its secret.
    for (const column of ["state text", "secret_hash text", "allowed_at integer", "acked_at integer"]) {
      try {
        this.sql.exec(`alter table hub_links add column ${column}`);
      } catch {
        // already there
      }
    }
    // A link from a Pulse before 0.10 that still waits for its code was never read by its hub: it is in handoff, not
    // live, and T_connect runs from now. (One without a code was connected by its hub's initialize: live.)
    this.sql.exec("update hub_links set state = 'handoff', acked_at = ? where state is null and pairing_code is not null", Date.now());
    // A grant made for a dock says so itself, in the statement that makes it: if its link is missing (a write that
    // failed between the two), it is never served as a Direct grant. It ends when it is next looked at (sweepDock).
    try {
      this.sql.exec("alter table grants add column dock integer");
    } catch {
      // already there
    }
    this.sql.exec("update grants set dock = 1 where dock is null and id in (select grant_id from hub_links)");
    this.links = new ApcLinks(sqlKv(this.sql), { appName: "Pulse", grants: () => this.linkGrants() });
    this.consent = new DockConsent(sqlKv(this.sql));
    // A deploy without the Direct profile takes agents only from a dock (TIN-402): a grant with no
    // dock link is a leftover from before (the old default agent), and goes with its pins (TIN-410).
    // Not when APC_PROFILES is wrong and nothing is offered: a typo must not delete the person's agents.
    if (this.env.APC_V2 === "1" && servedProfiles(this.env).length > 0 && !this.offers("direct")) {
      this.sql.exec("delete from agent_focus where grant_id in (select id from grants where id not in (select grant_id from hub_links))");
      this.sql.exec("delete from grants where id not in (select grant_id from hub_links)");
    }
  }

  // ---- storage helpers ----

  /** Whether Pulse offers this profile (APC_PROFILES). */
  private offers(profile: ApcProfile): boolean {
    return servedProfiles(this.env).includes(profile);
  }
  /** The path each live grant came by: Dock when a dock's hub holds it, Direct otherwise. */
  private linkGrants(): Array<{ id: string; path: ApcProfile }> {
    const dock = new Set(this.sql.exec<{ grant_id: string }>("select grant_id from hub_links").toArray().map((r) => r.grant_id));
    return this.sql.exec<{ id: string; dock: number | null }>("select id, dock from grants").toArray().map((r) => ({ id: r.id, path: dock.has(r.id) || r.dock === 1 ? "dock" : "direct" }));
  }

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0];
    return row?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }
  /** The demo's one world (TIN-621). A sandbox made before it kept a seed of its own; it is ignored. */
  private data(): Dataset {
    return demoDataset();
  }
  private grants(): Grant[] {
    return this.sql
      .exec<Record<string, string | null>>("select * from grants order by created_at")
      .toArray()
      .map((r) => ({
        id: r.id!,
        secret: r.secret!,
        label: r.label!,
        client_name: r.client_name ?? null,
        client_icon: r.client_icon ?? null,
        client_ua: r.client_ua ?? null,
        client_title: r.client_title ?? null,
        agent_name: r.agent_name ?? null,
        owner_name: r.owner_name ?? null,
        conflict: r.conflict ? (JSON.parse(r.conflict) as ClientConflict) : null,
        regions: r.regions ? (JSON.parse(r.regions) as Region[]) : null,
        created_at: r.created_at!,
        last_active_at: r.last_active_at ?? null,
      }));
  }
  private focusRow(grantId: string): FocusRow | null {
    const r = this.sql.exec<Record<string, string | null>>("select * from agent_focus where grant_id = ?", grantId).toArray()[0];
    if (!r) return null;
    return {
      grant_id: r.grant_id!,
      kind: r.kind!,
      id: r.target_id ?? null,
      part: r.part ?? null,
      params: r.params ? JSON.parse(r.params) : null,
      pinned_at: r.pinned_at!,
      seen_at: r.seen_at ?? null,
    };
  }
  private storedView(): StoredView | null {
    if (this.meta("share_view") === "0") return null;
    const r = this.sql.exec<{ data: string }>("select data from view_state where id = 1").toArray()[0];
    return r ? (JSON.parse(r.data) as StoredView) : null;
  }
  /** One Analytics Engine point per initialize (TIN-347). A failure here never fails the call. */
  private async countSession(request: Request, sid: string, grant: Grant, name: unknown, version: unknown, protocol: unknown, userAgent: string): Promise<void> {
    const { MCP_SESSIONS, ANALYTICS_SALT } = this.env;
    if (!MCP_SESSIONS || !ANALYTICS_SALT) return;
    try {
      MCP_SESSIONS.writeDataPoint(
        await sessionPoint(ANALYTICS_SALT, {
          sid,
          grantId: grant.id,
          label: grant.label,
          clientName: typeof name === "string" ? name.slice(0, 100) : null,
          clientVersion: typeof version === "string" ? version.slice(0, 40) : null,
          protocolVersion: typeof protocol === "string" ? protocol.slice(0, 20) : null,
          userAgent,
          ip: request.headers.get("cf-connecting-ip"),
        }),
      );
    } catch {
      // analytics only
    }
  }
  private log(type: string, grantId: string | null, data: Record<string, unknown>): void {
    this.sql.exec("insert into events (at, type, grant_id, data) values (?, ?, ?, ?)", new Date().toISOString(), type, grantId, JSON.stringify(data));
  }
  /**
   * Extend the sandbox's life. Expiry is checked on every access (alive()),
   * so it holds with or without alarms; the alarm only deletes an idle
   * sandbox proactively. It is skipped under `vite dev` because the local
   * runtime on Windows drops the request of a Durable Object that sets one.
   */
  private async touch(): Promise<void> {
    const expiresAt = Date.now() + SANDBOX_TTL_MS;
    this.setMeta("expires_at", String(expiresAt));
    if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) await this.ctx.storage.setAlarm(expiresAt);
  }

  /** An initialized sandbox that has not expired. An expired one is deleted on the spot. */
  private async alive(): Promise<boolean> {
    if (!this.meta("owner")) return false;
    if (Number(this.meta("expires_at") ?? 0) > Date.now()) return true;
    await this.alarm();
    return false;
  }
  /** A page of the person's is open: one of its WebSockets is open and answered a heartbeat lately (page.ts). */
  private pageOpen(): boolean {
    const sockets = this.ctx.getWebSockets().map((ws) => ({
      open: ws.readyState === WebSocket.OPEN,
      lastPongAt: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      acceptedAt: Number((ws.deserializeAttachment() as { accepted_at?: number } | null)?.accepted_at ?? 0),
    }));
    return anyPageOpen(sockets, Date.now());
  }
  /** pageOpen as the agents may learn it: null while the person does not share their view (page.ts). */
  private attendance(): boolean | null {
    return attendance(this.meta("share_view") !== "0", () => this.pageOpen());
  }
  /** A wait of a grant opened or closed (APC 0.11): kept for pages that connect later, and published on the presence channel. */
  private noteWait(event: PresenceWaitEvent): void {
    if (event.state === "open") this.openWaits.set(event.grant_id, event);
    else this.openWaits.delete(event.grant_id);
    this.broadcast({ type: "presence", event });
  }
  /**
   * The waits open now, as the presence messages a page that just connected is sent, so it shows an agent already
   * listening. One older than the ceiling plus the margin is left out: a worker that died mid-wait sent no closed.
   */
  waitsNow(now: number = Date.now()): Array<{ type: "presence"; event: PresenceWaitEvent }> {
    const limit = waitOpenLimitMs(this.waitCeilingS());
    return [...this.openWaits.values()].filter((e) => now - Date.parse(e.at) < limit).map((event) => ({ type: "presence" as const, event }));
  }
  private waitCeilingS(): number {
    return Number(this.env.WAIT_CEILING_S) || WAIT_CEILING_S;
  }
  private broadcast(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // a closed socket is dropped by the runtime
      }
    }
  }

  /** Start over (TIN-411, v2 deploy only): delete everything, as when the sandbox expires. */
  async reset(): Promise<boolean> {
    if (this.env.APC_V2 !== "1") return false;
    await this.alarm();
    return true;
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "sandbox expired");
    await this.ctx.storage.deleteAll();
    this.migrate();
  }

  // ---- owner RPC (the worker checked the owner secret first) ----

  async init(): Promise<{ owner: string }> {
    const existing = this.meta("owner");
    if (existing) return { owner: existing };
    const owner = randomHex(16);
    this.setMeta("owner", owner);
    this.setMeta("created_at", new Date().toISOString());
    this.setMeta("share_view", "1");
    this.setMeta("show_activity", "1");
    // Only the direct-only setup starts with an agent of its own; on the standard's deploy the person
    // makes one on the Agents screen, or drops one from a dock, when they want.
    if (this.env.APC_V2 !== "1" && this.offers("direct")) {
      const g = newDirectGrant();
      this.sql.exec("insert into grants (id, secret, label, regions, created_at) values (?, ?, ?, null, ?)", g.id, g.secret, "Your agent", g.created_at);
    }
    await this.touch();
    return { owner };
  }

  async isOwner(secret: string): Promise<boolean> {
    if (!(await this.alive())) return false;
    if (this.meta("owner") !== secret) return false;
    await this.touch();
    return true;
  }

  async dataset(): Promise<Dataset> {
    return this.data();
  }

  async state() {
    // A dock grant past its time has ended (APC 0.10): the page never lists it.
    this.sweepDock();
    const dock = new Map(this.dockRows().map((l) => [l.grant_id, l]));
    return {
      // The demo world's seed, always DEMO_SEED (TIN-621). Nothing new reads it: Pulse for Windows builds from before
      // read the state into a record with `seed` as a constructor parameter, so it stays in the answer for them.
      seed: DEMO_SEED,
      settings: { share_view: this.meta("share_view") !== "0", show_activity: this.meta("show_activity") !== "0" },
      // A dock grant's secret is its hub's alone (I4, APC 0.10): the page gets it only for a Direct agent, whose MCP URL it shows.
      grants: this.grants().map((g) => ({ ...g, secret: dock.has(g.id) ? "" : g.secret, pin: this.focusRow(g.id) })),
      tour: this.tour(),
      // APC v2 (TIN-382): on Pulse's v2 deploy, which dock agents are which grants.
      v2: this.env.APC_V2 === "1",
      // The profiles Pulse offers (APC 0.4), and which Direct and Dock grants are one agent: [direct, dock].
      profiles: servedProfiles(this.env),
      links: this.links.links(),
      // The docks Pulse pairs with, by host, for the page to name (TIN-402).
      hubs: this.env.APC_V2 === "1" ? hubAllowlist(this.env).hubs.map((h) => new URL(h).host) : [],
      // A dock grant still waiting for the code in the dock (APC 0.9) carries it, for this page only: never over MCP or to
      // the hub. `state` is where the grant stands (APC 0.10): in_flight (the Allow is being answered), handoff (the dock
      // has it and has not connected: with `pairing` the code is still to be typed, without it the dock said it is
      // connecting), live.
      hub_links: [...dock.values()].map((l) => ({
        hub: l.hub,
        agent: l.agent,
        grant_id: l.grant_id,
        state: (l.state ?? "live") as DockStored,
        pairing: l.state === "handoff" && l.pairing_code && l.pairing_expires_at ? { code: l.pairing_code, expires_at: l.pairing_expires_at } : null,
      })),
      expires_at: new Date(Number(this.meta("expires_at") ?? Date.now())).toISOString(),
    };
  }

  /** The guided first run (tour.ts): it follows the first agent that connected. */
  private tour(): { step: TourStep; grant_id: string | null } {
    const grantId = this.meta("tour_grant") ?? this.grants().find((g) => g.client_name)?.id ?? null;
    const reads = grantId
      ? new Set(
          this.sql
            .exec<{ data: string }>("select data from events where type = 'seen' and grant_id = ?", grantId)
            .toArray()
            .map((e) => (JSON.parse(e.data) as { pinned_at?: string }).pinned_at),
        ).size
      : 0;
    const step = tourStep({
      skipped: this.meta("tour_skip") === "1",
      done: this.meta("tour_done") === "1",
      acked: this.meta("tour_ack") === "1",
      grantId,
      hasPin: !!grantId && !!this.focusRow(grantId),
      reads,
    });
    return { step, grant_id: grantId };
  }

  async tourAction(action: unknown): Promise<{ ok: boolean }> {
    const key = action === "ack" ? "tour_ack" : action === "skip" ? "tour_skip" : action === "done" ? "tour_done" : null;
    if (!key) return { ok: false };
    this.setMeta(key, "1");
    this.broadcast({ type: "grants" });
    return { ok: true };
  }

  async reportView(raw: unknown): Promise<{ ok: boolean }> {
    if (this.meta("share_view") === "0") return { ok: false };
    const view = sanitizeView(raw, this.data());
    if (!view) return { ok: false };
    this.sql.exec("insert into view_state (id, data) values (1, ?) on conflict(id) do update set data = excluded.data", JSON.stringify(view));
    return { ok: true };
  }

  async setSetting(name: "share_view" | "show_activity", on: boolean): Promise<void> {
    this.setMeta(name, on ? "1" : "0");
    if (name === "share_view" && !on) this.sql.exec("delete from view_state");
  }

  async pin(grantId: string, raw: unknown): Promise<{ ok: boolean; error?: string; pin?: FocusRow }> {
    const grant = this.grants().find((g) => g.id === grantId);
    if (!grant) return { ok: false, error: "unknown_grant" };
    const checked = checkPin(raw, grant, this.data());
    if ("error" in checked) return { ok: false, error: checked.error };
    const t: FocusTarget = checked.target;
    const pinnedAt = new Date().toISOString();
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.sql.exec(
      "insert into agent_focus (grant_id, kind, target_id, part, params, pinned_at, seen_at) values (?, ?, ?, ?, ?, ?, null)",
      grantId, t.kind, t.id, t.part, t.params ? JSON.stringify(t.params) : null, pinnedAt,
    );
    this.log("pin", grantId, { kind: t.kind, id: t.id, part: t.part, params: t.params, pinned_at: pinnedAt });
    const pin = this.focusRow(grantId)!;
    this.broadcast({ type: "pin", grant_id: grantId, pin });
    return { ok: true, pin };
  }

  async unpin(grantId: string): Promise<void> {
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.broadcast({ type: "pin", grant_id: grantId, pin: null });
  }

  /** The person's own name for an agent (TIN-356); empty clears it, back to the agent's or the default. */
  async renameGrant(grantId: string, raw: unknown): Promise<{ ok: boolean }> {
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false };
    this.sql.exec("update grants set owner_name = ? where id = ?", cleanName(raw), grantId);
    this.broadcast({ type: "grants" });
    return { ok: true };
  }

  /**
   * The person's answer to a shared URL (TIN-358). split: a new agent and URL for the newcomer, the
   * old URL stays with the first product. adopt: the newcomer is this agent now; the name it gave
   * itself and its client's title and icon go, the person's name for it stays.
   */
  async resolveConflict(grantId: string, action: unknown): Promise<{ ok: boolean; grant?: Grant }> {
    const g = this.grants().find((x) => x.id === grantId);
    if (!g?.conflict || (action !== "split" && action !== "adopt")) return { ok: false };
    if (action === "adopt") {
      this.sql.exec("update grants set client_name = ?, client_ua = ?, client_icon = null, client_title = null, agent_name = null, conflict = null where id = ?", g.conflict.client_name, g.conflict.user_agent, grantId);
      this.log("conflict_adopted", grantId, { client_name: g.conflict.client_name });
      this.broadcast({ type: "grants" });
      return { ok: true };
    }
    // A new URL is a direct agent: only where Pulse offers the Direct profile.
    if (!this.offers("direct") || this.directFull()) return { ok: false };
    this.sql.exec("update grants set conflict = null where id = ?", grantId);
    const fresh = await this.addAgentGrant();
    this.log("conflict_split", grantId, { client_name: g.conflict.client_name, new_grant: fresh.id });
    return { ok: true, grant: fresh };
  }

  /** Whether the person already has MAX_DIRECT_GRANTS Direct grants (Signals' cap, TIN-607): the page offers no more. */
  private directFull(): boolean {
    return this.linkGrants().filter((x) => x.path === "direct").length >= MAX_DIRECT_GRANTS;
  }

  /** The Add buttons' way in: a new Direct agent, or `too_many` at the cap. */
  async tryAddAgent(): Promise<{ ok: boolean; error?: "too_many"; grant?: Grant }> {
    return this.directFull() ? { ok: false, error: "too_many" } : { ok: true, grant: await this.addAgentGrant() };
  }

  /** The restricted button's way in: the region's agent (made once), or `too_many` at the cap when it would be a new one. */
  async tryAddRestricted(region: Region): Promise<{ ok: boolean; error?: "too_many"; grant?: Grant }> {
    const exists = this.grants().some((g) => g.regions?.length === 1 && g.regions[0] === region);
    return !exists && this.directFull() ? { ok: false, error: "too_many" } : { ok: true, grant: await this.addRestrictedGrant(region) };
  }

  /** Another agent with full access: one URL and one mark per client, so each client's behaviour is measured apart. */
  async addAgentGrant(): Promise<Grant> {
    const g = newDirectGrant();
    const direct = this.linkGrants().filter((x) => x.path === "direct").map((x) => x.id);
    const n = this.grants().filter((x) => !x.regions && direct.includes(x.id)).length + 1;
    this.sql.exec("insert into grants (id, secret, label, regions, created_at) values (?, ?, ?, null, ?)", g.id, g.secret, `Agent ${n}`, g.created_at);
    this.broadcast({ type: "grants" });
    return this.grants().find((x) => x.id === g.id)!;
  }

  async addRestrictedGrant(region: Region): Promise<Grant> {
    const existing = this.grants().find((g) => g.regions?.length === 1 && g.regions[0] === region);
    if (existing) return existing;
    const g = newDirectGrant();
    this.sql.exec(
      "insert into grants (id, secret, label, regions, created_at) values (?, ?, ?, ?, ?)",
      g.id, g.secret, `Restricted agent (${region.toUpperCase()} only)`, JSON.stringify([region]), g.created_at,
    );
    this.broadcast({ type: "grants" });
    return this.grants().find((x) => x.id === g.id)!;
  }

  /**
   * APC v2 (TIN-382, DESIGN.md 12.1): the person dropped an agent from a dock here. Pulse makes a grant
   * for it (full, or one region), hands that grant's MCP URL to the dock's hub server to server with the
   * drag's single-use ticket, and pins the agent where it was dropped. The hub reads Pulse only after the
   * person says yes in the dock too. Only on the v2 deploy.
   *
   * The person's yes here is checked here, not on the page (APC 0.7, TIN-606): a page decides from the state
   * it last loaded, and one that missed a revoke would pair without asking. So an agent Pulse holds no grant
   * for gets `consent_required` and a nonce; the page shows its consent with it, and only a request that
   * brings it back (once, for the same dock and agent, within two minutes) makes a grant.
   */
  async pairHub(sid: string, origin: string, raw: unknown): Promise<PairHubAnswer> {
    if (this.env.APC_V2 !== "1" || !this.offers("dock")) return { ok: false, error: "not_available" };
    // The hub allowlist (M1, APC 0.10), on the drop and again on the Allow: both are this request. The hub is parsed,
    // must be a bare https origin on HUB_ORIGINS, and the hub calls below go to that parsed origin (M9).
    const drop = parseDockDrop(raw, hubAllowlist(this.env));
    if (!drop.ok) return { ok: false, error: drop.error === "hub_not_allowed" ? "hub_not_allowed" : "invalid" };
    const b = raw as { region?: unknown; target?: unknown; consent?: unknown };
    const { hub, agent, ticket } = drop;
    // One drop of an agent at a time (Grok on #123; M5): a second request while the first waits on the hub (a double-clicked
    // Allow) changes nothing, so it can neither ask for consent again nor drop the grant the first is making. The
    // grant's stored in_flight state says the same after a restart (pairHubOnce).
    const key = `${hub} ${agent}`;
    if (this.pairing.has(key)) return { ok: false, error: "pairing_in_progress" };
    this.pairing.add(key);
    try {
      return await this.pairHubOnce(sid, origin, hub, agent, ticket, b.region, b.target, b.consent);
    } finally {
      this.pairing.delete(key);
    }
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

  private dockRows(): DockLink[] {
    return this.sql.exec<DockLink>("select hub, agent, grant_id, state, secret_hash, allowed_at, acked_at, pairing_code, pairing_expires_at from hub_links").toArray();
  }
  private dockRow(grantId: string): DockLink | null {
    return this.dockRows().find((l) => l.grant_id === grantId) ?? null;
  }
  /**
   * Ends every dock grant past its time (MUST, APC 0.10): still in flight T_ack after the Allow, or still in handoff
   * T_connect after the hub's acknowledgement. Synchronous, and run before anything reads a dock grant, so an overdue
   * grant is never served, listed or moved on.
   */
  private sweepDock(): void {
    const now = this.dockNow();
    for (const l of this.dockRows()) if (dockStateNow(l, now) === "ended") this.endDockGrant(l.grant_id, l.state === "in_flight" ? "no_acknowledgement" : "not_connected");
    // A grant made for a dock whose link is missing (a write that failed half-way) is not a grant: it ends.
    for (const g of this.sql.exec<{ id: string }>("select id from grants where dock = 1 and id not in (select grant_id from hub_links)").toArray()) this.endDockGrant(g.id, "no_link");
  }
  /** A dock's grant ends: it goes with its pins and its link, and its MCP URL answers 404. Synchronous. */
  private endDockGrant(grantId: string, why: string): void {
    this.links.forget(grantId);
    this.waitSlots.forget(grantId);
    this.sql.exec("delete from agent_focus where grant_id = ?", grantId);
    this.sql.exec("delete from hub_links where grant_id = ?", grantId);
    this.sql.exec("delete from grants where id = ?", grantId);
    this.log("hub_revoked", grantId, { why });
    this.broadcast({ type: "grants" });
  }
  /**
   * A give-back (M7, APC 0.10): ends the dock grant whose secret hashes to `hash`, in flight, in handoff or live.
   * A revoked grant has no link left, so it stays revoked; an ended one is gone. One synchronous step. It never
   * opens or extends a sandbox: it reads one table.
   */
  async endDockGrantBySecretHash(hash: string): Promise<boolean> {
    const row = this.sql.exec<{ grant_id: string }>("select grant_id from hub_links where secret_hash = ?", hash).toArray()[0];
    if (!row) return false;
    this.endDockGrant(row.grant_id, "given_back");
    return true;
  }
  /**
   * Cancel on the waiting card (APC 0.10): a revoke, allowed only in handoff, before the dock connected and so before
   * any call was served. The state check and the revoke are one synchronous step (the grant's secret hash is on its
   * link, so nothing is awaited between them): an `initialize` that committed first wins, and Cancel is refused; a
   * Cancel that ran first wins, and that `initialize` gets the revoked answer.
   */
  async cancelDockGrant(grantId: string): Promise<{ ok: boolean; error?: string }> {
    this.sweepDock();
    const link = this.dockRow(grantId);
    if (!link) return { ok: false, error: "unknown_grant" };
    if (link.state !== "handoff" || !link.secret_hash) return { ok: false, error: "not_cancellable" };
    this.revokeNow(grantId, link.secret_hash, new Date().toISOString(), { cancelled: true });
    this.broadcast({ type: "grants" });
    return { ok: true };
  }
  /** One grant's revoke, synchronous: the revoked record by its secret's hash, then the grant, its pin and its dock link go. */
  private revokeNow(id: string, hash: string, at: string, note: Record<string, unknown>): void {
    const link = this.sql.exec<{ hub: string; agent: string }>("select hub, agent from hub_links where grant_id = ?", id).toArray()[0];
    this.sql.exec("insert or replace into revoked_grants (secret_hash, grant_id, hub, agent, revoked_at) values (?, ?, ?, ?, ?)", hash, id, link?.hub ?? null, link?.agent ?? null, at);
    this.links.forget(id);
    this.waitSlots.forget(id);
    this.sql.exec("delete from agent_focus where grant_id = ?", id);
    this.sql.exec("delete from hub_links where grant_id = ?", id);
    this.sql.exec("delete from grants where id = ?", id);
    this.log("revoked", id, { via: link ? "dock" : "direct", ...note });
  }

  private async pairHubOnce(sid: string, origin: string, hub: string, agent: string, ticket: string, rawRegion: unknown, target: unknown, consent: unknown): Promise<PairHubAnswer> {
    /** The person has not said yes here for this agent: the page asks, with this nonce and the pairing code (APC 0.9). */
    const askFirst = (): PairHubAnswer => {
      const asked = this.consent.ask(hub, agent);
      // This consent replaces any older one for the same dock and agent: only its nonce pairs from now on.
      this.sql.exec("insert into dock_consents (hub, agent, nonce) values (?, ?, ?) on conflict(hub, agent) do update set nonce = excluded.nonce", hub, agent, asked.nonce);
      return { ok: false, error: CONSENT_REQUIRED, consent: asked.nonce, pairing_code: asked.pairing_code };
    };
    this.sweepDock();
    const linkOf = () => this.sql.exec<{ grant_id: string }>("select grant_id from hub_links where hub = ? and agent = ?", hub, agent).toArray()[0];
    const linked = linkOf();
    if (linked) {
      const before = this.dockRow(linked.grant_id);
      // An Allow for this agent is still waiting on the hub (APC 0.10): one pairing at a time, also after a restart
      // lost the in-memory lock. Past T_ack the sweep above ended it, and the drop asks again.
      if (before?.state === "in_flight") return { ok: false, error: "pairing_in_progress" };
      // Already handed to the dock: the hub must still say so (TIN-389). If it does not, the grant goes and the person is asked again.
      const grant = this.grants().find((g) => g.id === linked.grant_id);
      const answer = grant ? await confirmWithHub(hub, { ticket, agent, mcp_url: `${origin}/mcp/${sid}/${grant.secret}` }, hubCallOptions(this.env)) : ({ ok: false, error: "not_paired" } as const);
      // Everything below is synchronous: the grant is read again, since a Cancel, a Revoke, a give-back or its time
      // running out may have taken it while the hub answered.
      this.sweepDock();
      const now = linkOf()?.grant_id === linked.grant_id ? this.dockRow(linked.grant_id) : null;
      if (!answer.ok) {
        if (answer.error !== "not_paired") return { ok: false, error: answer.error };
        // The dock no longer pairs them: the grant ends, and the ticket is still good, so the person can say yes here and pair at once.
        if (now) this.endDockGrant(linked.grant_id, "not_paired");
        return askFirst();
      }
      // Gone while the hub answered. The ticket is spent: the person drags the agent again.
      if (!now) return { ok: false, error: "pairing_ended" };
      this.sql.exec("update grants set client_icon = coalesce(?, client_icon) where id = ?", pickClientIcon([{ src: answer.agent.icon }]), linked.grant_id);
      if (now.state === "handoff") {
        if (answer.status === "paired") {
          // The dock took the code and is connecting (APC 0.10): the grant stays in handoff, since only the hub's
          // initialize makes it live. The page hides the code and says so; the pin waits for the grant to be live.
          this.sql.exec("update hub_links set pairing_code = null, pairing_expires_at = null where grant_id = ? and state = 'handoff'", linked.grant_id);
          this.broadcast({ type: "grants" });
          const pinned = await this.pin(linked.grant_id, target);
          return { ok: true, grant_id: linked.grant_id, status: "connecting", ...(pinned.ok ? {} : { pin_error: pinned.error ?? "pin_failed" }) };
        }
        // Still pending at the dock. With the stored expiry ahead, the page shows the same code and the time left: no
        // new consent, no new code, and the drop's target replaces the pin. Past it, the grant ends and the person is asked again.
        const pairing = this.pairingOf(linked.grant_id);
        if (!pairing || Date.parse(pairing.expires_at) <= this.dockNow()) {
          this.endDockGrant(linked.grant_id, "code_expired");
          return askFirst();
        }
        const pinned = await this.pin(linked.grant_id, target);
        return { ok: true, grant_id: linked.grant_id, status: "pending", pairing, ...(pinned.ok ? {} : { pin_error: pinned.error ?? "pin_failed" }) };
      }
      const pinned = await this.pin(linked.grant_id, target);
      return { ...pinned, grant_id: linked.grant_id, status: answer.status };
    }
    // No grant for this agent: one is made only with the person's yes on this page, proven by the nonce it was shown with.
    const region = (REGIONS as readonly string[]).includes(rawRegion as string) ? (rawRegion as Region) : null;
    const { id, secret, created_at } = newDirectGrant();
    // Before anything is written: the secret's hash, which the link keeps for a give-back and for Cancel.
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
    // In flight (APC 0.10): the grant and its link exist before the hub hears of them, and answer 404 to everything
    // until the hub's acknowledgement. One synchronous step with the consent taken above.
    // Two statements, safe if the second fails: the grant carries `dock = 1` from its own insert, so without its link
    // it is never served as a Direct grant (sweepDock ends it before any lookup), and here it is taken back at once.
    this.sql.exec(
      "insert into grants (id, secret, label, regions, created_at, dock) values (?, ?, ?, ?, ?, 1)",
      id, secret, `Via dock${region ? ` (${region.toUpperCase()} only)` : ""}`, region ? JSON.stringify([region]) : null, created_at,
    );
    try {
      this.sql.exec(
        "insert into hub_links (hub, agent, grant_id, pairing_id, created_at, pairing_code, pairing_expires_at, state, secret_hash, allowed_at, acked_at) values (?, ?, ?, null, ?, ?, null, 'in_flight', ?, ?, null)",
        hub, agent, id, new Date().toISOString(), taken.pairing_code, hash, this.dockNow(),
      );
    } catch (error) {
      try {
        this.sql.exec("delete from grants where id = ?", id);
      } catch {
        // the storage is failing: the orphan ends when it is next looked at
      }
      throw error;
    }
    // No lock is held across the call (M5): the row above is the only thing that says a pairing is under way.
    // The hub must say it keeps the code (APC 0.9): on any other answer the grant ends before the page hears back.
    const answer = await pairWithHub(hub, { ticket, agent, app: { name: "Pulse", origin }, mcp_url: `${origin}/mcp/${sid}/${secret}`, pairing_code: taken.pairing_code }, hubCallOptions(this.env));
    // Synchronous from here to the answer.
    // By the secret's hash, never the id alone: a grant that went meanwhile, and whose id a later one took, is not this one.
    const mine = () => this.sql.exec("select 1 from hub_links where grant_id = ? and secret_hash = ?", id, hash).toArray().length > 0;
    if (!answer.ok) {
      if (mine()) this.endDockGrant(id, answer.error);
      return { ok: false, error: answer.error };
    }
    // The acknowledgement moves the grant to handoff only if it is still in flight and within T_ack, in one statement
    // (APC 0.10): a give-back or a Revoke that landed during the call, or T_ack, wins, and the grant stays as they left it.
    const at = this.dockNow();
    const pairing: DockPairing = { code: taken.pairing_code, expires_at: new Date(at + PAIRING_CODE_TTL_MS).toISOString() };
    const moved = this.sql
      .exec("update hub_links set state = 'handoff', acked_at = ?, pairing_id = ?, pairing_expires_at = ? where grant_id = ? and secret_hash = ? and state = 'in_flight' and allowed_at > ? returning grant_id", at, answer.pairing_id, pairing.expires_at, id, hash, at - DOCK_TIMES.ackMs)
      .toArray().length === 1;
    if (!moved) {
      if (mine()) this.endDockGrant(id, "no_acknowledgement");
      return { ok: false, error: "pairing_ended" };
    }
    // The agent's mark from the hub (TIN-388), so its first pin shows its logo; initialize keeps it current.
    this.sql.exec("update grants set client_title = ?, client_icon = ? where id = ?", cleanName(answer.agent.name), pickClientIcon([{ src: answer.agent.icon }]), id);
    this.log("hub_paired", id, { hub, agent });
    this.broadcast({ type: "grants" });
    // Handed to the hub and waiting for the code in the dock, whatever the pin does: a pin that failed is said apart.
    const pinned = await this.pin(id, target);
    return { ok: true, grant_id: id, status: "pending", pairing, ...(pinned.ok ? {} : { pin_error: pinned.error ?? "pin_failed" }) };
  }

  /** The code a dock grant waits on, while it waits (APC 0.9). */
  private pairingOf(grantId: string): DockPairing | null {
    const l = this.sql.exec<{ pairing_code: string | null; pairing_expires_at: string | null }>("select pairing_code, pairing_expires_at from hub_links where grant_id = ?", grantId).toArray()[0];
    return l?.pairing_code && l.pairing_expires_at ? { code: l.pairing_code, expires_at: l.pairing_expires_at } : null;
  }

  /**
   * A dock's hub gives back the grant Pulse made for it (TIN-388), on unpair or deny in the dock: by the secret,
   * for callers that hold it (tests; the Worker's /apc/revoke goes by its hash, `endDockGrantBySecretHash`).
   * Only grants made for a dock can be given back this way.
   */
  async revokeHubGrant(secret: string): Promise<{ ok: boolean }> {
    return { ok: await this.endDockGrantBySecretHash(await secretHash(secret)) };
  }

  /**
   * Revoke from the app (APC 0.2, TIN-577): the person cuts an agent from Pulse itself, whichever way it
   * came (its own URL, or a dock's hub). It holds at once and calls nobody, so it holds with the hub
   * down: the grant, its pin and its dock link go, and its MCP URL answers 403 "revoked" from then on
   * (mcp()), with a call already running ending the same way (instrument()). It never comes back by
   * itself: a dock agent dropped here again asks the person, as a new one does. A dock grant in flight or
   * in handoff is revoked the same way (APC 0.10: revoked comes before every other state).
   */
  async revokeGrant(grantId: string): Promise<{ ok: boolean; error?: string }> {
    // A linked agent (apc_link, APC 0.4) is one agent with two grants: Revoke cuts both.
    const partner = this.links.partnerOf(grantId);
    const targets = this.grants().filter((g) => g.id === grantId || g.id === partner);
    if (!targets.some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const hashes = await Promise.all(targets.map(async (g) => [g, await secretHash(g.secret)] as const));
    // Everything below is synchronous storage work: nothing runs between the check and the deletes.
    if (!this.grants().some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const at = new Date().toISOString();
    // By the secret, never the id alone: a grant that went and whose id a later one took is not this one.
    for (const [g, hash] of hashes) if (this.holds(g.secret)) this.revokeNow(g.id, hash, at, g.id === grantId ? {} : { with: grantId });
    this.broadcast({ type: "grants" });
    return { ok: true };
  }

  /** The person unlinks an agent in the bar (apc_link, APC 0.4): the link goes, both grants stay. */
  async unlinkGrant(grantId: string): Promise<{ ok: boolean }> {
    const partner = this.links.unlink(grantId);
    if (!partner) return { ok: false };
    this.log("unlinked", grantId, { with: partner });
    this.broadcast({ type: "grants" });
    return { ok: true };
  }

  /**
   * When the person revoked the grant with this secret in the app, or null. Always by the secret's hash, for a
   * new request and for a call in flight alike (TIN-606): a grant id is short, and a later grant may reuse a
   * revoked one's, so an id never says whether this grant was revoked.
   */
  private revokedAt(hash: string): string | null {
    return this.sql.exec<{ revoked_at: string }>("select revoked_at from revoked_grants where secret_hash = ?", hash).toArray()[0]?.revoked_at ?? null;
  }
  /** The grant with this secret is still live: this grant, never a later one that took its id. */
  private holds(secret: string): boolean {
    return this.sql.exec("select 1 from grants where secret = ?", secret).toArray().length > 0;
  }

  // (a dock grant's end is endDockGrant, above)

  private allEvents(): LoggedEvent[] {
    return this.sql
      .exec<{ id: number; at: string; type: string; grant_id: string | null; data: string }>("select * from events order by id")
      .toArray()
      .map((e) => ({ id: e.id, at: e.at, type: e.type, grant_id: e.grant_id, ...(JSON.parse(e.data) as Record<string, unknown>) }));
  }

  /** The event log as JSON lines, oldest first. */
  async eventsJsonl(): Promise<string> {
    return this.allEvents()
      .map((e) => JSON.stringify(e) + "\n")
      .join("");
  }

  /** What each agent did with APC: one row of the client compatibility matrix per grant. */
  async compat(): Promise<CompatRow[]> {
    return compatSummary(this.grants(), this.allEvents());
  }

  // ---- fetch: the MCP endpoint and the owner's WebSocket ----

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
    const match = url.pathname.match(/^\/mcp\/([^/]+)\/([0-9a-f]{32})$/);
    if (match) return this.mcp(request, match[1]!, match[2]!, url.origin);
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(): Promise<void> {
    // The page only listens.
  }

  private async mcp(request: Request, sid: string, secret: string, origin: string): Promise<Response> {
    if (!(await this.alive())) return Response.json({ error: "sandbox_expired" }, { status: 404 });
    // The secret's hash, before the grant is looked up: what says whether this grant was revoked, now and during its calls.
    const hash = await secretHash(secret);
    // The body, before the grant is looked up: from that lookup to the gate's answer (and the commit of an
    // initialize) nothing is awaited, so no Cancel, Revoke or give-back can run in between (APC 0.10).
    // Read once and bounded (MCP_BODY_MAX_BYTES), whoever asks: a caller with no grant cannot make Pulse read more.
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
    // A dock grant past T_ack or T_connect has ended (APC 0.10), and one whose link is missing is none: gone before the lookup.
    this.sweepDock();
    const grant = this.grants().find((g) => g.secret === secret);
    // Revoked: 403 with the answer, whatever the method (checked before the method), so the holder can say so.
    if (!grant) return gone();
    // Agent traffic on a grant that is not live yet extends nothing (APC 0.10): the sandbox's life is not touched by it.
    let extendsLife = true;
    // A dock grant answers by its state (APC 0.10, dockGrantGate): 404 in flight; in handoff only initialize, ping and
    // tools/list are served, and a tools/call gets the `pairing` error; live, everything. A gated answer is built here,
    // before the log, the links, presence and the transport, so it carries no attention, then, apc_link or app data.
    const link = this.dockRow(grant.id);
    if (link) {
      const gate = dockGrantGate((link.state ?? "live") as DockStored, request.method === "POST" ? rpcBody : null, { host });
      if (!gate.serve) return gate.response;
      if (gate.commits) {
        // The hub's first initialize (the dock owner's yes) makes the grant live: one conditional statement, and no
        // result unless it committed. A storage failure answers HTTP 500, so the hub's introduction fails visibly.
        let committed: boolean;
        try {
          committed = this.sql.exec("update hub_links set state = 'live', pairing_code = null, pairing_expires_at = null where grant_id = ? and state = 'handoff' returning grant_id", grant.id).toArray().length === 1;
        } catch {
          return Response.json({ error: "internal_error" }, { status: 500, headers: { "cache-control": "no-store" } });
        }
        // Not committed: the state that won answers (a Cancel or Revoke: the revoked answer; an end: 404). Nothing runs
        // between the lookup above and this statement, so this is the fail-closed branch, not a path that is taken.
        if (!committed) return gone();
        this.log("hub_connected", grant.id, {});
        this.broadcast({ type: "grants" });
      } else if ((link.state ?? "live") !== "live") {
        // Served in handoff (ping, tools/list): answered, and nothing else.
        extendsLife = false;
      }
    }
    // Stateless: no server-to-client stream (GET) and no session to end (DELETE). 405 is what the spec allows.
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (extendsLife) await this.touch();
    // A notifications/cancelled in this POST aborts the call it names, running in another POST (APC 0.8).
    this.calls.cancel(grant.id, rpcBody);

    if (request.method === "POST") {
      try {
        const body = rpcBody;
        const messages = Array.isArray(body) ? body : [body];
        const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 120);
        for (const m of messages as Array<{ method?: string; params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown; icons?: unknown; title?: unknown } } } | null>) {
          if (m?.method === "initialize") {
            const name = m.params?.clientInfo?.name;
            const version = m.params?.clientInfo?.version;
            const protocol = m.params?.protocolVersion;
            const icons = m.params?.clientInfo?.icons;
            const icon = pickClientIcon(icons);
            this.log("initialize", grant.id, {
              client_name: typeof name === "string" ? name.slice(0, 100) : null,
              client_version: typeof version === "string" ? version.slice(0, 40) : null,
              protocol_version: typeof protocol === "string" ? protocol.slice(0, 20) : null,
              user_agent: userAgent,
              icons: Array.isArray(icons) ? icons.length : 0,
              icon_kept: icon !== null,
            });
            await this.countSession(request, sid, grant, name, version, protocol, userAgent);
            if (typeof name === "string" && name.length <= 100) {
              if (!this.meta("tour_grant")) this.setMeta("tour_grant", grant.id);
              // A grant from before TIN-364 may hold a generic name with no user agent (Gemini's "mcp") and a
              // warning about its own product ("Gemini"): that product, now known, takes the grant back.
              const sameAsWarned = !!grant.conflict && sameProduct(grant.conflict.client_name, grant.conflict.user_agent, name, userAgent) && productOf(name, userAgent) !== null && productOf(grant.client_name ?? "", grant.client_ua) === null;
              if (!grant.client_name || sameAsWarned || sameProduct(grant.client_name, grant.client_ua, name, userAgent)) {
                this.sql.exec("update grants set client_name = ?, client_icon = ?, client_title = ?, client_ua = ? where id = ?", name, icon, cleanName(m.params?.clientInfo?.title), userAgent, grant.id);
                // A warning raised by this same product (before its user agent was known) no longer applies.
                if (grant.conflict && sameProduct(grant.conflict.client_name, grant.conflict.user_agent, name, userAgent)) {
                  this.sql.exec("update grants set conflict = null where id = ?", grant.id);
                }
              } else {
                // One URL, one agent (TIN-358): a second product does not take the grant over. The page warns the person.
                const conflict: ClientConflict = { client_name: name, client_version: typeof version === "string" ? version.slice(0, 40) : null, user_agent: userAgent, at: new Date().toISOString() };
                this.sql.exec("update grants set conflict = ? where id = ?", JSON.stringify(conflict), grant.id);
                this.log("client_conflict", grant.id, { owner_client: grant.client_name, ...conflict });
              }
              this.broadcast({ type: "grants" });
            }
          } else if (m?.method === "tools/list") {
            this.log("tools_list", grant.id, { user_agent: userAgent });
          } else if (m?.method === "prompts/get") {
            const name = (m.params as { name?: unknown } | undefined)?.name;
            this.log("prompt_get", grant.id, { name: typeof name === "string" ? name.slice(0, 100) : null, user_agent: userAgent });
          }
        }
        // apc_link (APC 0.4): a new MCP session of this grant, by its client (on the Dock path, the one its hub names).
        const arriving = initializeOf(body);
        if (arriving) this.links.arrived(grant.id, linkClient(arriving, this.linkGrants().find((g) => g.id === grant.id)?.path ?? "direct"));
      } catch {
        // not JSON: the transport answers the error
      }
    }

    // The MCP SDK loads only when an agent calls: owner requests and new sandboxes stay light.
    const [{ McpServer }, { WebStandardStreamableHTTPServerTransport }, { CfWorkerJsonSchemaValidator }, { registerApcLinkTool, registerApcPrompts, registerApcTools }, { registerPulseTools }, { PULSE_GUIDE }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
      import("@modelcontextprotocol/sdk/validation/cfworker"),
      import("@tineira/apc-server"),
      import("./pulse-tools.ts"),
      import("./guide.ts"),
    ]);
    const data = this.data();
    const server = new McpServer(
      { name: "pulse-apc-demo", version: SERVER_VERSION },
      {
        instructions: `${APC_INSTRUCTIONS} If you have a name of your own (one your person gave you), call set_agent_name once when you start, so the page shows it on your mark. Pulse is product analytics for a SaaS: customers (external ids cus_NNNN, the same ids the person's billing uses), plans, regions, seats and monthly activity. It holds no revenue data.`,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    );
    // Which tool this request runs, so a "seen" stamp records how the pin was read.
    const call = { tool: "" };
    this.instrument(server, grant, hash, data, origin, call);
    // The calls this POST carries, so a later notifications/cancelled can end them; the client hanging up ends them too.
    const inflight = this.calls.track(grant.id, rpcBody);
    registerApcTools(server, {
      readView: async () => trimView(this.storedView(), grant, data, origin),
      readFocus: async () => resolveFocus(this.focusRow(grant.id), grant, data, origin),
      focusUnread: async () => isUnread(this.focusRow(grant.id)),
      // Seen once delivered (APC 0.8): the exact pin the result carried, never a newer one dropped since.
      markSeen: async (pinnedAt) => {
        const row = this.focusRow(grant.id);
        if (!row || row.pinned_at !== pinnedAt || !isUnread(row)) return;
        const seenAt = new Date().toISOString();
        this.sql.exec("update agent_focus set seen_at = ? where grant_id = ? and pinned_at = ?", seenAt, grant.id, pinnedAt);
        this.log("seen", grant.id, { pinned_at: row.pinned_at, seen_at: seenAt, via: call.tool });
        this.broadcast({ type: "pin", grant_id: grant.id, pin: this.focusRow(grant.id) });
      },
      // A grant revoked during a wait ends it at the next poll, as a closed page does; instrument() then answers "revoked".
      pageOpen: async () => (this.holds(grant.secret) ? this.attendance() : false),
      waitSlot: this.waitSlots.for(grant.id),
      // The wait events (APC 0.11): the page shows the agent listening while a wait holds its place, and only then.
      waitPresence: { grantId: grant.id, publish: (event) => this.noteWait(event) },
      signal: AbortSignal.any([request.signal, inflight.signal]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      waitCeilingS: this.waitCeilingS(),
    });
    registerPulseTools(server, data, grant, origin, this.env.APC_V2 === "1" ? demoMarket().signupCodes : undefined);
    // The agent introduces itself (TIN-356). The person's own name for it stays on top.
    const { z } = await import("zod");
    server.registerTool(
      "set_agent_name",
      {
        title: "Tell Pulse your name",
        description: "If you have a name of your own, call this once when you start: the page shows it on your mark instead of your client's name. Plain text, at most 40 characters. A name the person set for you stays on top.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const clean = cleanName(name);
        if (!clean) return toolError("invalid_name", "Give a name of 1 to 40 visible characters.");
        this.sql.exec("update grants set agent_name = ? where id = ?", clean, grant.id);
        this.log("agent_named", grant.id, { name: clean });
        this.broadcast({ type: "grants" });
        const owner = this.grants().find((g) => g.id === grant.id)?.owner_name;
        return toolResult(owner ? { name: clean, shown: owner, note: "The person named you; their name stays on the page." } : { name: clean, shown: clean });
      },
    );
    // apc_link (APC 0.4): where Pulse offers both profiles, the same agent on both paths can show as one.
    if (this.offers("direct") && this.offers("dock")) {
      registerApcLinkTool(server, {
        appName: "Pulse",
        redeem: async (code) => {
          const r = await this.links.redeem(grant.id, code);
          if (r.ok) {
            this.log("linked", grant.id, { with: r.partner });
            this.broadcast({ type: "grants" });
          }
          return r;
        },
      });
    }
    // The manual, for the person to load on purpose (a slash command or a menu item in their client).
    registerApcPrompts(server, PULSE_GUIDE);

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    // Answers are always JSON, never a stream: a client that accepts only application/json is fine too.
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    try {
      return await transport.handleRequest(new Request(request, { headers }));
    } finally {
      inflight.done();
    }
  }

  /**
   * Wrap every tool the server registers: log what came in (for the canary
   * check), attach the attention envelope while the pin is unread and the
   * loop hint while a page is open and the view is shared, measure bytes and latency, and announce
   * the call on the presence channel.
   */
  private instrument(server: McpServer, grant: Grant, hash: string, data: Dataset, origin: string, call: { tool: string }): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
      register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
        // Revoke from the app (APC 0.2): a call of a grant revoked since its request came in (one of a
        // batch, or the next poll of a wait) gets the revoked answer and nothing of Pulse's. By the grant's
        // secret and its hash, never its id, which a later grant may reuse (TIN-606).
        const cut = (): ToolResult | null => {
          if (this.holds(grant.secret)) return null;
          const revokedAt = this.revokedAt(hash);
          return revokedAt ? revokedToolResult(new URL(origin).host, revokedAt) : toolError("unknown_grant", "This grant no longer exists.");
        };
        const before = cut();
        if (before) return before;
        const started = Date.now();
        const tool = String(name);
        call.tool = tool;
        // A link code is a one-time secret: the log says it came, never what it was.
        this.log("inbound", grant.id, { tool, args: tool === APC_LINK_TOOL ? { code: "(hidden)" } : args });
        this.sql.exec("update grants set last_active_at = ? where id = ?", new Date().toISOString(), grant.id);

        // The page animates an agent's icon while it waits (TIN-350) from the wait events registerApcTools sends (APC 0.11).
        let result = (await (cb as (a: unknown, e: unknown) => Promise<ToolResult>)(args, extra)) as ToolResult;
        const after = cut();
        if (after) return after;

        const row = this.focusRow(grant.id);
        const focus = resolveFocus(row, grant, data, origin);
        let envelope = 0;
        if (isUnread(row) && focus) {
          const attention = attentionFor(focus);
          result = attachAttention(result, attention);
          envelope = envelopeBytes(attention);
          this.log("envelope_delivered", grant.id, { tool, pinned_at: row.pinned_at, bytes: envelope });
        }
        // The loop hint, while a page is open and the person shares their view. A wait that returned no focus carries its own note and ends the loop.
        const hinted = loopHinted(tool, result.structuredContent?.focus != null, this.attendance(), row?.pinned_at ?? null);
        result = attachThen(result, hinted);
        // apc_link (APC 0.4): at most once per session, the offer to show this agent as one with its other path.
        const offer = result.isError ? null : await this.links.offer(grant.id, tool);
        if (offer) {
          result = attachApcLink(result, offer);
          this.log("link_offered", grant.id, { tool });
        }
        if (row && focus && tool === focus.next && stable(args) === stable(focus.next_args)) {
          const already = this.sql.exec("select 1 from events where type = 'next_read' and grant_id = ? and data like ?", grant.id, `%"pinned_at":"${row.pinned_at}"%`).toArray().length;
          if (!already) this.log("next_read", grant.id, { tool, pinned_at: row.pinned_at });
        }
        this.log("tool_call", grant.id, {
          tool,
          ms: Date.now() - started,
          args_bytes: bytes(args),
          result_bytes: bytes(result.content.map((c) => c.text).join("")),
          envelope_bytes: envelope,
          then_bytes: thenBytes(hinted),
          error: !!result.isError,
        });
        if (result.isError) this.broadcast({ type: "activity" });
        if (!result.isError) {
          const targets = tool === "get_customer" && typeof args.id === "string" ? [{ kind: "customer", id: args.id }] : [];
          this.broadcast({ type: "presence", event: presenceEvent({ grantId: grant.id, tool, kind: "read", targets }) });
        }
        return result;
      });
  }
}
