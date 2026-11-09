import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ANY_PAGE, covered, frameNote, framesOutside, frameTitle, isApcApp, NATIVE_DROPS_ATTR, NOT_TAKEN_TEXT, replyTarget, scriptMatches, siteGrant } from "../src/drop.ts";

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

test("a note names the one frame the extension cannot enter, or says another site (TIN-752)", () => {
  assert.equal(frameNote(["https://tableau.example.com"]), "This part of the page comes from tableau.example.com. Allow this site again in the APC extension to include it.");
  assert.match(frameNote(["https://a.example", "https://b.example"]), /comes from another site\./);
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
