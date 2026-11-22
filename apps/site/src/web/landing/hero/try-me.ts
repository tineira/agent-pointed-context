/**
 * The hero's hand-drawn arrow (TIN-1103, three steps since TIN-1106): a dashed arrow in the accent that walks the visitor
 * through the hero, one step at a time.
 *
 * 1. `agent`, "Try me": at the agent in the stage's bar (the thing to drag), from beside the copy; down at the stage when
 *    the stage stacks under the copy. It shows 5 s after the stage starts (`tryMe.ready("agent")`, on the stage's
 *    clock), or at once under reduced motion, where there is no self-play.
 * 2. `own`, "Try me": after the visitor's first interaction with the agent (a press on it, a tap or keyboard arming, a
 *    pin), at "Use your own agent" in the agent window's title bar. The first arrow goes on the interaction, and this one
 *    shows once the visitor's pin is over, or a few seconds after a press that pinned nothing (HeroStage).
 * 3. `connect`, "Do this": after "Use your own agent" (from anywhere: `openRealHero`, live.ts), at Pulse's "Connect your
 *    agent" box inside the live frame, whose box the frame reports (`apc:embed-anchor`, PulseFrame). "Back to the demo"
 *    returns to step 2. Once the agent connects, the arrow goes for the rest of the page.
 *
 * Nothing is remembered: a reload starts at step 1 again (TIN-1106).
 *
 * Steps 2 and 3 start in the copy's column, above its first line, and arc over the stage's top edge onto the target;
 * where the stage stacks under the copy they sit just under (or over) the target, inside the stage, smaller if they must.
 * An arrow is drawn 80% larger than TIN-1103's, and smaller only where that does not fit; where nothing fits, it is not
 * drawn. It never covers its target or the copy's text, and stays inside the hero's grid (no horizontal scroll).
 *
 * It is decoration (aria-hidden): the stage keeps its own keyboard path. Every place and size goes through the CSSOM
 * (custom properties), never a style attribute. Over the field its label is bare --accent-text, under the dot field's
 * text caps (`data-text-mask`, TIN-1102); over the stage it is a solid pill (--accent with --try-pill-fg), since the
 * stage's windows are not the page's background. landing.test.ts proves both.
 *
 * Plain createElement, not JSX, so apps/site/test/try-me.test.ts renders it under node --test.
 */
