import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  APC_LINK_TOOL,
  APC_LINK_TTL_S,
  CORE_TOOLS,
  LINK_REFUSED_ERROR,
  oppositePath,
  type ApcLinkDone,
  type ApcLinkOffer,
  type ApcLinkRefusal,
  type ApcLinkRefused,
  type ApcProfile,
} from "@apc/protocol";
import { z } from "zod";
import { toolResult, type ToolResult } from "./envelope.ts";
import type { ApcKv } from "./kv.ts";
import { secretHash } from "./revoke.ts";

/**
 * `apc_link` (APC 0.4, `core.ts` in @apc/protocol): one agent connected to the same app both ways
 * (its own MCP URL and through a dock's hub) shown as one agent. The app tells `ApcLinks` when a
 * connection arrives and asks it, around every tool result, whether to carry an offer; the tool
 * `apc_link` redeems a code. It keeps its state in an `ApcKv`: which grants are linked, each grant's
 * current MCP session (its client, and whether an offer is still to be made in it) and the codes, by
 * hash. Linking grants nothing: the app's grants, their trimming and their pins do not change.
 *
 * Every method that checks and writes does so synchronously, after its one await (the code's hash),
 * so in a Durable Object nothing runs between the check and the write.
 */

/** A live grant of the app and the path it came by. */
export interface LinkGrant {
  id: string;
  path: ApcProfile;
}

export interface ApcLinksOptions {
  /** The app's name as the person knows it, for the notes. */
  appName: string;
  /** The app's live grants (revoked or deleted ones are not here), and the path each came by. */
  grants(): LinkGrant[];
  /** Milliseconds since the epoch; Date.now by default. */
  now?: () => number;
}

interface Session {
  client: string | null;
  /** An offer is still to be made in this session (decided when the connection arrived). */
  pending: boolean;
}

interface CodeRow {
  grant: string;
  path: ApcProfile;
  /** The connections it may be redeemed on: the opposite path, the same client, not linked, when it was offered. */
  candidates: string[];
  expires_at: number;
  used: boolean;
}

/** An expired or used code is kept this long to say why it is refused, then purged. */
const CODE_KEEP_MS = 10 * 60_000;

const REFUSALS: Record<ApcLinkRefusal, string> = {
  unknown_code: "No such code here. A code works only in the app that gave it, for two minutes.",
  expired: "The code expired. The app does not ask again in this session; the person sees you as two agents, which is fine.",
  used: "That code was already used.",
  same_connection: "Send the code back on your other connection to this app, not on the one that gave it.",
  same_path: "Send the code back on your connection that goes the other way: through your agent dock if it came directly, directly if it came through the dock.",
  not_offered: "This connection was not offered that code.",
  already_linked: "Already linked: nothing to do.",
};

export function linkRefused(reason: ApcLinkRefusal): ApcLinkRefused {
  return { error: LINK_REFUSED_ERROR, reason, message: REFUSALS[reason] };
}

