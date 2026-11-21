/**
 * How Signals' page reads its feed's state (TIN-1093, fix round 1 of PR #249; Pulse's hero, B-3 of PR #245). The state is
 * the truth: the page reads it on mount, on every socket open (what changed while it was down is not replayed), on a
 * message and after an action. Those reads can answer out of order, so only the newest counts (latestOnly): a slow read
 * from before a revoke never draws the revoked agent again. A failure is never silent: the feed gone (404) or no longer
 * this browser's (403) ends the page; any other (a 429, the network, a 5xx) is shown inline and read again with backoff,
 * so the page never stays on "Loading…" (as it did when a read after `?connect` failed and nothing read again).
 */
import { latestOnly } from "../../../demo/src/web/embed/latest.ts";

export const RETRY_FIRST_MS = 2000;
export const RETRY_MAX_MS = 30_000;

export type ReadFailure = "ended" | "limited" | "failed";

export interface StateReaderHooks<T> {
  read: () => Promise<T>;
  onState: (state: T) => void;
  /** null when a read succeeded again. */
  onFailure: (failure: ReadFailure | null) => void;
  /** Tests pass their own clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** The status a failed read carried (the page's `call` sets it), if any. */
const statusOf = (error: unknown): number | undefined => (error as { status?: unknown } | null)?.status as number | undefined;

/** `stop` (an unmount) drops every later outcome and the pending retry; `start` (a remount, StrictMode) takes them again. */
export function createStateReader<T>(hooks: StateReaderHooks<T>): { refresh: () => Promise<void>; start: () => void; stop: () => void } {
  const setTimer = hooks.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = hooks.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const readNewest = latestOnly(hooks.read);
  let timer: unknown = null;
  let delay = RETRY_FIRST_MS;
  let stopped = false;
  const refresh = async (): Promise<void> => {
    const outcome = await readNewest();
    if (stopped || !outcome.current) return;
    if (outcome.ok) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      delay = RETRY_FIRST_MS;
      hooks.onFailure(null);
      hooks.onState(outcome.value);
      return;
    }
    const status = statusOf(outcome.error);
    if (status === 403 || status === 404) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      hooks.onFailure("ended");
      return;
    }
    hooks.onFailure(status === 429 ? "limited" : "failed");
    if (timer === null) {
      const wait = delay;
      delay = Math.min(RETRY_MAX_MS, delay * 2);
      timer = setTimer(() => {
        timer = null;
        void refresh();
      }, wait);
    }
  };
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const start = () => {
    stopped = false;
  };
  return { refresh, start, stop };
}
