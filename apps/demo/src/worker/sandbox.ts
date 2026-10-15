/**
 * One visitor's sandbox: a Durable Object that holds its seed, grants, view,
 * pins and event log, serves its MCP endpoint and its presence WebSocket.
 * Visitors never share state: a URL leads to exactly one sandbox.
 */
import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { FocusRow, FocusTarget } from "@apc/protocol";
import { APC_INSTRUCTIONS, attachAttention, attentionFor, envelopeBytes, isUnread, presenceEvent, registerApcTools, type ToolResult } from "@apc/server";
import { generateDataset, type Dataset, type Region } from "../model/seed.ts";
import { checkPin, resolveFocus, sanitizeView, trimView, type Grant, type StoredView } from "./domain.ts";
import { registerPulseTools } from "./pulse-tools.ts";

export const SANDBOX_TTL_MS = 6 * 60 * 60_000;
const SERVER_VERSION = "0.1.0";

export interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
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

export class Sandbox extends DurableObject<Env> {
  private sql: SqlStorage;
  private cached: Dataset | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
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
    `);
  }

  // ---- storage helpers ----

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0];
    return row?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.sql.exec("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }
  private data(): Dataset {
    if (!this.cached) this.cached = generateDataset(Number(this.meta("seed")));
    return this.cached;
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
  private log(type: string, grantId: string | null, data: Record<string, unknown>): void {
    this.sql.exec("insert into events (at, type, grant_id, data) values (?, ?, ?, ?)", new Date().toISOString(), type, grantId, JSON.stringify(data));
  }
  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + SANDBOX_TTL_MS);
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

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "sandbox expired");
    await this.ctx.storage.deleteAll();
  }

  // ---- owner RPC (the worker checked the owner secret first) ----

  async init(): Promise<{ owner: string }> {
    const existing = this.meta("owner");
    if (existing) return { owner: existing };
    const owner = randomHex(16);
    this.setMeta("owner", owner);
    this.setMeta("seed", String(crypto.getRandomValues(new Uint32Array(1))[0]));
    this.setMeta("created_at", new Date().toISOString());
    this.setMeta("share_view", "1");
    this.setMeta("show_activity", "1");
    this.sql.exec("insert into grants (id, secret, label, regions, created_at) values (?, ?, ?, null, ?)", `g_${randomHex(4)}`, randomHex(16), "Your agent", new Date().toISOString());
    await this.touch();
    return { owner };
  }

  async isOwner(secret: string): Promise<boolean> {
    const owner = this.meta("owner");
    if (!owner || owner !== secret) return false;
    await this.touch();
    return true;
  }

  async state() {
    return {
      seed: Number(this.meta("seed")),
      settings: { share_view: this.meta("share_view") !== "0", show_activity: this.meta("show_activity") !== "0" },
      grants: this.grants().map((g) => ({ ...g, pin: this.focusRow(g.id) })),
      expires_at: new Date((await this.ctx.storage.getAlarm()) ?? Date.now()).toISOString(),
    };
  }

  async dataset(): Promise<Dataset> {
    return this.data();
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

  async pin(grantId: string, raw: unknown): Promise<{ ok: true; pin: FocusRow } | { ok: false; error: string }> {
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

  async addRestrictedGrant(region: Region): Promise<Grant> {
    const existing = this.grants().find((g) => g.regions?.length === 1 && g.regions[0] === region);
    if (existing) return existing;
    const id = `g_${randomHex(4)}`;
    this.sql.exec(
      "insert into grants (id, secret, label, regions, created_at) values (?, ?, ?, ?, ?)",
      id, randomHex(16), `Restricted agent (${region.toUpperCase()} only)`, JSON.stringify([region]), new Date().toISOString(),
    );
    this.broadcast({ type: "grants" });
    return this.grants().find((g) => g.id === id)!;
  }

  /** The event log as JSON lines, oldest first. */
  async eventsJsonl(): Promise<string> {
    return this.sql
      .exec<{ id: number; at: string; type: string; grant_id: string | null; data: string }>("select * from events order by id")
      .toArray()
      .map((e) => JSON.stringify({ id: e.id, at: e.at, type: e.type, grant_id: e.grant_id, ...JSON.parse(e.data) }) + "\n")
      .join("");
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
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const match = url.pathname.match(/^\/mcp\/[^/]+\/([0-9a-f]{32})$/);
    if (match) return this.mcp(request, match[1]!, url.origin);
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(): Promise<void> {
    // The page only listens.
  }

  private async mcp(request: Request, secret: string, origin: string): Promise<Response> {
    if (!this.meta("owner")) return Response.json({ error: "sandbox_expired" }, { status: 404 });
    const grant = this.grants().find((g) => g.secret === secret);
    if (!grant) return Response.json({ error: "unknown_grant" }, { status: 404 });
    await this.touch();

    if (request.method === "POST") {
      try {
        const body = (await request.clone().json()) as unknown;
        const messages = Array.isArray(body) ? body : [body];
        const init = messages.find((m) => (m as { method?: string })?.method === "initialize") as { params?: { clientInfo?: { name?: string } } } | undefined;
        const name = init?.params?.clientInfo?.name;
        if (typeof name === "string" && name.length <= 100) {
          this.sql.exec("update grants set client_name = ? where id = ?", name, grant.id);
          this.broadcast({ type: "grants" });
        }
      } catch {
        // not JSON: the transport answers the error
      }
    }

    const data = this.data();
    const server = new McpServer(
      { name: "pulse-apc-demo", version: SERVER_VERSION },
      {
        instructions: `${APC_INSTRUCTIONS} Pulse is product analytics for a SaaS: customers (external ids cus_NNNN, the same ids the person's billing uses), plans, regions, seats and monthly activity. It holds no revenue data.`,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    );
    this.instrument(server, grant, data, origin);
    registerApcTools(server, {
      readView: async () => trimView(this.storedView(), grant, data, origin),
      readFocus: async () => resolveFocus(this.focusRow(grant.id), grant, data, origin),
      focusUnread: async () => isUnread(this.focusRow(grant.id)),
      markSeen: async () => {
        const row = this.focusRow(grant.id);
        if (!row || !isUnread(row)) return;
        const seenAt = new Date().toISOString();
        this.sql.exec("update agent_focus set seen_at = ? where grant_id = ?", seenAt, grant.id);
        this.log("seen", grant.id, { pinned_at: row.pinned_at, seen_at: seenAt });
        this.broadcast({ type: "pin", grant_id: grant.id, pin: this.focusRow(grant.id) });
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    registerPulseTools(server, data, grant, origin);

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  /**
   * Wrap every tool the server registers: log what came in (for the canary
   * check), attach the attention envelope while the pin is unread, measure
   * bytes and latency, and announce the call on the presence channel.
   */
  private instrument(server: McpServer, grant: Grant, data: Dataset, origin: string): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
      register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
        const started = Date.now();
        const tool = String(name);
        this.log("inbound", grant.id, { tool, args });
        this.sql.exec("update grants set last_active_at = ? where id = ?", new Date().toISOString(), grant.id);

        let result = (await (cb as (a: unknown, e: unknown) => Promise<ToolResult>)(args, extra)) as ToolResult;

        const row = this.focusRow(grant.id);
        const focus = resolveFocus(row, grant, data, origin);
        let envelope = 0;
        if (isUnread(row) && focus) {
          const attention = attentionFor(focus);
          result = attachAttention(result, attention);
          envelope = envelopeBytes(attention);
          this.log("envelope_delivered", grant.id, { tool, pinned_at: row.pinned_at, bytes: envelope });
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
          error: !!result.isError,
        });
        if (!result.isError) {
          const targets = tool === "get_customer" && typeof args.id === "string" ? [{ kind: "customer", id: args.id }] : [];
          this.broadcast({ type: "presence", event: presenceEvent({ grantId: grant.id, tool, kind: "read", targets }) });
        }
        return result;
      });
  }
}
