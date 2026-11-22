/**
 * The hero's arrow (TIN-1103, three steps since TIN-1106, hero/try-me.ts): its steps ("Try me" at the agent, "Try me" at
 * "Use your own agent", "Do this" at Pulse's Connect box), when each shows and goes, that nothing is remembered across a
 * reload, where each is placed (beside the copy and with the stage stacked under it, at the largest size that fits,
 * nowhere when nothing fits), its markup (decorative, no style attribute), its stylesheet (a still arrow under reduced
 * motion) and how HeroStage and the live frame wire it. The labels' contrast is in landing.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openRealHero, takeRealHeroOpen } from "../src/web/landing/hero/live.ts";
import {
  createTryMe,
  placeTryMe,
  TRY_ME_ABOVE,
  TRY_ME_CLEAR,
  TRY_ME_DELAY_MS,
  TRY_ME_LABELS,
  TRY_ME_OVER_REACH,
  TRY_ME_SCALES,
  TRY_ME_STACKED_SCALES,
  TryMeArrow,
  tryMe,
  type Box,
  type TryMeLayout,
  type TryMePlace,
} from "../src/web/landing/hero/try-me.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const stage = read("apps/site/src/web/landing/HeroStage.tsx");
const section = read("apps/site/src/web/landing/HeroSection.tsx");
const live = read("apps/site/src/web/landing/hero/live.ts");
const source = read("apps/site/src/web/landing/hero/try-me.ts");
const css = read("apps/site/src/web/styles/hero.css");

test("three steps: Try me at the agent, Try me at Use your own agent after the first interaction, Do this once it opened", () => {
  const arrow = createTryMe();
  const heard: string[] = [];
  arrow.subscribe(() => heard.push(`${arrow.view().step}:${arrow.view().phase}`));
  assert.deepEqual(arrow.view(), { step: "agent", phase: "waiting" });
  arrow.ready("own");
  assert.equal(arrow.view().phase, "waiting", "only the step the visitor is on");
  arrow.ready("agent");
  assert.deepEqual(arrow.view(), { step: "agent", phase: "shown" });
  arrow.interacted();
  assert.deepEqual(arrow.view(), { step: "own", phase: "waiting" }, "the first arrow goes on the interaction; the second waits");
  arrow.ready("agent");
  assert.equal(arrow.view().phase, "waiting", "the stage's 5 s timer firing late does not bring the first back");
  arrow.interacted();
  arrow.ready("own");
  assert.deepEqual(arrow.view(), { step: "own", phase: "shown" });
  arrow.opened();
  assert.deepEqual(arrow.view(), { step: "connect", phase: "shown" }, "Use your own agent: the arrow moves to the Connect box");
  arrow.back();
  assert.deepEqual(arrow.view(), { step: "own", phase: "shown" }, "Back to the demo: back to Use your own agent");
  arrow.opened();
  arrow.connection(false);
  assert.equal(arrow.view().phase, "shown", "not connected yet");
  arrow.connection(true);
  assert.deepEqual(arrow.view(), { step: "connect", phase: "gone" }, "connected: it fades out");
  for (const act of [() => arrow.back(), () => arrow.opened(), () => arrow.ready("own"), () => arrow.interacted()]) act();
  assert.deepEqual(arrow.view(), { step: "connect", phase: "gone" }, "and stays gone for the page");
  assert.deepEqual(heard, ["agent:shown", "own:waiting", "own:shown", "connect:shown", "own:shown", "connect:shown", "connect:gone"]);
});

test("Use your own agent before any interaction goes straight to Do this; Back from there is Try me at the button", () => {
  const arrow = createTryMe();
  arrow.opened();
  assert.deepEqual(arrow.view(), { step: "connect", phase: "shown" });
  arrow.back();
  assert.deepEqual(arrow.view(), { step: "own", phase: "shown" });
  arrow.back();
  assert.deepEqual(arrow.view(), { step: "own", phase: "shown" }, "Back only matters from the Connect box");
});

test("nothing is remembered: no storage, so a reload starts at Try me again (TIN-1106)", () => {
  assert.doesNotMatch(source, /sessionStorage|localStorage|getItem|setItem/);
  assert.deepEqual(createTryMe().view(), { step: "agent", phase: "waiting" });
  assert.equal(TRY_ME_DELAY_MS, 5000, "about 5 s after the stage's animation starts");
});

test("the Connect box the frame reports is kept as given, and a change is heard", () => {
  const arrow = createTryMe();
  let heard = 0;
  arrow.subscribe(() => heard++);
  arrow.setConnectBox({ x: 10, y: 20, width: 300, height: 200 });
  arrow.setConnectBox({ x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(arrow.connectBox(), { x: 10, y: 20, width: 300, height: 200 });
  arrow.setConnectBox(null);
  assert.equal(arrow.connectBox(), null);
  assert.equal(heard, 2, "the same box twice is one change");
});

test("\"Use your own agent\", from anywhere (openRealHero), moves the page's arrow to the Connect box", () => {
  assert.deepEqual(tryMe.view(), { step: "agent", phase: "waiting" });
  openRealHero();
  assert.deepEqual(tryMe.view(), { step: "connect", phase: "shown" });
  takeRealHeroOpen(); // no hero here to take the request
  tryMe.back();
});

test("HeroStage: Try me 5 s after the stage starts; the first interaction moves on; the live frame reports through events", () => {
  assert.match(stage, /import \{ TRY_ME_DELAY_MS, TRY_ME_OWN_DELAY_MS, tryMe \} from "\.\/hero\/try-me\.ts";/);
  // The first arrow: on the stage's clock (paused while the tab is hidden), at once under reduced motion.
  assert.match(stage, /if \(reduceRef\.current\) return tryMe\.ready\("agent"\);\s*const due = new AbortController\(\);\s*void clock\.wait\(TRY_ME_DELAY_MS, due\.signal\)\.then\(\(\) => \{\s*if \(!due\.signal\.aborted\) tryMe\.ready\("agent"\);/);
  assert.doesNotMatch(stage, /over\(\)/, "no longer tied to the end of the stage's own pin");
  // A pin by any means: the second arrow shows when that pin (the latest) is over.
  assert.match(stage, /onPin: \(_grant, target\) => \{[^}]*stopSelfPlay\(\);\s*tryMe\.interacted\(\);\s*ownWait\.current\?\.abort\(\);\s*ownWait\.current = null;\s*const run = \+\+pinRun\.current;\s*void sequence\.pin\(index, "visitor"\)\.then\(\(\) => \{\s*if \(pinRun\.current === run\) tryMe\.ready\("own"\);/);
  // A press on the agent, or the agent armed by a tap or a key: the second arrow a few seconds later, unless a pin came.
  assert.match(stage, /const pressed = \(e: PointerEvent\) => e\.target instanceof Element && e\.target\.closest\("\[data-apc-mark\]"\) && interacted\(\);/);
  assert.match(stage, /const armed = \(e: Event\) => \(e as CustomEvent<\{ id: string \| null \} \| null>\)\.detail\?\.id && interacted\(\);/);
  assert.match(stage, /void clock\.wait\(TRY_ME_OWN_DELAY_MS, wait\.signal\)\.then\(\(\) => \{[^}]*if \(!wait\.signal\.aborted && pinRun\.current === run\) tryMe\.ready\("own"\);/);
  // The live frame's status, Connect box and Back, given to HeroStageHost; live.ts does not import the arrow.
  assert.match(stage, /const LIVE_EVENTS = \{ status: tryMe\.connection, connectBox: tryMe\.setConnectBox, back: tryMe\.back \};/);
  assert.match(stage, /<HeroStageHost\s+events=\{LIVE_EVENTS\}/);
  assert.doesNotMatch(live, /from "\.\/try-me/, "live.ts does not import the arrow (try-me.ts imports live.ts)");
  assert.match(live, /events\.current\?\.status\?\.\(message\.connected\);/);
  assert.match(live, /message\.type === "apc:embed-anchor"\) \{\s*events\.current\?\.connectBox\?\.\(message\.connect\);/);
  assert.match(live, /events\.current\?\.connectBox\?\.\(null\);\s*\};/, "the box goes with the frame");
  assert.match(source, /subscribeRealHeroOpen\(\(\) => tryMe\.opened\(\)\);/, "Use your own agent is heard through the one open action");
  assert.match(section, /<HeroStage \/>\s*<\/div>\s*<TryMeArrow \/>/, "a child of the hero's grid, after the stage");
});

test("the markup is decorative, carries no style attribute, says each step's word, and is nothing while waiting", () => {
  const arrow = createTryMe();
  assert.equal(renderToStaticMarkup(createElement(TryMeArrow, { store: arrow })), "");
  arrow.ready("agent");
  const shown = renderToStaticMarkup(createElement(TryMeArrow, { store: arrow }));
  assert.match(shown, /^<div class="try-me" data-dir="right" data-step="agent" data-text-mask="" aria-hidden="true" hidden="">/, "hidden until placed; the dot field keeps its text caps under all of it (TIN-1102)");
  assert.match(shown, /<span class="try-me-label" data-text-mask="">Try me<\/span>/);
  assert.match(shown, /<mask id="try-me-mask-agent"/);
  assert.match(shown, /<path class="try-me-reveal" d="[^"]+" pathLength="1"><\/path>/);
  assert.doesNotMatch(shown, /style=/);
  arrow.opened();
  assert.match(renderToStaticMarkup(createElement(TryMeArrow, { store: arrow })), />Do this<\/span>/);
  arrow.connection(true);
  assert.match(renderToStaticMarkup(createElement(TryMeArrow, { store: arrow })), /^<div class="try-me is-gone"/);
  assert.doesNotMatch(source, /\bstyle:|setAttribute\("style"|innerHTML/, "placed through the CSSOM only");
});

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
/** The hero at 1440 × 900 (measured in the preview). */
const COPY_DESKTOP = { grid: box(92, 117, 1332, 687), copy: box(92, 173, 522, 631), stage: box(578, 117, 1332, 687), anchor: box(92, 609, 237, 631) };
const TEXTS_DESKTOP = [box(92, 173, 522, 193), box(92, 215, 522, 409), box(92, 431, 522, 516), box(92, 546, 239, 591), box(251, 546, 431, 591), box(92, 609, 237, 631)];
const DESKTOP = (target: Box | null): TryMeLayout => ({ ...COPY_DESKTOP, texts: TEXTS_DESKTOP, target });
const MARK_DESKTOP = box(608, 589, 640, 621);
const OWN_DESKTOP = box(1171, 140, 1309, 160);
const CONNECT_DESKTOP = box(986, 172, 1318, 420);
/** The hero at 375 × 812, page coordinates: the stage under the copy, the agent window under the chart. */
const COPY_PHONE = { grid: box(16, 118, 359, 1408), copy: box(16, 118, 359, 478), stage: box(16, 514, 359, 1408), anchor: box(16, 456, 161, 478) };
const TEXTS_PHONE = [box(16, 118, 359, 136), box(16, 150, 359, 230), box(16, 250, 359, 370), box(16, 395, 181, 440), box(193, 395, 359, 440), box(16, 456, 161, 478)];
const PHONE = (target: Box | null): TryMeLayout => ({ ...COPY_PHONE, texts: TEXTS_PHONE, target });
const MARK_PHONE = box(38, 834, 82, 878);
const OWN_PHONE = box(212, 905, 341, 923);
const CONNECT_PHONE = box(37, 905, 338, 1180);

