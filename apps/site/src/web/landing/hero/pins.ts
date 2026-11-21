/**
 * When the hero says "Now use your own agent" (TIN-1066): after the visitor's second own pin and its answer. The pin the
 * stage plays by itself on load does not count, a pin cut short by the next one still counts, and the panel opens by
 * itself once (the title bar's shortcut opens it any time). Pure, so it is tested.
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

/** A pin's answer was shown: whether the panel opens now, and the count after. */
export function answerShown(count: PinCount, by: PinBy): { count: PinCount; offer: boolean } {
  const offer = by === "visitor" && !count.offered && count.own >= PINS_BEFORE_OFFER;
  return { count: offer ? { ...count, offered: true } : count, offer };
}

/** The panel was opened from the shortcut. */
export function offerOpened(count: PinCount): PinCount {
  return { ...count, offered: true };
}
