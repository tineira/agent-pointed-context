/**
 * The hero's one agent (TIN-1070, design TIN-1063 § 4 rule 3, with Tomas's one-click decision of 2026-11-21): the hero
 * gets its own unrestricted Direct grant when it opens, and only one per sandbox.
 *
 * - **The sandbox decides, idempotently** (`POST /api/s/:sid/grants/embed`, Sandbox.ensureEmbedGrant): it makes the
 *   sandbox's one hero grant on the first call and returns that same grant on every later one, while it still qualifies
 *   (unrestricted, Direct, not a dock's). So an answer lost on the way, a reload, a second tab or blocked storage never
 *   makes a second grant: nothing on the page has to remember it.
 * - Callers on one page share one call (React StrictMode, a remount): one request, not two.
 * - It never shows another grant's secret: not the sandbox's first agent, not a restricted one, not one made on the
 *   Agents page. The page shows only the grant this call returned, found again in the state by its id.
 */
import type { GrantState, SandboxState } from "./api.ts";

/** The hero's grant as the state lists it, if it still qualifies; null otherwise (revoked, restricted, a dock's, no secret). */
export function qualifyingGrant(state: SandboxState, id: string | null): GrantState | null {
  if (!id) return null;
  const grant = state.grants.find((g) => g.id === id);
  if (!grant || grant.regions !== null || !grant.secret) return null;
  if ((state.hub_links ?? []).some((l) => l.grant_id === id)) return null;
  return grant;
}

export type EmbedGrantError = "too_many" | "rate_limited" | "failed";
export type EmbedGrantResult = { ok: true; grantId: string; made: boolean } | { ok: false; error: EmbedGrantError };

/** The sandbox's answer to `POST /grants/embed`, as the page reads it (a test fakes it). */
export type EmbedMint = () => Promise<{ status: number; json: { id?: string; made?: boolean; ok?: boolean; error?: string } | null }>;

const inFlight = new Map<string, Promise<EmbedGrantResult>>();

/** The hero's grant for this sandbox, from the sandbox (made once, then the same one). Shared by concurrent callers. */
export function ensureEmbedGrant(sid: string, mint: EmbedMint): Promise<EmbedGrantResult> {
  let run = inFlight.get(sid);
  if (!run) {
    run = ask(mint).catch((): EmbedGrantResult => ({ ok: false, error: "failed" })).finally(() => inFlight.delete(sid));
    inFlight.set(sid, run);
  }
  return run;
}

async function ask(mint: EmbedMint): Promise<EmbedGrantResult> {
  const answer = await mint();
  if (answer.status === 429) return { ok: false, error: "rate_limited" };
  if (answer.status === 400 && answer.json?.error === "too_many") return { ok: false, error: "too_many" };
  const id = answer.json?.id;
  if (answer.status !== 200 || typeof id !== "string") return { ok: false, error: "failed" };
  return { ok: true, grantId: id, made: answer.json?.made === true };
}

/** A second product on the hero's address, while it still uses it (Pulse's rule, TIN-358: an hour after its last call). */
export function activeConflict(g: GrantState, now = Date.now()): GrantState["conflict"] {
  const at = Date.parse(g.conflict?.at ?? "");
  return g.conflict && at && now - at < 60 * 60_000 ? g.conflict : null;
}
