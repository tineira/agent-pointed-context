/**
 * Reads where only the newest counts (TIN-1070, fix round 2 of PR #245, B-3): the hero reads the sandbox's state on
 * mount, on every socket open and close, on a message and on a retry, and those reads can answer out of order. A read
 * that a later one superseded (started after it) is dropped with its outcome: its state, its error and the retry its
 * error would set. So a slow answer from before a revoke never shows the agent connected again after it.
 */
export type LatestOutcome<T> = { current: false } | { current: true; ok: true; value: T } | { current: true; ok: false; error: unknown };

export function latestOnly<T>(read: () => Promise<T>): () => Promise<LatestOutcome<T>> {
  let newest = 0;
  return async () => {
    const mine = ++newest;
    try {
      const value = await read();
      return mine === newest ? { current: true, ok: true, value } : { current: false };
    } catch (error) {
      return mine === newest ? { current: true, ok: false, error } : { current: false };
    }
  };
}
