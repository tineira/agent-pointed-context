/**
 * The agent `?connect` arrives with (TIN-1093, with Tomas's one-click choice, as Pulse's hero, TIN-1070): a visitor who
 * came to connect finds the agent already made, its MCP address shown, with no extra "Connect an agent" click.
 *
 * - **The feed decides, idempotently** (`POST /api/s/:sid/grants/connect`, Feed.ensureConnectGrant): it makes the feed's
 *   one connect grant on the first call and returns that same grant on every later one while it qualifies (Direct, not
 *   linked to a dock grant). So a reload, a second tab or an answer lost on the way never makes a second grant, and the
 *   page remembers nothing.
 * - **Once per page load.** Callers on one page (React StrictMode, a remount) share one call, and a page that asked once
 *   never asks again: a grant the person revokes on this page is not made again until the next `?connect` visit.
 * - **Only for `?connect` or `#connect`.** A plain visit makes nothing.
 */

/** True when the visitor came to connect: `?connect` in the query, or `#connect`. */
export function cameToConnect(search: string, hash: string): boolean {
  return new URLSearchParams(search).has("connect") || hash === "#connect";
}

export type ConnectGrantError = "too_many" | "rate_limited" | "dock_only" | "failed";
export type ConnectGrantResult = { ok: true; grantId: string; made: boolean } | { ok: false; error: ConnectGrantError };

/** The feed's answer to `POST /grants/connect`, as the page reads it (a test fakes it). */
export type ConnectMint = () => Promise<{ status: number; json: { ok?: boolean; grant_id?: string; made?: boolean; error?: string } | null }>;

const asked = new Map<string, Promise<ConnectGrantResult>>();

/** The connect grant for this feed: one call per page load, shared by every caller on the page. */
export function ensureConnectGrant(sid: string, mint: ConnectMint): Promise<ConnectGrantResult> {
  let run = asked.get(sid);
  if (!run) {
    run = ask(mint).catch((): ConnectGrantResult => ({ ok: false, error: "failed" }));
    asked.set(sid, run);
  }
  return run;
}

async function ask(mint: ConnectMint): Promise<ConnectGrantResult> {
  const answer = await mint();
  if (answer.status === 429) return { ok: false, error: "rate_limited" };
  const error = answer.json?.error;
  if (answer.status === 400 && (error === "too_many" || error === "dock_only")) return { ok: false, error };
  const id = answer.json?.grant_id;
  if (answer.status !== 200 || answer.json?.ok !== true || typeof id !== "string") return { ok: false, error: "failed" };
  return { ok: true, grantId: id, made: answer.json?.made === true };
}

/** The real call, as the page sends it: same origin, JSON, the owner's cookie. */
export const connectMint =
  (base: string): ConnectMint =>
  async () => {
    const response = await fetch(`${base}/grants/connect`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
    return { status: response.status, json: (await response.json().catch(() => null)) as Awaited<ReturnType<ConnectMint>>["json"] };
  };
