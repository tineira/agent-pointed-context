/**
 * The band under the hero (TIN-1104): "Now use your own agent" for anyone not yet connected, a quiet connected line once
 * the site knows the visitor's agent is connected; and the one action every "Use your own agent" goes through
 * (`openRealHero`, hero/live.ts): kept until the hero takes it, taken once, heard by every subscriber, and only ever the
 * one frame HeroStageHost mounts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HERO_STAGE_SELECTOR, OwnAgentBand, OwnAgentBandView, scrollUpAndOpen } from "../src/web/landing/OwnAgentBand.ts";
import { HeroStageHost, HeroSwitch, listenForRealHeroOpen, openRealHero, subscribeRealHeroOpen, takeRealHeroOpen } from "../src/web/landing/hero/live.ts";
import { pulseView, PULSE_AGENTS, PULSE_OVERVIEW, STATUS_KEY } from "../src/web/pulse-status.ts";

const iframes = (html: string) => html.match(/<iframe\b[^>]*>/g) ?? [];
const links = (html: string) => [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, text: m[2]!.replace(/<[^>]+>/g, "") }));

/** Renders the band with this tab's sessionStorage holding `hint` (or nothing), as a visitor's first paint. */
function bandWith(hint: unknown): string {
  const map = new Map<string, string>(hint === undefined ? [] : [[STATUS_KEY, JSON.stringify(hint)]]);
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: store, configurable: true });
  try {
    return renderToStaticMarkup(createElement(OwnAgentBand));
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

test("not connected: the offer, a real button that opens the real Pulse, and Open Pulse to Agents in a new tab", () => {
  const html = bandWith(undefined);
  assert.match(html, /^<section class="wrap landing-own rv" aria-labelledby="landing-own-title">/);
  assert.match(html, /<h2 id="landing-own-title">Now use your own agent<\/h2>/);
  assert.match(html, /<p>Claude, ChatGPT, Grok… point it at the real Pulse, right in the demo above\.<\/p>/);
  assert.match(html, /<button type="button" class="btn primary">Use your own agent <span aria-hidden="true">↑<\/span><\/button>/);
  const all = links(html);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.text, "or open Pulse ↗");
  assert.match(all[0]!.attrs, new RegExp(` href="${PULSE_AGENTS}" target="_blank" rel="noopener"`));
  assert.deepEqual(iframes(html), [], "the band mounts no frame");
  assert.doesNotMatch(html, /\sstyle=/, "no style attribute (the CSP)");
  assert.doesNotMatch(html, /Dock|Autio/);
});

test("connected: a quiet line with the agent's name, or Your agent without one, and Open Pulse to Overview", () => {
  for (const [hint, line] of [
    [{ connected: true, agentName: "Claude", updatedAt: Date.now() }, "Claude connected"],
    [{ connected: true, agentName: null, updatedAt: Date.now() }, "Your agent connected"],
  ] as const) {
    const html = bandWith(hint);
    assert.match(html, /^<section class="wrap landing-own rv" aria-labelledby="landing-own-title">/, "the same section, class unchanged for the reveal");
    assert.match(html, new RegExp(`<div class="landing-own-quiet"><h2 id="landing-own-title">${line}</h2><span aria-hidden="true">·</span>`));
    assert.doesNotMatch(html, /<button|Now use your own agent/, "no offer once connected");
    const all = links(html);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.text, "Open Pulse ↗");
    assert.match(all[0]!.attrs, new RegExp(` href="${PULSE_OVERVIEW}" target="_blank" rel="noopener"`));
  }
  // An expired hint says nothing: the offer again.
  assert.match(bandWith({ connected: true, agentName: "Claude", updatedAt: Date.now() - 7 * 60 * 60_000 }), /Now use your own agent/);
  // A name is a text node: markup in it is escaped, never rendered.
  const hostile = renderToStaticMarkup(createElement(OwnAgentBandView, { view: { connected: true, agentName: "<b>x</b>", openHref: PULSE_OVERVIEW }, onUseOwnAgent: () => {} }));
  assert.match(hostile, /&lt;b&gt;x&lt;\/b&gt; connected/);
});

test("a long agent name wraps inside the quiet line instead of widening the page at 375 px", () => {
  const css = readFileSync(new URL("../src/web/styles/landing.css", import.meta.url), "utf8");
  const rule = css.match(/\.landing-home \.landing-own-quiet h2 \{([^}]*)\}/);
  assert.ok(rule, "the quiet line's heading has its own rule");
  assert.match(rule[1]!, /min-width: 0;/, "the flex item may shrink below its longest word");
  assert.match(rule[1]!, /overflow-wrap: anywhere;/, "a 40-character name with no space still breaks");
  assert.match(css, /\.landing-home \.landing-own-quiet \{[^}]*flex-wrap: wrap;/);
});

