/**
 * The presence channel (the core, `core.ts` item 3): what an app publishes to the person's page. Ids only, and only
 * the grant's owner reads it. Two kinds of message travel on it:
 *
 * - **A call** (`PresenceEvent`, `kind` "read" or "write"): after each successful tool call, with the targets it named.
 * - **A wait** (`PresenceWaitEvent`, `kind` "wait", APC 0.11): whether a `wait_for_focus` of the grant holds its place,
 *   so the page can show that the agent is listening (a drop reaches it now) without guessing.
 *
 * **When a wait event is sent.** `open` when a `wait_for_focus` claims the grant's one place for a wait (APC 0.8);
 * `closed` when the wait gives it up: on return (a pin, a timeout, a closed page), on cancel, or when the grant is
 * revoked or deleted. A wait refused within `WAIT_CLAIM_GAP_S` claims nothing and sends nothing.
 *
 * **A takeover** sends the old wait's `closed`, then the new wait's `open`, both when the new wait claims the place.
 * The old wait sends nothing when it later finds it was taken over: its place was already given up. So the last wait
 * event of a grant always says whether a wait holds the place now.
 *
 * **A `closed` that never comes.** A worker can die before it sends `closed`. A page treats an `open` as closed once
 * it is older than the app's longest wait (its ceiling for `timeout_s`, `WAIT_CEILING_DEFAULT_S` unless the app sets
 * its own) plus `WAIT_EVENT_MARGIN_S`, counted on the page's own clock from when the event arrived (never from `at`,
 * which is the server's clock). A wait never holds its place past its timeout by more than one poll and its last
 * checks; the margin covers that, so a live wait is never shown closed early, and a lost `closed` leaves the page
 * "waiting" for at most a minute.
 *
 * **Dock grants.** A Dock agent waits on the hub, not on the app: the waits an app sees on a dock grant are the hub's
 * relays, not the agent listening. A page shows no "waiting" for a dock grant, whatever its wait events say.
 *
 * An app that implements 0.11 sends wait events for every wait it runs; a page that reads the channel ignores a
 * message it does not know, so pages before 0.11 are not affected (`flashTargets` in `@tineira/apc-web` ignores wait
 * events).
 */
import type { PresenceEvent } from "./types.ts";

/** A wait of the grant opened (claimed its place) or closed (gave it up) (APC 0.11). Ids only: no targets, no tool. */
export interface PresenceWaitEvent {
  v: 1;
  grant_id: string;
  at: string;
  kind: "wait";
  state: "open" | "closed";
}

/** Anything the presence channel carries: a call or a wait. */
export type PresenceMessage = PresenceEvent | PresenceWaitEvent;

/** The longest `wait_for_focus` of an app that does not set its own ceiling, in seconds (`@tineira/apc-server`'s default). */
export const WAIT_CEILING_DEFAULT_S = 50;
/**
 * How long past the app's longest wait a page still believes an `open` with no `closed`, in seconds (APC 0.11). A wait
 * overruns its timeout by at most one poll (2 s in `@tineira/apc-server`) plus its last store reads; 10 s covers that
 * on a slow store, and a lost `closed` still clears within a minute.
 */
export const WAIT_EVENT_MARGIN_S = 10;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const WAIT_KEYS = "at,grant_id,kind,state,v";

/** A wait event, exactly: those five keys and nothing else, `v` 1, an ISO time, `state` open or closed. Null for anything else. */
export function parsePresenceWaitEvent(value: unknown): PresenceWaitEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (Object.keys(e).sort().join() !== WAIT_KEYS) return null;
  if (e.v !== 1 || e.kind !== "wait" || (e.state !== "open" && e.state !== "closed")) return null;
  if (typeof e.grant_id !== "string" || !e.grant_id || e.grant_id.length > 200) return null;
  if (typeof e.at !== "string" || !ISO_TIME.test(e.at) || !Number.isFinite(Date.parse(e.at))) return null;
  return { v: 1, grant_id: e.grant_id, at: e.at, kind: "wait", state: e.state };
}

/** Whether a presence message is a wait event (its `kind` is "wait"); `parsePresenceWaitEvent` checks the rest. */
export function isPresenceWaitEvent(message: unknown): message is PresenceWaitEvent {
  return parsePresenceWaitEvent(message) !== null;
}

/**
 * How long a page shows an `open` with no `closed`, in ms: the app's ceiling plus the margin. Past it the wait reads closed.
 */
export function waitOpenLimitMs(ceilingS: number = WAIT_CEILING_DEFAULT_S): number {
  const ceiling = Number.isFinite(ceilingS) && ceilingS > 0 ? ceilingS : WAIT_CEILING_DEFAULT_S;
  return (ceiling + WAIT_EVENT_MARGIN_S) * 1000;
}
