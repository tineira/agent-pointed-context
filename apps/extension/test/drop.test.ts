import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLabel, decide, grantedAlone, hubAllowed, hubPatterns, isSensitive, readerKey, sitePattern, STATUS_TEXT } from "../src/drop.ts";

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
  for (const s of ["sent", "asking", "denied", "timeout", "no_ticket", "unknown_dock", "error", "consent", "consent_sensitive", "blocked", "not_here"] as const) assert.ok(STATUS_TEXT[s].length > 0);
});

test("sensitive sites: mail hosts, government hosts, and hosts naming a bank or health service (TIN-465)", () => {
  for (const h of ["mail.google.com", "www.sii.gob.cl", "www.gov.uk", "portal.bancochile.cl", "www.bankofamerica.com", "www.clinicaalemana.cl", "www.isapre-colmena.cl", "www.mayoclinic.org", "online.santander-bank.example"]) assert.equal(isSensitive(h), true, h);
  for (const h of ["en.wikipedia.org", "news.ycombinator.com", "127.0.0.1:8080", "docs.google.com", "github.com"]) assert.equal(isSensitive(h), false, h);
});

test("a drop is sent, asks or is refused by mode, site choice and sensitivity (TIN-465)", () => {
  assert.equal(decide("ask", undefined, false, false), "ask");
  assert.equal(decide("ask", "always", false, false), "send");
  assert.equal(decide("ask", undefined, false, true), "send", "a site granted by itself counts as Always");
  assert.equal(decide("ask", "never", false, true), "blocked");
  assert.equal(decide("ask", "always", true, true), "ask_sensitive", "a sensitive site always asks");
  assert.equal(decide("ask", "never", true, false), "blocked");
  assert.equal(decide("never_ask", "never", true, false), "send", "never ask sends everything");
  assert.equal(decide("never_ask", undefined, true, false), "send");
});

test("a site granted by itself matches by scheme and host, whatever the port; the grant for any page does not count (TIN-465)", () => {
  assert.equal(grantedAlone("http://127.0.0.1:61234", ["http://127.0.0.1/*"]), true);
  assert.equal(grantedAlone("https://en.wikipedia.org", ["https://en.wikipedia.org/*"]), true);
  assert.equal(grantedAlone("http://en.wikipedia.org", ["https://en.wikipedia.org/*"]), false);
  assert.equal(grantedAlone("https://es.wikipedia.org", ["https://*.wikipedia.org/*"]), true);
  assert.equal(grantedAlone("https://es.wikipedia.org", ["https://*/*", "http://*/*"]), false);
  assert.equal(grantedAlone("https://evilwikipedia.org", ["https://*.wikipedia.org/*"]), false);
});
