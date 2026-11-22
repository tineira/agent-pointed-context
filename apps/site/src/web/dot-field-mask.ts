/**
 * DOM text-region tracker for the dot field's glow mask. Reads `getBoundingClientRect()` from
 * shared text containers only on mount, resize, theme/visibility/motion resume, and DOM/transition
 * changes — never during scroll and never inside `drawFrame`. Stores full-document rectangles
 * (with transform-union for `.rv-wait` scroll reveals, extra heading overhang padding, and
 * fixed/sticky clamping metadata) alongside the `scrollY` at measure time so `createDotField`
 * projects them accurately on every frame during scrolling with zero DOM reads.
 */
import {
  normalizeTextRects,
  TEXT_MASK_HEADING_PAD_PX,
  TEXT_MASK_MARGIN_PX,
  TEXT_MASK_PAD_PX,
  TEXT_MASK_SELECTOR,
  type TextRect,
} from "./dot-field.ts";

export interface ComputedStyleLike {
  readonly position?: string;
  readonly top?: string;
  readonly transform?: string;
  readonly paddingTop?: string;
  readonly paddingBottom?: string;
  readonly borderTopWidth?: string;
  readonly borderBottomWidth?: string;
}

export interface RectReadable {
  getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number };
  readonly tagName?: string;
  readonly parentElement?: RectReadable | null;
  closest?: (selector: string) => unknown;
}

export interface QueryableRoot {
  querySelectorAll: (selector: string) => Iterable<RectReadable>;
}

export interface MeasureOptions {
  selector?: string;
  margin?: number;
  pad?: number;
  headingPad?: number;
  /** Vertically cull rects to the current viewport (default false so scrolling needs no re-measure). */
  cullY?: boolean;
  /** Override `window.getComputedStyle` for deterministic unit tests. */
  getComputedStyle?: (el: RectReadable) => ComputedStyleLike | null;
}

const HEADING_TAG = /^H[1-6]$/i;
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const ZERO_TRANSLATE = { tx: 0, ty: 0 } as const;

/**
 * Parse the 2D translation `(tx, ty)` in CSS px from a computed CSS `transform` string
 * (`matrix(...)` or `matrix3d(...)`). Returns `{ tx: 0, ty: 0 }` for `"none"` or unrecognized forms.
 */
export function parseTranslateTransform(transform: string | null | undefined): { tx: number; ty: number } {
  if (!transform || transform === "none") return ZERO_TRANSLATE;
  const m2d = transform.match(/^matrix\(([^)]+)\)$/);
  if (m2d) {
    const parts = m2d[1]!.split(",").map((s) => Number(s.trim()));
    if (parts.length === 6 && Number.isFinite(parts[4]) && Number.isFinite(parts[5])) {
      return { tx: parts[4]!, ty: parts[5]! };
    }
  }
  const m3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (m3d) {
    const parts = m3d[1]!.split(",").map((s) => Number(s.trim()));
    if (parts.length === 16 && Number.isFinite(parts[12]) && Number.isFinite(parts[13])) {
      return { tx: parts[12]!, ty: parts[13]! };
    }
  }
  return ZERO_TRANSLATE;
}

function isHeadingElement(el: RectReadable): boolean {
  if (el.tagName && HEADING_TAG.test(el.tagName)) return true;
  if (typeof el.closest === "function") return Boolean(el.closest(HEADING_SELECTOR));
  return false;
}

type PositionedInfo =
  | { readonly kind: "none" }
  | { readonly kind: "fixed" }
  | { readonly kind: "sticky"; readonly el: RectReadable; readonly stickyTop: number };

const NONE_POS: PositionedInfo = { kind: "none" };

interface StickyMetrics {
  readonly sUntransTop: number;
  readonly sFlowTop0: number;
  readonly sHeight: number;
  readonly stickyTop: number;
  readonly cbBottom0: number;
}

/**
 * Read and normalize text rectangles under `root` in viewport CSS pixels at the current scroll
 * position. By default keeps rects across the full document height (`cullY = false`), unions any
 * active CSS translation (such as `.rv-wait`'s `translateY(22px)`) with the untransformed resting
 * box so reveal transitions stay capped on every frame, applies `headingPad` to headings, and
 * records fixed/sticky scroll bounds so `drawFrame` tracks scrolling with zero DOM reads.
 */
