/** The Web Locks API where the browser has it (every current one, on https and localhost). */
type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
const locks = (): Locks | undefined => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;

let inFlight: Promise<string> | null = null;

/**
 * Resume or open the visitor's sandbox. Opening one is retried: a new sandbox can fail to start once.
 *
 * One open at a time (TIN-490): concurrent callers on this page (React StrictMode's second effect, a
 * remount) share one request, and Pulse's pages in other tabs wait for it under a Web Lock, so theirs
 * carries the cookie it set and resumes that sandbox instead of opening a second one whose id the
 * cookie would not name (every later call a 403).
 */
export function openSession(): Promise<string> {
  if (!inFlight) {
    const lock = locks();
    inFlight = (lock ? lock.request("apc-pulse-session", resumeOrOpen) : resumeOrOpen()).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function resumeOrOpen(): Promise<string> {
  // A dock opens Pulse's v2 deploy with ?seed= (TIN-393); apc.tineira.com ignores it.
  const seed = Number(new URLSearchParams(location.search).get("seed"));
  const body = Number.isInteger(seed) && seed > 0 ? { seed } : {};
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`/api/session: ${response.status}`);
      return ((await response.json()) as { sid: string }).sid;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}
