/**
 * The moving dot field behind the site pages: a 30 px dot grid blitted from an offscreen canvas
 * with pointer glow, a slow wandering light, subtle scroll parallax, and faint outer-gutter
 * identifier tags on wide screens. One palette per theme.
 *
 * Guards:
 * - One requestAnimationFrame loop at a time, paused while document.hidden.
 * - A frame-time guard drops to one static still frame when sustained frames are slow.
 * - Never draws at zero size (hidden tabs can report 0x0, where drawImage throws).
 * - Draws one static still frame under prefers-reduced-motion: reduce (never starts rAF).
 */
import type { Theme } from "./theme.ts";

export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface DotFieldPaletteSpec {
  /** Base 30 px grid dot color and alpha. */
  readonly dot: RgbaColor;
  /** Low-intensity glow color (k = 0). */
  readonly glowMin: RgbaColor;
  /** Hard-capped peak glow color (k = 1) inside and over text regions; contrast tests read this. */
  readonly glowMax: RgbaColor;
  /** Peak glow color (k = 1) in open space outside text regions and their fade margin. */
  readonly glowPeak: RgbaColor;
  /** Outer-gutter tag ring, center dot, and label RGB + hard alpha caps. */
  readonly ringRgb: readonly [number, number, number];
  readonly ringAlphaMax: number;
  readonly ringDotAlphaMax: number;
  readonly tagRgb: readonly [number, number, number];
  readonly tagAlphaMax: number;
}

/**
 * Single source of truth for every color and alpha the dot field can paint.
 * Imported directly by the contrast tests: inside text regions the mask caps glow at glowMax so
 * any change that breaches 4.5:1 fails tests, while open space outside the mask can rise to glowPeak.
 */
export const DOT_FIELD_SPECS: Record<Theme, DotFieldPaletteSpec> = {
  dark: {
    dot: { r: 255, g: 255, b: 255, a: 0.085 },
    glowMin: { r: 255, g: 190, b: 90, a: 0.06 },
    glowMax: { r: 235, g: 136, b: 24, a: 0.2 },
    glowPeak: { r: 235, g: 136, b: 24, a: 0.52 },
    ringRgb: [235, 136, 24],
    ringAlphaMax: 0.12,
    ringDotAlphaMax: 0.2,
    tagRgb: [190, 200, 216],
    tagAlphaMax: 0.08,
  },
  light: {
    dot: { r: 60, g: 54, b: 38, a: 0.12 },
    glowMin: { r: 216, g: 128, b: 56, a: 0.06 },
    glowMax: { r: 224, g: 122, b: 46, a: 0.22 },
    glowPeak: { r: 210, g: 102, b: 34, a: 0.55 },
    ringRgb: [224, 122, 46],
    ringAlphaMax: 0.14,
    ringDotAlphaMax: 0.22,
    tagRgb: [84, 80, 66],
    tagAlphaMax: 0.09,
  },
};

/**
 * Axis-aligned rectangle in CSS pixels describing a text region to keep capped at glowMax.
 * Coordinates are measured at a reference `scrollY` (recorded by `setTextRects`) and projected to
 * the current viewport per frame using `scrollDeltaY = currentScrollY - measuredScrollY`:
 * - default (document flow): shifts vertically by `-scrollDeltaY`;
 * - `fixed: true`: stays pinned in viewport coordinates;
 * - `stickyMinTop` + `stickyMaxTop`: shifts by `-scrollDeltaY` clamped to
 *   `[stickyMinTop, stickyMaxTop - scrollDeltaY]` so `position: sticky` elements track with zero
 *   DOM reads during scroll.
 */
export interface TextRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly fixed?: boolean;
  readonly stickyMinTop?: number;
  readonly stickyMaxTop?: number;
}

/** Base and maximum glowing dot square size (CSS px) drawn by `drawGlows`. */
export const DOT_BASE_SIZE_PX = 1.2;
export const DOT_GLOW_MAX_SIZE_PX = 3.4;

/** Smooth fade distance (CSS px) outside each text rectangle from glowMax to glowPeak. */
export const TEXT_MASK_MARGIN_PX = 32;

/**
 * Safety padding (CSS px) added to measured DOM text rectangles so body italic/ascender overhangs
 * and a glowing dot's half-width (`DOT_GLOW_MAX_SIZE_PX / 2 = 1.7 px`) never bleed above glowMax
 * onto any glyph pixel.
 */
export const TEXT_MASK_PAD_PX = 6;

