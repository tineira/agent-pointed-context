/**
 * What an agent's pet shows (TIN-483, TIN-878), pure so it is tested without a browser. The pet is one
 * animated character for every agent (pet.ts); this file says which of its eight states an agent is in,
 * from what the app (or the dock's hub) already knows of it.
 *
 * Nothing here guesses. An app feeds each field from data it has: its presence events (a call in
 * flight), the page-readable wait signal (an open `wait_for_focus`), its pins, its pairing requests and
 * its grants. A field the app does not have stays at its default, and the pet shows less, never more.
 */

/** The character's states: one machine for the dock (Float, the Windows pets, its tiles) and every app. */
export type PetState = "idle" | "waiting" | "calling" | "pinned" | "read" | "pairing" | "dragging" | "offline";

/** Every state, in the order petState weighs them (the first that holds wins). */
export const PET_STATES: readonly PetState[] = ["dragging", "pairing", "offline", "pinned", "calling", "read", "waiting", "idle"];

/** Where the agent's pin is: none, dropped and not read yet, or just read (shown for a moment). */
export type PinPhase = "none" | "unread" | "read";

/** What an app knows of one agent. Every field is optional; a field left out takes its default. */
export interface PetInput {
  /** An agent client is connected on this grant (default true: an app shows a pet for a live grant). */
  connected?: boolean;
  /** The grant was revoked or given back, and the app still shows it for a moment (default false). */
  revoked?: boolean;
  /**
   * A `wait_for_focus` of this agent is open now (default false). Only the page-readable wait signal says
   * so (presence kind `"wait"`, open or closed, TIN-886): pass what its helper answers for the grant.
   * Never inferred from how recently the agent called: a client that does not wait never shows waiting.
   */
  waiting?: boolean;
  /** A call other than `wait_for_focus` is in flight, or the page just heard of one (presence) (default false). */
  busy?: boolean;
  /** The agent's pin (default "none"): see watchRead and pinPhase. */
  pin?: PinPhase;
  /** Pairing requests of this agent waiting on the person (default 0). */
  requests?: number;
  /** The person is dragging this agent's mark, here (default false). */
  dragging?: boolean;
}

/**
 * The state, by what matters most to the person: their own drag, then a request waiting on them, then
 * not connected (or revoked), then an unread pin, then calling tools (an agent reading the pinned item
 * shows calling, not the read hold), then a pin just read, then an open wait. Otherwise idle.
 */
export function petState(i: PetInput = {}): PetState {
  if (i.dragging) return "dragging";
  if ((i.requests ?? 0) > 0) return "pairing";
  if (i.revoked || i.connected === false) return "offline";
  const pin = i.pin ?? "none";
  if (pin === "unread") return "pinned";
  if (i.busy) return "calling";
  if (pin === "read") return "read";
  if (i.waiting === true) return "waiting";
  return "idle";
}

/** How long "read the pin" shows: an app keeps a read pin until a new one comes, so the state must not stay on it. */
export const READ_HOLD_MS = 6000;

/** What a pet has seen of its agent's pin: which pin, whether it was read, and until when "read" shows. */
export interface ReadWatch {
  pin: string;
  seen: boolean;
  until: number;
}

/**
 * Follows the pin from state to state. `prev` is undefined on the page's first look: a pin already
 * read then is old news and does not show as "read". A pin that turns read while the page watches does.
 */
export function watchRead(prev: ReadWatch | null | undefined, focus: { pinned_at: string; seen: boolean } | null, now: number): ReadWatch | null {
  if (!focus) return null;
  if (!focus.seen) return { pin: focus.pinned_at, seen: false, until: 0 };
  if (prev && prev.pin === focus.pinned_at && prev.seen) return prev;
  return { pin: focus.pinned_at, seen: true, until: prev === undefined ? 0 : now + READ_HOLD_MS };
}

export function pinPhase(w: ReadWatch | null | undefined, now: number): PinPhase {
  if (!w) return "none";
  if (!w.seen) return "unread";
  return now < w.until ? "read" : "none";
}
