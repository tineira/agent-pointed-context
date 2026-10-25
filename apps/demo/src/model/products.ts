/**
 * Which product an MCP client is, from the name it declares in initialize. Shared by the page (the
 * logo and the default name, web/agent-brands.ts) and the sandbox (one URL, one product: TIN-358),
 * so it carries no logos.
 *
 * Order matters: the first match wins (the Grok bot before Cursor, Claude Duet before Claude).
 * Names seen in Analytics Engine (TIN-347), 2026-10-24: grok.com sends grok-validator to check the
 * URL, then connectors-manager for every call (user agent grok-connectors-manager); the Grok bot
 * sends exactly "Cursor" 1.0.0 (user agent Cursor/1.0.0); Cursor's editor sends cursor-vscode (user
 * agent Cursor/3.27.6 (win32 x64)). The other patterns are the names those clients are known to
 * send, or the product name; an unmatched name is its own product.
 *
 * Some clients name themselves generically, so a product may also match on the client's user agent
 * (TIN-364): Gemini sends "mcp" 0.1.0 on every call and "Gemini" 1.0.0 once, both with user agent
 * "Google".
 */
export const PRODUCTS = [
  { id: "grok-bot", name: "Grok bot", match: /^Cursor$/ },
  { id: "grok", name: "Grok", match: /grok|xai|^connectors-manager$/i },
  { id: "claude-duet", name: "Claude Duet", match: /duet/i },
  { id: "claude", name: "Claude", match: /claude|anthropic/i },
  // dots has no mark of its own here yet: it counts as OpenAI's.
  { id: "openai", name: "ChatGPT", match: /openai|chatgpt|codex|^dots\b/i },
  { id: "antigravity", name: "Antigravity", match: /antigravity|^agy\b/i },
  { id: "gemini", name: "Gemini", match: /gemini/i, ua: /^Google\b/ },
  { id: "cursor", name: "Cursor", match: /cursor/i },
  { id: "kimi", name: "Kimi", match: /kimi|moonshot/i },
  // ZCode, Z.ai's coding agent, names itself zcode (TIN-415).
  { id: "zai", name: "Z.ai", match: /z\.ai|zhipu|\bglm\b|\bz[- ]?code\b/i },
] as const satisfies ReadonlyArray<{ id: string; name: string; match: RegExp; ua?: RegExp }>;

export type ProductId = (typeof PRODUCTS)[number]["id"];

type Product = (typeof PRODUCTS)[number];

/** The product a client is: by its name first, then by its user agent. */
export function productOf(clientName: string | null | undefined, userAgent?: string | null): Product | null {
  if (!clientName && !userAgent) return null;
  const byName = clientName ? PRODUCTS.find((p) => p.match.test(clientName)) : undefined;
  if (byName) return byName;
  return (userAgent && PRODUCTS.find((p) => "ua" in p && p.ua.test(userAgent))) || null;
}

/** Two clients are the same product when they match the same entry, or have the same name. */
export function sameProduct(a: string, aUa: string | null | undefined, b: string, bUa: string | null | undefined): boolean {
  // The same name is the same client, even when one side's user agent is unknown (grants from before TIN-364).
  if (a === b) return true;
  const pa = productOf(a, aUa);
  const pb = productOf(b, bUa);
  return pa || pb ? pa?.id === pb?.id : a === b;
}

/** A product's name for people: its brand, or the client's own name. */
export const productName = (clientName: string, userAgent?: string | null) => productOf(clientName, userAgent)?.name ?? clientName;
