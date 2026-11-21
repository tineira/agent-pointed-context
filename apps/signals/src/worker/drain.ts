/**
 * Unread request bodies are drained (TIN-1093, fix round 1 of PR #249; Pulse's TIN-995, apps/demo/src/worker/index.ts).
 * The page sends a body with every POST, and many routes (the connect grant, Revoke, Cancel, a refusal) never read it.
 * The local runtime then answered the next request on that connection with "fetch failed", which the page saw as a
 * /state 500 and stayed on "Loading…". The page's few bytes are read to the end; past DRAIN_MAX_BYTES or DRAIN_MAX_MS
 * the rest is cancelled, never buffered or waited for.
 */
export const DRAIN_MAX_BYTES = 64 * 1024;
export const DRAIN_MAX_MS = 500;

/** Read a body to its end if it is small and quick, else cancel the rest. Never throws, never holds more than one chunk. */
export async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), DRAIN_MAX_MS)));
  try {
    for (let read = 0; read <= DRAIN_MAX_BYTES; ) {
      const chunk = await Promise.race([reader.read(), late]);
      if (chunk === "late") break;
      if (chunk.done) return;
      read += chunk.value.byteLength;
    }
    // Too big or too slow: cancelled, not awaited (a stuck source must not hold the answer).
    reader.cancel().catch(() => undefined);
  } catch {
    // a broken stream needs no draining
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
