/**
 * Which icon an agent gets, from the client name it declared in initialize (TIN-350).
 * A curated logo first; then the raster icon the client sent in clientInfo.icons; then a bot
 * glyph colored from the name.
 */
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

/**
 * Order matters: the first match wins (Claude Duet before Claude).
 * Names seen so far (Analytics Engine, TIN-347): Grok's connector sends grok-validator to check the
 * URL, then connectors-manager for every call, so both are the Grok bot; the Grok mark is for any
 * other Grok client. The other patterns are the names those clients are known to send, or the
 * product name; an unmatched name falls back to the bot until it is added here.
 */
export const BRANDS: Brand[] = [
  { id: "grok-bot", name: "Grok bot", match: /grok-validator|^connectors-manager$/i, logo: { images: GROK_BOTS } },
  { id: "grok", name: "Grok", match: /grok|xai/i, logo: mark(PATHS.grok, "0 0 1024 1024") },
  { id: "claude-duet", name: "Claude Duet", match: /duet/i, logo: { viewBox: "138 138 1024 1024", parts: DUET_PARTS } },
  { id: "claude", name: "Claude", match: /claude|anthropic/i, logo: mark(PATHS.claude, "0 0 24 24", "#D97757") },
  // dots has no mark of its own here yet: it shows OpenAI's.
  { id: "openai", name: "ChatGPT", match: /openai|chatgpt|codex|^dots\b/i, logo: mark(PATHS.openai, "180 180 356 356") },
  { id: "antigravity", name: "Antigravity", match: /antigravity|^agy\b/i, logo: { image: ANTIGRAVITY_PNG } },
  { id: "gemini", name: "Gemini", match: /gemini/i, logo: mark(PATHS.gemini, "0 0 24 24", "#8E75B2") },
  { id: "cursor", name: "Cursor", match: /cursor/i, logo: mark(PATHS.cursor, "0 0 24 24") },
  { id: "kimi", name: "Kimi", match: /kimi|moonshot/i, logo: mark(PATHS.kimi, "0 0 24 24") },
  { id: "zai", name: "Z.ai", match: /z\.ai|zhipu|\bglm\b/i, logo: mark(PATHS.zai, "0 0 24 24") },
];

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
