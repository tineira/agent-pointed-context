/**
 * Which icon an agent gets, from the client name it declared in initialize (TIN-350).
 * A curated logo first; then the raster icon the client sent in clientInfo.icons; then a bot
 * glyph colored from the name. Brands without an official logo in the repo yet show a monogram.
 */
import { PATHS } from "./agent-logos.ts";

export interface Logo {
  path: string;
  viewBox: string;
  /** A fixed brand color, or null to follow the text color (monochrome marks: black on light, white on dark). */
  color: string | null;
}

export interface Brand {
  id: string;
  name: string;
  match: RegExp;
  /** The official mark, or a monogram until one is added. */
  logo: Logo | { monogram: string; color: string | null };
}

const mono = (path: string, viewBox = "0 0 24 24"): Logo => ({ path, viewBox, color: null });

/**
 * Order matters: the first match wins, so the Grok bot comes before Grok.
 * Names seen so far (Analytics Engine, TIN-347): Grok sends connectors-manager and grok-validator.
 * The others are the names those clients are known to send, or the product name; an unmatched
 * name falls back to the bot until it is added here.
 */
export const BRANDS: Brand[] = [
  { id: "grok-bot", name: "Grok bot", match: /grok-validator/i, logo: { monogram: "GB", color: null } },
  { id: "grok", name: "Grok", match: /grok|xai|^connectors-manager$/i, logo: { monogram: "G", color: null } },
  { id: "claude", name: "Claude", match: /claude|anthropic/i, logo: { path: PATHS.claude, viewBox: "0 0 24 24", color: "#D97757" } },
  { id: "openai", name: "ChatGPT", match: /openai|chatgpt|codex/i, logo: mono(PATHS.openai, "180 180 356 356") },
  { id: "antigravity", name: "Antigravity", match: /antigravity|^agy\b/i, logo: { monogram: "A", color: null } },
  { id: "gemini", name: "Gemini", match: /gemini/i, logo: { path: PATHS.gemini, viewBox: "0 0 24 24", color: "#8E75B2" } },
  { id: "cursor", name: "Cursor", match: /cursor/i, logo: mono(PATHS.cursor) },
  { id: "kimi", name: "Kimi", match: /kimi|moonshot/i, logo: mono(PATHS.kimi) },
  { id: "zai", name: "Z.ai", match: /z\.ai|zhipu|\bglm\b/i, logo: mono(PATHS.zai) },
  { id: "dots", name: "dots", match: /^dots\b/i, logo: { monogram: "•••", color: null } },
];

export function brandFor(clientName: string | null | undefined): Brand | null {
  if (!clientName) return null;
  return BRANDS.find((b) => b.match.test(clientName)) ?? null;
}

/** A stable hue per client name, for the bot of an unknown client. */
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360} 65% 50%)`;
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
