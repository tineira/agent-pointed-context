/** The Web Locks API where the browser has it (every current one, on https and localhost). */
type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
const locks = (): Locks | undefined => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;

let inFlight: Promise<string> | null = null;

/**
 * Resume the visitor's feed or open one (with the ?seed= a dock opened Signals with), and resolve its id.
 *
 * One open at a time (TIN-490): concurrent callers on this page (React StrictMode's second effect, a
 * remount) share one request, and Signals' pages in other tabs wait for it under a Web Lock, so theirs
 * carries the cookie it set and resumes that feed instead of opening a second one whose id the cookie
 * would not name (every later call a 403).
 */
export function openSession(): Promise<string> {
  if (!inFlight) {
    const lock = locks();
    inFlight = (lock ? lock.request("apc-signals-session", resumeOrOpen) : resumeOrOpen()).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function resumeOrOpen(): Promise<string> {
  const seed = Number(new URLSearchParams(location.search).get("seed"));
  const body = Number.isInteger(seed) && seed > 0 ? { seed } : {};
  const response = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok && response.status !== 400) throw new Error(`/api/session: ${response.status}`);
  const result = (await response.json()) as { sid?: string; error?: string };
  if (!result.sid) throw new Error(result.error ?? "error");
  return result.sid;
}