function offerNote(appName: string, path: ApcProfile): string {
  const other =
    path === "direct"
      ? `through your agent dock: the dock's tool for ${appName}'s apc_link (<app>__apc_link, or call_app_tool with tool apc_link)`
      : `on your direct connection to ${appName} (its own MCP server): its tool apc_link`;
  return `You are connected to ${appName} two ways. So the person sees you as one agent, call apc_link({ code }) ${other}, within expires_in seconds. It grants nothing: each connection keeps its own access. If you have no other connection to ${appName}, ignore this.`;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ApcLinks {
  private readonly kv: ApcKv;
  private readonly options: ApcLinksOptions;

  constructor(kv: ApcKv, options: ApcLinksOptions) {
    this.kv = kv;
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private grant(id: string): LinkGrant | undefined {
    return this.options.grants().find((g) => g.id === id);
  }
  private session(grantId: string): Session | null {
    const raw = this.kv.get(`session:${grantId}`);
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  /** The grant this one is linked with, if both are still live and say so. */
  partnerOf(grantId: string): string | null {
    const partner = this.kv.get(`link:${grantId}`);
    if (!partner || this.kv.get(`link:${partner}`) !== grantId) return null;
    return this.grant(grantId) && this.grant(partner) ? partner : null;
  }

  /** Every link, once each: [the Direct grant, the Dock grant]. */
  links(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key] of this.kv.list("link:")) {
      const id = key.slice("link:".length);
      const partner = this.partnerOf(id);
      if (partner && this.grant(id)?.path === "direct") out.push([id, partner]);
    }
    return out;
  }

  /** The connections on the opposite path with the same client, neither linked. */
  private candidates(grantId: string, client: string): string[] {
    const me = this.grant(grantId);
    if (!me || this.partnerOf(grantId)) return [];
    const other = oppositePath(me.path);
    return this.options
      .grants()
      .filter((g) => g.id !== grantId && g.path === other && !this.partnerOf(g.id) && this.session(g.id)?.client === client)
      .map((g) => g.id);
  }

  /**
   * A connection arrived (`initialize`): a new MCP session for this grant. `client` is its MCP client
   * (`linkClient` in direct.ts). If one with the same client is already connected on the opposite path,
   * an offer is due in this session; otherwise none is.
   */
  arrived(grantId: string, client: string | null): void {
    const pending = !!client && this.candidates(grantId, client).length > 0;
    this.kv.put(`session:${grantId}`, JSON.stringify({ client, pending } satisfies Session));
  }

  /**
   * Around a successful tool result: the offer to carry (`attachApcLink`), at most once per session.
   * On the Dock path it waits for one of the app's own tools: the hub merges core results into its own.
   */
  async offer(grantId: string, tool: string): Promise<ApcLinkOffer | null> {
    if (tool === APC_LINK_TOOL || !this.session(grantId)?.pending) return null;
    if (this.grant(grantId)?.path === "dock" && (CORE_TOOLS as readonly string[]).includes(tool)) return null;
    const code = `lk_${randomHex(12)}`;
    const hash = await secretHash(code);
    // From here on, synchronous: check and write with nothing in between.
    const session = this.session(grantId);
    const me = this.grant(grantId);
    if (!session?.pending || !me) return null;
    this.kv.put(`session:${grantId}`, JSON.stringify({ ...session, pending: false } satisfies Session));
    const candidates = session.client ? this.candidates(grantId, session.client) : [];
    if (!candidates.length) return null;
    this.purge();
    const row: CodeRow = { grant: grantId, path: me.path, candidates, expires_at: this.now() + APC_LINK_TTL_S * 1000, used: false };
    this.kv.put(`code:${hash}`, JSON.stringify(row));
    return { code, expires_in: APC_LINK_TTL_S, note: offerNote(this.options.appName, me.path) };
  }

  /** `apc_link({ code })` on this grant: links it with the grant that got the code, or says why not. */
  async redeem(grantId: string, code: unknown): Promise<{ ok: true; partner: string } | { ok: false; reason: ApcLinkRefusal }> {
    if (typeof code !== "string" || code.length === 0 || code.length > 100) return { ok: false, reason: "unknown_code" };
    const key = `code:${await secretHash(code.trim())}`;
    // From here on, synchronous.
    const raw = this.kv.get(key);
    const row = raw ? (JSON.parse(raw) as CodeRow) : null;
    const me = this.grant(grantId);
    if (!row || !me || !this.grant(row.grant)) return { ok: false, reason: "unknown_code" };
    if (row.used) return { ok: false, reason: "used" };
    if (row.expires_at <= this.now()) return { ok: false, reason: "expired" };
    if (row.grant === grantId) return { ok: false, reason: "same_connection" };
    if (me.path === row.path) return { ok: false, reason: "same_path" };
    if (!row.candidates.includes(grantId)) return { ok: false, reason: "not_offered" };
    if (this.partnerOf(grantId) || this.partnerOf(row.grant)) return { ok: false, reason: "already_linked" };
    this.kv.put(key, JSON.stringify({ ...row, used: true } satisfies CodeRow));
    this.kv.put(`link:${grantId}`, row.grant);
    this.kv.put(`link:${row.grant}`, grantId);
    return { ok: true, partner: row.grant };
  }

  /** The person unlinks from the agent bar: the link goes, nothing else. Returns the partner it had. */
  unlink(grantId: string): string | null {
    const partner = this.kv.get(`link:${grantId}`);
    this.kv.delete(`link:${grantId}`);
    if (partner && this.kv.get(`link:${partner}`) === grantId) this.kv.delete(`link:${partner}`);
    return partner;
  }

  /** A grant is gone (revoked, given back, expired): its link, its session and the codes it got go. */
  forget(grantId: string): void {
    this.unlink(grantId);
    this.kv.delete(`session:${grantId}`);
    for (const [key, value] of this.kv.list("code:")) {
      if ((JSON.parse(value) as CodeRow).grant === grantId) this.kv.delete(key);
    }
  }

  private purge(): void {
    const before = this.now() - CODE_KEEP_MS;
    for (const [key, value] of this.kv.list("code:")) {
      if ((JSON.parse(value) as CodeRow).expires_at < before) this.kv.delete(key);
    }
  }
}

/** The answer to a redeemed code. */
export function linkDone(appName: string): ApcLinkDone {
  return { linked: true, note: `The person now sees you as one agent in ${appName}, reached two ways. Each connection keeps its own access; the person can unlink you.` };
}

/** `apc_link({ code })` on one grant's MCP server: the app passes the redeem for that grant. */
export function registerApcLinkTool(server: McpServer, options: { appName: string; redeem(code: string): ReturnType<ApcLinks["redeem"]> }): void {
  server.registerTool(
    APC_LINK_TOOL,
    {
      title: "Show yourself as one agent",
      description: `Only when a result from ${options.appName} on your other connection to it carried an 'apc_link' key: send its code back here, so the person sees you as one agent reached two ways (directly and through your agent dock). It grants nothing: each connection keeps its own access. A code works once, within its expires_in seconds, and only on the connection that goes the other way.`,
      inputSchema: { code: z.string().max(100) },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ code }): Promise<ToolResult> => {
      const r = await options.redeem(code);
      if (r.ok) return toolResult({ ...linkDone(options.appName) });
      const refused = linkRefused(r.reason);
      return { content: [{ type: "text", text: JSON.stringify(refused) }], isError: true };
    },
  );
}
