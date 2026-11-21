/**
 * The hero's one clock: every wait of the stage goes through it, so a hidden tab pauses the demo where it is (and it
 * goes on from there when the tab shows again), a cancelled wait clears its timer at once, and leaving the page clears
 * them all. Pure apart from the timers it is given, so it is tested.
 */

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
  now: () => number;
}

export interface Clock {
  /** Resolves after `ms` of visible time, or at once when `signal` aborts (its timer is cleared then). Never rejects. */
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Holds every pending wait (the tab is hidden). */
  pause: () => void;
  /** Lets them run again for the time they had left. */
  resume: () => void;
  /** Clears every timer: the stage is gone. */
  dispose: () => void;
  /** How many waits are pending (for tests). */
  readonly pending: number;
}

export const BROWSER_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export function createClock(timers: Timers = BROWSER_TIMERS): Clock {
  interface Wait {
    left: number;
    started: number;
    id: unknown;
    done: () => void;
  }
  const pending = new Set<Wait>();
  let paused = false;
  let gone = false;
  const arm = (w: Wait) => {
    w.started = timers.now();
    w.id = timers.set(w.done, w.left);
  };
  const disarm = (w: Wait) => {
    if (w.id === null) return;
    timers.clear(w.id);
    w.id = null;
  };
  return {
    wait(ms, signal) {
      return new Promise<void>((resolve) => {
        if (gone || signal?.aborted) return resolve();
        const w: Wait = {
          left: Math.max(0, ms),
          started: 0,
          id: null,
          done: () => {
            disarm(w);
            pending.delete(w);
            signal?.removeEventListener("abort", w.done);
            resolve();
          },
        };
        signal?.addEventListener("abort", w.done, { once: true });
        pending.add(w);
        if (!paused) arm(w);
      });
    },
    pause() {
      if (paused || gone) return;
      paused = true;
      for (const w of pending) {
        if (w.id === null) continue;
        w.left = Math.max(0, w.left - (timers.now() - w.started));
        disarm(w);
      }
    },
    resume() {
      if (!paused || gone) return;
      paused = false;
      for (const w of pending) arm(w);
    },
    dispose() {
      gone = true;
      for (const w of pending) disarm(w);
      pending.clear();
    },
    get pending() {
      return pending.size;
    },
  };
}