/** The arrow's tip (the end of its curve), in viewport coordinates. */
function tip(p: TryMePlace, grid: Box) {
  const [x, y] = p.curve.split(" ").slice(-2).map(Number);
  return { x: grid.left + p.x + x!, y: grid.top + p.y + y! };
}
const inGrid = (p: TryMePlace, l: TryMeLayout) => l.grid.left + p.x >= l.grid.left && l.grid.left + p.x + p.width <= l.grid.right && l.grid.top + p.y >= l.grid.top - TRY_ME_ABOVE;

test("step 1 beside the copy: right at the agent, 80% larger, clear of the stage", () => {
  const l = DESKTOP(MARK_DESKTOP);
  const p = placeTryMe("agent", l)!;
  assert.equal(p.dir, "right");
  assert.equal(p.scale, 1.8, "80% larger than TIN-1103's");
  assert.deepEqual(TRY_ME_SCALES, [1.8, 1.4, 1]);
  const t = tip(p, l.grid);
  assert.ok(Math.abs(t.x - (l.stage.left - TRY_ME_CLEAR)) <= 1, "the tip stops short of the stage");
  assert.ok(Math.abs(t.y - 605) <= 1, "level with the agent");
  assert.ok(l.grid.left + p.x + p.width <= l.stage.left, "clear of the stage");
  assert.ok(inGrid(p, l));
  assert.equal(p.onStage, false, "a bare label on the field");
});

