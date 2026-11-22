/**
 * The hero's "Try me" arrow (TIN-1103, hero/try-me.ts): when it shows and when it goes (each interaction, the tab's
 * stored dismissal, storage that throws), where it is placed (beside the copy pointing at the agent, under it pointing
 * down at the stage, nowhere when it would cover text or the stage), its markup (decorative, no style attribute), its
 * stylesheet (a still arrow under reduced motion) and how HeroStage wires it. The label's contrast is in landing.test.ts.
 * When it shows relative to the stage's own pin is driven on the stage's clock in hero-sequence.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openRealHero, takeRealHeroOpen } from "../src/web/landing/hero/live.ts";
import { createTryMe, placeTryMe, TRY_ME_CLEAR, TRY_ME_KEY, TRY_ME_SHAPES, TryMeArrow, tryMe, type Box, type TryMeLayout } from "../src/web/landing/hero/try-me.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const stage = read("apps/site/src/web/landing/HeroStage.tsx");
const section = read("apps/site/src/web/landing/HeroSection.tsx");
const css = read("apps/site/src/web/styles/hero.css");

/** A sessionStorage stand-in. */
function memory() {
  const items = new Map<string, string>();
  return { items, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

test("it waits for the stage, shows, and goes for good on the first interaction, stored for the tab", () => {
  const storage = memory();
  const arrow = createTryMe(() => storage);
  const heard: string[] = [];
  arrow.subscribe(() => heard.push(arrow.phase()));
  assert.equal(arrow.phase(), "waiting");
  arrow.ready();
  assert.equal(arrow.phase(), "shown");
  arrow.dismiss();
  assert.equal(arrow.phase(), "gone", "dismissed while shown: it fades out");
  assert.equal(storage.items.get(TRY_ME_KEY), "1");
  assert.equal(TRY_ME_KEY, "apc:site:try-me-dismissed");
  arrow.ready();
  arrow.dismiss();
  assert.equal(arrow.phase(), "gone", "nothing brings it back");
  assert.deepEqual(heard, ["shown", "gone"]);

  // A reload in the same tab: the stored dismissal holds, the stage's end does not bring it back.
  const reloaded = createTryMe(() => storage);
  assert.equal(reloaded.phase(), "dismissed");
  reloaded.ready();
  assert.equal(reloaded.phase(), "dismissed");
  // A new tab (an empty sessionStorage) sees it again.
  const fresh = createTryMe(() => memory());
  fresh.ready();
  assert.equal(fresh.phase(), "shown");
});

test("an interaction before it shows dismisses it too: it is never drawn", () => {
  const storage = memory();
  const arrow = createTryMe(() => storage);
  arrow.dismiss();
  assert.equal(arrow.phase(), "dismissed");
  arrow.ready();
  assert.equal(arrow.phase(), "dismissed");
  assert.equal(storage.items.get(TRY_ME_KEY), "1");
});

test("storage that throws does not break the hero: the arrow still shows and goes, for this page only", () => {
  const throwing = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };
  for (const storage of [() => throwing, () => { throw new DOMException("blocked", "SecurityError"); }, () => null]) {
    const arrow = createTryMe(storage);
    assert.equal(arrow.phase(), "waiting");
    arrow.ready();
    assert.equal(arrow.phase(), "shown");
    assert.doesNotThrow(() => arrow.dismiss());
    assert.equal(arrow.phase(), "gone");
  }
});

test("\"Use your own agent\", from anywhere (openRealHero), dismisses the page's arrow", () => {
  assert.equal(tryMe.phase(), "waiting", "no sessionStorage under node: nothing stored");
  tryMe.ready();
  assert.equal(tryMe.phase(), "shown");
  openRealHero();
  assert.equal(tryMe.phase(), "gone");
  takeRealHeroOpen(); // no hero here to take the request
});

test("HeroStage dismisses it on a press on the agent, a tap or keyboard arming, and every pin; shows it once its own pin is over", () => {
  assert.match(stage, /import \{ tryMe \} from "\.\/hero\/try-me\.ts";/);
  // A pin by any means: drag, tap then a bar, the keyboard, or the badge moved: enablePinning's onPin.
  assert.match(stage, /onPin: \(_grant, target\) => \{[^}]*stopSelfPlay\(\);\s*tryMe\.dismiss\(\);\s*void sequence\.pin\(index, "visitor"\);/);
  // A press on the agent (a drag starts there); the agent armed by a tap or by Enter (apc-armed with an id).
  assert.match(stage, /const pressed = \(e: PointerEvent\) => e\.target instanceof Element && e\.target\.closest\("\[data-apc-mark\]"\) && tryMe\.dismiss\(\);/);
  assert.match(stage, /const armed = \(e: Event\) => \(e as CustomEvent<\{ id: string \| null \} \| null>\)\.detail\?\.id && tryMe\.dismiss\(\);/);
  assert.match(stage, /stage\.addEventListener\("pointerdown", pressed, true\);\s*window\.addEventListener\("apc-armed", armed\);/);
  // Once the stage's own pin is over (done or cut short), or at once under reduced motion; never after the stage left.
  assert.match(stage, /if \(reduceRef\.current\) return tryMe\.ready\(\);/);
  assert.match(stage, /await sequence\.pin\(index, "self"\);\s*over\(\);/);
  assert.equal([...stage.matchAll(/return over\(\);/g)].length, 2, "the self-play cut short before its pin is over too");
  assert.match(stage, /const over = \(\) => \{\s*if \(!left\) tryMe\.ready\(\);\s*\};/);
  // "Use your own agent" is heard by try-me.ts itself, through the one open action (live.ts), not a second path.
  assert.match(read("apps/site/src/web/landing/hero/try-me.ts"), /subscribeRealHeroOpen\(\(\) => tryMe\.dismiss\(\)\);/);
  assert.match(section, /<HeroStage \/>\s*<\/div>\s*<TryMeArrow \/>/, "a child of the hero's grid, after the stage");
});

test("the markup is decorative, carries no style attribute, and is nothing until the arrow shows", () => {
  const arrow = createTryMe(() => null);
  assert.equal(renderToStaticMarkup(createElement(TryMeArrow, { store: arrow })), "");
  arrow.ready();
  const shown = renderToStaticMarkup(createElement(TryMeArrow, { store: arrow }));
  assert.match(shown, /^<div class="try-me" data-dir="right" data-text-mask="" aria-hidden="true" hidden="">/, "hidden until placed; the dot field keeps its text caps under all of it (TIN-1102)");
  assert.match(shown, /<span class="try-me-label" data-text-mask="">Try me<\/span>/);
  assert.match(shown, /<mask id="try-me-mask-right"/);
  assert.match(shown, /<path class="try-me-reveal" d="[^"]+" pathLength="1"><\/path>/);
  assert.doesNotMatch(shown, /style=/);
  arrow.dismiss();
  assert.match(renderToStaticMarkup(createElement(TryMeArrow, { store: arrow })), /^<div class="try-me is-gone"/);
  assert.doesNotMatch(read("apps/site/src/web/landing/hero/try-me.ts"), /\bstyle:|setAttribute\("style"|innerHTML/, "placed through the CSSOM only");
});

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
/** The hero at 1440 × 900 (measured in the preview). */
const DESKTOP: TryMeLayout = {
  grid: box(92, 117, 1332, 687),
  copy: box(92, 173, 522, 631),
  stage: box(578, 117, 1332, 687),
  mark: box(608, 589, 640, 621),
  anchor: box(92, 609, 237, 631),
  texts: [box(92, 173, 522, 190), box(92, 215, 522, 409), box(92, 431, 522, 516), box(92, 546, 245, 591), box(257, 546, 436, 591), box(92, 609, 237, 631)],
};
/** The hero at 375 × 812: the stage under the copy. */
const PHONE: TryMeLayout = {
  grid: box(16, 70, 359, 1200),
  copy: box(16, 70, 359, 478),
  stage: box(16, 514, 359, 1200),
  mark: box(40, 840, 72, 872),
  anchor: box(16, 456, 161, 478),
  texts: [box(16, 70, 359, 88), box(16, 100, 359, 230), box(16, 250, 359, 370), box(16, 395, 181, 440), box(193, 395, 359, 440), box(16, 456, 161, 478)],
};

test("beside the copy it points right at the agent, clear of the stage; under it, down at the stage", () => {
  const right = placeTryMe(DESKTOP)!;
  assert.equal(right.dir, "right");
  const r = TRY_ME_SHAPES.right;
  const tipX = DESKTOP.grid.left + right.x + r.tipX;
  const tipY = DESKTOP.grid.top + right.y + r.tipY;
  assert.equal(tipX, DESKTOP.stage.left - TRY_ME_CLEAR, "the tip stops short of the stage");
  assert.equal(tipY, 605, "level with the agent");
  assert.ok(DESKTOP.grid.left + right.x + r.width <= DESKTOP.stage.left);

  const down = placeTryMe(PHONE)!;
  assert.equal(down.dir, "down");
  const d = TRY_ME_SHAPES.down;
  assert.equal(PHONE.grid.top + down.y + d.tipY, PHONE.stage.top - TRY_ME_CLEAR, "the tip stops short of the stage");
  assert.ok(PHONE.grid.left + down.x >= PHONE.anchor!.right + 20, "beside the video link");
  assert.ok(PHONE.grid.left + down.x + d.width <= PHONE.grid.right, "inside the grid: no horizontal scroll");
});

test("where it would cover the copy's text or leave the grid, it is not drawn", () => {
  // A line of text where the label would go.
  assert.equal(placeTryMe({ ...DESKTOP, texts: [...DESKTOP.texts, box(380, 640, 470, 660)] }), null);
  // A grid too narrow for it.
  assert.equal(placeTryMe({ ...PHONE, grid: { ...PHONE.grid, right: 280 } }), null);
  // No video link to sit beside on a stacked hero.
  assert.equal(placeTryMe({ ...PHONE, anchor: null }), null);
  // A button's corner in the box's empty corner is fine: only the ink is kept clear.
  assert.ok(placeTryMe({ ...DESKTOP, texts: [...DESKTOP.texts, box(300, 560, 395, 600)] }));
  // Without the agent in its bar, it points at the stage's lower part.
  const lower = placeTryMe({ ...DESKTOP, mark: null })!;
  assert.equal(DESKTOP.grid.top + lower.y + TRY_ME_SHAPES.right.tipY, DESKTOP.stage.top + (DESKTOP.stage.bottom - DESKTOP.stage.top) * 0.8);
});

test("it draws in and nudges in CSS keyframes, never past five seconds, and stands still under reduced motion", () => {
  const rule = (selector: string) => {
    const open = css.indexOf(`${selector} {`);
    assert.ok(open >= 0, selector);
    return css.slice(open, css.indexOf("}", open));
  };
  assert.match(rule(".try-me-reveal"), /animation: try-me-draw /);
  assert.match(rule('.try-me[data-dir="right"] .try-me-svg'), /animation: try-me-nudge-x 1\.1s ease-in-out 1\.7s 3;/);
  assert.match(rule('.try-me[data-dir="down"] .try-me-svg'), /animation: try-me-nudge-y 1\.1s ease-in-out 1\.7s 3;/);
  assert.ok(1.7 + 1.1 * 3 <= 5, "all motion over within five seconds (WCAG 2.2.2)");
  assert.match(css, /@keyframes try-me-nudge-x \{[^@]*translateX\(5px\)/, "a nudge of 5 px, inside TRY_ME_CLEAR");
  assert.ok(TRY_ME_CLEAR > 5);
  // Drawn state is the resting state: with no animation the curve, head and label are all there.
  assert.match(rule(".try-me-reveal"), /stroke-dashoffset: 0;/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const still of [".try-me-reveal", ".try-me-head", ".try-me-label", ".try-me-svg"]) assert.ok(reduced.includes(still), still);
  assert.match(reduced, /\.try-me \{\s*transition: none;/);
  // Decoration that never takes a click, in the accent; the label in the text accent the contrast test checks.
  assert.match(rule(".try-me"), /pointer-events: none;/);
  assert.match(rule(".try-me"), /color: var\(--accent\);/);
  assert.match(rule(".try-me-label"), /color: var\(--accent-text\);/);
  assert.doesNotMatch(rule(".try-me-label"), /opacity/, "the label is never thinned at rest");
  // Placed through custom properties set in the CSSOM.
  assert.match(rule(".try-me"), /left: var\(--try-x, 0px\);\s*top: var\(--try-y, 0px\);/);
});
