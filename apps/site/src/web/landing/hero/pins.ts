/**
 * When the hero says "Now use your own agent" (TIN-1066): after the visitor's second own pin and its answer. The pin the
 * stage plays by itself on load does not count, a pin cut short by the next one still counts, and the panel opens by
 * itself once: it counts as offered only when it actually opens (the title bar's shortcut opens it any time), so a pin
 * or an unpin during the wait before it opens leaves it for the next answer. Pure, so it is tested.
 */

export type PinBy = "self" | "visitor";

export interface PinCount {
  /** The visitor's own pins so far. */
  own: number;
  /** The panel has opened (by itself or from the shortcut): it does not open by itself again. */
  offered: boolean;
}

export const NO_PINS: PinCount = { own: 0, offered: false };

/** How many of the visitor's pins it takes. */
export const PINS_BEFORE_OFFER = 2;

/** A pin was made. */
export function pinMade(count: PinCount, by: PinBy): PinCount {
  return by === "visitor" ? { ...count, own: count.own + 1 } : count;
}

/** Whether the answer just shown, to a pin `by`, is the one after which the panel opens. It does not mark it offered. */
export function offerDue(count: PinCount, by: PinBy): boolean {
  return by === "visitor" && !count.offered && count.own >= PINS_BEFORE_OFFER;
}

/** The panel opened, by itself or from the shortcut. */
export function offerOpened(count: PinCount): PinCount {
  return { ...count, offered: true };
}