test("steps 2 and 3 beside the copy: from above the copy's first line, over the stage's top edge, down onto the target", () => {
  for (const [step, target] of [["own", OWN_DESKTOP], ["connect", CONNECT_DESKTOP]] as const) {
    const l = DESKTOP(target);
    const p = placeTryMe(step, l)!;
    assert.equal(p.dir, "over", step);
    assert.equal(p.scale, 1.8, step);
    assert.equal(p.onStage, false, `${step}: the label sits in the copy's column, on the field`);
    const label = { left: l.grid.left + p.x + p.labelX, top: l.grid.top + p.y + p.labelY };
    assert.ok(label.left + TRY_ME_LABELS[step === "own" ? "Try me" : "Do this"].width * 1.8 <= l.stage.left, `${step}: label left of the stage`);
    assert.ok(label.top + 26 * 1.8 <= TEXTS_DESKTOP[0]!.top, `${step}: label above the copy's first line`);
    assert.ok(target.top - COPY_DESKTOP.stage.top <= TRY_ME_OVER_REACH, `${step}: near the stage's top edge`);
    const t = tip(p, l.grid);
    assert.ok(t.y < target.top && t.x > target.left && t.x < target.right, `${step}: the tip is just over the target`);
    assert.ok(p.ny > 0 && p.nx > 0, `${step}: it comes down and right onto the target`);
    assert.ok(inGrid(p, l), `${step}: inside the grid, at most TRY_ME_ABOVE over it`);
  }
});

