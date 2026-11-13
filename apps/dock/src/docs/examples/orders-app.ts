/**
 * Orders: the smallest complete APC app, the one the guide at apc.tineira.com/docs/integrate builds step by
 * step. A shop's orders, pointable one by one, offered to agents on both profiles: Direct (the agent connects
 * to Orders' own MCP URL) and Dock (the agent connects once to a dock's hub, which pairs with Orders).
 *
 * It runs anywhere Web standard Request and Response do (Node, Deno, Bun, a Cloudflare Worker): `fetch` takes
 * a Request and answers. State is in memory and for one person, to keep the APC parts in sight: a real app
 * keeps grants, pins and the view in its database (`OrdersStore` here), per person, and puts the person's
 * routes (/api/*) behind its own sign-in (`signedIn` here).
 *
 * `apps/dock/test/docs-examples.test.ts` runs the conformance suite against this file, on both profiles.
 */
// #region imports
import {
  LONG_DORMANCY_RECOMMENDED_MS,
  PAIRING_CODE_TTL_MS,
  T_ACK_MAX_MS,
  T_CONNECT_MAX_MS,
  T_IDLE_RECOMMENDED_MS,
  dockGrantStateOf,
  parseParams,
  parseTarget,
  type ApcProfile,
  type DockGrantState,
  type FocusPayload,
  type FocusRow,
  type PresenceMessage,
  type ViewPayload,
} from "@tineira/apc-protocol";
import {
  APC_INSTRUCTIONS,
  ApcLinks,
  CONSENT_REQUIRED,
  DockConsent,
  confirmWithHub,
  dockGrantGate,
  handleDockGiveBack,
  pairWithHub,
  parseDockDrop,
  InflightCalls,
  MemoryWaitSlots,
  apcJsonResponse,
  apcManifest,
  attachApcLink,
  attachAttention,
  attachThen,
  attentionFor,
  badContentLength,
  initializeOf,
  isUnread,
  linkClient,
  memoryKv,
  newDirectGrant,
  presenceEvent,
  registerApcLinkTool,
  registerApcTools,
  revokedResponse,
  revokedToolResult,
  secretHash,
  thenApplies,
  toolError,
  toolResult,
  type ApcKv,
  type DockDropOptions,
  type ToolResult,
} from "@tineira/apc-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
// #endregion

// #region data
export interface Order {
  id: string;
  customer: string;
  status: "open" | "shipped";
  total_eur: number;
}

export const ORDERS: Order[] = [
  { id: "ord_1001", customer: "Acme", status: "open", total_eur: 1200 },
  { id: "ord_1002", customer: "Globex", status: "shipped", total_eur: 640 },
  { id: "ord_1003", customer: "Initech", status: "open", total_eur: 89 },
];
// #endregion

// #region grant
/** One agent's access to Orders: a grant, with its own MCP URL, pin and name. */
export interface Grant {
  /** What pins and the agent bar name. Not secret. */
  id: string;
  /** 128 random bits, the last segment of the MCP URL: whoever holds the URL holds the grant. */
  secret: string;
  /** SHA-256 of the secret: what a revoked grant leaves behind, and what a dock's give-back is looked up by. */
  hash: string;
  /** How the agent came: directly, or through a dock's hub. */
  path: ApcProfile;
  name: string;
  /** The agent has connected (sent `initialize`), with this MCP client. */
  client: string | null;
  /** Dock: the hub's origin and the agent's public handle there. */
  hub: string | null;
  agent: string | null;
  /**
   * Dock (APC 0.10): where the grant is on its way to the dock. `in_flight` from the person's Allow to the hub's
   * acknowledgement, `handoff` until the hub's first `initialize`, then `live`. A Direct grant is always `live`.
   * A grant that ended is deleted (its URL answers 404); a revoked one leaves its hash in `revoked` (403).
   */
  state: "in_flight" | "handoff" | "live";
  /** Dock: when the person allowed it, when the hub acknowledged it, and the person's last wake action (ms). */
  allowedAt: number;
  ackedAt: number;
  lastWake: number;
  /** Dock: the pairing code the person types in their dock, while the grant is in handoff. Shown only on the person's page. */
  pairing: { code: string; expires_at: string } | null;
}

/** What Orders keeps: in a real app, tables in its database. It outlives the process (`OrdersAppOptions.store`). */
export interface OrdersStore {
  /** Live grants, by secret. */
  grants: Map<string, Grant>;
  /** Revoked grants: the SHA-256 of the secret (never the secret) and when. */
  revoked: Map<string, string>;
  /** One pin per grant, by grant id. */
  pins: Map<string, FocusRow>;
  /** Consent nonces and `apc_link` codes (`DockConsent`, `ApcLinks`). */
  kv: ApcKv;
}

