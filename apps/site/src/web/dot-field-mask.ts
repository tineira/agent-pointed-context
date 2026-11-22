/**
 * DOM text-region tracker for the dot field's glow mask. Reads `getBoundingClientRect()` from
 * shared text containers only on mount, resize, scroll and layout changes — throttled to at most
 * one animation frame — and hands a compact viewport-culled rectangle array to `createDotField`
 * so the draw loop never touches the DOM.
 */
import {
  normalizeTextRects,
  TEXT_MASK_MARGIN_PX,
  TEXT_MASK_PAD_PX,
  TEXT_MASK_SELECTOR,
  type TextRect,
} from "./dot-field.ts";

export interface RectReadable {
  getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number };
}

export interface QueryableRoot {
  querySelectorAll: (selector: string) => Iterable<RectReadable>;
}

export interface MeasureOptions {
  selector?: string;
  margin?: number;
  pad?: number;
}

/** Read and normalize all visible text rectangles under `root` in viewport CSS pixels. */
export function measureTextRects(
  root: QueryableRoot,
  viewport: { width: number; height: number },
  options?: MeasureOptions,
): TextRect[] {
  const selector = options?.selector ?? TEXT_MASK_SELECTOR;
  const margin = options?.margin ?? TEXT_MASK_MARGIN_PX;
  const pad = options?.pad ?? TEXT_MASK_PAD_PX;
  const raw: TextRect[] = [];
  for (const el of root.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    raw.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return normalizeTextRects(raw, viewport, margin, pad);
}

export interface FrameThrottledMeasureEnv {
  measure: () => void;
  isActive: () => boolean;
  requestFrame?: (cb: (now: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface FrameThrottledMeasure {
  /** Measure synchronously (e.g. once at mount before the first draw). */
  measureNow: () => void;
  /** Coalesce repeated scroll/resize/layout triggers into at most one measure on the next frame. */
  schedule: () => void;
  /** Cancel any pending frame and ignore future schedule calls. */
  stop: () => void;
}

/** Coalesces scroll, resize and observer notifications into at most one measurement per frame. */
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
  isActive: () => boolean;
  onRects: (rects: readonly TextRect[]) => void;
  selector?: string;
  margin?: number;
  pad?: number;
}

/**
 * Observe `root` for layout, DOM and reveal-transition changes and push normalized text rectangles
 * to `onRects`, throttled to one frame. Call `schedule()` from window scroll/resize handlers.
 */
export function attachTextMask(options: AttachTextMaskOptions): FrameThrottledMeasure {
  const scheduler = createFrameThrottledMeasure({
    isActive: options.isActive,
    measure: () => {
      const rects = measureTextRects(options.root, options.getViewport(), {
        selector: options.selector,
        margin: options.margin,
        pad: options.pad,
      });
      options.onRects(rects);
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
