/**
 * The landing's hero demo (TIN-1066): the answer the simulated agent gives for every month (from hero-data.json, the
 * January tie included), when "Now use your own agent" opens (after the visitor's second own pin and its answer, the
 * stage's own pin not counted), and what the stage is built from: the standard APC elements, no inline style, motion
 * in transforms and opacity, no self-play under reduced motion, Pulse's Agents page as the next step, and text colours
 * that pass 4.5:1 in both themes.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { answerParagraphs, answerText, heroAnswer, PLAN_NAMES, REGION_NAMES } from "../src/web/landing/hero/answer.ts";
import { CHART_TOP, monthName, type HeroData } from "../src/web/landing/hero/data.ts";
import { NO_PINS, offerDue, offerOpened, pinMade, type PinBy, type PinCount } from "../src/web/landing/hero/pins.ts";
import { DOT_FIELD_SPECS, type RgbaColor } from "../src/web/dot-field.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const data = JSON.parse(read("apps/site/src/web/hero-data.json")) as HeroData;
const stage = read("apps/site/src/web/landing/HeroStage.tsx");
const heroDir = "apps/site/src/web/landing/hero/";
const modules = readdirSync(new URL(heroDir, root)).map((f) => [f, read(heroDir + f)] as const);
const motion = read(heroDir + "motion.ts");
const css = read("apps/site/src/web/styles/hero.css");
const shellCss = read("apps/site/src/web/styles/shell.css");
const text = (m: (typeof data.months)[number]) => answerText(heroAnswer(m));

test("the answer for every month says what get_figure and get_customer returned, and nothing the chart shows alone", () => {
  assert.deepEqual(data.months.map((m) => m.month), ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  for (const m of data.months) {
    const a = heroAnswer(m);
    const facts = m.get_figure.breakdown.customers;
    assert.equal(a.active, facts.length, m.month);
    assert.equal(a.seats, facts.reduce((s, f) => s + f.seats, 0), m.month);
    assert.equal(a.plans.reduce((s, p) => s + p.count, 0), a.active, `${m.month}: every customer has a plan`);
    assert.equal(a.regions.reduce((s, r) => s + r.count, 0), a.active, `${m.month}: every customer has a region`);
    for (const p of a.plans) assert.equal(p.count, facts.filter((f) => f.plan === p.plan).length);
    for (const r of a.regions) assert.equal(r.count, facts.filter((f) => f.region === r.region).length);
    for (let i = 1; i < a.plans.length; i++) assert.ok(a.plans[i - 1]!.count >= a.plans[i]!.count, "plans, most first");
    const most = Math.max(...facts.map((f) => f.seats));
    assert.equal(a.top.first.seats, most, m.month);
    assert.ok(a.top.second.seats <= most && facts.filter((f) => f.seats > a.top.second.seats).length <= 1, `${m.month}: the runner-up`);
    // The names are what get_customer returned: get_figure gives ids only.
    for (const l of [a.top.first, a.top.second]) assert.equal(l.name, m.get_customer.find((c) => c.customer.id === l.id)?.customer.name);
    const i = m.get_figure.series.findIndex((s) => s.month === m.month);
    assert.deepEqual(a.previous, { month: m.get_figure.series[i - 1]!.month, active: m.get_figure.series[i - 1]!.value });
    const said = text(m);
    assert.ok(said.includes(`${a.active} active customers in ${monthName(m.month)}`), said);
    assert.ok(said.includes(`${a.seats.toLocaleString("en-US")} seats`), said);
    for (const p of a.plans) assert.ok(said.includes(`${p.count} on ${PLAN_NAMES[p.plan]}`), said);
    for (const r of a.regions) assert.ok(said.includes(`${REGION_NAMES[r.region]} ${r.count}`), said);
    assert.ok(said.includes(a.top.first.name) && said.includes(a.top.second.name), said);
    assert.doesNotMatch(said, /\$|€|revenue|MRR|ARR/i, "no money: the file holds none");
  }
});

test("March reads as the build page's example does, and the change against the month before", () => {
  const march = data.months.find((m) => m.month === "2026-03")!;
  assert.equal(
    text(march),
    "123 active customers in March 2026, with 4,009 seats in total. 51 on Team, 48 on Starter, 24 on Business. By region: LATAM 51, North America 45, EMEA 27. The most seats: Lumen Delta Systems (229, Business, LATAM), then Open Pine Foods (225, Business, North America). Up 10 from 113 in February 2026.",
  );
  const november = data.months.find((m) => m.month === "2025-11")!;
  assert.match(text(november), /Down 2 from 102 in October 2025\.$/);
  const october = data.months.find((m) => m.month === "2025-10")!;
  assert.match(text(october), /Up 10 from 92 in September 2025\.$/, "October's month before comes from get_figure's series");
  // The key figures are bold.
  assert.deepEqual(answerParagraphs(heroAnswer(march))[0]![0], { strong: "123 active customers" });
});

test("January is a tie for the most seats, and the answer says so", () => {
  const january = data.months.find((m) => m.month === "2026-01")!;
  const a = heroAnswer(january);
  assert.equal(a.top.tie, true);
  assert.equal(a.top.first.seats, 186);
  assert.equal(a.top.second.seats, 186);
  assert.match(text(january), /Two customers share the most seats, 186 each: Cedar Harbor Health \(Business, North America\) and Lumen Delta Systems \(Business, LATAM\)\./);
  for (const m of data.months.filter((x) => x.month !== "2026-01")) {
    assert.equal(heroAnswer(m).top.tie, false, m.month);
    assert.doesNotMatch(text(m), /share the most seats/);
  }
});

test("the panel opens after the visitor's second own pin and its answer; the stage's own pin does not count", () => {
  const play = (steps: Array<["pin" | "answer", PinBy]>) => {
    let count: PinCount = NO_PINS;
    const offers: number[] = [];
    steps.forEach(([step, by], i) => {
      if (step === "pin") count = pinMade(count, by);
      else if (offerDue(count, by)) {
        // The panel opens (and only then counts as offered).
        count = offerOpened(count);
        offers.push(i);
      }
    });
    return { count, offers };
  };
  // Self-play, then two pins of the visitor's: the panel after the second answer, once.
  assert.deepEqual(play([["pin", "self"], ["answer", "self"], ["pin", "visitor"], ["answer", "visitor"], ["pin", "visitor"], ["answer", "visitor"], ["pin", "visitor"], ["answer", "visitor"]]).offers, [5]);
  // Self-play alone, or with one pin of the visitor's: no panel.
  assert.deepEqual(play([["pin", "self"], ["answer", "self"], ["pin", "visitor"], ["answer", "visitor"]]).offers, []);
  assert.equal(play([["pin", "self"], ["answer", "self"]]).count.own, 0);
  // A pin cut short by the next one counts; the panel waits for an answer.
  assert.deepEqual(play([["pin", "visitor"], ["pin", "visitor"]]).offers, []);
  assert.deepEqual(play([["pin", "visitor"], ["pin", "visitor"], ["answer", "visitor"]]).offers, [2]);
  // Opened from the title bar's shortcut: it does not open again by itself.
  let count = offerOpened(pinMade(NO_PINS, "visitor"));
  count = pinMade(count, "visitor");
  assert.equal(offerDue(count, "visitor"), false);
  // Due is not offered: until the panel opens, the next answer is due again (hero-sequence.test.ts drives the wait).
  const two = pinMade(pinMade(NO_PINS, "visitor"), "visitor");
  assert.equal(offerDue(two, "visitor"), true);
  assert.equal(two.offered, false);
});

test("the stage is the standard APC pinning, not a redrawn imitation", () => {
  const elements = modules.find(([f]) => f === "elements.tsx")![1];
  assert.match(elements, /defineAgentBar\(\);/);
  assert.match(elements, /definePinBadge\(\);/);
  assert.match(elements, /createElement\("apc-agents"/);
  assert.match(elements, /createElement\("apc-pin"/);
  assert.match(stage, /enablePinning\(\{\s*root: stage,/);
  assert.match(stage, /\{\.\.\.focusAttrs\(\{ kind: m\.focus\.kind, id: null, params: m\.focus\.params \}\)\}/, "every bar is a target, named as Pulse names it");
  assert.match(stage, /data-apc-presence=\{lit === i \? "read" : undefined\}/, "presence lights up what the agent reads");
  // No inline style: the policy allows none, and CSSOM is the way (style.setProperty).
  for (const [file, source] of [["HeroStage.tsx", stage], ...modules] as const) {
    assert.doesNotMatch(source, /\bstyle=\{|\bstyle="|innerHTML|dangerouslySetInnerHTML/, file);
  }
  assert.doesNotMatch(stage, /Simulate:|Claude connected/, "the prototype's simulated connection does not ship");
});

test("the message travels and fades in transforms and opacity only, and stands still under reduced motion", () => {
  const keyframes = [...motion.matchAll(/\.animate\(\s*\[([^]*?)\]\s*,/g)].map((m) => m[1]!);
  assert.equal(keyframes.length, 2, "the message and its veil (the stage's own drag builds its frames below)");
  for (const k of keyframes) for (const prop of k.matchAll(/\{\s*([a-z]+):/g)) assert.ok(["transform", "opacity"].includes(prop[1]!), prop[1]);
  assert.match(motion, /frames\.push\(\{ transform: /);
  assert.match(motion, /if \(o\.reduce \|\| typeof el\.animate !== "function"\) \{/);
  assert.match(stage, /\/\/ Self-play on load[^\n]*\n\s*useEffect\(\(\) => \{\s*if \(reduceRef\.current\) return;/, "no self-play under reduced motion");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const animated of [".hero-chat > *", ".hero-offer", ".hero-tool-dot", '.hero-bar[data-apc-presence="read"]']) assert.ok(reduced.includes(animated), animated);
});

test("Now use your own agent leads to Pulse's Agents page, and a shortcut in the title bar opens it", () => {
  assert.match(stage, /export const PULSE_AGENTS = "https:\/\/pulse\.apc\.tineira\.com\/agents";/);
  assert.match(stage, /<a className="btn primary" href=\{PULSE_AGENTS\}>/);
  assert.match(stage, /make an agent there, copy its MCP address into your agent, then drop your agent on a bar in Pulse\./);
  assert.match(stage, /<button type="button" className="hero-own" onClick=\{openOffer\}>\s*Use your own agent\s*<\/button>/);
  assert.match(stage, /className="hero-offer" role="region"/);
  assert.match(css, /\.hero-offer \{\s*position: absolute;\s*inset: 0;/, "inside the stage, over it, not in a corner");
});

test("the stage shows no figure the file does not hold, and stacks on a phone", () => {
  assert.ok(Math.max(...data.months.map((m) => m.get_figure.values.active)) <= CHART_TOP, "every bar fits the chart");
  assert.match(css, /\.hero-grid-100 \{\s*bottom: calc\(\(100% - 48px\) \* 100 \/ 140\);/);
  assert.equal(CHART_TOP, 140);
  for (const [file, source] of [["HeroStage.tsx", stage], ...modules] as const) assert.doesNotMatch(source, /\$\d|revenue|USD|€/i, file);
  const phone = css.slice(css.indexOf("@container hero-stage (max-width: 479px)"));
  assert.match(phone, /\.hero-grid \{\s*grid-template-columns: 1fr;/);
});

test("the stage's text passes 4.5:1 in both themes, the caption over the worst case of the dot field", () => {
  type Rgb = [number, number, number];
  const block = (selector: string) => {
    const open = shellCss.indexOf("{", shellCss.indexOf(selector));
    const body = shellCss.slice(open + 1, shellCss.indexOf("}", open));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const over = (c: RgbaColor, under: Rgb): Rgb => [c.r, c.g, c.b].map((v, i) => Math.round(v * c.a + under[i]! * (1 - c.a))) as Rgb;
  const color = (raw: string, under: Rgb = [0, 0, 0]): Rgb => {
    if (raw.startsWith("#")) return [1, 3, 5].map((i) => parseInt(raw.slice(i, i + 2), 16)) as Rgb;
    const m = raw.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([0-9.]+)\s*\)$/);
    assert.ok(m, raw);
    return over({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) }, under);
  };
  const lum = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const [name, t] of [["dark", block(":root {")], ["light", block(':root[data-theme="light"] {')]] as const) {
    const v = (k: string, under?: Rgb) => color(t[k]!, under);
    const ink = v("ink");
    const focus = color("rgb(255 159 28 / 0.07)", ink);
    const call = color("rgb(255 159 28 / 0.16)", focus);
    const card = v("card-solid");
    const pairs: [string, Rgb, Rgb][] = [
      ["--paper-fg on --paper", v("paper-fg"), v("paper")],
      ["--paper-muted on --paper", v("paper-muted"), v("paper")],
      ["--paper-muted on --paper-bar", v("paper-muted"), v("paper-bar")],
      ["--paper-accent on --paper", v("paper-accent"), v("paper")],
      ["--ink-fg on --ink", v("ink-fg"), ink],
      ["--ink-muted on --ink", v("ink-muted"), ink],
      ["--ink-fg on --ink-bubble", v("ink-fg"), v("ink-bubble")],
      ["--ink-accent on --ink", v("ink-accent"), ink],
      ["--ink-fg on the focus card", v("ink-fg"), focus],
      ["--ink-muted on the focus card", v("ink-muted"), focus],
      ["--ink-accent on the focus card", v("ink-accent"), focus],
      ["--ink-fg on next / next_args", v("ink-fg"), call],
      ...["#a3c4ff", "#ffd9a3", "#d6b6ff"].flatMap((c): [string, Rgb, Rgb][] => [[`JSON ${c} on --ink`, color(c), ink], [`JSON ${c} on next / next_args`, color(c), call]]),
      ["the message's text", color("#dfe4ec"), color("#171b24")],
      ["the message's head", color("#ff9f1c"), color("#171b24")],
      ["--fg on the panel", v("fg"), card],
      ["--muted on the panel", v("muted"), card],
      ["--accent-text on the panel", v("accent-text"), card],
    ];
    // The caption (--fg) sits on the stage (at most 5% white in dark, over 40% in light) over any pixel of the dot field and its haze.
    const spec = DOT_FIELD_SPECS[name];
    const bg = v("bg");
    const glow = over(spec.glowMax, bg);
    const fields = [spec.dot, spec.glowMin, spec.glowMax].map((c) => over(c, bg));
    fields.push(over({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringDotAlphaMax }, bg));
    fields.push(over({ r: spec.tagRgb[0], g: spec.tagRgb[1], b: spec.tagRgb[2], a: spec.tagAlphaMax }, glow));
    const stageTop = name === "dark" ? "rgb(255 255 255 / 0.05)" : "rgb(255 255 255 / 0.4)";
    for (const f of fields) pairs.push(["--fg caption on the stage", v("fg"), color(stageTop, v("haze-b", v("haze-a", f)))]);
    for (const [label, a, b] of pairs) {
      const r = ratio(a, b);
      assert.ok(r >= 4.5, `${name}: ${label} is ${r.toFixed(2)}:1`);
    }
  }
});
