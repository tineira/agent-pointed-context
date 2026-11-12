/**
 * Orders: the smallest complete APC app, the one the guide at apc.tineira.com/docs/integrate builds step by
 * step. A shop's orders, pointable one by one, offered to agents on both profiles: Direct (the agent connects
 * to Orders' own MCP URL) and Dock (the agent connects once to a dock's hub, which pairs with Orders).
 *
 * It runs anywhere Web standard Request and Response do (Node, Deno, Bun, a Cloudflare Worker): `fetch` takes
 * a Request and answers. State is in memory and for one person, to keep the APC parts in sight: a real app
 * keeps grants, pins and the view in its database, per person, and puts the person's routes (/api/*) behind
 * its own sign-in.
 *
 * `apps/dock/test/docs-examples.test.ts` runs the conformance suite against this file, on both profiles.
 */
// #region imports
import { parseParams, parseTarget, type ApcProfile, type FocusPayload, type FocusRow, type PresenceEvent, type ViewPayload } from "@tineira/apc-protocol";
import {
  APC_INSTRUCTIONS,
  ApcLinks,
  CONSENT_REQUIRED,
  DockConsent,
  InflightCalls,
  MemoryWaitSlots,
  apcJsonResponse,
  apcManifest,
  attachApcLink,
  attachAttention,
  attachThen,
  attentionFor,
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
interface Grant {
  /** What pins and the agent bar name. Not secret. */
  id: string;
  /** 128 random bits, the last segment of the MCP URL: whoever holds the URL holds the grant. */
  secret: string;
  /** How the agent came: directly, or through a dock's hub. */
  path: ApcProfile;
  name: string;
  /** The agent has connected (sent `initialize`), with this MCP client. */
  client: string | null;
  /** Dock: the hub's origin, and the agent's public handle there once the hub took the pairing. */
  hub: string | null;
  agent: string | null;
}
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
}

export interface OrdersAppOptions {
  /** The app's own origin, e.g. "https://orders.example". */
  origin: string;
  /** How agents reach it: ["direct"], ["dock"] or both. */
  profiles: ApcProfile[];
  /** Dock: the hubs this app pairs with, e.g. ["https://apc.tineira.com"]. */
  hubs?: string[];
  /** How the server calls a hub; the global fetch by default. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; Date.now by default. */
  now?: () => number;
}

type PageMessage = { type: "presence"; event: PresenceEvent } | { type: "agents" };

export class OrdersApp {
  readonly origin: string;
  readonly profiles: ApcProfile[];
  private readonly host: string;
  private readonly hubs: string[];
  private readonly send: typeof fetch;
  /** Live grants, by secret. */
  private readonly grants = new Map<string, Grant>();
  /** Revoked grants: the SHA-256 of the secret (never the secret) and when. */
  private readonly revoked = new Map<string, string>();
  /** One pin per grant, by grant id. */
  private readonly pins = new Map<string, FocusRow>();
  /** One wait_for_focus per grant: every request runs in this one object, so the places live in memory. */
  private readonly waitSlots = new MemoryWaitSlots();
  /** MCP's notifications/cancelled comes in a POST of its own: the calls in flight, to find the one it names. */
  private readonly calls = new InflightCalls();
  private view: { screen: string; params: Record<string, string | string[]>; selection: { kind: string; id: string } | null; updated_at: string } | null = null;
  /** The person's open pages: each is a stream of messages (server-sent events). */
  private readonly pages = new Set<(message: PageMessage) => void>();
  /** Drops being paired with a hub now, by hub and agent: one at a time. */
  private readonly pairing = new Set<string>();
  private readonly kv = memoryKv();
  private readonly consent: DockConsent;
  private readonly links: ApcLinks;

  constructor(options: OrdersAppOptions) {
    this.origin = options.origin;
    this.profiles = options.profiles;
    this.host = new URL(options.origin).host;
    this.hubs = options.hubs ?? [];
    this.send = options.fetch ?? ((...args) => fetch(...args));
    const now = options.now ?? Date.now;
    this.consent = new DockConsent(this.kv, { now });
    // apc_link sees the grants that are live and, on the Dock path, already taken by the hub.
    this.links = new ApcLinks(this.kv, { appName: "Orders", now, grants: () => this.live().filter((g) => g.path === "direct" || g.agent).map((g) => ({ id: g.id, path: g.path })) });
  }

  // #region routes
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // What Orders is, for hubs, the browser extension and any tool (apc.json).
    if (path === "/.well-known/apc.json") return apcJsonResponse(apcManifest({ name: "Orders", origin: this.origin, profiles: this.profiles, connect: "/agents" }));
    // Each grant's MCP URL: the agent itself (Direct) or a dock's hub (Dock) calls it.
    const mcp = path.match(/^\/mcp\/([0-9a-f]{32})$/);
    if (mcp) return this.mcp(request, mcp[1]!);
    // A dock's hub gives a grant back (Dock): server to server, the MCP URL is the proof.
    if (path === "/apc/revoke" && request.method === "POST") return this.givenBack(await request.json().catch(() => null));

