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
 */
export const PRODUCTS = [
  { id: "grok-bot", name: "Grok bot", match: /^Cursor$/ },
  { id: "grok", name: "Grok", match: /grok|xai|^connectors-manager$/i },
  { id: "claude-duet", name: "Claude Duet", match: /duet/i },
  { id: "claude", name: "Claude", match: /claude|anthropic/i },
  // dots has no mark of its own here yet: it counts as OpenAI's.
  { id: "openai", name: "ChatGPT", match: /openai|chatgpt|codex|^dots\b/i },
  { id: "antigravity", name: "Antigravity", match: /antigravity|^agy\b/i },
  { id: "gemini", name: "Gemini", match: /gemini/i },
  { id: "cursor", name: "Cursor", match: /cursor/i },
  { id: "kimi", name: "Kimi", match: /kimi|moonshot/i },
  { id: "zai", name: "Z.ai", match: /z\.ai|zhipu|\bglm\b/i },
] as const;

export type ProductId = (typeof PRODUCTS)[number]["id"];

export function productOf(clientName: string | null | undefined): (typeof PRODUCTS)[number] | null {
  if (!clientName) return null;
  return PRODUCTS.find((p) => p.match.test(clientName)) ?? null;
}

/** Two client names are the same product when they match the same entry, or are the same name. */
export function sameProduct(a: string, b: string): boolean {
  const pa = productOf(a);
  const pb = productOf(b);
  return pa || pb ? pa?.id === pb?.id : a === b;
}

/** A product's name for people: its brand, or the client's own name. */
export const productName = (clientName: string) => productOf(clientName)?.name ?? clientName;
