import { parsePresenceWaitEvent, waitOpenLimitMs, type ApcProfile } from "@tineira/apc-protocol";

/**
 * Whether an agent is listening now (APC 0.11), from the wait events on the presence channel, for the page's
 * "waiting" state (the pet's, the agent bar's). Pure: the page keeps the value and folds each message into it.
 *
 * Per grant, the page's clock time (ms) at which the grant's open wait event arrived; a grant with no open wait is
 * absent. The time is the page's own, never the event's `at` (the server's clock).
 */
export type OpenWaits = ReadonlyMap<string, number>;

export const NO_OPEN_WAITS: OpenWaits = new Map();

/**
 * Folds one presence message into the open waits. Anything that is not a wait event (a call event, junk) leaves them
 * as they were, the same object, and so does an `open` for a grant already open: the first arrival is kept. `receivedAt` is
 * when the page got the message, on its own clock.
 */
export function foldWaitEvent(open: OpenWaits, message: unknown, receivedAt: number = Date.now()): OpenWaits {
  const event = parsePresenceWaitEvent(message);
  if (!event) return open;
  // An open for a wait already open (a replay to a page that reconnected) keeps the first arrival: its clock never restarts.
  if (event.state === "open" && open.has(event.grant_id)) return open;
  const next = new Map(open);
  if (event.state === "open") next.set(event.grant_id, receivedAt);
  else next.delete(event.grant_id);
  return next;
}

export interface WaitOpenOptions {
  /** The page's clock now. */
  now?: number;
  /** The app's longest `wait_for_focus`, in seconds (its `waitCeilingS`); `WAIT_CEILING_DEFAULT_S` when left out. */
  ceilingS?: number;
  /** The grant's path. A dock grant is never shown waiting: the agent waits on the hub, and the app sees only its relays. */
  path?: ApcProfile;
}

/**
 * Whether a wait of the grant is open now: its last wait event was `open`, it arrived less than the app's ceiling plus
 * `WAIT_EVENT_MARGIN_S` ago (a `closed` that never came does not leave the agent waiting for ever), and the grant is
 * not a dock grant. What a pet's `waiting` input takes.
 */
export function waitOpen(open: OpenWaits, grantId: string, options: WaitOpenOptions = {}): boolean {
  if (options.path === "dock") return false;
  const since = open.get(grantId);
  if (since === undefined) return false;
  const now = options.now ?? Date.now();
  return now - since < waitOpenLimitMs(options.ceilingS);
}

/** When the page should look again: the soonest moment an open wait expires by the rule above, or null when none is open. */
export function nextWaitExpiry(open: OpenWaits, ceilingS?: number): number | null {
  let soonest: number | null = null;
  for (const since of open.values()) {
    const at = since + waitOpenLimitMs(ceilingS);
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/**
 * The open waits without those past the rule (the ceiling plus the margin): the same object when none is. A page calls
 * it on a timer set at `nextWaitExpiry`, so it redraws when a lost `closed` runs out, and the next timer is the next one.
 */
export function dropExpiredWaits(open: OpenWaits, now: number = Date.now(), ceilingS?: number): OpenWaits {
  const limit = waitOpenLimitMs(ceilingS);
  const kept = [...open].filter(([, since]) => now - since < limit);
  return kept.length === open.size ? open : new Map(kept);
}