/**
 * Larger safety padding (CSS px) for headings (`h1`–`h6` and their inline children such as italic
 * Georgia `em` inside tight `line-height: 0.98` display headlines), where glyph ink can overhang
 * the element's border box by up to ~10 px plus the glowing dot's 1.7 px half-width.
 */
export const TEXT_MASK_HEADING_PAD_PX = 14;

/**
 * Shared selector covering text-bearing elements across every page that mounts SiteBackdrop
 * (landing, /try, /build) plus an opt-in `[data-text-mask]` hook for custom regions.
 */
export const TEXT_MASK_SELECTOR = [
  "[data-text-mask]",
  "header.site-nav",
  "figure.hero-stage",
  "h1, h2, h3, h4, h5, h6",
  "p, li, figcaption, blockquote, pre, code, dt, dd, th, td, label, summary, legend, caption",
  "a, button, em, small, b, strong",
  "svg text",
  ".kicker, .landing-who, .try-ask, .try-host, .try-join-app, .try-ex-row, .build-chip, .build-code-idx, .landing-conn",
].join(", ");

/** Euclidean distance from (x, y) to the axis-aligned rectangle (0 inside or on its edges). */
export function distanceToRect(x: number, y: number, rect: TextRect): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

/**
 * Openness factor in [0, 1] at viewport point (x, y):
 * - 0 anywhere inside or on the edge of any text rectangle (capped at glowMax);
 * - monotonically increasing smoothstep across (0, margin) outside the nearest rectangle;
 * - 1 at or beyond margin from every rectangle (or when there are no rectangles), allowing glowPeak.
 */
export function textMaskOpenness(
  x: number,
  y: number,
  rects: readonly TextRect[],
  margin: number = TEXT_MASK_MARGIN_PX,
): number {
  if (rects.length === 0) return 1;
  if (margin <= 0) {
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 0;
    }
    return 1;
  }
  const marginSq = margin * margin;
  let minDistSq = marginSq;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (dx >= margin) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (dy >= margin) continue;
    const dSq = dx * dx + dy * dy;
    if (dSq === 0) return 0;
    if (dSq < minDistSq) minDistSq = dSq;
  }
  if (minDistSq >= marginSq) return 1;
  const t = Math.sqrt(minDistSq) / margin;
  return t * t * (3 - 2 * t);
}

function sameScrollBehavior(a: TextRect, b: TextRect): boolean {
  if (Boolean(a.fixed) !== Boolean(b.fixed)) return false;
  const aSticky = a.stickyMinTop !== undefined && a.stickyMaxTop !== undefined;
  const bSticky = b.stickyMinTop !== undefined && b.stickyMaxTop !== undefined;
  if (aSticky !== bSticky) return false;
  if (!aSticky) return true;
  return (
    Math.abs((a.stickyMinTop! - a.top) - (b.stickyMinTop! - b.top)) < 0.01 &&
    Math.abs((a.stickyMaxTop! - a.top) - (b.stickyMaxTop! - b.top)) < 0.01
  );
}

/**
 * Project cached text rectangles from their measured `scrollY` into the current viewport at
 * `currentScrollY` (`scrollDeltaY = currentScrollY - measuredScrollY`), culling any rectangle
 * outside `[-margin, viewportHeight + margin]`. Pure math — zero DOM reads — so every frame
 * during scrolling has exact mask coordinates.
 */
export function projectTextRects(
  rects: readonly TextRect[],
  scrollDeltaY: number,
  viewportHeight: number,
  margin: number = TEXT_MASK_MARGIN_PX,
): TextRect[] {
  if (rects.length === 0 || viewportHeight <= 0) return [];
  const safeMargin = Math.max(0, margin);
  const out: TextRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    let top: number;
    let bottom: number;
    if (r.fixed) {
      top = r.top;
      bottom = r.bottom;
    } else if (r.stickyMinTop !== undefined && r.stickyMaxTop !== undefined) {
      const h = r.bottom - r.top;
      top = Math.min(r.stickyMaxTop - scrollDeltaY, Math.max(r.stickyMinTop, r.top - scrollDeltaY));
      bottom = top + h;
    } else {
      top = r.top - scrollDeltaY;
      bottom = r.bottom - scrollDeltaY;
    }
    if (bottom + safeMargin < 0 || top - safeMargin > viewportHeight) continue;
    out.push({ left: r.left, top, right: r.right, bottom });
  }
  return out;
}

