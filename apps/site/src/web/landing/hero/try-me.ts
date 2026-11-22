/**
 * The hero's "Try me" arrow (TIN-1103): a hand-drawn dashed arrow in the accent, between the copy and the stage, that
 * says the demo is there to be used. It points at the agent in the stage's bar (the thing to drag) when the stage sits
 * beside the copy, and down at the stage when the stage stacks under it (phones and narrow windows).
 *
 * - It shows once the stage's own pin is over (however it ended), or once the stage is ready under reduced motion, where
 *   there is no self-play: `tryMe.ready()`, from HeroStage.
 * - It goes on the visitor's first interaction, for the rest of the tab: a press on the agent (a drag), a tap on it or
 *   keyboard pinning (both arm it), a pin by any means, or "Use your own agent" from anywhere (`openRealHero`, live.ts):
 *   `tryMe.dismiss()`. The dismissal is kept in sessionStorage, so a reload in the same tab does not bring it back; a new
 *   tab does. Storage may throw (blocked site data): then it is only gone for this page.
 * - It is decoration (aria-hidden): the stage keeps its own keyboard path. It is placed through the CSSOM (custom
 *   properties), never a style attribute, and it is only drawn where it covers neither the stage nor the copy's text and
 *   stays inside the hero's grid (no horizontal scroll). Where it cannot, it is not drawn. The dot field keeps its
 *   glow at the text caps under it (`data-text-mask`, TIN-1102), so the label's contrast is the one landing.test.ts proves.
 *
 * Plain createElement, not JSX, so apps/site/test/try-me.test.ts renders it under node --test.
 */
