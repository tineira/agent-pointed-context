/**
 * Which logo an agent wears (TIN-878): the brand of the client name it declared on `initialize`
 * (`clientInfo.name`), or, for a client that names itself generically, of its user agent. A vector mark
 * or one PNG; an unknown client gets a neutral mark in a colour of its own. Brands only: no vendor
 * mascot is drawn or animated (TIN-388). A logo says which agent is connected, never that it is verified.
 */
import { ANTIGRAVITY_PNG, BRAND_PATHS, GEMINI_PNG } from "./brand-logos.ts";

/** A logo: vector parts in a viewBox (a part with no fill is drawn in ink on the badge's white disc), or one image. */
export type ApcLogo = { viewBox: string; parts: ReadonlyArray<{ d: string; fill: string | null; evenodd?: boolean }> } | { image: string };

/** What a pet's badge shows: a logo, or the neutral mark in a colour (an agent with no logo). */
export type PetBadge = ApcLogo | { color: string };

export interface ApcBrand {
  id: string;
  /** The product's name for people. */
  name: string;
  match: RegExp;
  /** Also matched on the client's user agent, for a client that names itself generically. */
  ua?: RegExp;
  logo: ApcLogo;
}

const mark = (d: string, viewBox: string, fill: string | null = null): ApcLogo => ({ viewBox, parts: [{ d, fill }] });

/** Order matters: the first match wins. */
export const APC_BRANDS: readonly ApcBrand[] = [
  { id: "grok", name: "Grok", match: /grok|xai|^connectors-manager$/i, logo: mark(BRAND_PATHS.grok, "0 0 1024 1024") },
  { id: "claude", name: "Claude", match: /claude|anthropic/i, logo: mark(BRAND_PATHS.claude, "0 0 24 24", "#D97757") },
  { id: "openai", name: "ChatGPT", match: /openai|chatgpt|codex|^dots\b/i, logo: mark(BRAND_PATHS.openai, "180 180 356 356") },
  { id: "antigravity", name: "Antigravity", match: /antigravity|^agy\b/i, logo: { image: ANTIGRAVITY_PNG } },
  { id: "gemini", name: "Gemini", match: /gemini/i, ua: /^Google\b/, logo: { image: GEMINI_PNG } },
  { id: "cursor", name: "Cursor", match: /cursor/i, logo: mark(BRAND_PATHS.cursor, "0 0 24 24") },
  { id: "kimi", name: "Kimi", match: /kimi|moonshot/i, logo: mark(BRAND_PATHS.kimi, "0 0 24 24") },
  { id: "zai", name: "Z.ai", match: /z\.ai|zhipu|\bglm\b|\bz[- ]?code\b/i, logo: mark(BRAND_PATHS.zai, "0 0 24 24") },
];

/** The brand of a client: by its name first, then by its user agent. Null for an unknown client. */
export function brandFor(clientName: string | null | undefined, userAgent?: string | null): ApcBrand | null {
  const byName = clientName ? APC_BRANDS.find((b) => b.match.test(clientName)) : undefined;
  if (byName) return byName;
  return (userAgent && APC_BRANDS.find((b) => b.ua?.test(userAgent))) || null;
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

/** A stable colour per agent (its client name, or its grant id): the neutral mark of an agent with no logo. */
export function colorFor(key: string): string {
  return `hsl(${hash(key) % 360} 55% 45%)`;
}

/**
 * An agent's badge: its brand's logo, else the image it sent or the app has (`icon`), else the neutral
 * mark in its own colour (`key`: the client name, or the grant id when there is none).
 */
export function agentBadge(agent: { clientName?: string | null; userAgent?: string | null; icon?: string | null; key: string }): PetBadge {
  const brand = brandFor(agent.clientName, agent.userAgent);
  if (brand) return brand.logo;
  if (agent.icon) return { image: agent.icon };
  return { color: colorFor(agent.clientName || agent.key) };
}