test("a target far under the stage's top edge (the agent window under the chart, ~1024 px) is not reached over that edge", () => {
  // At 1024 px the two columns stay, but the agent window sits under the chart: its button is ~380 px under the stage's top.
  const l: TryMeLayout = { grid: box(40, 117, 984, 900), copy: box(40, 173, 400, 640), stage: box(440, 117, 984, 900), anchor: box(40, 618, 185, 640), texts: [box(40, 173, 400, 193), box(40, 215, 400, 409), box(40, 431, 400, 520), box(40, 546, 185, 591), box(197, 546, 377, 591), box(40, 618, 185, 640)], target: box(820, 497, 960, 517) };
  const p = placeTryMe("own", l);
  assert.ok(p, "it still finds a way in");
  assert.notEqual(p!.dir, "over");
  assert.ok(p!.height < 200, "a short arrow beside the button, not one across the app window");
});

test("on phones: smaller, down at the stage beside the video link, then pills inside the stage beside each target", () => {
  assert.deepEqual(TRY_ME_STACKED_SCALES, [1.4, 1]);
  const first = placeTryMe("agent", PHONE(MARK_PHONE))!;
  assert.equal(first.dir, "down");
  assert.ok(tip(first, COPY_PHONE.grid).y === COPY_PHONE.stage.top - TRY_ME_CLEAR || Math.abs(tip(first, COPY_PHONE.grid).y - (COPY_PHONE.stage.top - TRY_ME_CLEAR)) <= 1);
  assert.ok(inGrid(first, PHONE(MARK_PHONE)));

  const own = placeTryMe("own", PHONE(OWN_PHONE))!;
  assert.equal(own.dir, "up", "from just under the button");
  assert.equal(own.onStage, true, "a pill, over the stage's window");
  assert.ok(tip(own, COPY_PHONE.grid).y > OWN_PHONE.bottom);
  assert.ok(inGrid(own, PHONE(OWN_PHONE)));

  const connect = placeTryMe("connect", PHONE(CONNECT_PHONE))!;
  assert.equal(connect.dir, "into", "from just over the box");
  assert.ok(tip(connect, COPY_PHONE.grid).y < CONNECT_PHONE.top);
  assert.ok(inGrid(connect, PHONE(CONNECT_PHONE)));
  for (const p of [own, connect]) assert.ok(p.scale <= 1.4);
});

