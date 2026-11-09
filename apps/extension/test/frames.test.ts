import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFocusAttrs } from "@tineira/apc-protocol";
import { test } from "node:test";
import { ANY_PAGE, covered, frameConsent, frameNote, frameOutside, framesOutside, frameTitle, appTakes, askingSite, type FocusNode, grantedAlone, isApcApp, originOf, STATUS_TEXT, NATIVE_DROPS_ATTR, NOT_TAKEN_TEXT, replyTarget, scriptMatches, siteGrant } from "../src/drop.ts";

/** A page's root as isApcApp reads it: its attributes, and what a selector finds under it. */
function page(attrs: string[], found: (selector: string) => boolean = () => false) {
  return { hasAttribute: (name: string) => attrs.includes(name), querySelector: (selector: string) => (found(selector) ? {} : null) };
}

test("an APC app is told by the standard's own marks, never by data-focus (TIN-703)", () => {
  // A page whose own markup uses data-focus (PFA, or a UI library that sets it on the focused element) is an ordinary page.
  const selectors: string[] = [];
  assert.equal(isApcApp(page([], (s) => (selectors.push(s), false))), false);
  assert.ok(selectors.every((s) => !s.includes("data-focus")), "data-focus is never looked for");
  // The agent bar, an agent mark, or enablePinning taking dock drops (set at mount, before the bar loads).
  assert.equal(isApcApp(page([], (s) => s.split(",").map((p) => p.trim()).includes("apc-agents"))), true);
  assert.equal(isApcApp(page([], (s) => s.includes("[data-apc-mark]"))), true);
  assert.equal(isApcApp(page([NATIVE_DROPS_ATTR])), true);
  assert.equal(isApcApp(null), false);
  // The attribute is the one @tineira/apc-web sets (read from its source: the tests run without the DOM's types).
  const pinning = readFileSync(new URL("../../../packages/web/src/pinning.ts", import.meta.url), "utf8");
  assert.equal(/export const APC_DROPS_ATTR = "([^"]+)"/.exec(pinning)?.[1], NATIVE_DROPS_ATTR);
  assert.match(NOT_TAKEN_TEXT, /Nothing was sent/);
});

test("a reply about a drop goes to the frame it came from (TIN-752)", () => {
  assert.deepEqual(replyTarget({ tab: { id: 7 }, frameId: 3 }), { tabId: 7, frameId: 3 });
  assert.deepEqual(replyTarget({ tab: { id: 7 }, frameId: 0 }), { tabId: 7, frameId: 0 });
  // An older Chrome that names no frame: the top one.
  assert.deepEqual(replyTarget({ tab: { id: 7 } }), { tabId: 7, frameId: 0 });
  assert.deepEqual(replyTarget({ tab: { id: 7 }, frameId: -1 }), { tabId: 7, frameId: 0 });
  // Not from a tab (the popup, another extension page): no reply target.
  assert.equal(replyTarget({ frameId: 0 }), null);
});

test("allowing a site asks for its frames' origins in the same prompt (TIN-752)", () => {
  const site = { origin: "https://b2b.datamind.cl", pattern: "https://b2b.datamind.cl/*" };
  const frames = [
    { frameId: 0, url: "https://b2b.datamind.cl/views/5711" },
    // Tableau, after the redirect from the site's own /oauth/authorize.
    { frameId: 4, url: "https://tableau.example.com/t/site/views/Resumen?embed=y" },
    { frameId: 5, url: "https://tableau.example.com/other" },
    { frameId: 6, url: "about:blank" },
    { frameId: 7, url: "https://b2b.datamind.cl/oauth/callback" },
    { frameId: 8, url: "https://apc.tineira.com/dock" },
    { frameId: 9, url: "chrome-extension://abc/page.html" },
  ];
  // Nothing granted yet: the site and Tableau, each once; never a dock, about:blank or an extension page.
  assert.deepEqual(siteGrant(site, frames, [], false), ["https://b2b.datamind.cl/*", "https://tableau.example.com/*"]);
  assert.deepEqual(framesOutside(frames, [], false), ["https://tableau.example.com", "https://b2b.datamind.cl"]);
  // The site granted, its frame not: allowing again asks for the frame.
  assert.deepEqual(framesOutside(frames, ["https://b2b.datamind.cl/*"], false), ["https://tableau.example.com"]);
  // The frame granted too, or the grant for any page: nothing more to ask.
  assert.deepEqual(framesOutside(frames, ["https://b2b.datamind.cl/*", "https://tableau.example.com/*"], false), []);
  assert.deepEqual(framesOutside(frames, ANY_PAGE, false), []);
  assert.deepEqual(siteGrant(site, frames, ANY_PAGE, false), ["https://b2b.datamind.cl/*"]);
  // The grant for http pages does not cover an https frame.
  assert.equal(covered("https://tableau.example.com", ["http://*/*"]), false);
  assert.equal(covered("https://tableau.example.com", ["https://*/*"]), true);
  // A frame on another port of a granted host is covered: a pattern names no port.
  assert.equal(covered("http://127.0.0.1:5001", ["http://127.0.0.1/*"]), true);
});

