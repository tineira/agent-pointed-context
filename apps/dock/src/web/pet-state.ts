/**
 * What an APC pet shows (TIN-479, TIN-483), pure so it is testable without a browser. The pet is one
 * animated character for every agent (apc-pet.tsx); this file says which of its eight states an agent
 * is in, from what the hub already reports.
 */

/** The character's states, one machine for the web Float, the Windows pets and the dock's tiles. */
export type PetState = "idle" | "waiting" | "calling" | "pinned" | "read" | "pairing" | "dragging" | "offline";

/** Where the agent's pin is: none, sent and not read yet, or just read (shown for a moment). */
export type PinPhase = "none" | "unread" | "read";

export interface PetInput {
  /** A client has connected to the agent (client_name). */
  connected: boolean;
  /** A wait_for_focus is in flight. */
  waiting: boolean;
  /** A call other than wait_for_focus is in flight. */
  busy: boolean;
  pin: PinPhase;
  /** Pairing requests waiting on the person. */
  requests: number;
  /** The person is dragging this pet (local to the page). */
  dragging: boolean;
}

/**
 * The state, by what matters most to the person: their own drag, then a request waiting on them, then
 * not connected, then an unread pin, then calling tools (an agent reading the pinned item shows calling, not the read hold), then a pin just read, then waiting.
 */
export function petState(i: PetInput): PetState {
  if (i.dragging) return "dragging";
  if (i.requests > 0) return "pairing";
  if (!i.connected) return "offline";
  if (i.pin === "unread") return "pinned";
  if (i.busy) return "calling";
  if (i.pin === "read") return "read";
  if (i.waiting) return "waiting";
  return "idle";
}

/** How long "read the pin" shows: the hub keeps a read pin until a new one comes, so the state must not stay on it. */
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
