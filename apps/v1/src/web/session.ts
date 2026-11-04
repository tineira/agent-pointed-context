import { BASE } from "../base.ts";

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
 * remount) share one request, and pages of this origin in other tabs wait for it under a Web Lock, so
 * theirs carries the cookie it set and resumes that sandbox instead of opening a second one whose id
 * the cookie would not name (every later call a 403). An open settles within `openMs` whatever its
 * requests do, so the lock is never held longer; a browser without Web Locks only shares within the page.
 */
export function openSession(): Promise<string> {
  if (!inFlight) {
    const lock = locks();
    const open = lock ? lock.request("apc-v1-session", { signal: AbortSignal.timeout(sessionLimits.waitMs) }, bounded) : bounded();
    inFlight = open.finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** resumeOrOpen, settled by `openMs` at the latest (a request that ignores its abort included). */
function bounded(): Promise<string> {
  const deadline = Date.now() + sessionLimits.openMs;
  // Given up (the deadline, or settled): no pause continues and no request starts after it.
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new Error(`${BASE}/api/session: timed out`));
    }, sessionLimits.openMs);
  });
  return Promise.race([resumeOrOpen(deadline, stop.signal), late]).finally(() => {
    clearTimeout(timer);
    stop.abort();
  });
}

async function resumeOrOpen(deadline: number, stop: AbortSignal): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    // Never a request once the open is given up: it could set the cookie to a sandbox no page holds,
    // after another tab, let in by the released lock, opened the one its page uses (TIN-490).
    if (stop.aborted || Date.now() >= deadline) throw new Error(`${BASE}/api/session: timed out`);
    const request = new AbortController();
    const abort = () => request.abort();
    const timer = setTimeout(abort, Math.min(sessionLimits.requestMs, deadline - Date.now()));
    stop.addEventListener("abort", abort);
    try {
      const response = await fetch(`${BASE}/api/session`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}", signal: request.signal });
      if (!response.ok) throw new Error(`${BASE}/api/session: ${response.status}`);
      return ((await response.json()) as { sid: string }).sid;
    } catch (error) {
      if (attempt >= 4 || stop.aborted || Date.now() + 250 * attempt >= deadline) throw error;
    } finally {
      clearTimeout(timer);
      stop.removeEventListener("abort", abort);
    }
    await pause(250 * attempt, stop);
  }
}

/** A pause between attempts that ends at once when the open is given up (a background tab may wake it late). */
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener("abort", done);
  });
}
