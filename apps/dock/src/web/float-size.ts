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

/**
 * What Float remembers about its window while requests come and go (a pure reducer, so the cases
 * below are testable). `before` is the outer size to give back; it is kept until a resize event
 * confirms the window got there, because a shrink without a user activation is refused silently.
 * `opened` is the request the card was opened for by a click, so a request that replaces it shows
 * the notice again if the window is small.
 */
export interface FloatSizeState {
  before: Size | null;
  opened: string | null;
  wantShrink: boolean;
}

export const FLOAT_START: FloatSizeState = { before: null, opened: null, wantShrink: false };

export type FloatSizeEvent =
  /** A request arrived: the resize was tried without a click. */
  | { type: "grow"; outer: Size }
  /** The notice was clicked; `ok` is false when resizeTo threw, and the notice then stays. */
  | { type: "open"; id: string; outer: Size; ok: boolean }
  /** Allow / Deny was clicked; `last` when no other request waits (the click shrinks the window). */
  | { type: "decide"; last: boolean }
  /** No request is left (decided here, elsewhere, or withdrawn). */
  | { type: "idle" }
  /** The window was resized. */
  | { type: "resize"; outer: Size }
  /** The window closed. */
  | { type: "reset" };

const near = (a: Size, b: Size) => Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

export function floatSizeReducer(s: FloatSizeState, e: FloatSizeEvent): FloatSizeState {
  switch (e.type) {
    case "grow":
      return { ...s, before: s.before ?? e.outer, wantShrink: false };
    case "open":
      return { before: s.before ?? e.outer, opened: e.ok ? e.id : null, wantShrink: false };
    case "decide":
      return { ...s, opened: null, wantShrink: e.last && s.before !== null };
    case "idle":
      return { ...s, opened: null, wantShrink: s.before !== null };
    case "resize":
      return s.wantShrink && s.before && near(e.outer, s.before) ? FLOAT_START : s;
    case "reset":
      return FLOAT_START;
  }
}
