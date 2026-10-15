import type { PresenceEvent } from "@apc/protocol";

export const IDLE_AFTER_MS = 2 * 60_000;
export const GONE_AFTER_MS = 5 * 60_000;
export const FLASH_MS = 4000;

/**
 * Typeset initials from a self-declared client name: two words give their first
 * letters, one word its first two; a collision gets a digit. No logos: the name
 * is not verified, and a logo would claim it was.
 */
export function initials(name: string, taken: ReadonlySet<string> = new Set()): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "AG";
  const base = (words.length >= 2 ? `${first[0]}${words[1]![0]}` : first.slice(0, 2)).toUpperCase().padEnd(2, "X");
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10; n++) {
    const candidate = `${base[0]}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export type MarkState = "active" | "idle" | "gone";

export function markState(lastActiveAt: string | null, now: number = Date.now()): MarkState {
  if (!lastActiveAt) return "gone";
  const quiet = now - Date.parse(lastActiveAt);
  if (quiet >= GONE_AFTER_MS) return "gone";
  return quiet >= IDLE_AFTER_MS ? "idle" : "active";
}

/**
 * Show an agent's initials on each element its call named, for four seconds:
 * data-apc-presence is "read" (dotted) or "write" (solid). Returns how many
 * elements on the page were touched.
 */
export function flashTargets(event: PresenceEvent, agentInitials: string, root: ParentNode = document): number {
  let touched = 0;
  for (const target of event.targets) {
    const selector = `[data-focus="${CSS.escape(target.kind)}:${CSS.escape(target.id)}"]`;
    for (const element of root.querySelectorAll(selector)) {
      element.setAttribute("data-apc-presence", event.kind);
      element.setAttribute("data-apc-agent", agentInitials);
      touched++;
      window.setTimeout(() => {
        element.removeAttribute("data-apc-presence");
        element.removeAttribute("data-apc-agent");
      }, FLASH_MS);
    }
  }
  return touched;
}
