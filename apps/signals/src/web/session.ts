/** The Web Locks API where the browser has it (every current one, on https and localhost). */
type Locks = { request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> };
const locks = (): Locks | undefined => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;

/**
 * How long an open may take (the most a tab holds the lock), and the most a tab waits for another
 * tab's open before it gives up and shows its error. Tests shorten them.
 */
export const sessionLimits = { openMs: 10_000, waitMs: 15_000 };

let inFlight: Promise<string> | null = null;

/**
 * Resume the visitor's feed or open one, and resolve its id. Every feed shows the demo's one world (TIN-621).
 *
 * One open at a time (TIN-490): concurrent callers on this page (React StrictMode's second effect, a
 * remount) share one request, and Signals' pages in other tabs wait for it under a Web Lock, so theirs
 * carries the cookie it set and resumes that feed instead of opening a second one whose id the cookie
 * would not name (every later call a 403). An open settles within `openMs` whatever its request does,
 * so the lock is never held longer; a browser without Web Locks only shares within the page.
 */
export function openSession(): Promise<string> {
  if (!inFlight) {
    const lock = locks();
    const open = lock ? lock.request("apc-signals-session", { signal: AbortSignal.timeout(sessionLimits.waitMs) }, bounded) : bounded();
    inFlight = open.finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** resumeOrOpen, settled by `openMs` at the latest (a request that ignores its abort included). */
function bounded(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("/api/session: timed out")), sessionLimits.openMs);
  });
  return Promise.race([resumeOrOpen(), late]).finally(() => clearTimeout(timer));
}

async function resumeOrOpen(): Promise<string> {
  const body = {};
  const response = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(sessionLimits.openMs) });
  if (!response.ok && response.status !== 400) throw new Error(`/api/session: ${response.status}`);
  const result = (await response.json()) as { sid?: string; error?: string };
  if (!result.sid) throw new Error(result.error ?? "error");
  return result.sid;
}