export const newOrdersStore = (): OrdersStore => ({ grants: new Map(), revoked: new Map(), pins: new Map(), kv: memoryKv() });
// #endregion

/** What the person's page shows of each agent, for the agent bar and the Direct agent list. */
export interface AgentRow {
  id: string;
  name: string;
  /** "direct", "dock", or both for one agent linked across the two paths (`apc_link`). */
  paths: ApcProfile[];
  /** The grants behind the row: two for a linked agent. */
  grants: string[];
  /** A Direct agent's MCP URL, for the person to paste into their agent. */
  url: string | null;
  client: string | null;
  pin: { label: string; seen: boolean } | null;
  /** Dock, before the dock connected: `"code"` (waiting for the person to type `pairing.code` in their dock) or `"connecting"` (the dock took the code and has not connected yet). */
  waiting: "code" | "connecting" | null;
  pairing: { code: string; expires_at: string } | null;
}

export interface OrdersAppOptions {
  /** The app's public origin as you configure it, e.g. "https://orders.example": never read from a request. */
  origin: string;
  /** How agents reach it: ["direct"], ["dock"] or both. */
  profiles: ApcProfile[];
  /** Dock: the hubs this app pairs with, its constant allowlist: bare https origins, e.g. ["https://apc.tineira.com"]. */
  hubs?: string[];
  /** Dock, local development only: loopback hubs allowed over http, e.g. ["http://localhost:5200"]. Leave it out in production. */
  localDevHubs?: string[];
  /** Whether a request carries the person's session: your own sign-in. Orders has one person, so by default every request does. */
  signedIn?: (request: Request) => boolean;
  /** How the server calls a hub; the global fetch by default. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; Date.now by default. Every time limit of a dock grant is read through it. */
  now?: () => number;
  /** Dock: how long a live grant stays awake after the person's last wake action (T_idle); 30 minutes by default. */
  idleMs?: number;
  /** Where Orders keeps its grants; a new, empty store by default. */
  store?: OrdersStore;
}

type PageMessage = { type: "presence"; event: PresenceMessage } | { type: "agents" };

/**
 * What a drop from a dock answers the page: `consent_required` with the nonce and the pairing code to show; or
 * the grant, with `status: "pending"` and the code to wait on (`pairing`) while the dock has not taken the code,
 * `"connecting"` once it has and until it connects, and `"paired"` for a live grant, pinned.
 */
export interface DropAnswer {
  ok: boolean;
  error?: string;
  consent?: string;
  pairing_code?: string;
  grant_id?: string;
  status?: string;
  pairing?: { code: string; expires_at: string };
  pin_error?: string;
}

/** The most of an MCP request Orders reads: 1 MiB, far more than any call it serves. Past it: HTTP 413. */
export const MCP_BODY_MAX_BYTES = 1_048_576;

