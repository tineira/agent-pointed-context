/**
 * Agent names (TIN-356). A name comes from the person (owner_name), from the agent itself
 * (set_agent_name, agent_name) or from the client's initialize (clientInfo.title, client_title).
 * Every one is cleaned the same way before it is stored: plain text, one line, at most 40 characters.
 * The page renders names as text only.
 */
export const NAME_MAX = 40;

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = [...raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim();
  return name || null;
}
