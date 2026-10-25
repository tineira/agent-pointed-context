/**
 * The attention hub's pure parts (TIN-382, DESIGN.md section 12): naming apps, rewriting an app's
 * focus so the agent reads it through the hub, and taking an app's own loop keys off its results.
 * No Workers APIs here, so the tests run it.
 */
import type { FocusPayload } from "@apc/protocol";

/** Where a focus or a view came from. */
export interface AppRef {
  id: string;
  name: string;
  origin: string;
}

/** The focus as the hub hands it to the agent: the app's, plus where it came from, read with call_app_tool. */
export interface HubFocus extends FocusPayload {
  app: AppRef;
}

/** The two APC tools the hub runs itself; an app's own are never relayed. */
export const HIDDEN_TOOLS = new Set(["get_current_view", "wait_for_focus"]);

/** An app's id within one agent's apps: [a-z0-9]{1,16} from its name, with a number on a collision ("pulse", "pulse2"). */
export function appIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "app";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** The app's focus, its next call rewritten to go through the hub. */
export function hubFocus(focus: FocusPayload, app: AppRef): HubFocus {
  return { ...focus, app, next: "call_app_tool", next_args: { app: app.id, tool: focus.next, args: focus.next_args } };
}

/** The newest of several foci (one per app): an agent has one mark, so the latest pin wins. */
export function newest<T extends { pinned_at: string }>(foci: Array<T | null | undefined>): T | null {
  let best: T | null = null;
  for (const f of foci) if (f && (!best || f.pinned_at > best.pinned_at)) best = f;
  return best;
}

/**
 * Take keys off a relayed result: the app's attention and then point at tools the agent cannot see.
 * Works on the structured result and on a first text block holding the same JSON.
 */
export function detachKeys<R extends { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }>(result: R, keys: readonly string[]): { result: R; had: Set<string> } {
  const had = new Set<string>();
  const drop = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (keys.includes(k)) had.add(k);
      else out[k] = v;
    }
    return out;
  };
  const structuredContent = result.structuredContent ? drop(result.structuredContent) : undefined;
  const content = result.content?.map((block, i) => {
    if (i !== 0 || block.type !== "text" || typeof block.text !== "string") return block;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...block, text: JSON.stringify(drop(parsed as Record<string, unknown>)) };
    } catch {
      // not JSON: leave it
    }
    return block;
  });
  return { result: { ...result, ...(content ? { content } : {}), ...(structuredContent ? { structuredContent } : {}) }, had };
}

/** Whether the person is on any paired app's page: true if one is, null if none says, false otherwise. */
export function combineAttendance(values: Array<boolean | null>): boolean | null {
  if (values.some((v) => v === true)) return true;
  if (values.every((v) => v === null)) return null;
  return false;
}

/** A focus in words, for the dock: "pulse: active_customers 2026-03" or "pulse: cus_0042 seats". */
export function focusLabel(f: { kind: string; id: string | null; part: string | null; params: Record<string, unknown> | null }): string {
  if (f.id) return [f.id, f.part].filter(Boolean).join(" ");
  const p = f.params ?? {};
  return [p.key, p.month, p.plan, p.region, f.part].filter((v) => v !== undefined && v !== null && v !== "").join(" ") || f.kind;
}

/** An app's origin the hub may pair with, and an MCP URL on that same origin. */
export function appAllowed(origin: string, mcpUrl: string, allowed: readonly string[], dev: boolean): boolean {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password) return false;
  return allowed.includes(origin) || (dev && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
}