    // The person's own routes. In a real app: behind their sign-in, for their data only.
    if (path === "/api/events") return this.events();
    if (path === "/api/agents/list") return Response.json(this.agents());
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (path === "/api/view") return Response.json(this.reportView(body));
    if (path === "/api/agents") return Response.json(this.addAgent());
    if (path === "/api/drop") return Response.json(await this.drop(body));
    const agent = path.match(/^\/api\/agents\/(g_[0-9a-f]{8})\/(pin|unpin|revoke|unlink)$/);
    if (agent) {
      const id = agent[1]!;
      const action = agent[2];
      if (action === "pin") return Response.json(this.pin(id, body?.target));
      if (action === "unpin") return Response.json(this.unpin(id));
      if (action === "revoke") return Response.json(await this.revoke(id));
      return Response.json(this.unlink(id));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  // #endregion

  /** A grant's MCP URL: the origin, under apc.json's mcp.path ("/mcp/"), and the secret. */
  mcpUrl(secret: string): string {
    return `${this.origin}/mcp/${secret}`;
  }

  private live(): Grant[] {
    return [...this.grants.values()];
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
  addAgent(): { ok: boolean; id?: string; url?: string; error?: string } {
    if (!this.profiles.includes("direct")) return { ok: false, error: "direct_not_offered" };
    const { id, secret } = newDirectGrant();
    this.grants.set(secret, { id, secret, path: "direct", name: "New agent", client: null, hub: null, agent: null });
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
    this.pins.set(grantId, { ...target, grant_id: grantId, pinned_at: new Date().toISOString(), seen_at: null });
    this.publish({ type: "agents" });
    return { ok: true };
  }

  unpin(grantId: string): { ok: boolean } {
    const had = this.pins.delete(grantId);
    this.publish({ type: "agents" });
    return { ok: had };
  }

  /** What the agent receives: the target, where it is, and the exact call that reads it. */
  private focusPayload(grantId: string): FocusPayload | null {
    const pin = this.pins.get(grantId);
    if (!pin?.id) return null;
    return { kind: pin.kind, id: pin.id, part: pin.part, params: pin.params, app_url: `${this.origin}/orders/${pin.id}`, pinned_at: pin.pinned_at, next: "get_order", next_args: { id: pin.id } };
  }
  // #endregion

  // #region mcp
  private async mcp(request: Request, secret: string): Promise<Response> {
    // The hash first: it is what tells "revoked" from "unknown", now and for the calls this request runs.
    const hash = await secretHash(secret);
    const grant = this.grants.get(secret);
    if (!grant) {
      const revokedAt = this.revoked.get(hash);
      // Revoked in the app: 403 with who and when, whatever the method. Unknown or given back: 404.
      return revokedAt ? revokedResponse(this.host, revokedAt) : Response.json({ error: "unknown_grant" }, { status: 404 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

    const body: unknown = await request.clone().json().catch(() => null);
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
      focusUnread: async () => isUnread(this.pins.get(grant.id) ?? null),
      // Seen once delivered: the exact pin the result carried, never a newer one dropped since.
      markSeen: async (pinnedAt) => {
        const pin = this.pins.get(grant.id);
        if (pin?.pinned_at === pinnedAt) pin.seen_at = new Date().toISOString();
        this.publish({ type: "agents" });
      },
      // A wait ends when the person has no page open, and when its grant is revoked meanwhile.
      pageOpen: async () => this.grants.get(secret) === grant && this.pages.size > 0,
      // One wait per grant: a newer wait takes over, a cancelled one frees its place.
      waitSlot: this.waitSlots.for(grant.id),
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
      return await transport.handleRequest(new Request(request, { headers }));
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
      if (this.grants.get(grant.secret) === grant) return null;
      const revokedAt = this.revoked.get(hash);
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
        if (focus && isUnread(this.pins.get(grant.id) ?? null)) result = attachAttention(result, attentionFor(focus));
        if (!result.isError) {
          const targets = tool === "get_order" && typeof args.id === "string" ? [{ kind: "order", id: args.id }] : [];
          this.publish({ type: "presence", event: presenceEvent({ grantId: grant.id, tool, kind: "read", targets }) });
        }
        // A wait that came back with no pin ends the loop: no `then` on it.
        const emptyWait = tool === "wait_for_focus" && result.structuredContent?.focus == null;
        result = attachThen(result, !emptyWait && thenApplies(this.pages.size > 0, this.pins.get(grant.id)?.pinned_at));
        const offer = result.isError ? null : await this.links.offer(grant.id, tool);
        return offer ? attachApcLink(result, offer) : result;
      });
  }
  // #endregion

  // #region revoke
  /** Revoke from the app: at once, calling nobody. A linked agent is one agent: both its grants go. */
  async revoke(grantId: string): Promise<{ ok: boolean }> {
    const partner = this.links.partnerOf(grantId);
    const cut = this.live().filter((g) => g.id === grantId || g.id === partner);
    if (!cut.length) return { ok: false };
    const hashes = await Promise.all(cut.map((g) => secretHash(g.secret)));
    const at = new Date().toISOString();
    cut.forEach((g, i) => {
      this.revoked.set(hashes[i]!, at);
      this.forget(g);
    });
    this.publish({ type: "agents" });
    return { ok: true };
  }

  private forget(g: Grant): void {
    this.links.forget(g.id);
    this.waitSlots.forget(g.id);
    this.pins.delete(g.id);
    this.grants.delete(g.secret);
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
   * page thinks it knows: an agent with no grant gets one only with the person's yes on this page, proven by
   * the nonce the page showed its consent with.
   */
  async drop(raw: Record<string, unknown> | null): Promise<{ ok: boolean; error?: string; consent?: string; grant_id?: string }> {
    if (!this.profiles.includes("dock")) return { ok: false, error: "dock_not_offered" };
    const hub = raw?.hub;
    const agent = raw?.agent;
    const ticket = raw?.ticket;
    if (typeof hub !== "string" || !this.hubs.includes(hub)) return { ok: false, error: "hub_not_allowed" };
    if (typeof agent !== "string" || !/^[\w.:-]{1,128}$/.test(agent) || typeof ticket !== "string" || !/^[\w.-]{16,200}$/.test(ticket)) return { ok: false, error: "invalid" };
    // One drop of an agent at a time: a double-clicked Allow changes nothing.
    const key = `${hub} ${agent}`;
    if (this.pairing.has(key)) return { ok: false, error: "pairing_in_progress" };
    this.pairing.add(key);
    try {
      return await this.dropOnce(hub, agent, ticket, raw?.target, raw?.consent);
    } finally {
      this.pairing.delete(key);
    }
  }

  private async dropOnce(hub: string, agent: string, ticket: string, target: unknown, consent: unknown): Promise<{ ok: boolean; error?: string; consent?: string; grant_id?: string }> {
    const askFirst = () => ({ ok: false, error: CONSENT_REQUIRED, consent: this.consent.ask(hub, agent) });
    const held = this.live().find((g) => g.hub === hub && g.agent === agent);
    if (held) {
      // Paired before: the hub must still say so, on every drop.
      const check = await this.hubCall(hub, "/apc/confirm", { ticket, agent, mcp_url: this.mcpUrl(held.secret) });
      if (check.ok) return { ...this.pin(held.id, target), grant_id: held.id };
      if (check.error !== "not_paired") return { ok: false, error: check.error ?? "hub_refused" };
      // The dock no longer pairs it: the grant goes, and the person is asked again (the ticket still works).
      this.forget(held);
      return askFirst();
    }
    if (!this.consent.take(consent, hub, agent)) return askFirst();
    // A grant for the hub to hold (newDirectGrant makes any grant's id and secret).
    const { id, secret } = newDirectGrant();
    const grant: Grant = { id, secret, path: "dock", name: "Agent via dock", client: null, hub, agent: null };
    this.grants.set(secret, grant);
    const answer = await this.hubCall(hub, "/apc/pair", { ticket, agent, app: { name: "Orders", origin: this.origin }, mcp_url: this.mcpUrl(secret) });
    if (!answer.ok) {
      this.grants.delete(secret);
      return { ok: false, error: answer.error ?? "hub_refused" };
    }
    // Linked to the agent only once the hub took it: until then no drop finds it half made.
    grant.agent = agent;
    if (typeof answer.agent?.name === "string") grant.name = answer.agent.name.replace(/[\p{C}]/gu, "").slice(0, 60);
    this.publish({ type: "agents" });
    return { ...this.pin(id, target), grant_id: id };
  }

  /** The hub gives a grant back (the person unpaired it in the dock): it goes. Not "revoked": its URL then answers 404. */
  private givenBack(raw: unknown): Response {
    const url = (raw as { mcp_url?: unknown } | null)?.mcp_url;
    const grant = this.live().find((g) => g.path === "dock" && this.mcpUrl(g.secret) === url);
    if (!grant) return Response.json({ ok: false, error: "unknown_grant" }, { status: 404 });
    this.forget(grant);
    this.publish({ type: "agents" });
    return Response.json({ ok: true });
  }

  private async hubCall(hub: string, path: string, body: unknown): Promise<{ ok?: boolean; error?: string; agent?: { name?: unknown } }> {
    try {
      const response = await this.send(`${hub}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
      return (await response.json()) as { ok?: boolean; error?: string; agent?: { name?: unknown } };
    } catch {
      return { ok: false, error: "hub_unreachable" };
    }
  }
  // #endregion

  // #region page
  /** The agents as the person's page shows them: a linked agent once, with both paths. */
  agents(): AgentRow[] {
    const rows: AgentRow[] = [];
    for (const g of this.live()) {
      if (g.path === "dock" && !g.agent) continue; // still pairing
      const partner = this.links.partnerOf(g.id);
      if (partner && g.path === "dock") continue; // shown with its Direct grant
      const pin = this.pins.get(g.id);
      rows.push({
        id: g.id,
        name: g.name,
        paths: partner ? ["direct", "dock"] : [g.path],
        grants: partner ? [g.id, partner] : [g.id],
        url: g.path === "direct" ? this.mcpUrl(g.secret) : null,
        client: g.client,
        pin: pin ? { label: `order ${pin.id}`, seen: !isUnread(pin) } : null,
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