test("the note names a host only for the frame under the pointer, else another site (TIN-752, review on #142)", () => {
  assert.equal(frameNote("https://tableau.example.com"), "This part of the page comes from tableau.example.com. Allow this site again in the APC extension to include it.");
  assert.match(frameNote(null), /comes from another site\./);
  const frames = [
    { frameId: 0, url: "https://site.example/" },
    { frameId: 3, url: "https://tracker.example/pixel" },
    { frameId: 4, url: "https://tableau.example.com/view" },
  ];
  const granted = ["https://site.example/*", "https://tableau.example.com/*"];
  // The pointer is on the granted dashboard: no note, though a hidden tracker frame is outside every grant.
  assert.deepEqual(frameOutside(frames, 4, granted, false), { note: false });
  // On the tracker's frame itself: named.
  assert.deepEqual(frameOutside(frames, 3, granted, false), { note: true, origin: "https://tracker.example" });
  // The frame under the pointer is not known: never a host, only "another site" when some frame is outside.
  assert.deepEqual(frameOutside(frames, null, granted, false), { note: true, origin: null });
  assert.deepEqual(frameOutside(frames, null, [...granted, "https://tracker.example/*"], false), { note: false });
  // A frame id the tab no longer has: nothing.
  assert.deepEqual(frameOutside(frames, 9, granted, false), { note: false });
});

test("a frame's own origin adds Always ask and Not here to the tab's consent; an opaque one adds nothing (TIN-752, review on #142)", () => {
  const sites = { "https://private.example": "sensitive", "https://nope.example": "never", "https://ok.example": "always" } as const;
  assert.deepEqual(frameConsent("https://private.example", sites), { sensitive: true, blocked: false });
  assert.deepEqual(frameConsent("https://nope.example", sites), { sensitive: false, blocked: true });
  assert.deepEqual(frameConsent("https://data.gob.cl", sites), { sensitive: true, blocked: false });
  // A frame's Always does not loosen the tab's consent.
  assert.deepEqual(frameConsent("https://ok.example", sites), { sensitive: false, blocked: false });
  assert.deepEqual(frameConsent(null, sites), { sensitive: false, blocked: false });
  // No URL parse that throws on an opaque frame's address.
  for (const url of ["about:blank", "about:srcdoc", "data:text/html,hi", "null", "", undefined]) assert.equal(originOf(url), null);
  assert.equal(originOf("https://b2b.datamind.cl/oauth/authorize?code=x"), "https://b2b.datamind.cl");
  assert.match(STATUS_TEXT.opaque_frame, /nothing was sent/);
});

test("a port-specific grant covers that port only; a pattern without a port covers them all (review on #142)", () => {
  assert.equal(grantedAlone("http://127.0.0.1:8080", ["http://127.0.0.1:8080/*"]), true);
  assert.equal(grantedAlone("http://127.0.0.1:9090", ["http://127.0.0.1:8080/*"]), false);
  assert.equal(covered("http://127.0.0.1:9090", ["http://127.0.0.1:8080/*"]), false);
  assert.equal(grantedAlone("http://127.0.0.1:9090", ["http://127.0.0.1/*"]), true);
  // A default port written out is the same as none.
  assert.equal(grantedAlone("https://site.example", ["https://site.example:443/*"]), true);
  assert.equal(grantedAlone("https://site.example:8443", ["https://site.example:443/*"]), false);
  // So the popup asks for a frame on another port of the same host.
  const frames = [{ frameId: 0, url: "http://127.0.0.1:8080/" }, { frameId: 2, url: "http://127.0.0.1:9090/inner" }];
  assert.deepEqual(framesOutside(frames, ["http://127.0.0.1:8080/*"], false), ["http://127.0.0.1:9090"]);
});

