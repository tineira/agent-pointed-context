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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createDotField,
  createFrameGuard,
  distanceToRect,
  DOT_BASE_SIZE_PX,
  DOT_FIELD_PALETTES,
  DOT_FIELD_SPECS,
  DOT_GLOW_MAX_SIZE_PX,
  glowAlpha,
  normalizeTextRects,
  projectTextRects,
  TEXT_MASK_HEADING_PAD_PX,
  TEXT_MASK_MARGIN_PX,
  TEXT_MASK_PAD_PX,
  TEXT_MASK_SELECTOR,
  textMaskOpenness,
  type CanvasContextLike,
  type CanvasLike,
  type TextRect,
} from "../src/web/dot-field.ts";
import {
  createFrameThrottledMeasure,
  measureTextRects,
  parseTranslateTransform,
  type ComputedStyleLike,
  type RectReadable,
} from "../src/web/dot-field-mask.ts";
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

test("masked cap equals today's glowMax alpha and the open peak is the site prototype's (TIN-1106) in both themes", () => {
  assert.equal(DOT_FIELD_SPECS.dark.glowMax.a, 0.2);
  assert.equal(DOT_FIELD_SPECS.light.glowMax.a, 0.22);
  // The prototype's glow(k) at k = 1: dark rgba(255,170,40,0.9), light rgba(216,76,30,0.95).
  assert.deepEqual(DOT_FIELD_SPECS.dark.glowPeak, { r: 255, g: 170, b: 40, a: 0.9 });
  assert.deepEqual(DOT_FIELD_SPECS.light.glowPeak, { r: 216, g: 76, b: 30, a: 0.95 });

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
  assert.ok(normalized[1]!.left <= 100 - (DOT_GLOW_MAX_SIZE_PX / 2 + 4), "padding expands rect beyond dot half-width + italic overhang");
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

  // With cullY = false (document-space caching), offscreen vertical rects are retained for scroll projection.
  const fullDoc = normalizeTextRects(raw, viewport, TEXT_MASK_MARGIN_PX, TEXT_MASK_PAD_PX, false);
  assert.equal(fullDoc.length, 4, "retains above- and below-viewport rects when cullY is false");

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

test("pad constants cover glowing dot half-width plus italic overhangs and selector includes every required token verbatim", () => {
  const dotMaxHalfWidth = DOT_GLOW_MAX_SIZE_PX / 2;
  assert.equal(DOT_BASE_SIZE_PX, 1.2);
  assert.equal(DOT_GLOW_MAX_SIZE_PX, 3.4);
  assert.ok(
    TEXT_MASK_PAD_PX >= dotMaxHalfWidth + 4,
    `TEXT_MASK_PAD_PX (${TEXT_MASK_PAD_PX}) must cover dot max half-width (${dotMaxHalfWidth}) + body italic overhang (>= 4 px)`,
  );
  assert.ok(
    TEXT_MASK_HEADING_PAD_PX >= dotMaxHalfWidth + 10.3,
    `TEXT_MASK_HEADING_PAD_PX (${TEXT_MASK_HEADING_PAD_PX}) must cover dot max half-width (${dotMaxHalfWidth}) + measured h1 italic em overhang (>= 10.3 px)`,
  );
  assert.ok(TEXT_MASK_HEADING_PAD_PX > TEXT_MASK_PAD_PX, "heading pad exceeds body pad");

  // Parse selector token-by-token so dropping a short token like `p` or `a` always fails.
  const tokens = new Set(TEXT_MASK_SELECTOR.split(",").map((s) => s.trim()));
  for (const required of [
    "[data-text-mask]",
    "header.site-nav",
    "figure.hero-stage",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "figcaption",
    "blockquote",
    "pre",
    "code",
    "dt",
    "dd",
    "th",
    "td",
    "label",
    "summary",
    "legend",
    "caption",
    "a",
    "button",
    "em",
    "small",
    "b",
    "strong",
    "svg text",
    ".kicker",
    ".landing-who",
    ".try-ask",
    ".try-host",
    ".try-join-app",
    ".try-ex-row",
    ".build-chip",
    ".build-code-idx",
    ".landing-conn",
  ]) {
    assert.ok(tokens.has(required), `TEXT_MASK_SELECTOR missing exact token "${required}"`);
  }
});

test("scrolling between measuring and drawing shifts document rects and tracks sticky/fixed rects so the cap holds on every frame", () => {
  for (const theme of ["dark", "light"] as const) {
    const spec = DOT_FIELD_SPECS[theme];
    const h = makeHarness({ width: 1200, height: 800, theme });

    // Measured once at scrollY = 0: one visible paragraph, one far-below-fold paragraph, one sticky header,
    // and one sticky side panel (like `.build-code` sticking at top: 92px inside a grid [340, 1100]).
    const measured: TextRect[] = [
      { left: 100, top: 260, right: 500, bottom: 380 }, // visible at scrollY = 0
      { left: 100, top: 1020, right: 500, bottom: 1140 }, // below initial viewport
      { left: 0, top: 0, right: 1200, bottom: 64, stickyMinTop: 0, stickyMaxTop: 2936 }, // sticky header
      { left: 620, top: 340, right: 1080, bottom: 640, stickyMinTop: 92, stickyMaxTop: 800 }, // sticky card
      { left: 900, top: 700, right: 1100, bottom: 760, fixed: true }, // fixed badge
    ];
    h.field.setTextRects(measured, 0);
    h.field.start();

    // Simulate a fast flick (~50 px/frame) without re-measuring: park pointer right on the moving text.
    for (let step = 1; step <= 6; step++) {
      const scrollY = step * 50;
      h.setScrollY(scrollY);
      const movedTop = 260 - scrollY;
      const movedBottom = 380 - scrollY;
      const centerY = Math.max(20, (movedTop + movedBottom) / 2);
      h.field.onPointerMove(300, centerY);
      h.main.rec.fillRectCalls.length = 0;
      h.stepFrame(step * 16);

      let checkedInside = 0;
      for (const call of h.main.rec.fillRectCalls) {
        const cx = call.x + call.w / 2;
        const cy = call.y + call.h / 2;
        const alpha = parseAlpha(call.fillStyle);
        if (cx >= 100 && cx <= 500 && cy >= movedTop && cy <= movedBottom) {
          checkedInside += 1;
          assert.ok(
            alpha <= spec.glowMax.a + 1e-6,
            `${theme} scrollY=${scrollY}: dot inside scrolled text at (${cx},${cy}) exceeded glowMax (${alpha} > ${spec.glowMax.a})`,
          );
        }
      }
      assert.ok(checkedInside > 0, `${theme} scrollY=${scrollY}: sampled dots over scrolled text`);
    }

    // Jump straight down to scrollY = 800 (bringing the initially offscreen rect into [220, 340],
    // while sticky header stays at [0, 64], sticky card is pushed up to [0, 300], fixed stays at [700, 760]).
    // Place pointer right on the bottom edge (y = 345) so half its radius hits [220, 340] and half hits open space below.
    h.setScrollY(800);
    h.field.onPointerMove(300, 345);
    h.main.rec.fillRectCalls.length = 0;
    h.stepFrame(160);
    let belowFoldChecked = 0;
    let openSpaceStrong = 0;
    for (const call of h.main.rec.fillRectCalls) {
      const cx = call.x + call.w / 2;
      const cy = call.y + call.h / 2;
      const alpha = parseAlpha(call.fillStyle);
      if (cx >= 100 && cx <= 500 && cy >= 220 && cy <= 340) {
        belowFoldChecked += 1;
        assert.ok(alpha <= spec.glowMax.a + 1e-6, `${theme}: below-fold rect at scrollY=800 exceeded glowMax: ${alpha}`);
      } else if (cy >= 340 + TEXT_MASK_MARGIN_PX && Math.hypot(cx - 300, cy - 345) < 80) {
        if (alpha > spec.glowMax.a + 0.05) openSpaceStrong += 1;
      }
    }
    assert.ok(belowFoldChecked > 0, `${theme}: below-fold text masked without re-measure`);
    assert.ok(openSpaceStrong > 0, `${theme}: open space below scrolled text still rises past glowMax`);

    // Verify exact sticky and fixed projection math across scroll positions.
    const proj300 = projectTextRects(measured, 300, 800, TEXT_MASK_MARGIN_PX);
    const header300 = proj300.find((r) => r.right === 1200);
    const stickyCard300 = proj300.find((r) => r.left === 620);
    const fixed300 = proj300.find((r) => r.left === 900);
    assert.deepEqual(header300, { left: 0, top: 0, right: 1200, bottom: 64 });
    assert.deepEqual(stickyCard300, { left: 620, top: 92, right: 1080, bottom: 392 });
    assert.deepEqual(fixed300, { left: 900, top: 700, right: 1100, bottom: 760 });

    // Once scrolled past stickyMaxTop - stickyMinTop (800 - 92 = 708), sticky card scrolls out with its parent.
    const proj750 = projectTextRects(measured, 750, 800, TEXT_MASK_MARGIN_PX);
    const stickyCard750 = proj750.find((r) => r.left === 620);
    assert.deepEqual(stickyCard750, { left: 620, top: 50, right: 1080, bottom: 350 });

    h.field.stop();
  }
});

test("measureTextRects unions .rv-wait / mid-transition transforms with final resting positions, applies heading pad, and extracts sticky bounds", () => {
  assert.deepEqual(parseTranslateTransform("none"), { tx: 0, ty: 0 });
  assert.deepEqual(parseTranslateTransform("matrix(1, 0, 0, 1, 0, 22)"), { tx: 0, ty: 22 });
  assert.deepEqual(parseTranslateTransform("matrix(1, 0, 0, 1, 0, 13.8)"), { tx: 0, ty: 13.8 });
  assert.deepEqual(parseTranslateTransform("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 22, 0, 1)"), {
    tx: -4,
    ty: 22,
  });

  // 1) `.rv-wait` block translated down by 22 px: union covers both final resting top (300) and start bottom (362).
  const rvWrapper: RectReadable = {
    tagName: "DIV",
    getBoundingClientRect: () => ({ left: 80, top: 322, right: 600, bottom: 422 }),
  };
  const rvParagraph: RectReadable = {
    tagName: "P",
    parentElement: rvWrapper,
    getBoundingClientRect: () => ({ left: 100, top: 322, right: 500, bottom: 362 }),
  };
  // 2) `h1` + italic `em` inside it: gets TEXT_MASK_HEADING_PAD_PX.
  const heading: RectReadable = {
    tagName: "H1",
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 420, bottom: 166 }),
  };
  const headingEm: RectReadable = {
    tagName: "EM",
    closest: (sel) => (sel.includes("h1") ? heading : null),
    getBoundingClientRect: () => ({ left: 300, top: 96, right: 430, bottom: 172 }),
  };
  // 3) Sticky container `.build-code` (top: 92px) inside `.build-grid` [340, 1100].
  const buildGrid: RectReadable = {
    tagName: "SECTION",
    getBoundingClientRect: () => ({ left: 80, top: 340, right: 1120, bottom: 1100 }),
  };
  const buildCode: RectReadable = {
    tagName: "DIV",
    parentElement: buildGrid,
    getBoundingClientRect: () => ({ left: 600, top: 340, right: 1100, bottom: 740 }),
  };
  const buildPre: RectReadable = {
    tagName: "PRE",
    parentElement: buildCode,
    getBoundingClientRect: () => ({ left: 628, top: 440, right: 1072, bottom: 712 }),
  };

  const styles = new Map<RectReadable, ComputedStyleLike>([
    [rvWrapper, { transform: "matrix(1, 0, 0, 1, 0, 22)" }],
    [buildCode, { position: "sticky", top: "92px" }],
  ]);

  const rects = measureTextRects(
    { querySelectorAll: () => [rvParagraph, heading, headingEm, buildPre] },
    { width: 1200, height: 800 },
    { getComputedStyle: (el) => styles.get(el) ?? null },
  );

  // Reveal paragraph covers final resting top (322 - 22 = 300) AND initial translated bottom (362), plus pad.
  const rvRect = rects.find((r) => r.left === 100 - TEXT_MASK_PAD_PX && r.right === 500 + TEXT_MASK_PAD_PX);
  assert.deepEqual(rvRect, {
    left: 100 - TEXT_MASK_PAD_PX,
    top: 300 - TEXT_MASK_PAD_PX,
    right: 500 + TEXT_MASK_PAD_PX,
    bottom: 362 + TEXT_MASK_PAD_PX,
  });

  // Heading and its italic `em` both receive TEXT_MASK_HEADING_PAD_PX (14 px), covering the >10 px overhang.
  const h1Rect = rects.find((r) => r.left === 100 - TEXT_MASK_HEADING_PAD_PX);
  const emRect = rects.find((r) => r.right === 430 + TEXT_MASK_HEADING_PAD_PX);
  assert.deepEqual(h1Rect, {
    left: 100 - TEXT_MASK_HEADING_PAD_PX,
    top: 100 - TEXT_MASK_HEADING_PAD_PX,
    right: 420 + TEXT_MASK_HEADING_PAD_PX,
    bottom: 166 + TEXT_MASK_HEADING_PAD_PX,
  });
  assert.deepEqual(emRect, {
    left: 300 - TEXT_MASK_HEADING_PAD_PX,
    top: 96 - TEXT_MASK_HEADING_PAD_PX,
    right: 430 + TEXT_MASK_HEADING_PAD_PX,
    bottom: 172 + TEXT_MASK_HEADING_PAD_PX,
  });

  // Sticky `<pre>` child inside `.build-code` records exact sticky clamp metadata.
  const stickyRect = rects.find((r) => r.left === 628 - TEXT_MASK_PAD_PX);
  assert.deepEqual(stickyRect, {
    left: 628 - TEXT_MASK_PAD_PX,
    top: 440 - TEXT_MASK_PAD_PX,
    right: 1072 + TEXT_MASK_PAD_PX,
    bottom: 712 + TEXT_MASK_PAD_PX,
    stickyMinTop: 92 + 100 - TEXT_MASK_PAD_PX,
    stickyMaxTop: 1100 - 400 + 100 - TEXT_MASK_PAD_PX,
  });

  // Mid-transition (ty = 13.8): final resting position (y = 300) is STILL capped at glowMax on that frame.
  styles.set(rvWrapper, { transform: "matrix(1, 0, 0, 1, 0, 13.8)" });
  const midParagraph: RectReadable = {
    tagName: "P",
    parentElement: rvWrapper,
    getBoundingClientRect: () => ({ left: 100, top: 313.8, right: 500, bottom: 353.8 }),
  };
  const midRects = measureTextRects(
    { querySelectorAll: () => [midParagraph] },
    { width: 1200, height: 800 },
    { getComputedStyle: (el) => styles.get(el) ?? null },
  );
  assert.equal(midRects[0]!.top, 300 - TEXT_MASK_PAD_PX);
  assert.equal(midRects[0]!.bottom, 353.8 + TEXT_MASK_PAD_PX);
  assert.equal(textMaskOpenness(250, 300, midRects), 0, "final resting top stays fully masked mid-reveal");
});