/**
 * Filter, pad, cull and deduplicate raw DOM rectangles into the compact list stored between layout
 * changes. Removing any rectangle contained in another with the same scroll behavior preserves
 * exact mask distances at every scroll position.
 */
export function normalizeTextRects(
  raw: readonly TextRect[],
  viewport: { width: number; height: number },
  margin: number = TEXT_MASK_MARGIN_PX,
  pad: number = TEXT_MASK_PAD_PX,
  cullY = true,
): TextRect[] {
  if (viewport.width <= 0 || viewport.height <= 0 || raw.length === 0) return [];
  const safeMargin = Math.max(0, margin);
  const safePad = Math.max(0, pad);
  const visible: TextRect[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    if (!Number.isFinite(r.left) || !Number.isFinite(r.top) || !Number.isFinite(r.right) || !Number.isFinite(r.bottom)) {
      continue;
    }
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    // Skip zero-sized and 1x1 visually hidden (sr-only) elements.
    if (w <= 0 || h <= 0 || (w <= 1 && h <= 1)) continue;
    const left = r.left - safePad;
    const top = r.top - safePad;
    const right = r.right + safePad;
    const bottom = r.bottom + safePad;
    if (right + safeMargin < 0 || left - safeMargin > viewport.width) continue;
    if (cullY && (bottom + safeMargin < 0 || top - safeMargin > viewport.height)) continue;
    if (r.fixed) {
      visible.push({ left, top, right, bottom, fixed: true });
    } else if (
      r.stickyMinTop !== undefined &&
      r.stickyMaxTop !== undefined &&
      Number.isFinite(r.stickyMinTop) &&
      Number.isFinite(r.stickyMaxTop)
    ) {
      visible.push({
        left,
        top,
        right,
        bottom,
        stickyMinTop: r.stickyMinTop - safePad,
        stickyMaxTop: r.stickyMaxTop - safePad,
      });
    } else {
      visible.push({ left, top, right, bottom });
    }
  }
  if (visible.length <= 1) return visible;

  const kept: TextRect[] = [];
  for (let i = 0; i < visible.length; i++) {
    const cand = visible[i]!;
    let covered = false;
    for (let j = 0; j < visible.length; j++) {
      if (i === j) continue;
      const other = visible[j]!;
      if (!sameScrollBehavior(other, cand)) continue;
      if (
        other.left <= cand.left &&
        other.top <= cand.top &&
        other.right >= cand.right &&
        other.bottom >= cand.bottom
      ) {
        const same =
          other.left === cand.left &&
          other.top === cand.top &&
          other.right === cand.right &&
          other.bottom === cand.bottom;
        if (!same || j < i) {
          covered = true;
          break;
        }
      }
    }
    if (!covered) kept.push(cand);
  }
  return kept;
}

/** Glow alpha for light intensity `k` in [0, 1] and mask openness `open` in [0, 1] (0 = text cap). */
export function glowAlpha(spec: DotFieldPaletteSpec, rawK: number, rawOpen = 0): number {
  const k = Math.min(1, Math.max(0, rawK));
  const open = Math.min(1, Math.max(0, rawOpen));
  const maxA = spec.glowMax.a + (spec.glowPeak.a - spec.glowMax.a) * open;
  return spec.glowMin.a + (maxA - spec.glowMin.a) * k;
}

export interface DotFieldPalette {
  dot: string;
  glow: (k: number, open?: number) => string;
  ring: string;
  ringAlphaMax: number;
  ringDotAlphaMax: number;
  tag: string;
  tagA: number;
}