/** An element as appTakes reads it, with closest() as the DOM's (parent elements only, never across a shadow root). */
class El implements FocusNode {
  readonly parentElement: El | null;
  readonly attrs: Record<string, string>;
  constructor(parentElement: El | null, attrs: Record<string, string> = {}) {
    this.parentElement = parentElement;
    this.attrs = attrs;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): El | null {
    assert.equal(selector, "[data-focus]");
    for (let e: El | null = this; e; e = e.parentElement) if (e.getAttribute("data-focus") !== null) return e;
    return null;
  }
}

test("the extension's 'the app takes this drop' is the app's own targetOf rule (TIN-703, fix check on #142)", () => {
  // A valid kind:id target, at the point or above it.
  const kpi = new El(null, { "data-focus": "figure:kpi" });
  assert.equal(appTakes(kpi), true);
  assert.equal(appTakes(new El(new El(kpi))), true);
  // A generic data-focus the protocol does not parse: empty, "true", no kind:id. The app does not pin there.
  for (const value of ["", "true", "row1", ":id"]) assert.equal(appTakes(new El(new El(null, { "data-focus": value }))), false, `data-focus="${value}"`);
  // One that does not parse is skipped for a target above it, as targetOf does.
  assert.equal(appTakes(new El(new El(kpi, { "data-focus": "true" }))), true);
  // Bad params make a target not parse.
  assert.equal(appTakes(new El(null, { "data-focus": "figure:kpi", "data-focus-params": "{nope" })), false);
  // A target only across a shadow root: the element at the point (the host, from the document's elementFromPoint) has
  // no data-focus above it, and closest() never reaches into or out of the shadow root, so the app does not take it.
  // (Inside the shadow root a target would be its own tree: an element there, with no parent element out of the root.)
  const insideShadow = new El(null, { "data-focus": "figure:kpi" });
  assert.equal(appTakes(insideShadow), true, "only when the point itself is in that tree, which elementFromPoint never gives");
  const hostAtPoint = new El(new El(null));
  assert.equal(appTakes(hostAtPoint), false);
  // Nothing at the point.
  assert.equal(appTakes(null), false);
  // The result is the protocol's: the rule above follows parseFocusAttrs, not a look-alike.
  assert.ok(parseFocusAttrs("figure:kpi", null, null));
  assert.equal(parseFocusAttrs("true", null, null), null);
});

test("the card that asks every time names the site whose setting it is (fix check on #142)", () => {
  const tab = "https://aggregator.example";
  const frame = "https://private.example";
  assert.equal(askingSite(tab, frame, { [tab]: "always", [frame]: "sensitive" }), frame);
  assert.equal(askingSite(tab, "https://data.gob.cl", { [tab]: "always" }), "https://data.gob.cl");
  assert.equal(askingSite(tab, frame, { [tab]: "sensitive", [frame]: "sensitive" }), tab);
  assert.equal(askingSite("https://sii.gob.cl", frame, {}), "https://sii.gob.cl");
  assert.equal(askingSite(tab, null, {}), tab);
});

test("a reading from a frame keeps the frame's address and adds the tab's title (TIN-752)", () => {
  assert.equal(frameTitle("Resumen principales indicadores", "Resumen"), "Resumen principales indicadores · Resumen");
  assert.equal(frameTitle("Resumen", "Resumen"), "Resumen");
  assert.equal(frameTitle("Resumen", ""), "Resumen");
  assert.equal(frameTitle(undefined, "Tableau"), "Tableau");
});

test("the content script runs in every frame, and the extension can list a tab's frames (TIN-752)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as { permissions: string[] };
  assert.ok(manifest.permissions.includes("webNavigation"));
  const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /allFrames: true, matchOriginAsFallback: true/);
  assert.match(worker, /target: \{ tabId: tab\.id, allFrames: true \}, files: \["content\.js"\]/);
  assert.match(worker, /\{ frameId: to\.frameId \}/);
});

test("the content script is registered on whole hosts only: with matchOriginAsFallback a path refuses it all (TIN-752)", () => {
  const granted = ["http://127.0.0.1/*", "http://localhost/*", "https://apc.tineira.com/", "https://apc.tineira.com/*", "https://apc.tineira.com/?*", "https://apc.tineira.com/dock*", "https://*/*", "*://*.example.com/*"];
  assert.deepEqual(scriptMatches(granted, new Set(["http://localhost/*"])), ["http://127.0.0.1/*", "https://apc.tineira.com/*", "https://*/*", "*://*.example.com/*"]);
});
