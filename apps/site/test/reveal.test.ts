/**
 * Scroll reveals: visible by default (never hides text when JS or IntersectionObserver is absent),
 * completely static under prefers-reduced-motion, and only animates below-the-fold elements.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initReveals, type ObserverEntryLike, type RevealElementLike } from "../src/web/reveal.ts";

function makeEl(top: number): RevealElementLike & { classes: Set<string> } {
  const classes = new Set<string>(["rv"]);
  return {
    classes,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
    },
    getBoundingClientRect: () => ({ top }),
  };
}

test("under reduced motion, reveals never hide elements and never create an observer", () => {
  const els = [makeEl(100), makeEl(1400)];
  let observerCreated = false;
  const cleanup = initReveals<RevealElementLike>({
    elements: els,
    viewportHeight: 900,
    reducedMotion: true,
    createObserver: () => {
      observerCreated = true;
      throw new Error("should not be called");
    },
  });
  assert.equal(observerCreated, false);
  for (const el of els) {
    assert.equal(el.classes.has("rv-wait"), false);
    assert.equal(el.classes.has("rv-in"), true);
  }
  cleanup();
});

test("without IntersectionObserver, all elements stay visible", () => {
  const els = [makeEl(100), makeEl(1500)];
  initReveals({
    elements: els,
    viewportHeight: 900,
    reducedMotion: false,
    createObserver: null,
  });
  for (const el of els) assert.equal(el.classes.has("rv-wait"), false);
});

test("above-the-fold stays visible immediately; below-the-fold reveals on intersection or cleanup", () => {
  const above = makeEl(200);
  const below1 = makeEl(1200);
  const below2 = makeEl(1800);
  let onEntries: ((entries: readonly ObserverEntryLike[]) => void) | null = null;
  const observed = new Set<RevealElementLike>();
  let disconnected = false;

  const cleanup = initReveals<RevealElementLike>({
    elements: [above, below1, below2],
    viewportHeight: 900,
    reducedMotion: false,
    createObserver: (cb) => {
      onEntries = cb;
      return {
        observe: (el) => void observed.add(el),
        unobserve: (el) => void observed.delete(el),
        disconnect: () => {
          disconnected = true;
          observed.clear();
        },
      };
    },
  });

  assert.equal(above.classes.has("rv-wait"), false, "above-the-fold is never hidden");
  assert.equal(above.classes.has("rv-in"), true);
  assert.equal(below1.classes.has("rv-wait"), true);
  assert.equal(below2.classes.has("rv-wait"), true);
  assert.equal(observed.has(above), false);
  assert.equal(observed.has(below1), true);
  assert.equal(observed.has(below2), true);

  // Intersecting reveals below1 and unobserves it.
  onEntries!([{ isIntersecting: true, target: below1 }]);
  assert.equal(below1.classes.has("rv-wait"), false);
  assert.equal(below1.classes.has("rv-in"), true);
  assert.equal(observed.has(below1), false);

  // Cleanup ensures below2 is never left hidden.
  cleanup();
  assert.equal(disconnected, true);
  assert.equal(below2.classes.has("rv-wait"), false);
  assert.equal(below2.classes.has("rv-in"), true);
});