test("the band follows the connection live: usePulseView subscribes to the hint the hero's frame saves", () => {
  const source = readFileSync(new URL("../src/web/landing/OwnAgentBand.ts", import.meta.url), "utf8");
  assert.match(source, /h\(OwnAgentBandView, \{ view: usePulseView\(\), onUseOwnAgent: scrollUpAndOpen \}\)/);
  const hook = readFileSync(new URL("../src/web/pulse-status.ts", import.meta.url), "utf8");
  assert.match(hook, /export function usePulseView\(\)[^]*return subscribePulseStatus\(sync\);/);
  // Both states render from the same view the hook returns.
  assert.match(renderToStaticMarkup(createElement(OwnAgentBandView, { view: pulseView(null), onUseOwnAgent: () => {} })), /Now use your own agent/);
  assert.match(renderToStaticMarkup(createElement(OwnAgentBandView, { view: pulseView({ agentName: "Grok" }), onUseOwnAgent: () => {} })), /Grok connected/);
});

test("the button scrolls up to the stage first, smoothly or as a plain jump under reduced motion, then asks the hero to open", () => {
  takeRealHeroOpen();
  for (const reduce of [false, true]) {
    const calls: string[] = [];
    const stage = { scrollIntoView: (options: ScrollIntoViewOptions) => void calls.push(`scroll ${options.behavior} ${options.block}`) };
    const doc = { querySelector: (selector: string) => (selector === HERO_STAGE_SELECTOR ? stage : null) } as unknown as Pick<Document, "querySelector">;
    const off = subscribeRealHeroOpen(() => void calls.push("open"));
    try {
      scrollUpAndOpen(doc, reduce);
    } finally {
      off();
    }
    assert.deepEqual(calls, [`scroll ${reduce ? "instant" : "smooth"} start`, "open"]);
    assert.equal(takeRealHeroOpen(), true, "the request waits for the hero");
  }
  assert.equal(HERO_STAGE_SELECTOR, ".landing-hero-stage");
  const hero = readFileSync(new URL("../src/web/landing/HeroSection.tsx", import.meta.url), "utf8");
  assert.match(hero, /<div className="landing-hero-stage">\s*<HeroStage \/>/, "the selector names the stage's own wrapper");
});

test("one frame: the hero takes a request once, a second request mounts no second frame, and every subscriber hears both", () => {
  takeRealHeroOpen();
  let live = false;
  let opens = 0;
  let heard = 0;
  const stopHero = listenForRealHeroOpen(() => {
    opens++;
    live = true; // HeroStageHost's setLive(true): the same state twice is the same one frame
  });
  const stopObserver = subscribeRealHeroOpen(() => void heard++);
  try {
    const render = () => renderToStaticMarkup(createElement(HeroSwitch, { live, demo: createElement("figure", null, "simulated"), onBack: () => {} }));
    assert.deepEqual(iframes(render()), [], "nothing from Pulse before the click");
    openRealHero();
    assert.equal(iframes(render()).length, 1);
    openRealHero();
    assert.equal(iframes(render()).length, 1, "a second click mounts no second frame");
    assert.equal(heard, 2, "a subscriber (TIN-1103's arrow) hears every request");
    assert.equal(opens, 2);
    assert.equal(takeRealHeroOpen(), false, "the hero took both: nothing waits");
  } finally {
    stopHero();
    stopObserver();
  }
});

test("a click before the hero is ready is not lost: the hero opens once it listens, and only once", () => {
  takeRealHeroOpen();
  openRealHero();
  let opens = 0;
  const stop = listenForRealHeroOpen(() => void opens++);
  try {
    assert.equal(opens, 1, "the waiting request opens the hero as it mounts");
    const again = listenForRealHeroOpen(() => void opens++);
    again();
    assert.equal(opens, 1, "taken once: a later listener finds nothing waiting");
  } finally {
    stop();
  }
});

test("HeroStageHost hands the demo the same action and listens for it from its mount effect", () => {
  let given: unknown = null;
  renderToStaticMarkup(createElement(HeroStageHost, { demo: (useOwnAgent) => ((given = useOwnAgent), createElement("figure", null, "simulated")) }));
  assert.equal(given, openRealHero, "the panel and the title bar call openRealHero too");
  const source = readFileSync(new URL("../src/web/landing/hero/live.ts", import.meta.url), "utf8");
  const host = source.slice(source.indexOf("export function HeroStageHost("), source.indexOf("export function HeroSwitch("));
  assert.match(host, /useEffect\(\(\) => listenForRealHeroOpen\(\(\) => setLive\(true\)\), \[\]\);/);
  // In-page state only: no global and no message for this.
  const action = source.slice(source.indexOf("let openRequested"), source.indexOf("export function HeroStageHost("));
  assert.doesNotMatch(action, /window|globalThis|postMessage|dispatchEvent/);
  // The live stage takes the focus when it opens, without scrolling: the band's button is far below it.
  assert.match(source, /figureRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(source, /\{ ref: figureRef, tabIndex: -1, className: "hero-stage hero-live"/);
});