/** A request's body as text, read up to `cap` bytes; null past it, or when its `content-length` already says so. */
async function cappedText(request: Request, cap: number): Promise<string | null> {
  if (badContentLength(request.headers, cap)) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  for (let size = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

export class OrdersApp {
  readonly origin: string;
  /** What `apc.json` and the page list: `dock` only while the app can pair, with a hub on its allowlist (M8). */
  readonly profiles: ApcProfile[];
  private readonly host: string;
  private readonly hubs: DockDropOptions;
  private readonly signedIn: (request: Request) => boolean;
  private readonly send: typeof fetch;
  private readonly store: OrdersStore;
  /** One wait_for_focus per grant: every request runs in this one object, so the places live in memory. */
  private readonly waitSlots = new MemoryWaitSlots();
  /** MCP's notifications/cancelled comes in a POST of its own: the calls in flight, to find the one it names. */
  private readonly calls = new InflightCalls();
  private view: { screen: string; params: Record<string, string | string[]>; selection: { kind: string; id: string } | null; updated_at: string } | null = null;
  /** The person's open pages: each is a stream of messages (server-sent events). */
  private readonly pages = new Set<(message: PageMessage) => void>();
  /** Drops being answered now, by hub and agent: one at a time, and never a lock held across the hub call (M5). */
  private readonly pairing = new Set<string>();
  private readonly consent: DockConsent;
  private readonly links: ApcLinks;
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(options: OrdersAppOptions) {
    this.origin = options.origin;
    this.host = new URL(options.origin).host;
    this.hubs = { hubs: options.hubs ?? [], localDevHubs: options.localDevHubs ?? [] };
    // A mistyped allowlist fails here, at start, not on the first drop: parseDockDrop throws on an entry that is not a bare origin.
    parseDockDrop(null, this.hubs);
    const canPair = this.hubs.hubs.length + (this.hubs.localDevHubs?.length ?? 0) > 0;
    this.profiles = options.profiles.filter((p) => p !== "dock" || canPair);
    this.signedIn = options.signedIn ?? (() => true);
    this.send = options.fetch ?? ((...args) => fetch(...args));
    this.store = options.store ?? newOrdersStore();
    const now = options.now ?? Date.now;
    this.now = now;
    this.idleMs = options.idleMs ?? T_IDLE_RECOMMENDED_MS;
    this.consent = new DockConsent(this.store.kv, { now });
    // apc_link sees the grants an agent can read with: a Direct one, or a Dock one its hub connected.
    this.links = new ApcLinks(this.store.kv, { appName: "Orders", now, grants: () => this.live().filter((g) => g.state === "live").map((g) => ({ id: g.id, path: g.path })) });
  }

  // #region routes
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // What Orders is, for hubs, the browser extension and any tool (apc.json).
    if (path === "/.well-known/apc.json") return apcJsonResponse(apcManifest({ name: "Orders", origin: this.origin, profiles: this.profiles, connect: "/agents" }));
    // Each grant's MCP URL: the agent itself (Direct) or a dock's hub (Dock) calls it.
    const mcp = path.match(/^\/mcp\/([0-9a-f]{32})$/);
    if (mcp) return this.mcp(request, mcp[1]!);
    // A dock's hub gives a grant back (Dock): public, so it answers the same 200 to anything (handleDockGiveBack).
    if (path === "/apc/revoke") return handleDockGiveBack(request, { origin: this.origin, endGrantBySecretHash: (hash) => this.givenBack(hash) });

    // The person's own routes: their session, and for every change the rule on the owner's endpoints.
    const refused = this.refuseOwner(request);
    if (refused) return refused;
    if (path === "/api/events") return this.events();
    if (path === "/api/agents/list") return Response.json(this.agents());
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (path === "/api/view") return Response.json(this.reportView(body));
    if (path === "/api/agents") return Response.json(await this.addAgent());
    if (path === "/api/drop") return Response.json(await this.drop(body));
    if (path === "/api/cancel") return Response.json(this.cancel(body?.grant_id));
    if (path === "/api/heartbeat") return Response.json(this.heartbeat());
    const agent = path.match(/^\/api\/agents\/(g_[0-9a-f]{8})\/(pin|unpin|revoke|unlink)$/);
    if (agent) {
      const id = agent[1]!;
      const action = agent[2];
      if (action === "pin") return Response.json(this.pin(id, body?.target));
      if (action === "unpin") return Response.json(this.unpin(id));
      if (action === "revoke") return Response.json(this.revoke(id));
      return Response.json(this.unlink(id));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  // #endregion

  // #region owner
  /**
   * The person's routes (M6, APC 0.10): their session, and every change is a POST of `application/json`. A
   * request that carries `Origin` must name this app's configured origin; one a browser marks `cross-site` or
   * `same-site` is refused; one with neither header is not a browser (a desktop client, a script) and is taken
   * on its session. A browser always sends `Origin` on a cross-origin POST, and a cross-origin JSON POST needs a
   * CORS preflight this app never grants, so another site's page cannot drop, allow or cancel for the person.
   */
  private refuseOwner(request: Request): Response | null {
    const no = (error: string, status: number) => Response.json({ error }, { status });
    if (!this.signedIn(request)) return no("unauthorized", 401);
    if (request.method !== "POST") return null;
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== this.origin) return no("origin_not_allowed", 403);
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") return no("cross_site_request", 403);
    const media = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return media === "application/json" ? null : no("json_required", 415);
  }
  // #endregion

  /** A grant's MCP URL: the origin, under apc.json's mcp.path ("/mcp/"), and the secret. */
  mcpUrl(secret: string): string {
    return `${this.origin}/mcp/${secret}`;
  }

  private live(): Grant[] {
    return [...this.store.grants.values()];
  }
  private byId(id: string): Grant | undefined {
    return this.live().find((g) => g.id === id);
  }
  /** To every open page. A page whose stream closed without telling us is dropped: it never fails the tool call that published. */
  private publish(message: PageMessage): void {
    for (const send of this.pages) {
      try {
        send(message);
      } catch {
        this.pages.delete(send);
      }
    }
  }

  // #region direct
  /** Direct: the person makes an agent on the page. It gets its own grant, and the URL to paste into the agent. */
  async addAgent(): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
    if (!this.profiles.includes("direct")) return { ok: false, error: "direct_not_offered" };
    const { id, secret } = newDirectGrant();
    this.store.grants.set(secret, { id, secret, hash: await secretHash(secret), path: "direct", name: "New agent", client: null, hub: null, agent: null, state: "live", allowedAt: 0, ackedAt: 0, lastWake: 0, pairing: null });
    this.publish({ type: "agents" });
    return { ok: true, id, url: this.mcpUrl(secret) };
  }
  // #endregion

  // #region view
  /** The page reports the screen as identifiers: a screen name, key-only params, at most one selected row. */
  reportView(raw: Record<string, unknown> | null): { ok: boolean } {
    const screen = typeof raw?.screen === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(raw.screen) ? raw.screen : null;
    const params = parseParams(raw?.params ?? {});
    const s = raw?.selection as { kind?: unknown; id?: unknown } | null | undefined;
    const selection = s && s.kind === "order" && typeof s.id === "string" && ORDERS.some((o) => o.id === s.id) ? { kind: "order", id: s.id } : null;
    if (!screen || !params) return { ok: false };
    this.view = { screen, params, selection, updated_at: new Date().toISOString() };
    return { ok: true };
  }

  private viewPayload(): ViewPayload | null {
    if (!this.view) return null;
    const age = Math.max(0, Math.round((Date.now() - Date.parse(this.view.updated_at)) / 1000));
    return { ...this.view, app_url: `${this.origin}/${this.view.screen}`, age_seconds: age, stale: age > 300, next: this.view.selection ? "get_order" : "list_orders" };
  }
  // #endregion

  // #region pin
  /** The person drops an agent's mark on a target. One pin per grant: a new one replaces it, unread. */
  pin(grantId: string, raw: unknown): { ok: boolean; error?: string } {
    if (!this.byId(grantId)) return { ok: false, error: "unknown_grant" };
    const target = raw && typeof raw === "object" ? parseTarget(raw) : null;
    if (!target || target.kind !== "order" || !ORDERS.some((o) => o.id === target.id)) return { ok: false, error: "invalid_target" };
    this.store.pins.set(grantId, { ...target, grant_id: grantId, pinned_at: new Date().toISOString(), seen_at: null });
    this.publish({ type: "agents" });
    return { ok: true };
  }

  unpin(grantId: string): { ok: boolean } {
    const had = this.store.pins.delete(grantId);
    this.publish({ type: "agents" });
    return { ok: had };
  }

  /** What the agent receives: the target, where it is, and the exact call that reads it. */
  private focusPayload(grantId: string): FocusPayload | null {
    const pin = this.store.pins.get(grantId);
    if (!pin?.id) return null;
    return { kind: pin.kind, id: pin.id, part: pin.part, params: pin.params, app_url: `${this.origin}/orders/${pin.id}`, pinned_at: pin.pinned_at, next: "get_order", next_args: { id: pin.id } };
  }
  // #endregion

  // #region mcp
  private async mcp(request: Request, secret: string): Promise<Response> {
    // The hash first: it is what tells "revoked" from "unknown", now and for the calls this request runs.
    const hash = await secretHash(secret);
    // The message is read before the grant is looked up (so nothing is awaited between the lookup and the gate), and
    // whoever sends it need not hold a grant: so it is read up to a cap, and the same 413 answers any secret past it.
    const text = request.method === "POST" ? await cappedText(request, MCP_BODY_MAX_BYTES).catch(() => null) : "";
    if (text === null) return Response.json({ error: "too_large" }, { status: 413 });
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: the gate takes it as "another method", and the transport answers the parse error
    }
    // Nothing is awaited from here to the gate and the commit below: the grant's state cannot change in between.
    this.sweep();
    const grant = this.store.grants.get(secret);
    if (!grant) {
      const revokedAt = this.store.revoked.get(hash);
      // Revoked in the app: 403 with who and when, whatever the method. Unknown, ended or given back: 404.
      return revokedAt ? revokedResponse(this.host, revokedAt) : Response.json({ error: "unknown_grant" }, { status: 404 });
    }
    // Dock (APC 0.10): the grant's state decides the answer, before the transport and before anything that
    // notes the client, publishes presence or attaches attention, then or apc_link. In flight: 404. Handoff:
    // only initialize, ping and tools/list are served, a tool call gets the `pairing` error. Dormant: the idle shapes.
    if (grant.path === "dock") {
      const gate = dockGrantGate(this.stateOf(grant), body, { host: this.host });
      if (!gate.serve) return gate.response;
      // The hub's first initialize is the dock owner's yes: it makes the grant live, or it gets no result (it fails closed).
      if (gate.commits) {
        let committed: boolean;
        try {
          committed = this.commitConnection(grant);
        } catch {
          return Response.json({ error: "storage_failed" }, { status: 500 });
        }
        // Cancel, a give-back or a time limit got there first: answered by the state that won.
        if (!committed) return this.store.revoked.has(hash) ? revokedResponse(this.host, this.store.revoked.get(hash)!) : Response.json({ error: "unknown_grant" }, { status: 404 });
      }
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

    // A cancel in this POST ends the call it names; the calls this POST carries can be cancelled the same way.
    this.calls.cancel(grant.id, body);
    const inflight = this.calls.track(grant.id, body);

    // A connection arrives: note its client (for the bar, and for apc_link).
    const arriving = initializeOf(body);
    if (arriving) {
      grant.client = linkClient(arriving, grant.path);
      if (grant.path === "direct" && grant.name === "New agent" && arriving.name) grant.name = arriving.name;
      this.links.arrived(grant.id, grant.client);
      this.publish({ type: "agents" });
    }

    const server = new McpServer({ name: "orders", version: "1.0.0" }, { instructions: `${APC_INSTRUCTIONS} Orders lists a shop's orders: customer, status and total.` });
    this.aroundEveryTool(server, grant, hash);
    registerApcTools(server, {
      readView: async () => this.viewPayload(),
      readFocus: async () => this.focusPayload(grant.id),
      focusUnread: async () => isUnread(this.store.pins.get(grant.id) ?? null),
      // Seen once delivered: the exact pin the result carried, never a newer one dropped since.
      markSeen: async (pinnedAt) => {
        const pin = this.store.pins.get(grant.id);
        if (pin?.pinned_at === pinnedAt) pin.seen_at = new Date().toISOString();
        this.publish({ type: "agents" });
      },
      // A wait ends when the person has no page open, and when its grant is revoked meanwhile.
      pageOpen: async () => this.store.grants.get(secret) === grant && this.pages.size > 0,
      // One wait per grant: a newer wait takes over, a cancelled one frees its place.
      waitSlot: this.waitSlots.for(grant.id),
      // Wait events (APC 0.11): the page knows the agent is listening while a wait holds its place.
      waitPresence: { grantId: grant.id, publish: (event) => this.publish({ type: "presence", event }) },
      signal: AbortSignal.any([request.signal, inflight.signal]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pollMs: 500,
    });
    server.registerTool(
      "list_orders",
      { title: "List the orders", description: "Every order: id, customer and status.", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => toolResult({ orders: ORDERS.map(({ id, customer, status }) => ({ id, customer, status })) }),
    );
    server.registerTool(
      "get_order",
      { title: "Read one order", description: "One order by id (ord_NNNN): customer, status and total. Usually called with the next_args of a focus.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ id }) => {
        const order = ORDERS.find((o) => o.id === id);
        return order ? toolResult({ order }) : toolError("unknown_order", `No order ${id}.`);
      },
    );
    // apc_link: with both profiles, the same agent on both paths shows as one.
    if (this.profiles.includes("direct") && this.profiles.includes("dock")) {
      registerApcLinkTool(server, { appName: "Orders", redeem: (code) => this.links.redeem(grant.id, code) });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    // The transport wants a client that takes both JSON and an event stream; some clients send less.
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    try {
      // The body was read above: the transport gets it back as it came.
      return await transport.handleRequest(new Request(request.url, { method: "POST", headers, body: text, signal: request.signal }));
    } finally {
      inflight.done();
    }
  }
  // #endregion

  // #region around
  /**
   * Around every tool, the two core tools included (registerApcTools registers through
   * server.registerTool too): the grant is checked before and after the tool, `attention` rides while the
   * pin is unread, presence goes to the person's pages, `then` rides while a page is open and the grant
   * was pinned in the last 30 minutes, and an `apc_link` offer once per session.
   */
  private aroundEveryTool(server: McpServer, grant: Grant, hash: string): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    // Revoked meanwhile? Told by this grant's own secret, never by an id a later grant may reuse.
    const cut = (): ToolResult | null => {
      if (this.store.grants.get(grant.secret) === grant) return null;
      const revokedAt = this.store.revoked.get(hash);
      return revokedAt ? revokedToolResult(this.host, revokedAt) : toolError("unknown_grant", "This grant no longer exists.");
    };
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, run: unknown) =>
      register(name, config, async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> => {
        const tool = String(name);
        const before = cut();
        if (before) return before;
        let result = await (run as (args: unknown, extra: unknown) => Promise<ToolResult>)(args, extra);
        const after = cut();
        if (after) return after;
        const focus = this.focusPayload(grant.id);
        if (focus && isUnread(this.store.pins.get(grant.id) ?? null)) result = attachAttention(result, attentionFor(focus));
        if (!result.isError) {
          const targets = tool === "get_order" && typeof args.id === "string" ? [{ kind: "order", id: args.id }] : [];
          this.publish({ type: "presence", event: presenceEvent({ grantId: grant.id, tool, kind: "read", targets }) });
        }
        // A wait that came back with no pin ends the loop: no `then` on it.
        const emptyWait = tool === "wait_for_focus" && result.structuredContent?.focus == null;
        result = attachThen(result, !emptyWait && thenApplies(this.pages.size > 0, this.store.pins.get(grant.id)?.pinned_at));
        const offer = result.isError ? null : await this.links.offer(grant.id, tool);
        return offer ? attachApcLink(result, offer) : result;
      });
  }
  // #endregion

  // #region revoke
  /** Revoke from the app: at once, calling nobody, in any state. A linked agent is one agent: both its grants go. */
  revoke(grantId: string): { ok: boolean } {
    const partner = this.links.partnerOf(grantId);
    const cut = this.live().filter((g) => g.id === grantId || g.id === partner);
    if (!cut.length) return { ok: false };
    for (const g of cut) this.revokeNow(g);
    this.publish({ type: "agents" });
    return { ok: true };
  }

  /** The grant's URL answers `revoked` from now on: its hash is kept, never its secret. Nothing is awaited (the hash is on the grant). */
  private revokeNow(g: Grant): void {
    this.store.revoked.set(g.hash, new Date().toISOString());
    this.forget(g);
  }

  private forget(g: Grant): void {
    this.links.forget(g.id);
    this.waitSlots.forget(g.id);
    this.store.pins.delete(g.id);
    this.store.grants.delete(g.secret);
  }
  // #endregion

  /** Unlink: a linked agent shows as two again. Both grants stay. */
  unlink(grantId: string): { ok: boolean } {
    const ok = this.links.unlink(grantId) !== null;
    this.publish({ type: "agents" });
    return { ok };
  }

  // #region dock
  /**
   * Dock: the person dropped an agent from a dock on the page. Every such drop comes here, whatever the
   * page thinks it knows, and so does the Allow (the same request with the consent's nonce). `parseDockDrop`
   * checks the drag's hub against the allowlist both times (M1) and gives back its origin, which is where the
   * hub calls go (M9). An agent with no grant gets one only with the person's yes on this page, proven by the
   * nonce; the consent shows a pairing code, which the hub gets with the grant and the person types in their dock.
   */
  async drop(raw: Record<string, unknown> | null): Promise<DropAnswer> {
    if (!this.profiles.includes("dock")) return { ok: false, error: "dock_not_offered" };
    const parsed = parseDockDrop(raw, this.hubs);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { hub, agent, ticket } = parsed;
    // One drop, Allow or confirm of an agent at a time: a double-clicked Allow changes nothing.
    const key = `${hub} ${agent}`;
    if (this.pairing.has(key)) return { ok: false, error: "pairing_in_progress" };
    this.pairing.add(key);
    try {
      return await this.dropOnce(hub, agent, ticket, raw?.target, raw?.consent);
    } finally {
      this.pairing.delete(key);
    }
  }

  private async dropOnce(hub: string, agent: string, ticket: string, target: unknown, consent: unknown): Promise<DropAnswer> {
    // The newest consent asked for this agent: a new drop replaces the one before it.
    const newest = `asked:${hub} ${agent}`;
    const askFirst = (): DropAnswer => {
      const asked = this.consent.ask(hub, agent);
      this.store.kv.put(newest, asked.nonce);
      return { ok: false, error: CONSENT_REQUIRED, consent: asked.nonce, pairing_code: asked.pairing_code };
    };
    this.sweep();
    const held = this.live().find((g) => g.hub === hub && g.agent === agent);
    if (held) {
      // Its Allow still waits on the hub (in another request, or in a process that died): T_ack ends it within 30 s.
      if (held.state === "in_flight") return { ok: false, error: "pairing_in_progress" };
      // A grant already: the hub must still say it pairs them, on every drop.
      const check = await confirmWithHub(hub, { ticket, agent, mcp_url: this.mcpUrl(held.secret) }, { fetch: this.send });
      // Cancel, Revoke, a give-back or a time limit may have taken the grant while the hub answered.
      this.sweep();
      if (this.store.grants.get(held.secret) !== held) return { ok: false, error: "pairing_ended" };
      if (!check.ok && check.error !== "not_paired") return { ok: false, error: check.error };
      const expired = !held.pairing || Date.parse(held.pairing.expires_at) <= this.now();
      // The dock no longer pairs it, or it did not take the code in time: the grant ends, and the person is asked again.
      if (!check.ok || (held.state === "handoff" && check.status === "pending" && expired)) {
        this.forget(held);
        this.publish({ type: "agents" });
        return askFirst();
      }
      const pinned = this.pin(held.id, target);
      const pinError = pinned.ok ? {} : { pin_error: pinned.error };
      if (held.state === "handoff") {
        // Still waiting for the code in the dock: the same code, never a new one. The drop's target replaces the pin.
        if (check.status === "pending") return { ok: true, grant_id: held.id, status: "pending", pairing: held.pairing!, ...pinError };
        // The dock took the code and has not connected yet. Only its initialize makes the grant live, never this answer.
        held.pairing = null;
        this.publish({ type: "agents" });
        return { ok: true, grant_id: held.id, status: "connecting", ...pinError };
      }
      // A live grant: the confirmed drop is a wake action of the person's.
      held.lastWake = this.now();
      return { ...pinned, grant_id: held.id, status: check.status };
    }
    // No grant for this agent. A drop asks; an Allow must bring back the newest nonce.
    if (consent === undefined || consent === null) return askFirst();
    const { id, secret } = newDirectGrant(); // any grant's id and secret
    const hash = await secretHash(secret);
    // From the nonce to the grant in flight, nothing is awaited.
    if (this.store.kv.get(newest) !== consent) return { ok: false, error: "consent_expired" };
    const taken = this.consent.takeConsent(consent, hub, agent);
    if (!taken.ok) return { ok: false, error: "consent_expired" };
    this.store.kv.delete(newest);
    const now = this.now();
    // In flight: stored before the hub is called, so its URL answers 404 until the hub acknowledges it.
    const grant: Grant = { id, secret, hash, path: "dock", name: "Agent via dock", client: null, hub, agent, state: "in_flight", allowedAt: now, ackedAt: 0, lastWake: now, pairing: null };
    this.store.grants.set(secret, grant);
    // pairWithHub refuses redirects, has one 10 s deadline and reads 8 KiB at most (M2 to M4). The hub must say
    // it keeps the code: on any other answer the grant ends, before the page hears back.
    const answer = await pairWithHub(hub, { ticket, agent, app: { name: "Orders", origin: this.origin }, mcp_url: this.mcpUrl(secret), pairing_code: taken.pairing_code }, { fetch: this.send });
    this.sweep();
    const still = this.store.grants.get(secret) === grant && grant.state === "in_flight";
    if (!answer.ok) {
      if (still) this.forget(grant);
      return { ok: false, error: answer.error };
    }
    // The acknowledgement moves the grant to handoff only if it is still in flight: a give-back, a Revoke or
    // T_ack that came first wins. In a database: UPDATE ... SET state = 'handoff' WHERE state = 'in_flight'.
    if (!still) return { ok: false, error: "pairing_ended" };
    grant.state = "handoff";
    grant.ackedAt = this.now();
    grant.pairing = { code: taken.pairing_code, expires_at: new Date(grant.ackedAt + PAIRING_CODE_TTL_MS).toISOString() };
    if (answer.agent.name) grant.name = answer.agent.name.replace(/[\p{C}]/gu, "").slice(0, 60);
    this.publish({ type: "agents" });
    const pinned = this.pin(id, target);
    return { ok: true, grant_id: id, status: "pending", pairing: grant.pairing, ...(pinned.ok ? {} : { pin_error: pinned.error }) };
  }

  /**
   * A dock grant's state now (APC 0.10), from what is stored and the clock. In flight more than T_ack (30 s)
   * after the Allow, or in handoff more than T_connect (10 minutes) after the acknowledgement, it has ended. A
   * live grant sleeps T_idle after the person's last wake action (`dormant`: it returns no data until they are
   * back), and ends after 30 days asleep. `dockGrantStateOf` picks the first state that applies.
   */
  private stateOf(g: Grant): DockGrantState {
    const now = this.now();
    const asleep = g.state === "live" ? now - g.lastWake : 0;
    return dockGrantStateOf({
      ended: (g.state === "in_flight" && now - g.allowedAt >= T_ACK_MAX_MS) || (g.state === "handoff" && now - g.ackedAt >= T_CONNECT_MAX_MS) || asleep >= this.idleMs + LONG_DORMANCY_RECOMMENDED_MS,
      in_flight: g.state === "in_flight",
      handoff: g.state === "handoff",
      dormant: asleep >= this.idleMs,
    });
  }

  /** Dock grants whose time ran out go: an ended grant's URL answers 404. Run before every read of a dock grant. */
  private sweep(): void {
    for (const g of this.live()) if (g.path === "dock" && this.stateOf(g) === "ended") this.forget(g);
  }

  /**
   * The hub's first `initialize` commits the connection: handoff to live, only if the grant is still there and in
   * handoff (in a database: UPDATE ... SET state = 'live' WHERE state = 'handoff', and whether a row changed).
   * False: it was not. If it throws, `initialize` answers HTTP 500 and the grant stays in handoff.
   */
  private commitConnection(grant: Grant): boolean {
    if (this.store.grants.get(grant.secret) !== grant || grant.state !== "handoff") return false;
    grant.state = "live";
    grant.pairing = null;
    this.publish({ type: "agents" });
    return true;
  }

  /** Cancel on the waiting card: a revoke, and only while the grant is in handoff. The check and the revoke are one step. */
  cancel(grantId: unknown): { ok: boolean; error?: string } {
    this.sweep();
    const g = this.live().find((x) => x.id === grantId);
    if (!g) return { ok: false, error: "unknown_grant" };
    if (g.path !== "dock" || this.stateOf(g) !== "handoff") return { ok: false, error: "not_cancellable" };
    this.revokeNow(g);
    this.publish({ type: "agents" });
    return { ok: true };
  }

  /** The page's heartbeat, while it is open: a wake action. Agent traffic never wakes a grant; only the person does. */
  heartbeat(): { ok: boolean; idle_ms: number } {
    this.sweep();
    for (const g of this.live()) if (g.path === "dock" && g.state === "live") g.lastWake = this.now();
    // The T_idle in effect, so the page beats at least every half of it (a MUST while the page is open).
    return { ok: true, idle_ms: this.idleMs };
  }

  /** The hub gives a grant back (the person unpaired it in the dock): it ends, in any state. Not "revoked": its URL then answers 404. */
  private givenBack(hash: string): void {
    const grant = this.live().find((g) => g.path === "dock" && g.hash === hash);
    if (!grant) return; // unknown, ended or revoked: nothing to do, and the hub is told nothing
    this.forget(grant);
    this.publish({ type: "agents" });
  }
  // #endregion

  // #region page
  /** The agents as the person's page shows them: a linked agent once, with both paths. */
  agents(): AgentRow[] {
    const rows: AgentRow[] = [];
    this.sweep();
    for (const g of this.live()) {
      if (g.state === "in_flight") continue; // the hub has not acknowledged it yet
      const partner = this.links.partnerOf(g.id);
      if (partner && g.path === "dock") continue; // shown with its Direct grant
      const pin = this.store.pins.get(g.id);
      rows.push({
        id: g.id,
        name: g.name,
        paths: partner ? ["direct", "dock"] : [g.path],
        grants: partner ? [g.id, partner] : [g.id],
        url: g.path === "direct" ? this.mcpUrl(g.secret) : null,
        client: g.client,
        pin: pin ? { label: `order ${pin.id}`, seen: !isUnread(pin) } : null,
        waiting: g.state === "handoff" ? (g.pairing ? "code" : "connecting") : null,
        pairing: g.pairing,
      });
    }
    return rows;
  }

  /** The person's page: a stream of messages (presence, and "agents changed"). An open stream is an open page. */
  events(): Response {
    const encoder = new TextEncoder();
    let send: ((message: PageMessage) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // Throws once the stream is closed; publish() then drops this page.
        send = (message) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        this.pages.add(send);
      },
      cancel: () => {
        if (send) this.pages.delete(send);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  // #endregion
}
