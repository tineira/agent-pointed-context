import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLabel, hubAllowed, hubPatterns, readerKey, sitePattern, STATUS_TEXT } from "../src/drop.ts";

test("the extension talks only to known docks; a dev build also to a local one (TIN-421)", () => {
  assert.equal(hubAllowed("https://v2.apc.tineira.com", false), true);
  assert.equal(hubAllowed("https://evil.example", false), false);
  assert.equal(hubAllowed("http://localhost:5173", false), false);
  assert.equal(hubAllowed("http://localhost:5173", true), true);
  assert.equal(hubAllowed("http://localhost.evil.example:80", true), false);
  assert.equal(hubAllowed("http://127.0.0.1:8080", true), false);
  assert.deepEqual(hubPatterns(false), ["https://v2.apc.tineira.com/*"]);
  assert.ok(hubPatterns(true).includes("http://localhost/*"));
});

test("the dock names this browser by product and system", () => {
  assert.equal(browserLabel([{ brand: "Chromium" }, { brand: "Google Chrome" }], "Windows", ""), "Chrome on Windows");
  assert.equal(browserLabel([{ brand: "Microsoft Edge" }, { brand: "Chromium" }], "Windows", ""), "Edge on Windows");
  assert.equal(browserLabel(undefined, undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/156.0 Safari/537.36"), "Chromium on macOS");
  assert.equal(browserLabel(undefined, undefined, "Mozilla/5.0 (Windows NT 10.0) Chrome/156.0 Edg/156.0"), "Edge on Windows");
  assert.equal(browserLabel([], "", ""), "Chromium");
});

test("a site to grant is an http(s) page's origin as a match pattern", () => {
  assert.deepEqual(sitePattern("https://en.wikipedia.org/wiki/Churn_rate?x=1"), { origin: "https://en.wikipedia.org", pattern: "https://en.wikipedia.org/*" });
  assert.equal(sitePattern("chrome://extensions"), null);
  assert.equal(sitePattern("file:///C:/x.html"), null);
  assert.equal(sitePattern(undefined), null);
  assert.equal(sitePattern("not a url"), null);
});

test("one reader token per dock and agent, and a note for every outcome", () => {
  assert.equal(readerKey("https://v2.apc.tineira.com", "ag_1234"), "https://v2.apc.tineira.com ag_1234");
  for (const s of ["sent", "asking", "denied", "timeout", "no_ticket", "unknown_dock", "error"] as const) assert.ok(STATUS_TEXT[s].length > 0);
});