test("where it would cover its target or the copy's text, or leave the grid, it is smaller or not drawn", () => {
  // Nothing to point at (the stage's own panel is open, or the frame said nothing yet): no arrow for steps 2 and 3.
  assert.equal(placeTryMe("own", DESKTOP(null)), null);
  assert.equal(placeTryMe("connect", PHONE(null)), null);
  // Step 1 without the agent in its bar points at the stage's lower part.
  const lower = placeTryMe("agent", DESKTOP(null))!;
  assert.ok(Math.abs(tip(lower, COPY_DESKTOP.grid).y - (COPY_DESKTOP.stage.top + (COPY_DESKTOP.stage.bottom - COPY_DESKTOP.stage.top) * 0.8)) <= 1);
  // A line of text where the big label would go: a smaller arrow, or none.
  const crowded = { ...DESKTOP(MARK_DESKTOP), texts: [...TEXTS_DESKTOP, box(330, 640, 420, 700)] };
  const smaller = placeTryMe("agent", crowded);
  assert.ok(!smaller || smaller.scale < 1.8);
  assert.equal(placeTryMe("agent", { ...DESKTOP(MARK_DESKTOP), texts: [...TEXTS_DESKTOP, box(92, 632, 577, 720)] }), null);
  // A grid too narrow for anything on a phone.
  assert.equal(placeTryMe("agent", { ...PHONE(MARK_PHONE), grid: { ...COPY_PHONE.grid, right: 200 } }), null);
  // No video link to sit beside on a stacked hero.
  assert.equal(placeTryMe("agent", { ...PHONE(MARK_PHONE), anchor: null }), null);
});

test("it draws in and nudges along its last stretch in CSS keyframes, never past five seconds, and stands still under reduced motion", () => {
  const rule = (selector: string) => {
    const open = css.indexOf(`${selector} {`);
    assert.ok(open >= 0, selector);
    return css.slice(open, css.indexOf("}", open));
  };
  assert.match(rule(".try-me-reveal"), /animation: try-me-draw /);
  assert.match(rule(".try-me .try-me-svg"), /animation: try-me-nudge 1\.1s ease-in-out 1\.7s 3;/);
  assert.ok(1.7 + 1.1 * 3 <= 5, "all motion over within five seconds (WCAG 2.2.2)");
  assert.match(css, /@keyframes try-me-nudge \{[^@]*translate\(var\(--try-nx, 5px\), var\(--try-ny, 0px\)\)/, "5 px along the arrow");
  assert.ok(TRY_ME_CLEAR > 5);
  assert.match(source, /set\("--try-nx", `\$\{place\.nx \* 5\}px`\);/);
  // Drawn state is the resting state: with no animation the curve, head and label are all there.
  assert.match(rule(".try-me-reveal"), /stroke-dashoffset: 0;/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const still of [".try-me-reveal", ".try-me-head", ".try-me-label", ".try-me-svg"]) assert.ok(reduced.includes(still), still);
  assert.match(reduced, /\.try-me \{\s*transition: none;/);
  // Decoration that never takes a click, in the accent; the label in the text accent, or a pill over the stage.
  assert.match(rule(".try-me"), /pointer-events: none;/);
  assert.match(rule(".try-me"), /color: var\(--accent\);/);
  assert.match(rule(".try-me-label"), /color: var\(--accent-text\);/);
  assert.match(rule(".try-me-label.is-pill"), /background: var\(--accent\);\s*color: var\(--try-pill-fg\);/);
  assert.doesNotMatch(rule(".try-me-label"), /opacity/, "the label is never thinned at rest");
  // Placed and sized through custom properties set in the CSSOM.
  assert.match(rule(".try-me"), /left: var\(--try-x, 0px\);\s*top: var\(--try-y, 0px\);/);
  assert.match(rule(".try-me-label"), /font: 700 calc\(15px \* var\(--try-s, 1\)\)/);
});