export function measureTextRects(
  root: QueryableRoot,
  viewport: { width: number; height: number },
  options?: MeasureOptions,
): TextRect[] {
  const selector = options?.selector ?? TEXT_MASK_SELECTOR;
  const margin = options?.margin ?? TEXT_MASK_MARGIN_PX;
  const pad = options?.pad ?? TEXT_MASK_PAD_PX;
  const headingPad = options?.headingPad ?? TEXT_MASK_HEADING_PAD_PX;
  const cullY = options?.cullY ?? false;
  const readStyle: (el: RectReadable) => ComputedStyleLike | null =
    options?.getComputedStyle ??
    (typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? (el) => (typeof Element !== "undefined" && el instanceof Element ? window.getComputedStyle(el) : null)
      : () => null);

  const translateCache = new Map<RectReadable, { tx: number; ty: number }>();
  const posCache = new Map<RectReadable, PositionedInfo>();
  const stickyMetricsCache = new Map<RectReadable, StickyMetrics | null>();

  const getTranslate = (node: RectReadable): { tx: number; ty: number } => {
    const cached = translateCache.get(node);
    if (cached) return cached;
    const own = parseTranslateTransform(readStyle(node)?.transform);
    const parent = (node as unknown) !== root ? (node.parentElement ?? null) : null;
    const anc = parent ? getTranslate(parent) : ZERO_TRANSLATE;
    const total = own.tx === 0 && own.ty === 0 ? anc : { tx: anc.tx + own.tx, ty: anc.ty + own.ty };
    translateCache.set(node, total);
    return total;
  };

  const getPositioned = (node: RectReadable): PositionedInfo => {
    const cached = posCache.get(node);
    if (cached) return cached;
    const style = readStyle(node);
    let info: PositionedInfo | null = null;
    if (style?.position === "fixed") {
      info = { kind: "fixed" };
    } else if (style?.position === "sticky") {
      const stickyTop = Number.parseFloat(style.top ?? "");
      if (Number.isFinite(stickyTop)) {
        info = { kind: "sticky", el: node, stickyTop };
      }
    }
    if (!info) {
      const parent = (node as unknown) !== root ? (node.parentElement ?? null) : null;
      info = parent ? getPositioned(parent) : NONE_POS;
    }
    posCache.set(node, info);
    return info;
  };

  const getStickyMetrics = (stickyEl: RectReadable, stickyTop: number): StickyMetrics | null => {
    if (stickyMetricsCache.has(stickyEl)) return stickyMetricsCache.get(stickyEl)!;
    const parent = stickyEl.parentElement ?? null;
    if (!parent) {
      stickyMetricsCache.set(stickyEl, null);
      return null;
    }
    const sRect = stickyEl.getBoundingClientRect();
    const sTrans = getTranslate(stickyEl);
    const sUntransTop = sRect.top - sTrans.ty;
    const sUntransBottom = sRect.bottom - sTrans.ty;
    const sHeight = sUntransBottom - sUntransTop;
    const pRect = parent.getBoundingClientRect();
    const pTrans = getTranslate(parent);
    const pStyle = readStyle(parent);
    const pPadTop =
      (Number.parseFloat(pStyle?.paddingTop ?? "0") || 0) +
      (Number.parseFloat(pStyle?.borderTopWidth ?? "0") || 0);
    const pPadBot =
      (Number.parseFloat(pStyle?.paddingBottom ?? "0") || 0) +
      (Number.parseFloat(pStyle?.borderBottomWidth ?? "0") || 0);
    const cbTop0 = pRect.top - pTrans.ty + pPadTop;
    const cbBottom0 = pRect.bottom - pTrans.ty - pPadBot;
    const stuckTop = sUntransTop <= stickyTop + 0.5;
    const stuckBottom = sUntransBottom >= cbBottom0 - 0.5;
    const sFlowTop0 = !stuckTop && !stuckBottom ? sUntransTop : cbTop0;
    const metrics: StickyMetrics = { sUntransTop, sFlowTop0, sHeight, stickyTop, cbBottom0 };
    stickyMetricsCache.set(stickyEl, metrics);
    return metrics;
  };

  const raw: TextRect[] = [];
  for (const el of root.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.right) ||
      !Number.isFinite(r.bottom) ||
      w <= 0 ||
      h <= 0 ||
      (w <= 1 && h <= 1)
    ) {
      continue;
    }

    // Union current and untransformed boxes so `.rv-wait` / mid-transition `.rv-in` blocks stay
    // masked across their entire rise into place without waiting for `transitionend`.
    const { tx, ty } = getTranslate(el);
    let left = Math.min(r.left, r.left - tx);
    let top = Math.min(r.top, r.top - ty);
    let right = Math.max(r.right, r.right - tx);
    let bottom = Math.max(r.bottom, r.bottom - ty);

    const extraPad = isHeadingElement(el) ? Math.max(0, headingPad - pad) : 0;
    if (extraPad > 0) {
      left -= extraPad;
      top -= extraPad;
      right += extraPad;
      bottom += extraPad;
    }

    const pos = getPositioned(el);
    if (pos.kind === "fixed") {
      raw.push({ left, top, right, bottom, fixed: true });
    } else if (pos.kind === "sticky") {
      const m = getStickyMetrics(pos.el, pos.stickyTop);
      if (m) {
        const offsetFromS = top - m.sUntransTop;
        const elH = bottom - top;
        const flowTop = m.sFlowTop0 + offsetFromS;
        raw.push({
          left,
          top: flowTop,
          right,
          bottom: flowTop + elH,
          stickyMinTop: m.stickyTop + offsetFromS,
          stickyMaxTop: m.cbBottom0 - m.sHeight + offsetFromS,
        });
      } else {
        raw.push({ left, top, right, bottom });
      }
    } else {
      raw.push({ left, top, right, bottom });
    }
  }
  return normalizeTextRects(raw, viewport, margin, pad, cullY);
}