function formatRgba(c: RgbaColor): string {
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

function buildPalette(spec: DotFieldPaletteSpec): DotFieldPalette {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  return {
    dot: formatRgba(spec.dot),
    glow: (rawK, rawOpen = 0) => {
      const k = Math.min(1, Math.max(0, rawK));
      const open = Math.min(1, Math.max(0, rawOpen));
      const peakR = spec.glowMax.r + (spec.glowPeak.r - spec.glowMax.r) * open;
      const peakG = spec.glowMax.g + (spec.glowPeak.g - spec.glowMax.g) * open;
      const peakB = spec.glowMax.b + (spec.glowPeak.b - spec.glowMax.b) * open;
      const r = lerp(spec.glowMin.r, peakR, k);
      const g = lerp(spec.glowMin.g, peakG, k);
      const b = lerp(spec.glowMin.b, peakB, k);
      const a = glowAlpha(spec, k, open);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    },
    ring: spec.ringRgb.join(","),
    ringAlphaMax: spec.ringAlphaMax,
    ringDotAlphaMax: spec.ringDotAlphaMax,
    tag: spec.tagRgb.join(","),
    tagA: spec.tagAlphaMax,
  };
}

export const DOT_FIELD_PALETTES: Record<Theme, DotFieldPalette> = {
  dark: buildPalette(DOT_FIELD_SPECS.dark),
  light: buildPalette(DOT_FIELD_SPECS.light),
};

const GAP = 30;
const TAG_MIN_WIDTH = 960;
const IDS = [
  "figure",
  "active_customers",
  "2026-03",
  "next: get_figure",
  "cus_0048",
  "post_013",
  "data-focus",
  "get_current_view",
  "wait_for_focus",
  "apc.json",
  "kind: figure",
  "next_args",
] as const;

export interface FrameGuard {
  /** Record a frame timestamp; returns true when sustained slow frames trigger static fallback. */
  record: (now: number) => boolean;
  /** Reset frame delta baseline (e.g. after tab hidden pause) without clearing degraded state. */
  resetTiming: () => void;
  readonly degraded: boolean;
}

export function createFrameGuard(options?: { slowFrameMs?: number; maxSlowFrames?: number }): FrameGuard {
  const slowFrameMs = options?.slowFrameMs ?? 50;
  const maxSlowFrames = options?.maxSlowFrames ?? 5;
  let lastNow: number | null = null;
  let slowStreak = 0;
  let degraded = false;

  return {
    get degraded() {
      return degraded;
    },
    resetTiming() {
      lastNow = null;
      slowStreak = 0;
    },
    record(now: number): boolean {
      if (degraded) return true;
      if (lastNow !== null) {
        const dt = now - lastNow;
        if (dt > slowFrameMs) {
          slowStreak += 1;
          if (slowStreak >= maxSlowFrames) degraded = true;
        } else {
          slowStreak = 0;
        }
      }
      lastNow = now;
      return degraded;
    },
  };
}

export interface CanvasContextLike {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (image: CanvasLike, dx: number, dy: number) => void;
  beginPath: () => void;
  arc: (x: number, y: number, radius: number, startAngle: number, endAngle: number) => void;
  stroke: () => void;
  fillText: (text: string, x: number, y: number) => void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext: (type: "2d") => CanvasContextLike | null;
}

export interface DotFieldEnv {
  canvas: CanvasLike;
  createOffscreenCanvas?: () => CanvasLike;
  getSize: () => { width: number; height: number; dpr: number };
  getScrollY: () => number;
  isHidden: () => boolean;
  isReducedMotion: () => boolean;
  getTheme: () => Theme;
  now?: () => number;
  random?: () => number;
  requestFrame?: (cb: (now: number) => void) => number;
  cancelFrame?: (id: number) => void;
  slowFrameMs?: number;
  maxSlowFrames?: number;
  /** Smooth fade margin (CSS px) outside text rectangles; defaults to TEXT_MASK_MARGIN_PX. */
  textMaskMargin?: number;
}

export interface DotFieldController {
  resize: () => void;
  start: () => void;
  stop: () => void;
  onVisibilityChange: () => void;
  onReducedMotionChange: () => void;
  onScroll: () => void;
  onPointerMove: (x: number, y: number) => void;
  onThemeChange: () => void;
  /**
   * Replace the cached text rectangles and the `scrollY` at which they were measured
   * (defaults to the current `env.getScrollY()`). `drawFrame` projects them to the current scroll
   * with zero DOM reads.
   */
  setTextRects: (rects: readonly TextRect[], measuredScrollY?: number) => void;
  isRunning: () => boolean;
  isDegraded: () => boolean;
}

interface GutterTag {
  gx: number;
  gy: number;
  text: string;
  born: number;
  side: boolean;
}

export function createDotField(env: DotFieldEnv): DotFieldController {
  const cx = env.canvas.getContext("2d");
  const base: CanvasLike = (env.createOffscreenCanvas ?? (() => document.createElement("canvas") as unknown as CanvasLike))();
  const bx = base.getContext("2d");
  const now = env.now ?? (() => performance.now());
  const random = env.random ?? (() => Math.random());
  const requestFrame = env.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = env.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const guard = createFrameGuard({ slowFrameMs: env.slowFrameMs, maxSlowFrames: env.maxSlowFrames });
  const textMaskMargin = env.textMaskMargin ?? TEXT_MASK_MARGIN_PX;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let hasBase = false;
  let rafId: number | null = null;
  let destroyed = false;
  let pointerX = 0;
  let pointerY = 0;
  let lastMove = -Infinity;
  let tags: GutterTag[] = [];
  let nextTag = 0;
  let textRects: readonly TextRect[] = [];
  let textRectsScrollY = 0;

  const isStatic = () => env.isReducedMotion() || guard.degraded;

  const canDraw = () =>
    cx !== null &&
    bx !== null &&
    hasBase &&
    width > 0 &&
    height > 0 &&
    env.canvas.width > 0 &&
    env.canvas.height > 0 &&
    base.width > 0 &&
    base.height > 0;

  function cancelLoop() {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    guard.resetTiming();
  }

  function palette(): DotFieldPalette {
    return DOT_FIELD_PALETTES[env.getTheme()] ?? DOT_FIELD_PALETTES.dark;
  }

  function rebuildBase(): boolean {
    if (!cx || !bx) return false;
    const measured = env.getSize();
    const w = Math.floor(measured.width);
    const h = Math.floor(measured.height);
    if (w <= 0 || h <= 0) {
      width = 0;
      height = 0;
      hasBase = false;
      return false;
    }
    dpr = Math.min(Math.max(measured.dpr || 1, 1), 2);
    width = w;
    height = h;
    env.canvas.width = Math.round(width * dpr);
    env.canvas.height = Math.round(height * dpr);
    base.width = Math.round(width * dpr);
    base.height = Math.round((height + GAP) * dpr);
    if (env.canvas.width <= 0 || env.canvas.height <= 0 || base.width <= 0 || base.height <= 0) {
      hasBase = false;
      return false;
    }
    bx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bx.clearRect(0, 0, width, height + GAP);
    bx.fillStyle = palette().dot;
    for (let y = GAP / 2; y < height + GAP; y += GAP) {
      for (let x = GAP / 2; x < width; x += GAP) {
        bx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
      }
    }
    hasBase = true;
    return true;
  }

  interface GlowLight {
    x: number;
    y: number;
    radius: number;
    strength: number;
  }

  /**
   * Paint every glowing dot at most once per frame using the max intensity across active lights
   * (wander + pointer), clearing the base dot underneath first so alphas never stack past the
   * dot's cap (glowMax inside text rectangles, fading smoothly to glowPeak in open space).
   */
  function drawGlows(c: DotFieldPalette, lights: readonly GlowLight[], off: number, scrollDeltaY: number) {
    if (!cx || lights.length === 0) return;
    const cols = Math.ceil(width / GAP) + 2;
    const minGy = -2;
    const cells = new Map<number, { gx: number; gy: number; k: number }>();

    for (const light of lights) {
      if (light.strength <= 0) continue;
      const x0 = Math.max(0, Math.floor((light.x - light.radius) / GAP));
      const x1 = Math.min(Math.ceil(width / GAP), Math.ceil((light.x + light.radius) / GAP));
      const y0 = Math.floor((light.y - light.radius + off) / GAP);
      const y1 = Math.ceil((light.y + light.radius + off) / GAP);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const x = gx * GAP + GAP / 2;
          const y = gy * GAP + GAP / 2 - off;
          const d = Math.hypot(x - light.x, y - light.y);
          if (d > light.radius) continue;
          const k = Math.min(1, (1 - d / light.radius) ** 2 * light.strength);
          if (k <= 0) continue;
          const key = (gy - minGy) * cols + gx;
          const prev = cells.get(key);
          if (!prev || k > prev.k) {
            cells.set(key, { gx, gy, k });
          }
        }
      }
    }

    const frameRects = projectTextRects(textRects, scrollDeltaY, height, textMaskMargin);
    const sizeSpan = DOT_GLOW_MAX_SIZE_PX - DOT_BASE_SIZE_PX;
    for (const { gx, gy, k } of cells.values()) {
      const x = gx * GAP + GAP / 2;
      const y = gy * GAP + GAP / 2 - off;
      const open = textMaskOpenness(x, y, frameRects, textMaskMargin);
      const s = DOT_BASE_SIZE_PX + k * sizeSpan;
      cx.clearRect(x - s / 2 - 1, y - s / 2 - 1, s + 2, s + 2);
      cx.fillStyle = c.glow(k, open);
      cx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  function drawFrame(frameNow: number, forceStill: boolean) {
    if (!canDraw() || !cx) return;
    const scrollY = env.getScrollY();
    const rawOff = (scrollY * 0.25) % GAP;
    const off = rawOff < 0 ? rawOff + GAP : rawOff;
    const c = palette();
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, env.canvas.width, env.canvas.height);
    cx.drawImage(base, 0, -off * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (forceStill || isStatic()) return;

    const t = frameNow / 1000;
    const wanderX = width * (0.5 + 0.42 * Math.sin(t * 0.13 + 1));
    const wanderY = height * (0.5 + 0.38 * Math.sin(t * 0.19));
    const lights: GlowLight[] = [{ x: wanderX, y: wanderY, radius: 200, strength: 0.55 }];

    if (frameNow - lastMove < 4000) {
      lights.push({
        x: pointerX,
        y: pointerY,
        radius: 170,
        strength: Math.min(1, (4000 - (frameNow - lastMove)) / 1200),
      });
    }
    drawGlows(c, lights, off, scrollY - textRectsScrollY);

    if (width >= TAG_MIN_WIDTH) {
      if (frameNow > nextTag) {
        nextTag = frameNow + 2200 + random() * 1600;
        const side = random() < 0.5;
        const gx = Math.floor(((side ? random() * 0.16 : 0.84 + random() * 0.13) * width) / GAP);
        const gy = Math.floor(random() * Math.max(1, height / GAP - 2)) + 1;
        const text = IDS[Math.floor(random() * IDS.length) % IDS.length] ?? IDS[0];
        tags.push({ gx, gy, text, born: frameNow, side });
      }
      cx.font = "11px ui-monospace, Consolas, monospace";
      tags = tags.filter((g) => frameNow - g.born < 5200);
      for (const g of tags) {
        const a = Math.min(1, Math.max(0, Math.sin(((frameNow - g.born) / 5200) * Math.PI)));
        const x = g.gx * GAP + GAP / 2;
        const y = g.gy * GAP + GAP / 2 - off;
        cx.strokeStyle = `rgba(${c.ring},${(a * c.ringAlphaMax).toFixed(3)})`;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.arc(x, y, 5 + (1 - a) * 3, 0, Math.PI * 2);
        cx.stroke();
        cx.clearRect(x - 2, y - 2, 4, 4);
        cx.fillStyle = `rgba(${c.ring},${(a * c.ringDotAlphaMax).toFixed(3)})`;
        cx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        cx.fillStyle = `rgba(${c.tag},${(a * c.tagA).toFixed(3)})`;
        cx.textAlign = g.side ? "left" : "right";
        cx.fillText(g.text, x + (g.side ? 12 : -12), y + 4);
      }
    }
  }

  function tick(frameNow: number) {
    rafId = null;
    if (destroyed || env.isHidden()) return;
    if (guard.record(frameNow)) {
      drawFrame(frameNow, true);
      return;
    }
    drawFrame(frameNow, false);
    if (!destroyed && !env.isHidden() && !isStatic() && rafId === null) {
      rafId = requestFrame(tick);
    }
  }

  function syncLoop() {
    if (destroyed) return;
    if (env.isHidden()) {
      cancelLoop();
      return;
    }
    if (!hasBase) rebuildBase();
    if (isStatic()) {
      cancelLoop();
      drawFrame(now(), true);
      return;
    }
    if (rafId === null) {
      guard.resetTiming();
      rafId = requestFrame(tick);
    }
  }

  return {
    resize() {
      if (destroyed) return;
      if (rebuildBase()) {
        drawFrame(now(), isStatic());
      }
    },
    start() {
      destroyed = false;
      rebuildBase();
      syncLoop();
    },
    stop() {
      destroyed = true;
      cancelLoop();
    },
    onVisibilityChange() {
      syncLoop();
    },
    onReducedMotionChange() {
      syncLoop();
    },
    onScroll() {
      if (destroyed || env.isHidden()) return;
      if (isStatic()) drawFrame(now(), true);
    },
    onPointerMove(x: number, y: number) {
      pointerX = x;
      pointerY = y;
      lastMove = now();
    },
    onThemeChange() {
      if (destroyed) return;
      if (rebuildBase() && !env.isHidden()) {
        drawFrame(now(), isStatic());
      }
    },
    setTextRects(rects: readonly TextRect[], measuredScrollY?: number) {
      textRects = rects;
      textRectsScrollY = measuredScrollY ?? env.getScrollY();
    },
    isRunning() {
      return rafId !== null;
    },
    isDegraded() {
      return guard.degraded;
    },
  };
}
