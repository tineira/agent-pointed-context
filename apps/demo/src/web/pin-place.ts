/**
 * Where a pinned agent's badge goes on the page (TIN-903): the pure part of pin-badges.tsx, so it is tested. Several agents on one
 * element sit side by side, a step apart that leaves each × clear of the next badge's mark (the package's `pinStackStep`: 30 px,
 * 72 px on touch), and the first badge never sits so far right that its × leaves the screen (`pinBadgeX`).
 */
import { pinBadgeX } from "@tineira/apc-web";

/** The badge is 28 px (`--apc-pin-size`) and the app centres it on the point it is given (`translate(-50%, -50%)`). */
const HALF = 14;

/**
 * The x (px) of the centre of an agent's badge. A bar or a cell (`narrow`) has the badge astride its right edge; a row or a
 * card has it just inside its top right corner. `index` is the agent's place among those on the element.
 */
export function badgeCenterX(o: { right: number; narrow: boolean; index: number; viewportWidth: number; touch: boolean }): number {
  const center = o.narrow ? o.right : o.right - 24;
  // pinBadgeX takes a left edge 22 px left of the point it is given.
  return pinBadgeX({ targetRight: center - HALF + 22, viewportWidth: o.viewportWidth, index: o.index, touch: o.touch }) + HALF;
}