export interface FrameThrottledMeasureEnv {
  measure: () => void;
  isActive: () => boolean;
  requestFrame?: (cb: (now: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface FrameThrottledMeasure {
  /** Measure synchronously (e.g. at mount, resize, or before resuming from hidden/reduced-motion). */
  measureNow: () => void;
  /** Coalesce repeated layout/observer triggers into at most one measure on the next frame. */
  schedule: () => void;
  /** Cancel any pending frame and ignore future schedule calls. */
  stop: () => void;
}

/** Coalesces resize and observer notifications into at most one measurement per frame. */
export function createFrameThrottledMeasure(env: FrameThrottledMeasureEnv): FrameThrottledMeasure {
  const requestFrame = env.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = env.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  let rafId: number | null = null;
  let stopped = false;

  const cancel = () => {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
  };

  return {
    measureNow() {
      if (stopped || !env.isActive()) return;
      cancel();
      env.measure();
    },
    schedule() {
      if (stopped || !env.isActive() || rafId !== null) return;
      rafId = requestFrame(() => {
        rafId = null;
        if (!stopped && env.isActive()) env.measure();
      });
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}

export interface AttachTextMaskOptions {
  root: Element;
  getViewport: () => { width: number; height: number };
  getScrollY?: () => number;
  isActive: () => boolean;
  onRects: (rects: readonly TextRect[], scrollY: number) => void;
  selector?: string;
  margin?: number;
  pad?: number;
  headingPad?: number;
}

/**
 * Observe `root` for layout, DOM and reveal-transition changes and push normalized text rectangles
 * (with their measured `scrollY`) to `onRects`, throttled to one frame.
 */
export function attachTextMask(options: AttachTextMaskOptions): FrameThrottledMeasure {
  const scheduler = createFrameThrottledMeasure({
    isActive: options.isActive,
    measure: () => {
      const scrollY = options.getScrollY
        ? options.getScrollY()
        : typeof window !== "undefined"
          ? window.scrollY
          : 0;
      const rects = measureTextRects(options.root, options.getViewport(), {
        selector: options.selector,
        margin: options.margin,
        pad: options.pad,
        headingPad: options.headingPad,
      });
      options.onRects(rects, scrollY);
    },
  });

  const schedule = () => scheduler.schedule();

  const resizeObserver =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  resizeObserver?.observe(options.root);

  const mutationObserver =
    typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
  mutationObserver?.observe(options.root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "data-text-mask"],
  });

  const onTransitionEnd = (event: Event) => {
    const prop = (event as TransitionEvent).propertyName;
    if (!prop || prop === "transform" || prop === "height" || prop === "width") {
      schedule();
    }
  };
  options.root.addEventListener("transitionend", onTransitionEnd, { passive: true });

  let fontsActive = true;
  if (typeof document !== "undefined" && document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (fontsActive) schedule();
    });
  }

  return {
    measureNow: () => scheduler.measureNow(),
    schedule,
    stop() {
      fontsActive = false;
      scheduler.stop();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      options.root.removeEventListener("transitionend", onTransitionEnd);
    },
  };
}
