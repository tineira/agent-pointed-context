import { THEN_PIN_WINDOW_MIN, WAIT_CLAIM_GAP_S, type PresenceWaitEvent } from "@tineira/apc-protocol";
import { presenceWaitEvent } from "./presence.ts";

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
  /**
   * Takes the place, or says how many seconds until a claim would. `tookOver` (APC 0.11): the place was held by
   * another wait, which this claim took it from; the wait events say that wait closed. A store that cannot tell
   * leaves it out.
   */
  claim(): Promise<{ token: string; tookOver?: boolean } | { retryAfterS: number }>;
  /** Whether the wait that got `token` still holds the place. */
  holds(token: string): Promise<boolean>;
  /**
   * Gives the place up, if `token` still holds it. Since APC 0.11 it may answer whether it did (true also when the
   * grant was forgotten while `token` held it): the wait event `closed` goes only then. A store that answers nothing
   * is asked `holds` just before instead.
   */
  release(token: string): Promise<boolean | void>;
}

/** Waits of grants run in one process: the places in memory, per grant id. */
export class MemoryWaitSlots {
  private readonly slots = new Map<string, { token: string; claimedAt: number }>();
  /** Tokens that held a place when its grant was forgotten: their release still says they held it (APC 0.11). */
  private readonly forgotten = new Set<string>();
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
        return held ? { token, tookOver: true } : { token };
      },
      holds: async (token) => this.slots.get(grantId)?.token === token,
      release: async (token) => {
        if (this.forgotten.delete(token)) return true;
        if (this.slots.get(grantId)?.token !== token) return false;
        this.slots.delete(grantId);
        return true;
      },
    };
  }

  /** Forget a grant's place (the grant was revoked or deleted). */
  forget(grantId: string): void {
    const held = this.slots.get(grantId);
    if (held) this.forgotten.add(held.token);
    this.slots.delete(grantId);
  }

  /** Whether a wait of the grant holds its place now. */
  held(grantId: string): boolean {
    return this.slots.has(grantId);
  }
}

/**
 * The wait events of a grant (APC 0.11, `presence.ts` in @tineira/apc-protocol), from its place for a wait: `slot`
 * as before, sending `publish` an `open` when a wait claims the place and a `closed` when it gives it up. A claim
 * that takes over sends the old wait's `closed` first, then the new one's `open`; the old wait, finding later that
 * it was taken over, sends nothing. A refused claim sends nothing. `publish` failing never fails the wait.
 *
 * `registerApcTools` uses it when the context gives `waitPresence`; a hub or an app with its own wait loop wraps
 * its slot with it.
 */
export function announceWaits(slot: WaitSlot, grantId: string, publish: (event: PresenceWaitEvent) => void | Promise<void>): WaitSlot {
  const send = async (state: "open" | "closed") => {
    try {
      await publish(presenceWaitEvent({ grantId, state }));
    } catch {
      // Presence is for the page; a wait does not fail on it. A lost closed clears on the page by itself.
    }
  };
  return {
    claim: async () => {
      const claim = await slot.claim();
      if ("token" in claim) {
        if (claim.tookOver) await send("closed");
        await send("open");
      }
      return claim;
    },
    holds: (token) => slot.holds(token),
    release: async (token) => {
      const before = await slot.holds(token);
      const released = await slot.release(token);
      if (typeof released === "boolean" ? released : before) await send("closed");
      return released;
    },
  };
}

/**
 * MCP's cancel for a stateless server (APC 0.8). A server that builds a new MCP server per POST never sees a
 * `notifications/cancelled` for a call running in another POST: the SDK's `extra.signal` cannot fire. The app
 * keeps one of these where all of a person's requests run (a Durable Object), and for each POST:
 *
 * ```ts
 * calls.cancel(grantId, body);                         // a notifications/cancelled in this POST aborts those calls
 * const call = calls.track(grantId, body);              // the calls this POST carries
 * try { … ctx.signal = AbortSignal.any([request.signal, call.signal]) … } finally { call.done(); }
 * ```
 *
 * A call is named by its grant and JSON-RPC id. Cancelling an id aborts every call of that grant with that id.
 */
export class InflightCalls {
  private readonly calls = new Map<string, Set<AbortController>>();

  /** The calls (requests with an id) a POST body carries, one message or a batch: a signal that aborts when any is cancelled. */
  track(grantId: string, body: unknown): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    const keys: string[] = [];
    for (const m of messagesOf(body)) {
      if (typeof m.method === "string" && !m.method.startsWith("notifications/") && isId(m.id)) keys.push(key(grantId, m.id));
    }
    for (const k of keys) {
      const set = this.calls.get(k) ?? new Set();
      set.add(controller);
      this.calls.set(k, set);
    }
    return {
      signal: controller.signal,
      done: () => {
        for (const k of keys) {
          const set = this.calls.get(k);
          set?.delete(controller);
          if (set && !set.size) this.calls.delete(k);
        }
      },
    };
  }

  /** Aborts the calls of this grant that a `notifications/cancelled` in the body names; how many it found. */
  cancel(grantId: string, body: unknown): number {
    let found = 0;
    for (const m of messagesOf(body)) {
      if (m.method !== "notifications/cancelled") continue;
      const id = (m.params as { requestId?: unknown } | undefined)?.requestId;
      if (!isId(id)) continue;
      for (const controller of this.calls.get(key(grantId, id)) ?? []) {
        controller.abort();
        found++;
      }
    }
    return found;
  }
}

type RpcMessage = { method?: unknown; id?: unknown; params?: unknown };
const messagesOf = (body: unknown): RpcMessage[] => (Array.isArray(body) ? body : [body]).filter((m): m is RpcMessage => !!m && typeof m === "object");
const isId = (id: unknown): id is string | number => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
const key = (grantId: string, id: string | number) => `${grantId}\u0000${typeof id}:${id}`;

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