import { createElement as h, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { subscribeRealHeroOpen } from "./live.ts";

/** Where the tab keeps the dismissal. */
export const TRY_ME_KEY = "apc:site:try-me-dismissed";

/**
 * - `waiting`: the stage's own pin is not over yet;
 * - `shown`: drawn, waiting for the visitor;
 * - `gone`: dismissed while shown (it fades out);
 * - `dismissed`: dismissed before it showed, or in an earlier page of this tab: never drawn.
 */
export type TryMePhase = "waiting" | "shown" | "gone" | "dismissed";

export interface TryMe {
  phase: () => TryMePhase;
  /** The stage is waiting for the visitor: show the arrow, unless it was dismissed. */
  ready: () => void;
  /** The visitor interacted: the arrow goes for the rest of the tab. */
  dismiss: () => void;
  subscribe: (listener: () => void) => () => void;
}

type TryMeStorage = Pick<Storage, "getItem" | "setItem">;

/** The arrow's state, kept in `storage` (sessionStorage on the page); every storage call is guarded. */
export function createTryMe(storage: () => TryMeStorage | null | undefined): TryMe {
  let phase: TryMePhase = "waiting";
  try {
    if (storage()?.getItem(TRY_ME_KEY) === "1") phase = "dismissed";
  } catch {
    // No storage here: the arrow is remembered for this page only.
  }
  const listeners = new Set<() => void>();
  const set = (next: TryMePhase) => {
    if (next === phase) return;
    phase = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    phase: () => phase,
    ready() {
      if (phase === "waiting") set("shown");
    },
    dismiss() {
      if (phase === "gone" || phase === "dismissed") return;
      try {
        storage()?.setItem(TRY_ME_KEY, "1");
      } catch {
        // As above: gone for this page only.
      }
      set(phase === "shown" ? "gone" : "dismissed");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The page's arrow. Reading `sessionStorage` itself can throw, so it is read inside the store's guards. */
export const tryMe = createTryMe(() => (typeof sessionStorage === "undefined" ? null : sessionStorage));
// "Use your own agent", from the stage's panel, its title bar or the band under the hero, dismisses it.
subscribeRealHeroOpen(() => tryMe.dismiss());

export type TryMeDir = "right" | "down";
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Each arrow's drawing box, in px, where its tip is in it, and the parts of the box that hold ink (the label, the curve
 * and its head), as [left, top, right, bottom] in the box: only those must stay clear of the copy's text, so a button's
 * corner may sit in the box's empty corner.
 */
export const TRY_ME_SHAPES: Record<TryMeDir, { width: number; height: number; tipX: number; tipY: number; ink: [number, number, number, number][] }> = {
  right: { width: 190, height: 64, tipX: 184, tipY: 8, ink: [[0, 32, 76, 64], [72, 22, 140, 64], [124, 0, 190, 34]] },
  down: { width: 120, height: 56, tipX: 98, tipY: 50, ink: [[0, 0, 76, 26], [70, 0, 120, 56]] },
};
/** The tip stays this far from the stage, so the nudge (5 px) never reaches it. */
export const TRY_ME_CLEAR = 12;
/** And this far from the copy's text. */
const TEXT_PAD = 4;

/** What the arrow is placed against, in viewport coordinates. */
export interface TryMeLayout {
  /** The hero's grid, which the arrow is placed in. */
  grid: Box;
  copy: Box;
  stage: Box;
  /** The agent in the stage's bar, if it is there. */
  mark: Box | null;
  /** The copy's last line (the video link), which the down arrow sits beside. */
  anchor: Box | null;
  /** Every block of the copy's text and its buttons. */
  texts: Box[];
}

export interface TryMePlace {
  dir: TryMeDir;
  /** The drawing box's top-left corner, from the grid's. */
  x: number;
  y: number;
}

const overlaps = (a: Box, b: Box, pad: number) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/**
 * Where the arrow goes: beside the copy, pointing right at the agent (or the stage's lower part); under it, pointing down
 * at the stage from beside the video link. Null where it would cover the stage or the copy's text, or leave the grid.
 */
export function placeTryMe(l: TryMeLayout): TryMePlace | null {
  const beside = l.stage.left >= l.copy.right;
  const dir: TryMeDir = beside ? "right" : "down";
  const shape = TRY_ME_SHAPES[dir];
  let tipX: number;
  let tipY: number;
  if (beside) {
    tipX = l.stage.left - TRY_ME_CLEAR;
    tipY = l.mark ? (l.mark.top + l.mark.bottom) / 2 : l.stage.top + (l.stage.bottom - l.stage.top) * 0.8;
  } else {
    if (!l.anchor) return null;
    tipX = l.anchor.right + 20 + shape.tipX;
    tipY = l.stage.top - TRY_ME_CLEAR;
  }
  const left = tipX - shape.tipX;
  const top = tipY - shape.tipY;
  const box: Box = { left, top, right: left + shape.width, bottom: top + shape.height };
  if (box.left < l.grid.left || box.right > l.grid.right) return null;
  if (overlaps(box, l.stage, 0)) return null;
  const ink = shape.ink.map(([x0, y0, x1, y1]): Box => ({ left: left + x0, top: top + y0, right: left + x1, bottom: top + y1 }));
  if (ink.some((part) => l.texts.some((t) => overlaps(part, t, TEXT_PAD)))) return null;
  return { dir, x: Math.round(box.left - l.grid.left), y: Math.round(box.top - l.grid.top) };
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** The hero's layout, read from HeroSection's markup. */
function readLayout(grid: Element): TryMeLayout | null {
  const copy = grid.querySelector(".landing-hero-copy");
  const stage = grid.querySelector(".landing-hero-stage");
  if (!copy || !stage) return null;
  const mark = stage.querySelector("apc-agents [data-apc-mark]");
  const anchor = copy.querySelector(".landing-watch");
  return {
    grid: boxOf(grid),
    copy: boxOf(copy),
    stage: boxOf(stage),
    mark: mark ? boxOf(mark) : null,
    anchor: anchor ? boxOf(anchor) : null,
    texts: [...copy.querySelectorAll("h1, p, .landing-cta-row > *, .landing-watch")].map(boxOf),
  };
}

/** The curves and arrowheads, drawn by hand on each shape's box. */
const DRAWINGS: Record<TryMeDir, { curve: string; head: string }> = {
  right: { curve: "M78 48 C108 60 134 14 182 8", head: "M170.1 2.8 L182 8 L171 15" },
  down: { curve: "M76 12 C98 8 106 22 98 50", head: "M95.7 39.2 L98 50 L105.6 42.1" },
};

function drawing(dir: TryMeDir): ReactElement {
  const { width, height } = TRY_ME_SHAPES[dir];
  const { curve, head } = DRAWINGS[dir];
  const mask = `try-me-mask-${dir}`;
  // The dashed curve shows through a solid copy of itself that draws in (stroke-dashoffset): a dashed line drawn by hand.
  return h(
    "svg",
    { className: "try-me-svg", width, height, viewBox: `0 0 ${width} ${height}`, fill: "none", focusable: "false" },
    h("defs", null, h("mask", { id: mask, maskUnits: "userSpaceOnUse", x: -10, y: -10, width: width + 20, height: height + 20 }, h("path", { className: "try-me-reveal", d: curve, pathLength: 1 }))),
    h("path", { className: "try-me-curve", d: curve, mask: `url(#${mask})` }),
    h("path", { className: "try-me-head", d: head }),
  );
}

/**
 * The arrow, a child of HeroSection's grid. Drawn only while `shown` (and fading out once `gone`), placed against the
 * copy and the stage on every change of their size.
 */
export function TryMeArrow(props: { store?: TryMe }): ReactElement | null {
  const store = props.store ?? tryMe;
  const phase = useSyncExternalStore(store.subscribe, store.phase, store.phase);
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<TryMePlace | null>(null);
  const drawn = phase === "shown" || phase === "gone";
  const live = phase === "shown";

  useLayoutEffect(() => {
    const el = ref.current;
    const grid = el?.parentElement;
    if (!live || !grid) return;
    const measure = () => {
      const layout = readLayout(grid);
      const next = layout ? placeTryMe(layout) : null;
      setPlace((prev) => (prev && next && prev.dir === next.dir && prev.x === next.x && prev.y === next.y ? prev : next));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(grid);
    for (const part of grid.querySelectorAll(".landing-hero-copy, .landing-hero-stage")) watch.observe(part);
    addEventListener("resize", measure);
    return () => {
      watch.disconnect();
      removeEventListener("resize", measure);
    };
  }, [live]);

  useLayoutEffect(() => {
    if (!place) return;
    ref.current?.style.setProperty("--try-x", `${place.x}px`);
    ref.current?.style.setProperty("--try-y", `${place.y}px`);
  }, [place]);

  if (!drawn) return null;
  const dir = place?.dir ?? "right";
  return h(
    "div",
    { ref, className: phase === "gone" ? "try-me is-gone" : "try-me", "data-dir": dir, "data-text-mask": "", "aria-hidden": "true", hidden: !place },
    drawing(dir),
    h("span", { className: "try-me-label", "data-text-mask": "" }, "Try me"),
  );
}
