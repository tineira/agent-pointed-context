/**
 * Tickets: a complete Direct app in one file, whose agents authenticate with a bearer token on one shared MCP
 * URL (APC 0.8, the OAuth binding). The guide at apc.tineira.com/docs/integrate shows it whole: every name it
 * uses is defined here or exported by a package. Copy it, swap the tickets for your data and your sign-in for
 * `signedIn`, and the conformance suite passes (tickets-conformance.ts; `apps/dock/test/docs-tickets.test.ts`
 * runs it).
 *
 * Web standard Request and Response, so it runs on Node, Deno, Bun or a Cloudflare Worker. State is in memory,
 * for one person: a real app keeps grants, pins and the view in its database, per person.
 */
import { parseParams, parseTarget, type ApcManifest, type FocusPayload, type FocusRow, type PresenceMessage, type ViewPayload } from "@tineira/apc-protocol";
import {
  APC_INSTRUCTIONS,
  InflightCalls,
  MemoryWaitSlots,
  apcJsonResponse,
  apcManifest,
  attachAttention,
  attachThen,
  attentionFor,
  badContentLength,
  initializeOf,
  isUnread,
  newDirectGrant,
  presenceEvent,
  registerApcTools,
  revokedResponse,
  revokedToolResult,
  secretHash,
  thenApplies,
  toolError,
  toolResult,
  unknownBearerResponse,
  type ToolResult,
} from "@tineira/apc-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/** The app's data. A target carries only the kind and the id; the agent reads the rest through the tools. */
export interface Ticket {
  id: string;
  subject: string;
  status: "open" | "closed";
}
export const TICKETS: Ticket[] = [
  { id: "t_101", subject: "Printer offline", status: "open" },
  { id: "t_102", subject: "VPN drops every hour", status: "open" },
  { id: "t_103", subject: "New laptop for Ana", status: "closed" },
];

/** One agent's access: a grant. The app keeps only a hash of its token, so the token is never stored. */
interface Grant {
  /** What pins, presence and the agent bar name. Not secret. */
  id: string;
  /** SHA-256 of the bearer token: how a request finds its grant, and what a revoked grant leaves behind. */
  tokenHash: string;
  name: string;
  /** The MCP client that connected with it (its `initialize`), or null before. */
  client: string | null;
}

/** What the person's page hears on its event stream: presence, and "the agents changed". */
export type PageMessage = { type: "presence"; event: PresenceMessage } | { type: "agents" };

/** What the page shows of each agent. */
export interface AgentRow {
  id: string;
  name: string;
  client: string | null;
  pin: { label: string; seen: boolean } | null;
}

/** The most of an MCP request read: 1 MiB, far more than any call needs. Past it: HTTP 413. */
const MCP_BODY_MAX_BYTES = 1_048_576;

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

/** The token in `Authorization: Bearer <token>`, or null. */
function bearerToken(request: Request): string | null {
  return request.headers.get("authorization")?.match(/^Bearer +([\w.~+/-]+=*)$/i)?.[1] ?? null;
}

export class TicketsApp {
  readonly origin: string;
  private readonly host: string;
  /** Built once, at start: a mistake in it fails here, never as a 500 on every read of apc.json. */
  private readonly manifest: ApcManifest;
  private readonly signedIn: (request: Request) => boolean;
  /** Live grants by token hash; revoked ones by token hash, with when. */
  private readonly grants = new Map<string, Grant>();
  private readonly revoked = new Map<string, string>();
  /** One pin per grant, by grant id. */
  private readonly pins = new Map<string, FocusRow>();
  private view: { screen: string; params: Record<string, string | string[]>; selection: { kind: string; id: string } | null; updated_at: string } | null = null;
  /** The person's open pages, each a stream of messages. An open stream is an open page. */
  private readonly pages = new Set<(message: PageMessage) => void>();
  /** One wait_for_focus per grant; every request runs in this one process, so the places live in memory. */
  private readonly waitSlots = new MemoryWaitSlots();
  /** MCP's notifications/cancelled comes in a POST of its own: the calls in flight, to find the one it names. */
  private readonly calls = new InflightCalls();

