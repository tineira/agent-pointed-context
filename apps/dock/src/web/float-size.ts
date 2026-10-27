/**
 * Float's window sizes (TIN-480). Pure, so it is testable without a browser.
 * A Document Picture-in-Picture window resizes only during a user activation, so Float shows a
 * compact notice first and grows to this card size on the click.
 */

/** The content size one pairing request card needs (what was once the outer 300 x 190). */
export const CARD = { width: 300, height: 190 };

interface Size {
  width: number;
  height: number;
}

/** True when the window's content area already holds the card, so it can show at once. */
export function fitsCard(inner: Size): boolean {
  return inner.width >= CARD.width && inner.height >= CARD.height;
}

/**
 * The outer size to pass to resizeTo so the content area is the card's: resizeTo sets the outer
 * size and the title bar is extra, so add (outer - inner). Never smaller than the window now.
 */
export function cardOuterSize(inner: Size, outer: Size): Size {
  return {
    width: Math.max(outer.width, CARD.width + (outer.width - inner.width)),
    height: Math.max(outer.height, CARD.height + (outer.height - inner.height)),
  };
}
