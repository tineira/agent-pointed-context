/**
 * Unit tests for the moving dot field behind the site pages:
 * - single requestAnimationFrame loop, paused while document.hidden;
 * - frame-time guard drops to one still frame when sustained frames are slow;
 * - never draws at zero size (hidden tab 0x0 canvas never calls drawImage);
 * - one still frame under prefers-reduced-motion: reduce;
 * - switches palettes per theme and applies light scroll parallax.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDotField, createFrameGuard, DOT_FIELD_PALETTES, DOT_FIELD_SPECS, type CanvasContextLike, type CanvasLike } from "../src/web/dot-field.ts";
import type { Theme } from "../src/web/theme.ts";

interface RecordedContext {
  ctx: CanvasContextLike;
  drawImageCalls: { image: CanvasLike; dx: number; dy: number }[];
  fillRectCalls: { x: number; y: number; w: number; h: number; fillStyle: string }[];
  clearRectCalls: { x: number; y: number; w: number; h: number }[];
  fillTextCalls: string[];
}

function makeMockCanvas(): { canvas: CanvasLike; rec: RecordedContext } {
  const rec: RecordedContext = {
    drawImageCalls: [],
    fillRectCalls: [],
    clearRectCalls: [],
    fillTextCalls: [],
    ctx: null as unknown as CanvasContextLike,
  };
  const ctx: CanvasContextLike = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    setTransform() {},
    clearRect(x, y, w, h) {
      rec.clearRectCalls.push({ x, y, w, h });
    },
    fillRect(x, y, w, h) {
      rec.fillRectCalls.push({ x, y, w, h, fillStyle: ctx.fillStyle });
    },
    drawImage(image, dx, dy) {
      if (image.width <= 0 || image.height <= 0) {
        throw new Error("InvalidStateError: drawImage called on zero-sized canvas");
      }
      rec.drawImageCalls.push({ image, dx, dy });
    },
    beginPath() {},
    arc() {},
    stroke() {},
    fillText(text) {
      rec.fillTextCalls.push(text);
    },
  };
  rec.ctx = ctx;
  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  return { canvas, rec };
}

function makeHarness(initial?: { width?: number; height?: number; hidden?: boolean; reduced?: boolean; theme?: Theme; slowFrameMs?: number; maxSlowFrames?: number }) {
  const main = makeMockCanvas();
  const offscreen = makeMockCanvas();
  let width = initial?.width ?? 1200;
  let height = initial?.height ?? 800;
  let scrollY = 0;
  let hidden = initial?.hidden ?? false;
  let reduced = initial?.reduced ?? false;
  let theme: Theme = initial?.theme ?? "dark";
  let clock = 0;
  let nextRafId = 1;
  const pending = new Map<number, (now: number) => void>();
  let totalScheduled = 0;
  let totalCancelled = 0;

  const field = createDotField({
    canvas: main.canvas,
    createOffscreenCanvas: () => offscreen.canvas,
    getSize: () => ({ width, height, dpr: 1 }),
    getScrollY: () => scrollY,
    isHidden: () => hidden,
    isReducedMotion: () => reduced,
    getTheme: () => theme,
    now: () => clock,
    random: () => 0.1,
    slowFrameMs: initial?.slowFrameMs ?? 50,
    maxSlowFrames: initial?.maxSlowFrames ?? 4,
    requestFrame: (cb) => {
      const id = nextRafId++;
      totalScheduled += 1;
      pending.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      if (pending.delete(id)) totalCancelled += 1;
    },
  });

  const stepFrame = (atMs: number) => {
    clock = atMs;
    const entries = [...pending.entries()];
    assert.ok(entries.length <= 1, `at most one rAF pending, saw ${entries.length}`);
    for (const [id, cb] of entries) {
      pending.delete(id);
      cb(atMs);
    }
  };

  return {
    field,
    main,
    offscreen,
    pending,
    stepFrame,
    stats: () => ({ totalScheduled, totalCancelled, pendingCount: pending.size }),
    setSize: (w: number, h: number) => {
      width = w;
      height = h;
    },
    setScrollY: (y: number) => {
      scrollY = y;
    },
    setHidden: (v: boolean) => {
      hidden = v;
    },
    setReduced: (v: boolean) => {
      reduced = v;
    },
    setTheme: (t: Theme) => {
      theme = t;
    },
    setClock: (t: number) => {
      clock = t;
    },
  };
}

test("never draws at zero size (0x0 hidden tab never throws drawImage)", () => {
  const h = makeHarness({ width: 0, height: 0 });
  h.field.start();
  h.field.resize();
  h.stepFrame(16);
  h.field.onThemeChange();
  assert.equal(h.main.rec.drawImageCalls.length, 0);
  assert.equal(h.main.rec.clearRectCalls.length, 0);
  assert.equal(h.offscreen.rec.fillRectCalls.length, 0);

  // Also safe with one zero dimension.
  h.setSize(1200, 0);
  h.field.resize();
  h.stepFrame(32);
  assert.equal(h.main.rec.drawImageCalls.length, 0);

  // Recovers once given a positive size.
  h.setSize(600, 400);
  h.field.resize();
  assert.equal(h.main.rec.drawImageCalls.length, 1);
  h.field.stop();
});

test("keeps a single rAF loop and pauses while document.hidden", () => {
  const h = makeHarness();
  h.field.start();
  assert.equal(h.stats().pendingCount, 1);
  assert.equal(h.field.isRunning(), true);

  // Repeated events never create a second loop.
  h.field.resize();
  h.field.onThemeChange();
  h.field.onVisibilityChange();
  assert.equal(h.stats().pendingCount, 1);

  h.stepFrame(16);
  h.stepFrame(32);
  assert.equal(h.stats().pendingCount, 1);

  // Hiding cancels the pending rAF and stops drawing.
  h.setHidden(true);
  h.field.onVisibilityChange();
  assert.equal(h.stats().pendingCount, 0);
  assert.equal(h.field.isRunning(), false);
  const drawsWhileHidden = h.main.rec.drawImageCalls.length;
  h.field.onScroll();
  h.field.onThemeChange();
  assert.equal(h.main.rec.drawImageCalls.length, drawsWhileHidden);

  // Returning after a long hidden gap resumes one rAF and does NOT trip the slow-frame guard.
  h.setHidden(false);
  h.setClock(60_000);
  h.field.onVisibilityChange();
  assert.equal(h.stats().pendingCount, 1);
  h.stepFrame(60_016);
  h.stepFrame(60_032);
  assert.equal(h.field.isDegraded(), false);
  assert.equal(h.field.isRunning(), true);
  h.field.stop();
  assert.equal(h.stats().pendingCount, 0);
});

test("frame-time guard drops to one still frame on sustained slow frames, ignoring isolated spikes", () => {
  const guard = createFrameGuard({ slowFrameMs: 50, maxSlowFrames: 3 });
  assert.equal(guard.record(0), false);
  assert.equal(guard.record(80), false); // 1 slow
  assert.equal(guard.record(160), false); // 2 slow
  assert.equal(guard.record(176), false); // fast resets streak
  assert.equal(guard.record(250), false); // 1 slow
  assert.equal(guard.record(330), false); // 2 slow
  assert.equal(guard.record(410), true); // 3rd consecutive slow frame -> degraded
  assert.equal(guard.degraded, true);

  const h = makeHarness({ slowFrameMs: 50, maxSlowFrames: 3 });
  h.field.start();
  h.stepFrame(0);
  h.stepFrame(80);
  h.stepFrame(160);
  assert.equal(h.field.isDegraded(), false);
  assert.equal(h.field.isRunning(), true);

  // Third slow frame drops to one still frame and cancels rAF.
  const drawsBeforeDrop = h.main.rec.drawImageCalls.length;
  h.stepFrame(240);
  assert.equal(h.field.isDegraded(), true);
  assert.equal(h.field.isRunning(), false);
  assert.equal(h.stats().pendingCount, 0);
  assert.equal(h.main.rec.drawImageCalls.length, drawsBeforeDrop + 1, "draws one clean static frame on drop");

  // Scroll still updates the static frame without restarting rAF.
  h.setScrollY(40);
  h.field.onScroll();
  assert.equal(h.field.isRunning(), false);
  assert.equal(h.main.rec.drawImageCalls.at(-1)?.dy, -10);
});

test("prefers-reduced-motion: reduce draws one still frame and never schedules rAF", () => {
  const h = makeHarness({ reduced: true });
  h.field.start();
  assert.equal(h.stats().totalScheduled, 0, "never calls requestAnimationFrame under reduced motion");
  assert.equal(h.main.rec.drawImageCalls.length, 1, "draws one still frame");
  assert.equal(h.main.rec.fillRectCalls.length, 0, "no animated pointer/wander glow in still frame");

  // Scroll parallax updates the still frame with no rAF.
  h.setScrollY(48);
  h.field.onScroll();
  assert.equal(h.stats().totalScheduled, 0);
  assert.equal(h.main.rec.drawImageCalls.at(-1)?.dy, -12);

  // Turning reduced motion off starts one rAF loop; turning it back on cancels it.
  h.setReduced(false);
  h.field.onReducedMotionChange();
  assert.equal(h.field.isRunning(), true);
  h.setReduced(true);
  h.field.onReducedMotionChange();
  assert.equal(h.field.isRunning(), false);
  assert.equal(h.stats().pendingCount, 0);
});

test("theme change rebuilds the dot grid with the active theme's palette", () => {
  const h = makeHarness({ reduced: true, theme: "dark" });
  h.field.start();
  assert.equal(h.offscreen.rec.fillRectCalls.at(-1)?.fillStyle, DOT_FIELD_PALETTES.dark.dot);

  h.setTheme("light");
  h.field.onThemeChange();
  assert.equal(h.offscreen.rec.fillRectCalls.at(-1)?.fillStyle, DOT_FIELD_PALETTES.light.dot);
});

test("glow merges wander and pointer into one non-stacking pass capped by DOT_FIELD_SPECS", () => {
  const parseAlpha = (rgba: string) => {
    const m = rgba.match(/^rgba\(\d+,\d+,\d+,([0-9.]+)\)$/);
    assert.ok(m, `unexpected rgba: ${rgba}`);
    return Number(m[1]);
  };

  for (const theme of ["dark", "light"] as const) {
    const spec = DOT_FIELD_SPECS[theme];
    const pal = DOT_FIELD_PALETTES[theme];
    // Out-of-range k is clamped to glowMax.a.
    assert.equal(parseAlpha(pal.glow(2.5)), spec.glowMax.a);
    assert.equal(parseAlpha(pal.glow(-1)), spec.glowMin.a);

    // Place pointer directly on top of the wander center at t = 0 so both lights overlap.
    const h = makeHarness({ width: 900, height: 600, theme });
    const wanderX = 900 * (0.5 + 0.42 * Math.sin(1));
    const wanderY = 600 * 0.5;
    h.field.start();
    h.field.onPointerMove(wanderX, wanderY);
    h.main.rec.fillRectCalls.length = 0;
    h.main.rec.clearRectCalls.length = 0;
    h.stepFrame(16);

    assert.ok(h.main.rec.fillRectCalls.length > 0, `${theme}: glow draws lit dots`);
    // Every glowing dot center is drawn at most once per frame (never wander + pointer stacked),
    // its base dot is cleared first, and its alpha never exceeds glowMax.a.
    const centers = new Set<string>();
    for (const call of h.main.rec.fillRectCalls) {
      const cx = Math.round(call.x + call.w / 2);
      const cy = Math.round(call.y + call.h / 2);
      const key = `${cx},${cy}`;
      assert.ok(!centers.has(key), `${theme}: dot at ${key} was double-painted in one frame`);
      centers.add(key);
      assert.ok(parseAlpha(call.fillStyle) <= spec.glowMax.a + 1e-6, `${theme}: glow alpha ${call.fillStyle} exceeds cap ${spec.glowMax.a}`);
    }
    // 1 full-canvas clear + 1 clear per lit dot.
    assert.equal(h.main.rec.clearRectCalls.length, 1 + h.main.rec.fillRectCalls.length);
    h.field.stop();
  }
});
