/** The Web Locks API where the browser has it (every current one, on https and localhost). */
type Locks = { request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> };
const locks = (): Locks | undefined => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;

/**
 * How long an open may take: one request, all its attempts (the most a tab holds the lock), and the
 * most a tab waits for another tab's open before it gives up and shows its error. Tests shorten them.
 */
export const sessionLimits = { requestMs: 10_000, openMs: 20_000, waitMs: 25_000 };

let inFlight: Promise<string> | null = null;

/**
 * Resume or open the visitor's sandbox. Opening one is retried: a new sandbox can fail to start once.
 *
 * One open at a time (TIN-490): concurrent callers on this page (React StrictMode's second effect, a
 * remount) share one request, and Pulse's pages in other tabs wait for it under a Web Lock, so theirs
 * carries the cookie it set and resumes that sandbox instead of opening a second one whose id the
 * cookie would not name (every later call a 403). An open settles within `openMs` whatever its
 * requests do, so the lock is never held longer; a browser without Web Locks only shares within the page.
 */
export function openSession(): Promise<string> {
  if (!inFlight) {
    const lock = locks();
    const open = lock ? lock.request("apc-pulse-session", { signal: AbortSignal.timeout(sessionLimits.waitMs) }, bounded) : bounded();
    inFlight = open.finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** resumeOrOpen, settled by `openMs` at the latest (a request that ignores its abort included). */
function bounded(): Promise<string> {
  const deadline = Date.now() + sessionLimits.openMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("/api/session: timed out")), sessionLimits.openMs);
  });
  return Promise.race([resumeOrOpen(deadline), late]).finally(() => clearTimeout(timer));
}

async function resumeOrOpen(deadline: number): Promise<string> {
  // A dock opens Pulse's v2 deploy with ?seed= (TIN-393); apc.tineira.com ignores it.
  const seed = Number(new URLSearchParams(location.search).get("seed"));
  const body = Number.isInteger(seed) && seed > 0 ? { seed } : {};
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(sessionLimits.requestMs, deadline - Date.now())));
      const response = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      if (!response.ok) throw new Error(`/api/session: ${response.status}`);
      return ((await response.json()) as { sid: string }).sid;
    } catch (error) {
      if (attempt >= 4 || Date.now() + 250 * attempt >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}
