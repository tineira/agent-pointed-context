/**
 * The hero's one agent (TIN-1070, design TIN-1063 § 4 rule 3, with Tomas's one-click decision of 2026-11-21): the hero
 * makes its own unrestricted Direct grant when it opens, and only one per sandbox.
 *
 * - It remembers the grant's id in Pulse's localStorage, per sandbox (`apc:embed-hero-grant:<sid>`), and reuses it only
 *   while it still qualifies: in the sandbox's grants, unrestricted (`regions === null`), not a dock's.
 * - One make at a time: callers on the page share one promise (React StrictMode, a remount), and Pulse's tabs take
 *   turns under a Web Lock, each looking again at what is remembered once it holds it.
 * - It never shows another grant's secret: not the sandbox's first agent, not a restricted one, not one made on the
 *   Agents page.
 */
import type { GrantState, SandboxState } from "./api.ts";

export const EMBED_GRANT_LOCK = "apc-pulse-embed-grant";
export const embedGrantKey = (sid: string): string => `apc:embed-hero-grant:${sid}`;

/** The remembered grant, if it still qualifies; null otherwise. A dock grant's secret is empty in the state, so it never shows. */
export function qualifyingGrant(state: SandboxState, id: string | null): GrantState | null {
  if (!id) return null;
  const grant = state.grants.find((g) => g.id === id);
  if (!grant || grant.regions !== null || !grant.secret) return null;
  if ((state.hub_links ?? []).some((l) => l.grant_id === id)) return null;
  return grant;
}

export type EmbedGrantError = "too_many" | "rate_limited" | "failed";
export type EmbedGrantResult = { ok: true; grantId: string; made: boolean } | { ok: false; error: EmbedGrantError };

/** What making the grant needs; the page passes the real ones, a test fakes them. */
export interface EmbedGrantDeps {
  state(): Promise<SandboxState>;
  mint(): Promise<{ status: number; json: { id?: string; ok?: boolean; error?: string } | null }>;
  storage: { get(key: string): string | null; set(key: string, value: string): void };
  locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
}

const inFlight = new Map<string, Promise<EmbedGrantResult>>();

/** The hero's grant for this sandbox: the remembered one, else a new one. Shared by concurrent callers. */
export function ensureEmbedGrant(sid: string, deps: EmbedGrantDeps): Promise<EmbedGrantResult> {
  let run = inFlight.get(sid);
  if (!run) {
    const once = () => resolveGrant(sid, deps);
    run = (deps.locks ? deps.locks.request(EMBED_GRANT_LOCK, once) : once()).catch((): EmbedGrantResult => ({ ok: false, error: "failed" })).finally(() => inFlight.delete(sid));
    inFlight.set(sid, run);
  }
  return run;
}

async function resolveGrant(sid: string, deps: EmbedGrantDeps): Promise<EmbedGrantResult> {
  const key = embedGrantKey(sid);
  const remembered = deps.storage.get(key);
  if (remembered && qualifyingGrant(await deps.state(), remembered)) return { ok: true, grantId: remembered, made: false };
  const answer = await deps.mint();
  if (answer.status === 429) return { ok: false, error: "rate_limited" };
  if (answer.status === 400 && answer.json?.error === "too_many") return { ok: false, error: "too_many" };
  const id = answer.json?.id;
  if (answer.status !== 200 || typeof id !== "string") return { ok: false, error: "failed" };
  deps.storage.set(key, id);
  return { ok: true, grantId: id, made: true };
}

/** Web Locks, where the browser has them, in the shape ensureEmbedGrant takes. */
export function browserLocks(): EmbedGrantDeps["locks"] {
  const locks = (globalThis as { navigator?: { locks?: { request<T>(name: string, cb: () => Promise<T>): Promise<T> } } }).navigator?.locks;
  return locks ? { request: (name, callback) => locks.request(name, callback) } : undefined;
}

/** Pulse-origin localStorage, which can throw (blocked storage): a failed read is nothing remembered, a failed write is skipped. */
export const browserStorage: EmbedGrantDeps["storage"] = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not remembered: the next open makes another grant, which the cap bounds
    }
  },
};

/** A second product on the hero's address, while it still uses it (Pulse's rule, TIN-358: an hour after its last call). */
export function activeConflict(g: GrantState, now = Date.now()): GrantState["conflict"] {
  const at = Date.parse(g.conflict?.at ?? "");
  return g.conflict && at && now - at < 60 * 60_000 ? g.conflict : null;
}
