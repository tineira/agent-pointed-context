/**
 * One connection state for the site (TIN-1087, TIN-1089): where every "Open Pulse" goes (Overview when the visitor's
 * agent is connected, Agents otherwise), what the landing's Try it card shows, how both follow the hero's frame live,
 * and that an expired, malformed or hostile hint changes nothing it should not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectedRow, ConnectedTick } from "../src/web/landing/connected.ts";
import { HeroStageHost } from "../src/web/landing/hero/live.ts";
import {
  clearPulseStatus,
  PULSE_AGENTS,
  PULSE_OVERVIEW,
  pulseView,
  readPulseStatus,
  savePulseStatus,
  STATUS_KEY,
  STATUS_TTL_MS,
  subscribePulseStatus,
} from "../src/web/pulse-status.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const paths = read("apps/site/src/web/landing/PathsSection.tsx");
const tryPage = read("apps/site/src/web/try.tsx");
const stage = read("apps/site/src/web/landing/HeroStage.tsx");
const live = read("apps/site/src/web/landing/hero/live.ts");

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
const NOW = 1_800_000_000_000;
const hint = (value: unknown) => memory({ [STATUS_KEY]: typeof value === "string" ? value : JSON.stringify(value) });
const view = (store: ReturnType<typeof memory>, now = NOW) => pulseView(readPulseStatus(store, now));

test("the target: Overview when connected, Agents otherwise", () => {
  assert.equal(PULSE_OVERVIEW, "https://pulse.apc.tineira.com/overview");
  assert.equal(PULSE_AGENTS, "https://pulse.apc.tineira.com/agents");
  assert.deepEqual(pulseView(null), { connected: false, agentName: null, openHref: PULSE_AGENTS });
  assert.deepEqual(pulseView({ agentName: "Claude" }), { connected: true, agentName: "Claude", openHref: PULSE_OVERVIEW });
  assert.deepEqual(pulseView({ agentName: null }), { connected: true, agentName: null, openHref: PULSE_OVERVIEW }, "connected without a name still goes to Overview");
  assert.deepEqual(view(hint({ connected: true, agentName: "Claude", updatedAt: NOW - 1000 })), { connected: true, agentName: "Claude", openHref: PULSE_OVERVIEW });
  assert.deepEqual(view(memory()), { connected: false, agentName: null, openHref: PULSE_AGENTS });
});

test("the Try it card: a check and \"<agent> connected\" with the shared link when connected, nothing when not", () => {
  const off = renderToStaticMarkup(createElement(ConnectedRow, { view: pulseView(null) }));
  assert.equal(off, '<div class="landing-conn-row" role="status"></div>', "an empty live region: the card is as it was");
  const named = renderToStaticMarkup(createElement(ConnectedRow, { view: pulseView({ agentName: "Claude" }) }));
  assert.match(named, /<span class="landing-conn"><i class="landing-tick" aria-hidden="true"><\/i>Claude connected<\/span>/);
  assert.match(named, /<a class="landing-conn-open" href="https:\/\/pulse\.apc\.tineira\.com\/overview">Open Pulse <span aria-hidden="true">↗<\/span><\/a>/);
  const anonymous = renderToStaticMarkup(createElement(ConnectedRow, { view: pulseView({ agentName: null }) }));
  assert.match(anonymous, /<\/i>Connected<\/span>/);
  assert.doesNotMatch(anonymous, /undefined|null/);
  assert.equal(renderToStaticMarkup(createElement(ConnectedTick)), '<i class="landing-tick" aria-hidden="true"></i>');
  // The card itself: the check lands on Pulse's chip only, Signals' chip and the go link stay as they were.
  assert.match(paths, /className=\{app\.name === "Pulse" && pulse\.connected \? "landing-chip on" : "landing-chip"\}/);
  assert.match(paths, /\{app\.name === "Pulse" && pulse\.connected && <ConnectedTick \/>\}/);
  assert.match(paths, /<ConnectedRow view=\{pulse\} \/>/);
  assert.match(paths, /const pulse = usePulseView\(\);/);
  assert.match(paths, /<a className="landing-go" href=\{SITE_PAGES\.try\.path\}>\s*Try the demo/);
  assert.doesNotMatch(paths, /Signals/, "Signals stays as it is: nothing in the card names it apart from the shared chip list");
});

test("a hostile name is text, cleaned on read: markup stays inert and bidi controls are gone", () => {
  const hostile = '<img src=x onerror=alert(1)>‮evil';
  const status = readPulseStatus(hint({ connected: true, agentName: hostile, updatedAt: NOW }), NOW);
  assert.ok(status);
  assert.doesNotMatch(status.agentName ?? "", /[‮\u0000-\u001f]/);
  const html = renderToStaticMarkup(createElement(ConnectedRow, { view: pulseView(status) }));
  assert.doesNotMatch(html, /<img/, "escaped, never markup");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /‮/);
  // 40 characters at most, whatever was stored.
  const long = readPulseStatus(hint({ connected: true, agentName: "x".repeat(500), updatedAt: NOW }), NOW);
  assert.equal(long?.agentName?.length, 40);
});

test("an expired, future, malformed or wrongly shaped hint is the not-connected state, and is removed", () => {
  const bad: unknown[] = [
    { connected: true, agentName: "Claude", updatedAt: NOW - STATUS_TTL_MS - 1 },
    { connected: true, agentName: "Claude", updatedAt: NOW + 60_000 },
    { connected: false, agentName: "Claude", updatedAt: NOW },
    { connected: "true", agentName: "Claude", updatedAt: NOW },
    { connected: true, agentName: { a: 1 }, updatedAt: NOW },
    { connected: true, agentName: "Claude" },
    "{not json",
    "null",
    "[]",
    '"connected"',
  ];
  for (const value of bad) {
    const store = hint(value);
    assert.deepEqual(view(store), { connected: false, agentName: null, openHref: PULSE_AGENTS }, JSON.stringify(value));
    assert.equal(store.map.has(STATUS_KEY), false, "removed");
  }
  // Storage that throws is no hint at all.
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(pulseView(readPulseStatus(blocked, NOW)), { connected: false, agentName: null, openHref: PULSE_AGENTS });
});

test("a hint that arrives after render updates the subscribers: the links and the card follow the hero live", () => {
  const store = memory();
  const seen: ReturnType<typeof pulseView>[] = [];
  const unsubscribe = subscribePulseStatus(() => seen.push(view(store, Date.now())));
  // Rendered before the hero connected: not connected, Agents.
  assert.equal(view(store).openHref, PULSE_AGENTS);
  assert.equal(renderToStaticMarkup(createElement(ConnectedRow, { view: view(store) })), '<div class="landing-conn-row" role="status"></div>');
  // The frame says connected: every subscriber re-reads, and now sees Overview and the name.
  savePulseStatus({ connected: true, agentName: "Grok" }, store);
  assert.deepEqual(seen.at(-1), { connected: true, agentName: "Grok", openHref: PULSE_OVERVIEW });
  assert.match(renderToStaticMarkup(createElement(ConnectedRow, { view: seen.at(-1)! })), /Grok connected/);
  // It later says not connected, or a new frame mounts: back to Agents.
  savePulseStatus({ connected: false, agentName: null }, store);
  assert.deepEqual(seen.at(-1), { connected: false, agentName: null, openHref: PULSE_AGENTS });
  savePulseStatus({ connected: true, agentName: null }, store);
  clearPulseStatus(store);
  assert.deepEqual(seen.at(-1), { connected: false, agentName: null, openHref: PULSE_AGENTS });
  assert.equal(seen.length, 4);
  // Reading an invalid hint removes it without telling anyone (a read is not a change, and cannot loop).
  store.setItem(STATUS_KEY, "{bad");
  readPulseStatus(store, NOW);
  assert.equal(seen.length, 4);
  unsubscribe();
  savePulseStatus({ connected: true, agentName: "Claude" }, store);
  assert.equal(seen.length, 4, "an unsubscribed component hears nothing");
});

test("the components read the shared state: no Open Pulse link keeps its own target", () => {
  assert.match(stage, /const \{ openHref \} = usePulseView\(\);/);
  assert.match(stage, /<a className="hero-offer-open" href=\{openHref\} target="_blank" rel="noopener">\s*or open Pulse/);
  assert.match(live, /const \{ openHref \} = usePulseView\(\);/);
  assert.match(live, /href: openHref, target: "_blank", rel: "noopener"/, "the frame's fallback and the note under it share one link");
  assert.equal(live.match(/newTab\("/g)?.length, 2, "the fallback and \"or open Pulse\" both use it");
  for (const [file, source] of [["HeroStage.tsx", stage], ["live.ts", live], ["PathsSection.tsx", paths]] as const) {
    assert.doesNotMatch(source, /href[:=]\{?\s*PULSE_AGENTS/, `${file} does not hard-code Agents`);
  }
  assert.match(tryPage, /const pulse = usePulseView\(\);/);
  assert.match(tryPage, /<a className="btn primary" href=\{pulse\.openHref\}>\s*\{pulse\.connected \? "Open Pulse" : "Open Pulse and connect your agent"\}/);
  assert.match(tryPage, /<a href=\{pulse\.openHref\}>\s*Open Pulse/);
  assert.doesNotMatch(tryPage, /useEffect|sessionStorage|localStorage|fetch\(/, "/try keeps no storage or request of its own");
});

test("the component that can mount the frame starts on the demo, even with a valid hint stored", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: hint({ connected: true, agentName: "Claude", updatedAt: Date.now() }), configurable: true });
  try {
    let asked = 0;
    const html = renderToStaticMarkup(
      createElement(HeroStageHost, {
        demo: (useOwnAgent) => {
          asked += typeof useOwnAgent === "function" ? 1 : 0;
          return createElement("figure", { className: "hero-stage" }, "simulated");
        },
      }),
    );
    assert.equal(asked, 1);
    assert.match(html, /simulated/);
    assert.doesNotMatch(html, /<iframe/, "no frame, no request to Pulse, whatever is stored");
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