test("first frame after reduced motion turns off or after a hidden tab returns measures before drawing", () => {
  // Scenario A: starts with reduced motion ON (no initial measure), then turns OFF.
  const h1 = makeHarness({ width: 900, height: 600, reduced: true, theme: "dark" });
  let reduced = true;
  let hidden = false;
  let currentTextRect: TextRect = { left: 100, top: 200, right: 400, bottom: 320 };
  const mask1 = createFrameThrottledMeasure({
    isActive: () => !hidden && !reduced && !h1.field.isDegraded(),
    measure: () => h1.field.setTextRects([currentTextRect], 0),
  });
  mask1.measureNow(); // inactive under reduced motion -> skipped
  h1.field.start();
  h1.field.onPointerMove(250, 260);

  // Reduced motion turns off: measureNow runs synchronously BEFORE onReducedMotionChange schedules first rAF.
  reduced = false;
  h1.setReduced(false);
  mask1.measureNow();
  h1.field.onReducedMotionChange();
  h1.main.rec.fillRectCalls.length = 0;
  h1.stepFrame(16); // very first animated frame
  let checkedFirst = 0;
  for (const call of h1.main.rec.fillRectCalls) {
    const cx = call.x + call.w / 2;
    const cy = call.y + call.h / 2;
    if (cx >= 100 && cx <= 400 && cy >= 200 && cy <= 320) {
      checkedFirst += 1;
      assert.ok(parseAlpha(call.fillStyle) <= DOT_FIELD_SPECS.dark.glowMax.a + 1e-6);
    }
  }
  assert.ok(checkedFirst > 0, "first frame after reduced-motion off capped text region");
  h1.field.stop();

  // Scenario B: tab hides, layout shifts while hidden, then tab returns.
  const h2 = makeHarness({ width: 900, height: 600, theme: "light" });
  hidden = false;
  reduced = false;
  currentTextRect = { left: 100, top: 100, right: 400, bottom: 180 };
  const mask2 = createFrameThrottledMeasure({
    isActive: () => !hidden && !reduced && !h2.field.isDegraded(),
    measure: () => h2.field.setTextRects([currentTextRect], 0),
  });
  mask2.measureNow();
  h2.field.start();
  h2.stepFrame(16);

  hidden = true;
  h2.setHidden(true);
  h2.field.onVisibilityChange();
  // Text moves to a new location while hidden.
  currentTextRect = { left: 450, top: 260, right: 750, bottom: 380 };
  h2.field.onPointerMove(600, 320);

  // Tab returns: measureNow runs BEFORE onVisibilityChange schedules the first resumed frame.
  hidden = false;
  h2.setHidden(false);
  mask2.measureNow();
  h2.field.onVisibilityChange();
  h2.main.rec.fillRectCalls.length = 0;
  h2.stepFrame(60_016);
  let checkedResume = 0;
  for (const call of h2.main.rec.fillRectCalls) {
    const cx = call.x + call.w / 2;
    const cy = call.y + call.h / 2;
    if (cx >= 450 && cx <= 750 && cy >= 260 && cy <= 380) {
      checkedResume += 1;
      assert.ok(parseAlpha(call.fillStyle) <= DOT_FIELD_SPECS.light.glowMax.a + 1e-6);
    }
  }
  assert.ok(checkedResume > 0, "first frame after returning from hidden tab capped new text region");
  h2.field.stop();

  // Guard SiteBackdrop's wiring in site.tsx so resume/resize/theme always measure before drawing.
  const siteSrc = readFileSync(new URL("../src/web/site.tsx", import.meta.url), "utf8");
  assert.match(siteSrc, /onVisibility\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(!document\.hidden\)\s*mask\?\.measureNow\(\);\s*field\.onVisibilityChange\(\);/s);
  assert.match(siteSrc, /onMotion\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(!isReduced\(\)\)\s*mask\?\.measureNow\(\);\s*field\.onReducedMotionChange\(\);/s);
  assert.match(siteSrc, /onResize\s*=\s*\(\)\s*=>\s*\{\s*mask\?\.measureNow\(\);\s*field\.resize\(\);/s);
  assert.match(siteSrc, /subscribeTheme\(\(\)\s*=>\s*\{\s*mask\?\.measureNow\(\);\s*field\.onThemeChange\(\);/s);
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
});
