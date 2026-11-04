import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLabel, connectLabel, decide, directOnlyAnswer, directOnlyGate, grantedAlone, hubAllowed, isDockPage, LOOKUP_KEEP_MS, LOOKUP_KEEP_UNKNOWN_MS, lookUpDirectOnly, pinState, hubPatterns, isSensitive, readerKey, sitePattern, STATUS_TEXT, type DirectOnly } from "../src/drop.ts";

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
    host: "signals.example",
    connect: `${origin}/?connect`,
    message: 'This page says it is "Signals" (signals.example). It connects agents directly, not through a dock: connect your agent to it on its own URL, then drag its mark from the agent bar there.',
  });
  // The card lends no authority to the name the page chose: the domain first, the name as the page's word.
  const spoof = directOnlyAnswer(signals(["direct"], { name: "Your bank" }), origin)!;
  assert.match(spoof.message, /^This page says it is "Your bank" \(signals\.example\)\./);
  assert.equal(connectLabel(spoof.host), "Connect an agent on signals.example");
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
  const direct = await lookUpDirectOnly(origin, serve(JSON.stringify(signals(["direct"]))));
  assert.deepEqual([direct.directOnly?.connect, direct.read], [`${origin}/?connect`, true]);
  assert.equal(asked[0]![0], `${origin}/.well-known/apc.json`, "read from the page's own origin");
  assert.equal(asked[0]![1]?.credentials, "omit", "no cookies");
  assert.equal(asked[0]![1]?.redirect, "error", "no redirect");
  assert.deepEqual(await lookUpDirectOnly(origin, serve(JSON.stringify(signals(["direct", "dock"])))), { directOnly: null, read: true }, "a real answer: the app takes dock agents");
  // Nothing could be told: the service worker keeps these only briefly (LOOKUP_KEEP_UNKNOWN_MS), never for five minutes.
  const unknown = { directOnly: null, read: false };
  assert.deepEqual(await lookUpDirectOnly(origin, serve("not found", 404)), unknown);
  assert.deepEqual(await lookUpDirectOnly(origin, serve("<html>")), unknown);
  assert.deepEqual(await lookUpDirectOnly(origin, serve(JSON.stringify({ ...signals(["direct"]), pad: "x".repeat(20_000) }))), unknown, "too large");
  const offline = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  assert.deepEqual(await lookUpDirectOnly(origin, offline), unknown);
  assert.ok(LOOKUP_KEEP_UNKNOWN_MS <= 30_000 && LOOKUP_KEEP_MS === 5 * 60_000);
});

test("a drop on an APC app while its apc.json is still being read is taken, and answered when the file comes back (APC 0.5)", async () => {
  const app: DirectOnly = { name: "Signals", host: "signals.example", connect: "https://signals.example/?connect", message: "…" };
  /** A lookup the test answers when it likes: the service worker's reply, still on its way. */
  const deferred = () => {
    let resolve!: (v: DirectOnly | null) => void;
    let calls = 0;
    const promise = new Promise<DirectOnly | null>((r) => (resolve = r));
    return { lookUp: () => (calls++, promise), resolve, calls: () => calls };
  };

  // In flight, then Direct-only: the first dragover already takes the drop, the drop waits for the answer.
  const slow = deferred();
  let pageAnswers = false;
  const gate = directOnlyGate(slow.lookUp, () => pageAnswers);
  assert.equal(gate.accepts(), true, "dragover takes the drop while the file is on its way: the browser does not refuse it");
  const dropped = gate.drop();
  assert.ok(dropped && "later" in dropped, "a drop during the lookup is held, not lost");
  slow.resolve(app);
  assert.equal(await (dropped as { later: Promise<DirectOnly | null> }).later, app, "and answered when the file comes back");
  assert.deepEqual(gate.drop(), { now: app }, "the next drop is answered at once");
  assert.equal(gate.accepts(), true);
  assert.equal(slow.calls(), 1, "the file is read once per page");
  pageAnswers = true;
  assert.equal(gate.accepts(), false, "a page that answers drops itself (data-apc-native-drops) is never taken from");
  assert.equal(gate.drop(), null);

  // In flight, then an app that takes dock agents (or no answer): the held drop is let go, and later drags are not taken.
  const dock = deferred();
  const gate2 = directOnlyGate(dock.lookUp, () => false);
  const held = gate2.drop();
  assert.ok(held && "later" in held);
  dock.resolve(null);
  assert.equal(await (held as { later: Promise<DirectOnly | null> }).later, null, "nothing to answer: the extension stands back");
  assert.equal(gate2.accepts(), false);
  assert.equal(gate2.drop(), null);

  // A page with the marker is never taken from, even before its file is read.
  const gate3 = directOnlyGate(deferred().lookUp, () => true);
  assert.equal(gate3.accepts(), false);
  assert.equal(gate3.drop(), null);

  // A lookup that fails counts as no answer.
  const gate4 = directOnlyGate(() => Promise.reject(new Error("the service worker went away")), () => false);
  const failed = gate4.drop();
  assert.equal(await (failed as { later: Promise<DirectOnly | null> }).later, null);
  assert.equal(gate4.accepts(), false);
});
