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

export interface DotFieldPalette {
  dot: string;
  glow: (k: number) => string;
  ring: string;
  tag: string;
  tagA: number;
}

export const DOT_FIELD_PALETTES: Record<Theme, DotFieldPalette> = {
  dark: {
    dot: "rgba(255,255,255,0.085)",
    glow: (k) => `rgba(255,${(170 + 40 * (1 - k)) | 0},${(90 * (1 - k) + 40) | 0},${(0.1 + k * 0.8).toFixed(3)})`,
    ring: "255,159,28",
    tag: "190,200,216",
    tagA: 0.42,
  },
  light: {
    dot: "rgba(60,54,38,0.17)",
    glow: (k) => `rgba(${(196 + 20 * k) | 0},${(96 - 20 * k) | 0},${(50 - 20 * k) | 0},${(0.2 + k * 0.75).toFixed(3)})`,
    ring: "196,80,29",
    tag: "84,80,66",
    tagA: 0.62,
  },
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

  function drawGlow(c: DotFieldPalette, lx: number, ly: number, radius: number, off: number, strength: number) {
    if (!cx) return;
    const x0 = Math.max(0, Math.floor((lx - radius) / GAP));
    const x1 = Math.min(Math.ceil(width / GAP), Math.ceil((lx + radius) / GAP));
    const y0 = Math.floor((ly - radius + off) / GAP);
    const y1 = Math.ceil((ly + radius + off) / GAP);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const x = gx * GAP + GAP / 2;
        const y = gy * GAP + GAP / 2 - off;
        const d = Math.hypot(x - lx, y - ly);
        if (d > radius) continue;
        const k = (1 - d / radius) ** 2 * strength;
        const s = 1.2 + k * 2.2;
        cx.fillStyle = c.glow(k);
        cx.fillRect(x - s / 2, y - s / 2, s, s);
      }
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
    drawGlow(c, wanderX, wanderY, 200, off, 0.55);

    if (frameNow - lastMove < 4000) {
      drawGlow(c, pointerX, pointerY, 170, off, Math.min(1, (4000 - (frameNow - lastMove)) / 1200));
    }

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
        const a = Math.sin(((frameNow - g.born) / 5200) * Math.PI);
        const x = g.gx * GAP + GAP / 2;
        const y = g.gy * GAP + GAP / 2 - off;
        cx.strokeStyle = `rgba(${c.ring},${(a * 0.6).toFixed(3)})`;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.arc(x, y, 5 + (1 - a) * 3, 0, Math.PI * 2);
        cx.stroke();
        cx.fillStyle = `rgba(${c.ring},${(a * 0.9).toFixed(3)})`;
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