import { createElement as h, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { subscribeRealHeroOpen } from "./live.ts";

/** How long after the stage starts the first arrow shows (TIN-1106: about 5 s from the start of the animation). */
export const TRY_ME_DELAY_MS = 5000;
/** After a press on the agent that pinned nothing, how long before the second arrow shows. */
export const TRY_ME_OWN_DELAY_MS = 4000;

export type TryMeStep = "agent" | "own" | "connect";
/**
 * - `waiting`: this step's arrow is not due yet;
 * - `shown`: drawn, waiting for the visitor;
 * - `gone`: the agent connected (it fades out, for the rest of the page).
 */
export type TryMePhase = "waiting" | "shown" | "gone";

export interface TryMeView {
  readonly step: TryMeStep;
  readonly phase: TryMePhase;
}

/** The Connect box, in the live frame's own coordinates (CSS px), as Pulse reports it; null while it is not shown. */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TryMe {
  view: () => TryMeView;
  /** `step`'s arrow is due: shown, if the visitor is still on that step. */
  ready: (step: TryMeStep) => void;
  /** The visitor interacted with the agent: the first arrow goes, the second waits for `ready("own")`. */
  interacted: () => void;
  /** "Use your own agent": the arrow moves to the Connect box. */
  opened: () => void;
  /** "Back to the demo": back to "Use your own agent". */
  back: () => void;
  /** The live frame's status: once the agent is connected, the arrow goes. */
  connection: (connected: boolean) => void;
  /** Where the live frame says its Connect box is. */
  connectBox: () => FrameBox | null;
  setConnectBox: (box: FrameBox | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createTryMe(): TryMe {
  let view: TryMeView = { step: "agent", phase: "waiting" };
  let box: FrameBox | null = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  const set = (step: TryMeStep, phase: TryMePhase) => {
    if (view.phase === "gone" || (step === view.step && phase === view.phase)) return;
    view = { step, phase };
    tell();
  };
  return {
    view: () => view,
    ready(step) {
      if (view.step === step && view.phase === "waiting") set(step, "shown");
    },
    interacted() {
      if (view.step === "agent") set("own", "waiting");
    },
    opened() {
      set("connect", "shown");
    },
    back() {
      if (view.step === "connect") set("own", "shown");
    },
    connection(connected) {
      if (connected && view.step === "connect") set("connect", "gone");
    },
    connectBox: () => box,
    setConnectBox(next) {
      if (box === next || (box && next && box.x === next.x && box.y === next.y && box.width === next.width && box.height === next.height)) return;
      box = next;
      tell();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The page's arrow. */
export const tryMe = createTryMe();
// "Use your own agent", from the stage's panel, its title bar or the band under the hero, moves it to the Connect box.
subscribeRealHeroOpen(() => tryMe.opened());

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Point {
  x: number;
  y: number;
}

/** What the arrow is placed against, in viewport coordinates. */
export interface TryMeLayout {
  /** The hero's grid, which the arrow is placed in. */
  grid: Box;
  copy: Box;
  stage: Box;
  /** What this step points at: the agent in the stage's bar, "Use your own agent", or the Connect box. Null: none. */
  target: Box | null;
  /** The copy's last line (the video link), which the first arrow sits beside when the stage stacks under the copy. */
  anchor: Box | null;
  /** Every block of the copy's text and its buttons. */
  texts: Box[];
}

/** How the arrow comes at its target, which says how its nudge moves and where its label sits. */
export type TryMeDir = "right" | "down" | "over" | "up" | "into";

/** The arrow, ready to draw: its box from the grid's corner, and its curve, head and label inside that box. */
export interface TryMePlace {
  dir: TryMeDir;
  /** 1.8 (TIN-1106's size), or smaller where that does not fit. */
  scale: number;
  /** The label sits on the field (bare) or on the stage (a pill). */
  onStage: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  curve: string;
  head: string;
  labelX: number;
  labelY: number;
  /** The nudge, a unit vector along the arrow's last stretch. */
  nx: number;
  ny: number;
}

/**
 * The sizes tried, largest first: 80% larger than TIN-1103's arrow (TIN-1106), then smaller where that does not fit.
 * With the stage stacked under the copy (phones), from the middle size: a smaller arrow there (Tomas, TIN-1106).
 */
export const TRY_ME_SCALES = [1.8, 1.4, 1] as const;
export const TRY_ME_STACKED_SCALES = [1.4, 1] as const;
/** The tip stays this far from what it points at, so the nudge (5 px) never reaches it. */
export const TRY_ME_CLEAR = 12;
/** And the ink this far from the copy's text. */
const TEXT_PAD = 4;
/** How far under the stage's top edge a target may sit for an arrow to arc over that edge onto it. */
export const TRY_ME_OVER_REACH = 120;
/** How far above the grid an arrow may reach (the hero's own top padding, under the header). */
export const TRY_ME_ABOVE = 44;
/** Each label's size at scale 1 (15 px, bold, upper case, rotated -5°), with room to spare. */
export const TRY_ME_LABELS = { "Try me": { width: 76, height: 26 }, "Do this": { width: 84, height: 26 } } as const;
export type TryMeLabel = keyof typeof TRY_ME_LABELS;
/** The pill's padding around a label on the stage, at scale 1. */
const PILL_PAD = { x: 8, y: 3 };

export const labelFor = (step: TryMeStep): TryMeLabel => (step === "connect" ? "Do this" : "Try me");

const overlaps = (a: Box, b: Box, pad: number) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/** A point on the cubic Bézier S C1 C2 T at t. */
function bezier(s: Point, c1: Point, c2: Point, t: Point, u: number): Point {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return { x: a * s.x + b * c1.x + c * c2.x + d * t.x, y: a * s.y + b * c1.y + c * c2.y + d * t.y };
}

/** One arrow as drawn, in viewport coordinates: its label's box, its curve and its head, and the ink to keep clear. */
interface Drawn {
  dir: TryMeDir;
  scale: number;
  onStage: boolean;
  label: Box;
  s: Point;
  c1: Point;
  c2: Point;
  t: Point;
}

function draw(d: Drawn, grid: Box): { place: TryMePlace; ink: Box[] } {
  const { s, c1, c2, t, scale } = d;
  // The head: two strokes back from the tip, 30° either side of the curve's last direction.
  let dx = t.x - c2.x;
  let dy = t.y - c2.y;
  if (Math.hypot(dx, dy) < 1) {
    dx = t.x - c1.x;
    dy = t.y - c1.y;
  }
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const arm = 12 * scale;
  const rot = (deg: number): Point => {
    const r = (deg * Math.PI) / 180;
    return { x: t.x - arm * (ux * Math.cos(r) - uy * Math.sin(r)), y: t.y - arm * (ux * Math.sin(r) + uy * Math.cos(r)) };
  };
  const h1 = rot(30);
  const h2 = rot(-30);
  const dots = Array.from({ length: 25 }, (_, i) => bezier(s, c1, c2, t, i / 24));
  const stroke = 3 * scale;
  const ink: Box[] = [d.label, ...[...dots, h1, h2].map((p) => ({ left: p.x - stroke, top: p.y - stroke, right: p.x + stroke, bottom: p.y + stroke }))];
  const left = Math.floor(Math.min(...ink.map((b) => b.left)));
  const top = Math.floor(Math.min(...ink.map((b) => b.top)));
  const right = Math.ceil(Math.max(...ink.map((b) => b.right)));
  const bottom = Math.ceil(Math.max(...ink.map((b) => b.bottom)));
  const r = (n: number) => Math.round(n * 10) / 10;
  const p = (q: Point) => `${r(q.x - left)} ${r(q.y - top)}`;
  return {
    ink,
    place: {
      dir: d.dir,
      scale,
      onStage: d.onStage,
      x: Math.round(left - grid.left),
      y: Math.round(top - grid.top),
      width: right - left,
      height: bottom - top,
      curve: `M${p(s)} C${p(c1)} ${p(c2)} ${p(t)}`,
      head: `M${p(h1)} L${p(t)} L${p(h2)}`,
      labelX: Math.round(d.label.left - left),
      labelY: Math.round(d.label.top - top),
      nx: r(ux),
      ny: r(uy),
    },
  };
}

type Template = (l: TryMeLayout, target: Box, scale: number, size: { width: number; height: number }) => Drawn | null;

/** Step 1, beside the copy: right at the agent, from below-left (TIN-1103's curve, scaled). */
const agentRight: Template = (l, target, k, size) => {
  const t = { x: l.stage.left - TRY_ME_CLEAR, y: (target.top + target.bottom) / 2 };
  const s = { x: t.x - 104 * k, y: t.y + 40 * k };
  const label = { left: s.x - 2 * k - size.width, top: s.y - size.height / 2, right: s.x - 2 * k, bottom: s.y + size.height / 2 };
  return { dir: "right", scale: k, onStage: false, label, s, c1: { x: s.x + 30 * k, y: s.y + 12 * k }, c2: { x: s.x + 56 * k, y: s.y - 34 * k }, t };
};

/** Step 1, the stage under the copy: down at the stage, beside the video link, or as far right as the grid allows. */
const agentDown =
  (side: "anchor" | "end"): Template =>
  (l, _target, k, size) => {
    if (!l.anchor) return null;
    const reach = size.width + 2 * k + 22 * k + 8 * k;
    const labelLeft = side === "anchor" ? l.anchor.right + 20 : l.grid.right - reach;
    const s = { x: labelLeft + size.width + 2 * k, y: l.stage.top - TRY_ME_CLEAR - 38 * k };
    const t = { x: s.x + 22 * k, y: l.stage.top - TRY_ME_CLEAR };
    const label = { left: labelLeft, top: s.y - size.height / 2, right: labelLeft + size.width, bottom: s.y + size.height / 2 };
    return { dir: "down", scale: k, onStage: false, label, s, c1: { x: s.x + 22 * k, y: s.y - 4 * k }, c2: { x: s.x + 30 * k, y: s.y + 10 * k }, t };
  };

/**
 * Steps 2 and 3, beside the copy: from above the copy's first line, over the stage's top edge, down onto the target.
 * Only for a target near that edge (TRY_ME_OVER_REACH): a target lower in the stage (the agent window under the chart,
 * around 1024 px) would take the arc across the app window, so the next way in is used instead.
 */
const over: Template = (l, target, k, size) => {
  if (target.top - l.stage.top > TRY_ME_OVER_REACH) return null;
  const label = { left: l.stage.left - 8 - size.width, top: l.stage.top + 2, right: l.stage.left - 8, bottom: l.stage.top + 2 + size.height };
  const s = { x: label.right + 6 * k, y: (label.top + label.bottom) / 2 };
  const t = { x: target.left + 14 * k, y: target.top - 8 };
  const peak = Math.min(s.y, t.y) - 30 * k;
  return { dir: "over", scale: k, onStage: false, label, s, c1: { x: s.x + (t.x - s.x) * 0.3, y: peak }, c2: { x: t.x - 40 * k, y: peak }, t };
};

/**
 * Steps 2 and 3, inside the stage: up at the target from just under it. `side` is where the label sits from the tip:
 * "left" and "right" go outward from the target's near corner; "in" stays over the target's width, from its left corner.
 */
type Side = "left" | "right" | "in";
const tipX = (target: Box, side: Side, k: number) => (side === "right" ? target.right - 16 * k : target.left + 16 * k);
const under =
  (side: Side): Template =>
  (_l, target, k, size) => {
    const pill = { width: size.width + 2 * PILL_PAD.x * k, height: size.height + 2 * PILL_PAD.y * k };
    const sign = side === "left" ? -1 : 1;
    const t = { x: tipX(target, side, k), y: target.bottom + 8 };
    const s = { x: t.x + sign * 34 * k, y: t.y + 40 * k };
    const lx = side === "left" ? s.x - 4 * k - pill.width : s.x + 4 * k;
    const label = { left: lx, top: s.y - pill.height / 2, right: lx + pill.width, bottom: s.y + pill.height / 2 };
    return { dir: "up", scale: k, onStage: true, label, s, c1: { x: s.x - sign * 18 * k, y: s.y }, c2: { x: t.x, y: t.y + 22 * k }, t };
  };

/** Steps 2 and 3, inside the stage: down onto the target from just over it (`side` as for `under`). */
const above =
  (side: Side): Template =>
  (_l, target, k, size) => {
    const pill = { width: size.width + 2 * PILL_PAD.x * k, height: size.height + 2 * PILL_PAD.y * k };
    const sign = side === "left" ? -1 : 1;
    const t = { x: tipX(target, side, k), y: target.top - 8 };
    const s = { x: t.x + sign * 34 * k, y: t.y - 40 * k };
    const lx = side === "left" ? s.x - 4 * k - pill.width : s.x + 4 * k;
    const label = { left: lx, top: s.y - pill.height / 2, right: lx + pill.width, bottom: s.y + pill.height / 2 };
    return { dir: "into", scale: k, onStage: true, label, s, c1: { x: s.x - sign * 18 * k, y: s.y }, c2: { x: t.x, y: t.y - 22 * k }, t };
  };

/** Each step's ways in, in order of preference, beside the copy and with the stage stacked under it. */
const TEMPLATES: Record<TryMeStep, { beside: Template[]; stacked: Template[] }> = {
  agent: { beside: [agentRight], stacked: [agentDown("anchor"), agentDown("end")] },
  own: { beside: [over, under("left"), under("in")], stacked: [under("left"), under("in"), under("right"), above("in")] },
  connect: { beside: [over, above("left"), above("in")], stacked: [above("left"), above("in"), above("right"), under("in")] },
};

/**
 * Where `step`'s arrow goes: the first way in and the largest size whose ink stays inside the grid (and no higher than
 * TRY_ME_ABOVE over it), clear of the copy's text and of the target (and, for the first arrow, of the whole stage). Null
 * where none fits, or with nothing to point at.
 */
export function placeTryMe(step: TryMeStep, l: TryMeLayout): TryMePlace | null {
  const beside = l.stage.left >= l.copy.right;
  if (!l.target && !(step === "agent" && beside)) return null;
  const target = l.target ?? { left: l.stage.left, top: l.stage.top + (l.stage.bottom - l.stage.top) * 0.8, right: l.stage.left, bottom: l.stage.top + (l.stage.bottom - l.stage.top) * 0.8 };
  const base = TRY_ME_LABELS[labelFor(step)];
  for (const template of TEMPLATES[step][beside ? "beside" : "stacked"]) {
    for (const scale of beside ? TRY_ME_SCALES : TRY_ME_STACKED_SCALES) {
      const drawn = template(l, target, scale, { width: base.width * scale, height: base.height * scale });
      if (!drawn) continue;
      const { place, ink } = draw(drawn, l.grid);
      const box = { left: l.grid.left + place.x, top: l.grid.top + place.y, right: l.grid.left + place.x + place.width, bottom: l.grid.top + place.y + place.height };
      if (box.left < l.grid.left || box.right > l.grid.right || box.top < l.grid.top - TRY_ME_ABOVE) continue;
      if (step === "agent" ? overlaps(box, l.stage, 0) : ink.some((part) => overlaps(part, target, 2))) continue;
      if (ink.some((part) => l.texts.some((t) => overlaps(part, t, TEXT_PAD)))) continue;
      return place;
    }
  }
  return null;
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** What `step` points at, read from the stage's markup (and, for the Connect box, from what the live frame said). */
function targetOf(step: TryMeStep, stage: Element, store: TryMe): Box | null {
  if (step === "agent") {
    const mark = stage.querySelector("apc-agents [data-apc-mark]");
    return mark ? boxOf(mark) : null;
  }
  if (step === "own") {
    // While the stage's own "Now use your own agent" panel is open, the panel says it: no arrow.
    if (stage.querySelector(".hero-offer")) return null;
    const own = stage.querySelector(".hero-agent .hero-own");
    return own ? boxOf(own) : null;
  }
  const frame = stage.querySelector('.hero-live[data-phase="ready"] iframe.hero-live-frame');
  const box = store.connectBox();
  if (!frame || !box) return null;
  const f = boxOf(frame);
  const left = Math.max(f.left, f.left + box.x);
  const top = Math.max(f.top, f.top + box.y);
  const right = Math.min(f.right, f.left + box.x + box.width);
  const bottom = Math.min(f.bottom, f.top + box.y + box.height);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** The hero's layout, read from HeroSection's markup. */
function readLayout(grid: Element, step: TryMeStep, store: TryMe): TryMeLayout | null {
  const copy = grid.querySelector(".landing-hero-copy");
  const stage = grid.querySelector(".landing-hero-stage");
  if (!copy || !stage) return null;
  const anchor = copy.querySelector(".landing-watch");
  return {
    grid: boxOf(grid),
    copy: boxOf(copy),
    stage: boxOf(stage),
    target: targetOf(step, stage, store),
    anchor: anchor ? boxOf(anchor) : null,
    texts: [...copy.querySelectorAll("h1, p, .landing-cta-row > *, .landing-watch")].map(boxOf),
  };
}

const samePlace = (a: TryMePlace | null, b: TryMePlace | null) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

/**
 * The arrow, a child of HeroSection's grid. Drawn while its step is `shown` (and fading out once `gone`), placed against
 * the copy, the stage and its target on every change of their size or of the stage's content.
 */
export function TryMeArrow(props: { store?: TryMe }): ReactElement | null {
  const store = props.store ?? tryMe;
  const view = useSyncExternalStore(store.subscribe, store.view, store.view);
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<TryMePlace | null>(null);
  const live = view.phase === "shown";
  const step = view.step;

  useLayoutEffect(() => {
    const el = ref.current;
    const grid = el?.parentElement;
    if (!live || !grid) return;
    let queued = 0;
    const measure = () => {
      queued = 0;
      const layout = readLayout(grid, step, store);
      const next = layout ? placeTryMe(step, layout) : null;
      setPlace((prev) => (samePlace(prev, next) ? prev : next));
    };
    const soon = () => {
      if (!queued) queued = requestAnimationFrame(measure);
    };
    measure();
    const watch = new ResizeObserver(soon);
    watch.observe(grid);
    for (const part of grid.querySelectorAll(".landing-hero-copy, .landing-hero-stage")) watch.observe(part);
    // The stage changes under the arrow: its panel opens and closes, the live frame replaces the demo and gets ready.
    const stage = grid.querySelector(".landing-hero-stage");
    const changes = new MutationObserver(soon);
    if (stage) changes.observe(stage, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-phase", "class"] });
    const unsubscribe = store.subscribe(soon);
    addEventListener("resize", soon);
    return () => {
      if (queued) cancelAnimationFrame(queued);
      watch.disconnect();
      changes.disconnect();
      unsubscribe();
      removeEventListener("resize", soon);
    };
  }, [live, step, store]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !place) return;
    const set = (name: string, value: string) => el.style.setProperty(name, value);
    set("--try-x", `${place.x}px`);
    set("--try-y", `${place.y}px`);
    set("--try-w", `${place.width}px`);
    set("--try-h", `${place.height}px`);
    set("--try-lx", `${place.labelX}px`);
    set("--try-ly", `${place.labelY}px`);
    set("--try-s", String(place.scale));
    set("--try-nx", `${place.nx * 5}px`);
    set("--try-ny", `${place.ny * 5}px`);
  }, [place]);

  if (view.phase === "waiting") return null;
  const label = labelFor(step);
  const mask = `try-me-mask-${step}`;
  const width = place?.width ?? 0;
  const height = place?.height ?? 0;
  // Keyed by step: each step's arrow draws itself in again, where the last one was.
  return h(
    "div",
    {
      key: step,
      ref,
      className: view.phase === "gone" ? "try-me is-gone" : "try-me",
      "data-dir": place?.dir ?? "right",
      "data-step": step,
      "data-text-mask": "",
      "aria-hidden": "true",
      hidden: !place,
    },
    h(
      "svg",
      { className: "try-me-svg", width, height, viewBox: `0 0 ${width} ${height}`, fill: "none", focusable: "false" },
      // The dashed curve shows through a solid copy of itself that draws in (stroke-dashoffset): a dashed line drawn by hand.
      h("defs", null, h("mask", { id: mask, maskUnits: "userSpaceOnUse", x: -10, y: -10, width: width + 20, height: height + 20 }, h("path", { className: "try-me-reveal", d: place?.curve ?? "M0 0", pathLength: 1 }))),
      h("path", { className: "try-me-curve", d: place?.curve ?? "M0 0", mask: `url(#${mask})` }),
      h("path", { className: "try-me-head", d: place?.head ?? "M0 0" }),
    ),
    h("span", { className: place?.onStage ? "try-me-label is-pill" : "try-me-label", "data-text-mask": "" }, label),
  );
}
