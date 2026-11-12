import { THEN_PIN_WINDOW_MIN, WAIT_CLAIM_GAP_S } from "@tineira/apc-protocol";

/**
 * One wait per grant (APC 0.8, `WaitForFocusResult` in @tineira/apc-protocol): the place a grant's
 * `wait_for_focus` holds while it runs. A new claim takes the place (the newest wait wins), unless the
 * last claim was under `WAIT_CLAIM_GAP_S` ago and still holds it: then the new one is refused, with how
 * long to wait. A wait checks that it still holds the place before it delivers, and gives it up when it
 * ends or its request is cancelled.
 *
 * An app whose waits all run in one process (a Durable Object per person, as Pulse and Signals) keeps
 * the places in memory with `MemoryWaitSlots`. An app on stateless functions keeps them in its store: a
 * row per grant with the holder's token and when it claimed.
 */
export interface WaitSlot {
  /** Takes the place, or says how many seconds until a claim would. */
  claim(): Promise<{ token: string } | { retryAfterS: number }>;
  /** Whether the wait that got `token` still holds the place. */
  holds(token: string): Promise<boolean>;
  /** Gives the place up, if `token` still holds it. */
  release(token: string): Promise<void>;
}

/** Waits of grants run in one process: the places in memory, per grant id. */
export class MemoryWaitSlots {
  private readonly slots = new Map<string, { token: string; claimedAt: number }>();
  private readonly now: () => number;
  private readonly gapMs: number;

  constructor(now: () => number = Date.now, gapMs: number = WAIT_CLAIM_GAP_S * 1000) {
    this.now = now;
    this.gapMs = gapMs;
  }

  /** The place of one grant. */
  for(grantId: string): WaitSlot {
    return {
      claim: async () => {
        const held = this.slots.get(grantId);
        const now = this.now();
        if (held && now - held.claimedAt < this.gapMs) return { retryAfterS: Math.max(1, Math.ceil((held.claimedAt + this.gapMs - now) / 1000)) };
        const token = crypto.randomUUID();
        this.slots.set(grantId, { token, claimedAt: now });
        return { token };
      },
      holds: async (token) => this.slots.get(grantId)?.token === token,
      release: async (token) => {
        if (this.slots.get(grantId)?.token === token) this.slots.delete(grantId);
      },
    };
  }

  /** Forget a grant's place (the grant was revoked or deleted). */
  forget(grantId: string): void {
    this.slots.delete(grantId);
  }
}

/**
 * Whether a result carries `then` (APC 0.8): a page of the person's is open and shared (`attending` is
 * true; null while they do not share their view), and the grant's pin, read or unread, was dropped
 * within `windowMs` (`THEN_PIN_WINDOW_MIN` unless the app sets its own). With no recent pin an open page
 * gives no `then`, so the agent does not wait after every answer.
 */
export function thenApplies(attending: boolean | null, lastPinnedAt: string | null | undefined, now: number = Date.now(), windowMs: number = THEN_PIN_WINDOW_MIN * 60_000): boolean {
  if (attending !== true || !lastPinnedAt) return false;
  const at = Date.parse(lastPinnedAt);
  return Number.isFinite(at) && now - at <= windowMs;
}