  /**
   * `origin`: the public origin you configure, never one read from a request. `signedIn`: your own sign-in, required:
   * whether a request carries the person's session. There is no default, so a copy of this file is never open to all.
   */
  constructor(origin: string, options: { signedIn: (request: Request) => boolean }) {
    this.origin = origin;
    this.host = new URL(origin).host;
    if (typeof options?.signedIn !== "function") throw new TypeError("TicketsApp: give signedIn, your own sign-in check");
    this.signedIn = options.signedIn;
    // One MCP URL, /mcp, shared by every grant: the bearer token names the grant. mcp.path is a prefix that starts and
    // ends with /, and covers /mcp, the exact endpoint (APC 0.11) that readers from 0.11 on go by.
    this.manifest = apcManifest({ name: "Tickets", origin, profiles: ["direct"], connect: "/", mcpPath: "/mcp/", endpoints: [{ path: "/mcp", profiles: ["direct"] }] });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/apc.json") return apcJsonResponse(this.manifest);
    if (path === "/mcp") return this.mcp(request);

    // The person's own routes: their session, and a change only from this origin's own pages.
    if (!this.signedIn(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (path === "/api/events") return this.events();
    if (path === "/api/agents/list") return Response.json(this.agents());
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== this.origin) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (path === "/api/view") return Response.json(this.reportView(body));
    if (path === "/api/agents") return Response.json(await this.addAgent());
    const agent = path.match(/^\/api\/agents\/(g_[0-9a-f]{8})\/(pin|unpin|revoke)$/);
    if (agent?.[2] === "pin") return Response.json(this.pin(agent[1]!, body?.target));
    if (agent?.[2] === "unpin") return Response.json(this.unpin(agent[1]!));
    if (agent?.[2] === "revoke") return Response.json(this.revoke(agent[1]!));
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * The person makes an agent. It gets its own grant and token; the page shows the token once, to paste into the
   * agent with the MCP URL (most clients take a custom `Authorization` header). The grant id is random, never
   * derived from the token, and stays the same for the grant's life.
   */
  async addAgent(): Promise<{ ok: true; id: string; url: string; token: string }> {
    const { id, secret: token } = newDirectGrant();
    const tokenHash = await secretHash(token);
    this.grants.set(tokenHash, { id, tokenHash, name: "New agent", client: null });
    this.publish({ type: "agents" });
    return { ok: true, id, url: `${this.origin}/mcp`, token };
  }

  /** Revoke: at once, calling nobody. The token now answers `revoked` (401) to every method; its hash is all that is kept. */
  revoke(grantId: string): { ok: boolean } {
    const grant = [...this.grants.values()].find((g) => g.id === grantId);
    if (!grant) return { ok: false };
    this.revoked.set(grant.tokenHash, new Date().toISOString());
    this.grants.delete(grant.tokenHash);
    this.pins.delete(grant.id);
    this.waitSlots.forget(grant.id);
    this.publish({ type: "agents" });
    return { ok: true };
  }

  /** The page reports the screen as identifiers: a screen name, key-only params, at most one selected ticket. */
  reportView(raw: Record<string, unknown> | null): { ok: boolean } {
    const screen = typeof raw?.screen === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(raw.screen) ? raw.screen : null;
    const params = parseParams(raw?.params ?? {});
    const s = raw?.selection as { kind?: unknown; id?: unknown } | null | undefined;
    const selection = s && s.kind === "ticket" && typeof s.id === "string" && TICKETS.some((t) => t.id === s.id) ? { kind: "ticket", id: s.id } : null;
    if (!screen || !params) return { ok: false };
    this.view = { screen, params, selection, updated_at: new Date().toISOString() };
    return { ok: true };
  }

  /** The person drops an agent's mark on a ticket. One pin per grant: a new one replaces it, unread. */
  pin(grantId: string, raw: unknown): { ok: boolean; error?: string } {
    if (![...this.grants.values()].some((g) => g.id === grantId)) return { ok: false, error: "unknown_grant" };
    const target = raw && typeof raw === "object" ? parseTarget(raw) : null;
    if (!target || target.kind !== "ticket" || !TICKETS.some((t) => t.id === target.id)) return { ok: false, error: "invalid_target" };
    this.pins.set(grantId, { ...target, grant_id: grantId, pinned_at: new Date().toISOString(), seen_at: null });
    this.publish({ type: "agents" });
    return { ok: true };
  }

  unpin(grantId: string): { ok: boolean } {
    const had = this.pins.delete(grantId);
    this.publish({ type: "agents" });
    return { ok: had };
  }

  /** The agents, for the page's agent bar. */
  agents(): AgentRow[] {
    return [...this.grants.values()].map((g) => {
      const pin = this.pins.get(g.id);
      return { id: g.id, name: g.name, client: g.client, pin: pin ? { label: `ticket ${pin.id}`, seen: !isUnread(pin) } : null };
    });
  }

  /** The person's page: a stream of messages. It is open while the stream is. */
  events(): Response {
    const encoder = new TextEncoder();
    let send: ((message: PageMessage) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        send = (message) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        this.pages.add(send);
      },
      cancel: () => {
        if (send) this.pages.delete(send);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  /** To every open page. A page whose stream closed is dropped: it never fails the tool call that published. */
  private publish(message: PageMessage): void {
    for (const send of this.pages) {
      try {
        send(message);
      } catch {
        this.pages.delete(send);
      }
    }
  }

  private viewPayload(): ViewPayload | null {
    if (!this.view) return null;
    const age = Math.max(0, Math.round((Date.now() - Date.parse(this.view.updated_at)) / 1000));
    return { ...this.view, app_url: `${this.origin}/${this.view.screen}`, age_seconds: age, stale: age > 300, next: this.view.selection ? "get_ticket" : "list_tickets" };
  }

  /** What the agent receives for its pin: the target, where it is, and the exact call that reads it. */
  private focusPayload(grantId: string): FocusPayload | null {
    const pin = this.pins.get(grantId);
    if (!pin?.id) return null;
    return { kind: pin.kind, id: pin.id, part: pin.part, params: pin.params, app_url: `${this.origin}/tickets/${pin.id}`, pinned_at: pin.pinned_at, next: "get_ticket", next_args: { id: pin.id } };
  }

  /** What a token that holds no live grant answers: the `RevokedAnswer` (401) if it was revoked, else a plain 401. */
  private notLive(tokenHash: string): Response {
    const revokedAt = this.revoked.get(tokenHash);
    return revokedAt ? revokedResponse(this.host, revokedAt, { bearer: true }) : unknownBearerResponse();
  }

  /**
   * The MCP endpoint, one URL for every grant. No token: a plain 401 with the bare `Bearer` challenge. A token the
   * app does not know: a plain 401 (no `RevokedAnswer`). A revoked token: 401 with the `RevokedAnswer` and
   * `WWW-Authenticate: Bearer error="invalid_token"`, to every request, before anything else (its body is not even read).
   */
  private async mcp(request: Request): Promise<Response> {
    const token = bearerToken(request);
    if (!token) return unknownBearerResponse({ missing: true });
    const tokenHash = await secretHash(token);
    if (!this.grants.has(tokenHash)) return this.notLive(tokenHash);
    const text = request.method === "POST" ? await cappedText(request, MCP_BODY_MAX_BYTES).catch(() => null) : "";
    if (text === null) return Response.json({ error: "too_large" }, { status: 413 });
    // Read again after the body: a revoke while it arrived is answered as revoked.
    const grant = this.grants.get(tokenHash);
    if (!grant) return this.notLive(tokenHash);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: the transport answers the parse error
    }
    // A cancel in this POST ends the call it names; the calls this POST carries can be cancelled the same way.
    this.calls.cancel(grant.id, body);
    const inflight = this.calls.track(grant.id, body);
    const arriving = initializeOf(body);
    if (arriving) {
      grant.client = arriving.name;
      if (grant.name === "New agent" && arriving.name) grant.name = arriving.name;
      this.publish({ type: "agents" });
    }

    const server = new McpServer({ name: "tickets", version: "1.0.0" }, { instructions: `${APC_INSTRUCTIONS} Tickets lists a help desk's tickets.` });
    // The wrapper first: registerApcTools registers through server.registerTool, so the two core tools get it too.
    this.aroundEveryTool(server, grant);
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
      pageOpen: async () => this.grants.get(tokenHash) === grant && this.pages.size > 0,
      waitSlot: this.waitSlots.for(grant.id),
      // A wait's open and closed (APC 0.11), so the page knows the agent is listening.
      waitPresence: { grantId: grant.id, publish: (event) => this.publish({ type: "presence", event }) },
      signal: AbortSignal.any([request.signal, inflight.signal]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pollMs: 500,
    });
    server.registerTool(
      "list_tickets",
      { title: "List the tickets", description: "Every ticket: id, subject and status.", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => toolResult({ tickets: TICKETS }),
    );
    server.registerTool(
      "get_ticket",
      { title: "Read one ticket", description: "One ticket by id (t_NNN). Usually called with the next_args of a focus.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ id }) => {
        const ticket = TICKETS.find((t) => t.id === id);
        return ticket ? toolResult({ ticket }) : toolError("unknown_ticket", `No ticket ${id}.`);
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    // The transport wants a client that takes both JSON and an event stream; some clients send less.
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    try {
      return await transport.handleRequest(new Request(request.url, { method: "POST", headers, body: text, signal: request.signal }));
    } finally {
      inflight.done();
    }
  }

  /**
   * Around every tool: the grant is checked before and after it runs (revoked meanwhile ends the call `revoked`),
   * `attention` rides while the pin is unread, presence goes to the person's pages, and `then` rides while a page is
   * open and the grant was pinned in the last 30 minutes, but never on a wait that came back empty.
   */
  private aroundEveryTool(server: McpServer, grant: Grant): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    const cut = (): ToolResult | null => {
      if (this.grants.get(grant.tokenHash) === grant) return null;
      const revokedAt = this.revoked.get(grant.tokenHash);
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
          const targets = tool === "get_ticket" && typeof args.id === "string" ? [{ kind: "ticket", id: args.id }] : [];
          this.publish({ type: "presence", event: presenceEvent({ grantId: grant.id, tool, kind: "read", targets }) });
        }
        const emptyWait = tool === "wait_for_focus" && result.structuredContent?.focus == null;
        return attachThen(result, !emptyWait && thenApplies(this.pages.size > 0, this.pins.get(grant.id)?.pinned_at));
      });
  }
}
