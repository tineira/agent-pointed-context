/**
 * Which icon an agent gets, from the client name it declared in initialize (TIN-350).
 * A curated logo first; then the raster icon the client sent in clientInfo.icons; then a bot
 * glyph colored from the name.
 */
import { PRODUCTS, type ProductId } from "../model/products.ts";
import { ANTIGRAVITY_PNG, DUET_PARTS, GROK_BOTS, PATHS } from "./agent-logos.ts";

export interface Logo {
  viewBox: string;
  /** Each part's fill is a brand color, or null to follow the text color (monochrome marks: black on light, white on dark). */
  parts: ReadonlyArray<{ d: string; fill: string | null; evenodd?: boolean }>;
}

export interface Brand {
  id: string;
  name: string;
  match: RegExp;
  /** A vector mark, one raster image, or a set of images of which each agent gets one (pickImage). */
  logo: Logo | { image: string } | { images: ReadonlyArray<{ name: string; src: string }> };
}

const mark = (d: string, viewBox: string, fill: string | null = null): Logo => ({ viewBox, parts: [{ d, fill }] });

const LOGOS: Record<ProductId, Brand["logo"]> = {
  "grok-bot": { images: GROK_BOTS },
  grok: mark(PATHS.grok, "0 0 1024 1024"),
  "claude-duet": { viewBox: "138 138 1024 1024", parts: DUET_PARTS },
  claude: mark(PATHS.claude, "0 0 24 24", "#D97757"),
  openai: mark(PATHS.openai, "180 180 356 356"),
  antigravity: { image: ANTIGRAVITY_PNG },
  gemini: mark(PATHS.gemini, "0 0 24 24", "#8E75B2"),
  cursor: mark(PATHS.cursor, "0 0 24 24"),
  kimi: mark(PATHS.kimi, "0 0 24 24"),
  zai: mark(PATHS.zai, "0 0 24 24"),
};

/** Each product (model/products.ts, which says how clients are matched) with its logo. */
export const BRANDS: Brand[] = PRODUCTS.map((p) => ({ ...p, logo: LOGOS[p.id] }));

export function brandFor(clientName: string | null | undefined): Brand | null {
  if (!clientName) return null;
  return BRANDS.find((b) => b.match.test(clientName)) ?? null;
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

/** A stable hue per client name, for the bot of an unknown client. */
export function colorFor(name: string): string {
  return `hsl(${hash(name) % 360} 65% 50%)`;
}

/** One image of a set, fixed per agent (its grant id), so two Grok bots on one page look different. */
export function pickImage<T>(images: ReadonlyArray<T>, seed: string): T {
  return images[hash(seed) % images.length]!;
}

export type AgentMotion = "off" | "idle" | "waiting" | "busy" | "seen";

/** What the icon does, from what the page knows about the agent. Order: off, seen, waiting, busy, idle. */
export function motionFor(a: { connected: boolean; waiting: boolean; busy: boolean; seenAt: number | undefined; now: number }): AgentMotion {
  if (!a.connected) return "off";
  if (a.seenAt !== undefined && a.now - a.seenAt < 1200) return "seen";
  if (a.waiting) return "waiting";
  if (a.busy) return "busy";
  return "idle";
}

/** What a grant needs for its displayed name. */
export interface Nameable {
  id: string;
  label: string;
  client_name: string | null;
  client_title?: string | null;
  agent_name?: string | null;
  owner_name?: string | null;
  regions: readonly string[] | null;
}

/**
 * The name the page shows for an agent (TIN-356). The person's name wins, then the name the agent
 * gave itself (set_agent_name), then the client's title from initialize, then the client's product
 * (the brand that picks its logo, or its own client name), numbered when two agents share it
 * ("Claude", "Claude 2"). Before it connects, an agent keeps its label ("Your agent", "Agent 2").
 * A restricted agent keeps saying so, whatever its name.
 */
export function displayNames(grants: readonly Nameable[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const g of grants) {
    let name = g.owner_name || g.agent_name || g.client_title || null;
    if (!name && g.client_name) {
      const base = brandFor(g.client_name)?.name ?? g.client_name;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      name = n === 1 ? base : `${base} ${n}`;
    }
    if (!name) {
      out.set(g.id, g.label);
      continue;
    }
    out.set(g.id, g.regions ? `${name} (${g.regions.map((r) => r.toUpperCase()).join(", ")} only)` : name);
  }
  return out;
}
