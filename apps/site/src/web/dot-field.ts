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
  /** Low-intensity glow color (k = 0) and hard-capped peak glow color (k = 1). */
  readonly glowMin: RgbaColor;
  readonly glowMax: RgbaColor;
  /** Outer-gutter tag ring, center dot, and label RGB + hard alpha caps. */
  readonly ringRgb: readonly [number, number, number];
  readonly ringAlphaMax: number;
  readonly ringDotAlphaMax: number;
  readonly tagRgb: readonly [number, number, number];
  readonly tagAlphaMax: number;
}

/**
 * Single source of truth for every color and alpha the dot field can paint.
 * Imported directly by the contrast test so any change that breaches 4.5:1 fails tests.
 */
export const DOT_FIELD_SPECS: Record<Theme, DotFieldPaletteSpec> = {
  dark: {
    dot: { r: 255, g: 255, b: 255, a: 0.085 },
    glowMin: { r: 255, g: 190, b: 90, a: 0.06 },
    glowMax: { r: 235, g: 136, b: 24, a: 0.2 },
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
    ringRgb: [224, 122, 46],
    ringAlphaMax: 0.14,
    ringDotAlphaMax: 0.22,
    tagRgb: [84, 80, 66],
    tagAlphaMax: 0.09,
  },
};

export interface DotFieldPalette {
  dot: string;
  glow: (k: number) => string;
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
    glow: (rawK) => {
      const k = Math.min(1, Math.max(0, rawK));
      const r = lerp(spec.glowMin.r, spec.glowMax.r, k);
      const g = lerp(spec.glowMin.g, spec.glowMax.g, k);
      const b = lerp(spec.glowMin.b, spec.glowMax.b, k);
      const a = spec.glowMin.a + (spec.glowMax.a - spec.glowMin.a) * k;
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
   * (wander + pointer), clearing the base dot underneath first so alphas never stack past glowMax.
   */
  function drawGlows(c: DotFieldPalette, lights: readonly GlowLight[], off: number) {
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

    for (const { gx, gy, k } of cells.values()) {
      const x = gx * GAP + GAP / 2;
      const y = gy * GAP + GAP / 2 - off;
      const s = 1.2 + k * 2.2;
      cx.clearRect(x - s / 2 - 1, y - s / 2 - 1, s + 2, s + 2);
      cx.fillStyle = c.glow(k);
      cx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  function drawFrame(frameNow: number, forceStill: boolean) {
    if (!canDraw() || !cx) return;
    const rawOff = (env.getScrollY() * 0.25) % GAP;
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
    drawGlows(c, lights, off);

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
    isRunning() {
      return rafId !== null;
    },
    isDegraded() {
      return guard.degraded;
    },
  };
}
