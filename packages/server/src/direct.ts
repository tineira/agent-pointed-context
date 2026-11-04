import { APC_AGENT_CLIENT_META, type ApcProfile } from "@apc/protocol";

/**
 * The Direct profile's server parts (APC 0.4), for an app's Durable Object: a grant per agent with its
 * secret MCP URL, the agent's name, what an arriving connection says about itself, and which profiles
 * the app offers. Storage stays the app's: these helpers make and read values, the app keeps them in
 * its own grants table. Linking an agent across both paths is `ApcLinks` (links.ts); revoke is core
 * (revoke.ts).
 */

export const PROFILES: readonly ApcProfile[] = ["direct", "dock"];

/**
 * The profiles an app offers, declared in one place (Pulse and Signals: `APC_PROFILES` in their
 * wrangler.jsonc, e.g. "direct,dock"). Unknown words are ignored; nothing valid means both.
 */
export function parseProfiles(raw: string | null | undefined): ApcProfile[] {
  const words = (raw ?? "").split(",").map((w) => w.trim().toLowerCase());
  const found = PROFILES.filter((p) => words.includes(p));
  return found.length ? found : [...PROFILES];
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface NewGrant {
  /** The app's id for the grant: what pins and the agent bar name. Not secret. */
  id: string;
  /** 128 random bits, the last segment of the MCP URL: whoever holds the URL holds the grant. */
  secret: string;
  created_at: string;
}

/** A new grant for one agent: one per agent, so each agent's pin, name and access are its own. */
export function newDirectGrant(now = new Date()): NewGrant {
  return { id: `g_${randomHex(4)}`, secret: randomHex(16), created_at: now.toISOString() };
}

/** The agent's MCP URL: the app's origin, the person's sandbox and the grant's secret. */
export function directMcpUrl(origin: string, sid: string, secret: string): string {
  return `${origin}/mcp/${sid}/${secret}`;
}

export const AGENT_NAME_MAX = 40;

/** A name for an agent, from the person or the agent itself: plain text, one line, at most 40 characters. Null when nothing is left. */
export function cleanAgentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = [...raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, AGENT_NAME_MAX).join("").trim();
  return name || null;
}

/** What a connection says about itself in `initialize`. */
export interface ArrivingClient {
  /** `clientInfo.name`: the MCP client (a dock's hub says "apc-hub"). */
  name: string | null;
  title: string | null;
  version: string | null;
  icons: unknown;
  protocolVersion: string | null;
  /** On the Dock path, the agent's own MCP client as its hub names it (`_meta[APC_AGENT_CLIENT_META]`). */
  agentClient: string | null;
}

const short = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** The `initialize` in a request body (one message or a batch), or null when it carries none. */
export function initializeOf(body: unknown): ArrivingClient | null {
  for (const m of (Array.isArray(body) ? body : [body]) as Array<{ method?: unknown; params?: Record<string, unknown> } | null>) {
    if (!m || m.method !== "initialize") continue;
    const params = m.params ?? {};
    const info = (params.clientInfo ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    return {
      name: short(info.name, 100),
      title: short(info.title, 200),
      version: short(info.version, 40),
      icons: info.icons,
      protocolVersion: short(params.protocolVersion, 20),
      agentClient: short(meta[APC_AGENT_CLIENT_META], 100),
    };
  }
  return null;
}

/**
 * The MCP client an arriving connection is, for `apc_link`: its own `clientInfo.name` on the Direct
 * path; on the Dock path the agent's client as the hub names it (the hub's own name says nothing).
 */
export function linkClient(client: ArrivingClient, path: ApcProfile): string | null {
  return path === "direct" ? client.name : client.agentClient;
}
