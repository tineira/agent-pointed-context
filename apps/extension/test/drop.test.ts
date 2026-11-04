import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLabel, connectLabel, decide, directOnlyAnswer, grantedAlone, hubAllowed, isDockPage, lookUpDirectOnly, pinState, hubPatterns, isSensitive, readerKey, sitePattern, STATUS_TEXT } from "../src/drop.ts";

test("the extension talks only to known docks; a dev build also to a local one (TIN-421)", () => {
  assert.equal(hubAllowed("https://apc.tineira.com", false), true);
  assert.equal(hubAllowed("https://evil.example", false), false);
  assert.equal(hubAllowed("http://localhost:5173", false), false);
  assert.equal(hubAllowed("http://localhost:5173", true), true);
  assert.equal(hubAllowed("http://localhost.evil.example:80", true), false);
  assert.equal(hubAllowed("http://127.0.0.1:8080", true), false);
  assert.ok(hubPatterns(true).includes("http://localhost/*"));
});

test("the dock is its own paths of apc.tineira.com, never V1 under /v1/", () => {
  assert.deepEqual(hubPatterns(false), ["https://apc.tineira.com/", "https://apc.tineira.com/?*", "https://apc.tineira.com/dock*", "https://apc.tineira.com/extension*"]);
  assert.equal(hubPatterns(false).some((p) => p.endsWith("/*")), false, "no pattern covers the whole host");
  for (const url of ["https://apc.tineira.com/", "https://apc.tineira.com/?x=1", "https://apc.tineira.com/dock", "https://apc.tineira.com/dock/agents/ag_1", "https://apc.tineira.com/extension"]) assert.equal(isDockPage(url, false), true, url);
  for (const url of ["https://apc.tineira.com/v1", "https://apc.tineira.com/v1/", "https://apc.tineira.com/v1/overview?x=1", "https://pulse.apc.tineira.com/", "https://evil.example/dock", undefined, "not a url"]) assert.equal(isDockPage(url, false), false, String(url));
  assert.equal(isDockPage("http://localhost:5200/anything", false), false);
  assert.equal(isDockPage("http://localhost:5200/anything", true), true);
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
  assert.equal(readerKey("https://apc.tineira.com", "ag_1234"), "https://apc.tineira.com ag_1234");
  for (const s of ["sent", "asking", "denied", "timeout", "no_ticket", "unknown_dock", "error", "consent", "consent_sensitive", "blocked", "not_here"] as const) assert.ok(STATUS_TEXT[s].length > 0);
});

test("sensitive by domain only: government labels and the .bank and .insurance TLDs, never a guess from the name (TIN-478)", () => {
  for (const h of ["www.sii.gob.cl", "www.gov.uk", "www.irs.gov", "www.army.mil", "online.example.bank", "my.example.insurance", "sii.gob.localhost:8080"]) assert.equal(isSensitive(h), true, h);
  // Banks, email and health sites are not recognised by name: the person sets them to Always ask.
  for (const h of ["mail.google.com", "portal.bancochile.cl", "www.santander.cl", "www.paypal.com", "www.clinicaalemana.cl", "www.sii.cl", "en.wikipedia.org", "127.0.0.1:8080", "bank.localhost", "www.government-news.com"]) assert.equal(isSensitive(h), false, h);
});

test("a site the person set to Always ask asks every time, as a sensitive domain does (TIN-478)", () => {
  assert.equal(decide("ask", "sensitive", false, false), "ask_sensitive");
  assert.equal(decide("ask", "sensitive", false, true), "ask_sensitive", "even when granted by itself");
  assert.equal(decide("never_ask", "sensitive", false, false), "send", "Never ask still sends everything");
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

test("a pin is unread, read once the agent read it, and stale once a newer drop replaced it (TIN-469)", () => {
  assert.equal(pinState("t1", "t1", false), "unread");
  assert.equal(pinState("t1", "t1", true), "read");
  assert.equal(pinState("t1", "t2", true), "stale");
  assert.equal(pinState("t1", null, false), "stale", "cleared or expired at the dock");
});

test("a dock agent dropped on a Direct-only APC app gets the answer from its apc.json; an app with Dock gets none (APC 0.5)", async () => {
  const origin = "https://signals.example";
  const signals = (profiles: string[], over: Record<string, unknown> = {}) => ({ name: "Signals", standard: "0.5.0", origin, profiles, mcp: { path: "/mcp/" }, direct: { connect: `${origin}/?connect` }, ...over });
  assert.deepEqual(directOnlyAnswer(signals(["direct"]), origin), {
    name: "Signals",
    connect: `${origin}/?connect`,
    message: "Signals connects agents directly, not through a dock. Connect your agent to Signals on its own URL, then drag its mark from the agent bar there.",
  });
  assert.equal(connectLabel("Signals"), "Connect an agent to Signals");
  assert.equal(directOnlyAnswer(signals(["direct", "dock"]), origin), null, "an app that offers Dock answers its own drops");
  assert.equal(directOnlyAnswer(signals(["dock"]), origin), null);
  assert.equal(directOnlyAnswer(signals(["direct"]), "https://other.example"), null, "a file that names another origin is not this app's");
  assert.equal(directOnlyAnswer(signals(["direct"], { direct: { connect: "https://phish.example/connect" } }), origin), null, "a connect page off its origin is never linked");
  assert.equal(directOnlyAnswer({ name: "x" }, origin), null);

  const asked: Array<[string, RequestInit | undefined]> = [];
  const serve = (body: string, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push([String(url), init]);
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  assert.equal((await lookUpDirectOnly(origin, serve(JSON.stringify(signals(["direct"])))))?.connect, `${origin}/?connect`);
  assert.equal(asked[0]![0], `${origin}/.well-known/apc.json`, "read from the page's own origin");
  assert.equal(asked[0]![1]?.credentials, "omit", "no cookies");
  assert.equal(asked[0]![1]?.redirect, "error", "no redirect");
  assert.equal(await lookUpDirectOnly(origin, serve(JSON.stringify(signals(["direct", "dock"])))), null);
  assert.equal(await lookUpDirectOnly(origin, serve("not found", 404)), null);
  assert.equal(await lookUpDirectOnly(origin, serve("<html>")), null);
  assert.equal(await lookUpDirectOnly(origin, serve(JSON.stringify({ ...signals(["direct"]), pad: "x".repeat(20_000) }))), null, "too large");
  const offline = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  assert.equal(await lookUpDirectOnly(origin, offline), null);
});
