/**
 * Unit tests for the moving dot field behind the site pages:
 * - single requestAnimationFrame loop, paused while document.hidden;
 * - frame-time guard drops to one still frame when sustained frames are slow;
 * - never draws at zero size (hidden tab 0x0 canvas never calls drawImage);
 * - one still frame under prefers-reduced-motion: reduce;
 * - switches palettes per theme and applies light scroll parallax;
 * - text mask caps glow at glowMax inside text rectangles, fades monotonically across the margin,
 *   and reaches glowPeak in open space; DOM reads are coalesced to one frame outside drawFrame.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDotField,
  createFrameGuard,
  distanceToRect,
  DOT_FIELD_PALETTES,
  DOT_FIELD_SPECS,
  glowAlpha,
  normalizeTextRects,
  TEXT_MASK_MARGIN_PX,
  TEXT_MASK_PAD_PX,
  TEXT_MASK_SELECTOR,
  textMaskOpenness,
  type CanvasContextLike,
  type CanvasLike,
  type TextRect,
} from "../src/web/dot-field.ts";
import { createFrameThrottledMeasure, measureTextRects } from "../src/web/dot-field-mask.ts";
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

function parseAlpha(rgba: string): number {
  const m = rgba.match(/^rgba\(\d+,\d+,\d+,([0-9.]+)\)$/);
  assert.ok(m, `unexpected rgba: ${rgba}`);
  return Number(m[1]);
}

test("glow merges wander and pointer into one non-stacking pass capped by glowPeak in open space and glowMax over text", () => {
  for (const theme of ["dark", "light"] as const) {
    const spec = DOT_FIELD_SPECS[theme];
    const pal = DOT_FIELD_PALETTES[theme];
    // Default (omitted open = 0) and masked (open = 0) clamp to glowMax.a; open space (open = 1) clamps to glowPeak.a.
    assert.equal(parseAlpha(pal.glow(2.5)), spec.glowMax.a);
    assert.equal(parseAlpha(pal.glow(2.5, 0)), spec.glowMax.a);
    assert.equal(parseAlpha(pal.glow(2.5, -2)), spec.glowMax.a);
    assert.equal(parseAlpha(pal.glow(2.5, 1)), spec.glowPeak.a);
    assert.equal(parseAlpha(pal.glow(2.5, 4)), spec.glowPeak.a);
    assert.equal(parseAlpha(pal.glow(-1, 0)), spec.glowMin.a);
    assert.equal(parseAlpha(pal.glow(-1, 1)), spec.glowMin.a);

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
    // In open space: every glowing dot center is drawn at most once per frame (never wander + pointer
    // stacked), its base dot is cleared first, alpha reaches above glowMax.a and never exceeds glowPeak.a.
    const centers = new Set<string>();
    let maxOpenAlpha = 0;
    for (const call of h.main.rec.fillRectCalls) {
      const cx = Math.round(call.x + call.w / 2);
      const cy = Math.round(call.y + call.h / 2);
      const key = `${cx},${cy}`;
      assert.ok(!centers.has(key), `${theme}: dot at ${key} was double-painted in one frame`);
      centers.add(key);
      const alpha = parseAlpha(call.fillStyle);
      if (alpha > maxOpenAlpha) maxOpenAlpha = alpha;
      assert.ok(alpha <= spec.glowPeak.a + 1e-6, `${theme}: open glow alpha ${call.fillStyle} exceeds peak ${spec.glowPeak.a}`);
    }
    assert.ok(maxOpenAlpha > spec.glowMax.a + 0.1, `${theme}: open glow (${maxOpenAlpha}) should be visibly stronger than masked cap (${spec.glowMax.a})`);
    // 1 full-canvas clear + 1 clear per lit dot.
    assert.equal(h.main.rec.clearRectCalls.length, 1 + h.main.rec.fillRectCalls.length);

    // Now cover the entire viewport with a text rectangle: every dot must stay <= glowMax.a.
    h.field.setTextRects([{ left: 0, top: 0, right: 900, bottom: 600 }]);
    h.main.rec.fillRectCalls.length = 0;
    h.stepFrame(32);
    assert.ok(h.main.rec.fillRectCalls.length > 0, `${theme}: masked glow still draws lit dots`);
    for (const call of h.main.rec.fillRectCalls) {
      const alpha = parseAlpha(call.fillStyle);
      assert.ok(alpha <= spec.glowMax.a + 1e-6, `${theme}: masked glow alpha ${call.fillStyle} exceeds cap ${spec.glowMax.a}`);
    }
    h.field.stop();
  }
});

test("masked cap equals today's glowMax alpha and open peak matches the tuned values in both themes", () => {
  assert.equal(DOT_FIELD_SPECS.dark.glowMax.a, 0.2);
  assert.equal(DOT_FIELD_SPECS.light.glowMax.a, 0.22);
  assert.equal(DOT_FIELD_SPECS.dark.glowPeak.a, 0.52);
  assert.equal(DOT_FIELD_SPECS.light.glowPeak.a, 0.55);

  for (const theme of ["dark", "light"] as const) {
    const spec = DOT_FIELD_SPECS[theme];
    assert.equal(glowAlpha(spec, 1, 0), spec.glowMax.a);
    assert.equal(glowAlpha(spec, 1, 1), spec.glowPeak.a);
    assert.equal(glowAlpha(spec, 0, 0), spec.glowMin.a);
    assert.equal(glowAlpha(spec, 0, 1), spec.glowMin.a);
    assert.ok(spec.glowPeak.a > spec.glowMax.a);
  }
});

test("text mask caps every point inside a text rectangle, reaches peak outside the margin, and fades monotonically", () => {
  const rect: TextRect = { left: 100, top: 200, right: 360, bottom: 280 };
  const rects: readonly TextRect[] = [rect];
  const margin = TEXT_MASK_MARGIN_PX;

  // Empty rect list -> fully open everywhere.
  assert.equal(textMaskOpenness(150, 240, [], margin), 1);

  // Every point inside and on the edges/corners of the text rectangle has distance 0 and openness 0.
  for (let y = rect.top; y <= rect.bottom; y += 10) {
    for (let x = rect.left; x <= rect.right; x += 13) {
      assert.equal(distanceToRect(x, y, rect), 0, `inside (${x},${y})`);
      const open = textMaskOpenness(x, y, rects, margin);
      assert.equal(open, 0, `openness inside (${x},${y})`);
      for (const theme of ["dark", "light"] as const) {
        const spec = DOT_FIELD_SPECS[theme];
        assert.ok(glowAlpha(spec, 1, open) <= spec.glowMax.a, `${theme}: inside (${x},${y}) capped at glowMax`);
      }
    }
  }
  for (const [cx, cy] of [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.left, rect.bottom],
    [rect.right, rect.bottom],
  ] as const) {
    assert.equal(textMaskOpenness(cx, cy, rects, margin), 0, `corner (${cx},${cy})`);
  }

  // Points at or beyond margin outside the rectangle reach full openness (1 -> glowPeak).
  for (const [px, py] of [
    [rect.right + margin, 240],
    [rect.right + margin + 100, 240],
    [rect.left - margin, 240],
    [220, rect.top - margin],
    [220, rect.bottom + margin],
    [rect.right + margin, rect.bottom + margin],
  ] as const) {
    assert.equal(textMaskOpenness(px, py, rects, margin), 1, `outside (${px},${py})`);
    for (const theme of ["dark", "light"] as const) {
      assert.equal(glowAlpha(DOT_FIELD_SPECS[theme], 1, textMaskOpenness(px, py, rects, margin)), DOT_FIELD_SPECS[theme].glowPeak.a);
    }
  }

  // Strictly monotonic fade across the margin from all 4 sides and diagonally from a corner.
  const rays: Array<{ name: string; at: (d: number) => [number, number] }> = [
    { name: "right", at: (d) => [rect.right + d, 240] },
    { name: "left", at: (d) => [rect.left - d, 240] },
    { name: "bottom", at: (d) => [220, rect.bottom + d] },
    { name: "top", at: (d) => [220, rect.top - d] },
    { name: "diagonal", at: (d) => [rect.right + d / Math.SQRT2, rect.bottom + d / Math.SQRT2] },
  ];
  for (const ray of rays) {
    let prevOpen = -1;
    let prevDark = -1;
    let prevLight = -1;
    for (let step = 0; step <= 16; step++) {
      const d = (margin * step) / 16;
      const [x, y] = ray.at(d);
      const open = textMaskOpenness(x, y, rects, margin);
      const darkA = glowAlpha(DOT_FIELD_SPECS.dark, 1, open);
      const lightA = glowAlpha(DOT_FIELD_SPECS.light, 1, open);
      assert.ok(open > prevOpen, `${ray.name} step ${step}: openness ${open} should exceed ${prevOpen}`);
      assert.ok(darkA > prevDark, `${ray.name} step ${step}: dark alpha ${darkA} should exceed ${prevDark}`);
      assert.ok(lightA > prevLight, `${ray.name} step ${step}: light alpha ${lightA} should exceed ${prevLight}`);
      prevOpen = open;
      prevDark = darkA;
      prevLight = lightA;
    }
    assert.equal(prevOpen, 1, `${ray.name} ends at 1`);
  }

  // Multiple rectangles: closest rectangle governs, so being inside rect A caps at 0 even far from rect B.
  const twoRects: readonly TextRect[] = [
    { left: 50, top: 50, right: 150, bottom: 100 },
    { left: 500, top: 500, right: 700, bottom: 560 },
  ];
  assert.equal(textMaskOpenness(100, 75, twoRects, margin), 0);
  assert.equal(textMaskOpenness(600, 530, twoRects, margin), 0);
  assert.equal(textMaskOpenness(325, 300, twoRects, margin), 1);

  // Zero margin behaves as a hard boundary (0 inside, 1 strictly outside).
  assert.equal(textMaskOpenness(100, 240, rects, 0), 0);
  assert.equal(textMaskOpenness(360.1, 240, rects, 0), 1);
});

test("createDotField caps dots inside a partial text rectangle while letting open-space dots exceed glowMax", () => {
  // Pointer sits at (225, 225) — half inside the text rect on the left, half in open space on the right.
  const textRect: TextRect = { left: 40, top: 100, right: 240, bottom: 350 };
  const h = makeHarness({ width: 900, height: 600, theme: "dark" });
  h.field.setTextRects([textRect]);
  h.field.start();
  h.field.onPointerMove(255, 225);
  h.main.rec.fillRectCalls.length = 0;
  h.stepFrame(16);

  const spec = DOT_FIELD_SPECS.dark;
  let insideCount = 0;
  let openStrongCount = 0;
  for (const call of h.main.rec.fillRectCalls) {
    const cx = call.x + call.w / 2;
    const cy = call.y + call.h / 2;
    const alpha = parseAlpha(call.fillStyle);
    if (cx >= textRect.left && cx <= textRect.right && cy >= textRect.top && cy <= textRect.bottom) {
      insideCount += 1;
      assert.ok(alpha <= spec.glowMax.a + 1e-6, `dot inside text rect at (${cx},${cy}) exceeded glowMax: ${alpha}`);
    } else if (cx >= textRect.right + TEXT_MASK_MARGIN_PX && Math.hypot(cx - 255, cy - 225) < 70) {
      if (alpha > spec.glowMax.a + 0.05) openStrongCount += 1;
      assert.ok(alpha <= spec.glowPeak.a + 1e-6, `dot outside text rect exceeded glowPeak: ${alpha}`);
    }
  }
  assert.ok(insideCount > 0, "tested dots inside the text rectangle");
  assert.ok(openStrongCount > 0, "tested open-space dots stronger than glowMax");
  h.field.stop();
});

test("normalizeTextRects filters invalid/offscreen rects, pads, and prunes contained rects without changing openness", () => {
  const viewport = { width: 1200, height: 800 };
  const raw: TextRect[] = [
    { left: 0, top: 0, right: 0, bottom: 0 }, // empty
    { left: 10, top: 10, right: 11, bottom: 11 }, // 1x1 sr-only
    { left: 200, top: 100, right: 100, bottom: 200 }, // inverted
    { left: Number.NaN, top: 0, right: 50, bottom: 50 }, // non-finite
    { left: 100, top: -500, right: 300, bottom: -400 }, // far offscreen above
    { left: 100, top: 900, right: 300, bottom: 960 }, // far offscreen below
    { left: 100, top: -20, right: 300, bottom: -2 }, // just above viewport (within margin -> kept!)
    { left: 100, top: 200, right: 500, bottom: 320 }, // outer container
    { left: 120, top: 220, right: 260, bottom: 250 }, // contained child -> pruned
    { left: 100, top: 200, right: 500, bottom: 320 }, // exact duplicate -> deduplicated to one
  ];
  const normalized = normalizeTextRects(raw, viewport, TEXT_MASK_MARGIN_PX, TEXT_MASK_PAD_PX);
  assert.equal(normalized.length, 2, `expected 2 kept rects, got ${JSON.stringify(normalized)}`);
  assert.deepEqual(normalized[0], {
    left: 100 - TEXT_MASK_PAD_PX,
    top: -20 - TEXT_MASK_PAD_PX,
    right: 300 + TEXT_MASK_PAD_PX,
    bottom: -2 + TEXT_MASK_PAD_PX,
  });
  assert.deepEqual(normalized[1], {
    left: 100 - TEXT_MASK_PAD_PX,
    top: 200 - TEXT_MASK_PAD_PX,
    right: 500 + TEXT_MASK_PAD_PX,
    bottom: 320 + TEXT_MASK_PAD_PX,
  });

  // Openness against the pruned list matches openness against the unpruned padded list at every grid point.
  const unpruned = raw
    .filter((r) => Number.isFinite(r.left) && r.right - r.left > 1 && r.bottom - r.top > 1 && r.bottom > -TEXT_MASK_MARGIN_PX && r.top < viewport.height + TEXT_MASK_MARGIN_PX)
    .map((r) => ({ left: r.left - TEXT_MASK_PAD_PX, top: r.top - TEXT_MASK_PAD_PX, right: r.right + TEXT_MASK_PAD_PX, bottom: r.bottom + TEXT_MASK_PAD_PX }));
  for (let y = 0; y <= viewport.height; y += 40) {
    for (let x = 0; x <= viewport.width; x += 60) {
      assert.equal(
        textMaskOpenness(x, y, normalized, TEXT_MASK_MARGIN_PX),
        textMaskOpenness(x, y, unpruned, TEXT_MASK_MARGIN_PX),
        `pruned openness mismatch at (${x},${y})`,
      );
    }
  }
});

test("frame-throttled text mask coalesces bursts to one frame, respects active state, and covers shared site text selectors", () => {
  let active = true;
  let measures = 0;
  let nextId = 1;
  const pending = new Map<number, (now: number) => void>();
  let cancelled = 0;

  const tracker = createFrameThrottledMeasure({
    isActive: () => active,
    measure: () => {
      measures += 1;
    },
    requestFrame: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      if (pending.delete(id)) cancelled += 1;
    },
  });

  // Burst of scroll/resize/observer triggers schedules only one frame.
  tracker.schedule();
  tracker.schedule();
  tracker.schedule();
  assert.equal(pending.size, 1);
  assert.equal(measures, 0);

  for (const [id, cb] of [...pending.entries()]) {
    pending.delete(id);
    cb(16);
  }
  assert.equal(measures, 1);

  // Inactive (hidden or reduced motion): neither schedule nor measureNow runs DOM work.
  active = false;
  tracker.schedule();
  tracker.measureNow();
  assert.equal(pending.size, 0);
  assert.equal(measures, 1);

  // stop() cancels any pending frame.
  active = true;
  tracker.schedule();
  assert.equal(pending.size, 1);
  tracker.stop();
  assert.equal(pending.size, 0);
  assert.equal(cancelled, 1);
  tracker.schedule();
  assert.equal(pending.size, 0);

  // measureTextRects reads from the shared selector and normalizes.
  let seenSelector = "";
  const rects = measureTextRects(
    {
      querySelectorAll(sel) {
        seenSelector = sel;
        return [
          { getBoundingClientRect: () => ({ left: 20, top: 40, right: 200, bottom: 80 }) },
          { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
        ];
      },
    },
    { width: 1200, height: 800 },
  );
  assert.equal(seenSelector, TEXT_MASK_SELECTOR);
  assert.equal(rects.length, 1);
  for (const token of ["[data-text-mask]", "header.site-nav", "figure.hero-stage", "h1", "p", "li", "a", "button", "code", "pre", "figcaption"]) {
    assert.ok(TEXT_MASK_SELECTOR.includes(token), `TEXT_MASK_SELECTOR includes ${token}`);
  }
});
