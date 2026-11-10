import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { browserLabel, connectLabel, decide, heldForInclude, HELD_MAX, HELD_MS, holdReading, readingId, type Held, directOnlyAnswer, directOnlyGate, grantedAlone, grantedByPerson, hubAllowed, includeSensitive, isDockPage, LOOKUP_KEEP_MS, LOOKUP_KEEP_UNKNOWN_MS, lookUpDirectOnly, NOTICE_ALL, ownPatterns, NOTICE_SITES, pinState, hubPatterns, reask, FORM_NOTE, WHATS_SENT, isSensitive, readerKey, sensitiveMode, sensitiveNote, sentWithout, sitePattern, STATUS_TEXT, type DirectOnly, type DirectOnlyLookup } from "../src/drop.ts";

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
  for (const s of ["sent", "asking", "denied", "timeout", "no_ticket", "unknown_dock", "error", "consent", "consent_sensitive", "consent_update", "blocked", "not_here"] as const) assert.ok(STATUS_TEXT[s].length > 0);
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
  assert.equal(decide("never_ask", "never", true, false), "blocked", "Not here sticks under Never ask (TIN-571)");
  assert.equal(decide("never_ask", "never", false, true), "blocked");
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
    let resolve!: (v: DirectOnlyLookup) => void;
    let calls = 0;
    const promise = new Promise<DirectOnlyLookup>((r) => (resolve = r));
    return { lookUp: () => (calls++, promise), resolve, calls: () => calls };
  };

  // In flight, then Direct-only: the first dragover already takes the drop, the drop waits for the answer.
  const slow = deferred();
  let pageAnswers = false;
  const gate = directOnlyGate(slow.lookUp, () => pageAnswers);
  assert.equal(gate.accepts(), true, "dragover takes the drop while the file is on its way: the browser does not refuse it");
  const dropped = gate.drop();
  assert.ok(dropped && "later" in dropped, "a drop during the lookup is held, not lost");
  slow.resolve({ directOnly: app, read: true });
  assert.equal(await (dropped as { later: Promise<DirectOnly | null> }).later, app, "and answered when the file comes back");
  assert.deepEqual(gate.drop(), { now: app }, "the next drop is answered at once");
  assert.equal(gate.accepts(), true);
  assert.equal(slow.calls(), 1, "the file is read once per page");
  pageAnswers = true;
  assert.equal(gate.accepts(), false, "a page that answers drops itself (data-apc-native-drops) is never taken from");
  assert.equal(gate.drop(), null);

  // In flight, then an app that takes dock agents: the held drop goes back to the page, and later drags are not taken.
  const dock = deferred();
  const gate2 = directOnlyGate(dock.lookUp, () => false);
  const held = gate2.drop();
  assert.ok(held && "later" in held);
  dock.resolve({ directOnly: null, read: true });
  assert.equal(await (held as { later: Promise<DirectOnly | null> }).later, null, "nothing to answer: the drop is the page's");
  assert.equal(gate2.accepts(), false);
  assert.equal(gate2.drop(), null);
  assert.equal(dock.calls(), 1, "a real answer holds for the page");

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

test("a lookup that told nothing is asked again on a later drag, once the service worker's short negative cache has run out (APC 0.5)", async () => {
  const app: DirectOnly = { name: "Signals", host: "signals.example", connect: "https://signals.example/?connect", message: "…" };
  let clock = 1_000_000;
  const replies: DirectOnlyLookup[] = [{ directOnly: null, read: false }, { directOnly: app, read: true }];
  let calls = 0;
  const gate = directOnlyGate(async () => replies[calls++]!, () => false, () => clock);
  gate.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  // Told nothing (the file was briefly unreachable): stand back, and do not ask again on every dragover.
  assert.equal(gate.accepts(), false);
  assert.equal(gate.drop(), null);
  clock += LOOKUP_KEEP_UNKNOWN_MS - 1;
  gate.start();
  assert.equal(gate.accepts(), false);
  assert.equal(calls, 1, "not before the service worker's negative cache runs out");
  // A later drag, past it: asked again, and this time the file says Direct-only.
  clock += 1;
  gate.start();
  assert.equal(calls, 2);
  assert.equal(gate.accepts(), true, "taken while the new lookup is on its way");
  const dropped = gate.drop();
  assert.equal(await (dropped as { later: Promise<DirectOnly | null> }).later, app);
  assert.deepEqual(gate.drop(), { now: app });
});

test("the card says what goes along and where, and a site that sends without asking asks once more with it (TIN-571, TIN-619)", () => {
  for (const s of ["consent", "consent_sensitive", "consent_update"] as const) {
    assert.ok(STATUS_TEXT[s].includes(FORM_NOTE), s);
    assert.match(STATUS_TEXT[s], /APC hub .*kept 10 minutes at most.*agent's provider/, s);
  }
  assert.match(FORM_NOTE, /Everything you can see inside the outline goes along, including what you typed there\./);
  assert.match(FORM_NOTE, /passwords and codes never/);
  assert.match(STATUS_TEXT.consent_update, /^New: the outline is what goes\./);
  // The re-ask is a new version: a person who saw TIN-571's notice is asked once more.
  assert.notEqual(NOTICE_ALL, "formNoticeAll");
  assert.notEqual(NOTICE_SITES, "formNoticeSites");
  // Always, a site granted by itself and Never ask send without a card: once, they ask with the new words.
  assert.equal(reask(decide("ask", "always", false, false), false), true);
  assert.equal(reask(decide("ask", undefined, false, true), false), true);
  assert.equal(reask(decide("never_ask", undefined, true, false), false), true);
  // Seen once: the setting stays, and drops are sent again without a card.
  assert.equal(reask(decide("ask", "always", false, false), true), false);
  // A drop that asks anyway, or never sends, needs no second card.
  for (const d of [decide("ask", undefined, false, false), decide("ask", "sensitive", false, false), decide("ask", "never", false, false)]) assert.equal(reask(d, false), false, d);
});

test("the sensitive-data setting: Ask per drop by default, one choice for every site, and Include this time only under Ask (TIN-619)", () => {
  assert.equal(sensitiveMode(undefined), "ask");
  assert.equal(sensitiveMode("bogus"), "ask");
  assert.equal(sensitiveMode("send"), "send");
  assert.equal(sensitiveMode("never"), "never");
  assert.equal(includeSensitive("ask", false), false);
  assert.equal(includeSensitive("ask", true), true);
  assert.equal(includeSensitive("send", false), true);
  assert.equal(includeSensitive("never", true), false, "Always leave out offers no button, and refuses one");
  assert.equal(sentWithout(2), "Sent to your agent. 2 sensitive values left out.");
  assert.equal(sentWithout(1), "Sent to your agent. 1 sensitive value left out.");
  assert.match(sensitiveNote(3, "ask"), /^3 sensitive values will be left out; you can include them after sending\.$/);
  assert.match(sensitiveNote(1, "send"), /go along/);
  assert.match(sensitiveNote(1, "never"), /left out/);
});

test("Include them this time sends only the reading kept for that drop, once its consent was given; a later drop never takes its place (TIN-619, Grok's review)", () => {
  const first = "0b8f6a52-1f6e-4c3a-9d2b-1a2b3c4d5e6f";
  const second = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  const entry = (raw: string, consented: boolean, at: number): Held => ({ raw, hub: "https://apc.tineira.com", agent: "a1", consented, at });
  let held: Record<string, Held> = {};
  // The first drop: consented on its card, then held while the browser waits for the dock's Allow.
  held = holdReading(held, first, entry("first drop: card 4111 1111 1111 1111", false, 1000), 1000);
  assert.equal(heldForInclude(held, first, 1500), null, "not before its consent");
  held = holdReading(held, first, entry("first drop: card 4111 1111 1111 1111", true, 1000), 1600);
  // The second drop, waiting on its own consent card.
  held = holdReading(held, second, entry("second drop: IBAN DE89 3704 0044 0532 0130 00", false, 2000), 2000);
  // Allow comes; Include on the first sends the first drop's reading, never the second's.
  assert.equal(heldForInclude(held, first, 3000)?.raw, "first drop: card 4111 1111 1111 1111");
  assert.equal(heldForInclude(held, second, 3000), null, "the second drop's consent is not given");
  // Unknown ids, ids that are not a drop's, and readings kept too long give nothing.
  assert.equal(heldForInclude(held, "nope", 3000), null);
  assert.equal(heldForInclude(held, first, 1000 + HELD_MS + 1), null);
  assert.equal(readingId(first), first);
  for (const bad of ["", "x".repeat(36), 42, null, "../held"]) assert.equal(readingId(bad), null, String(bad));
  // At most HELD_MAX are kept, the newest.
  let many: Record<string, Held> = {};
  const idOf = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (let i = 0; i < HELD_MAX + 5; i++) many = holdReading(many, idOf(i), entry(`r${i}`, true, 5000 + i), 5000 + i);
  assert.equal(Object.keys(many).length, HELD_MAX);
  assert.ok(heldForInclude(many, idOf(HELD_MAX + 4), 5100));
  assert.equal(heldForInclude(many, idOf(0), 5100), null);
});

test("Your sites leaves out the extension's own patterns, and keeps what the person granted (TIN-786)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const own = ownPatterns(manifest);
  // What chrome.permissions.getAll() lists on a fresh install: the manifest's required host permission and its content scripts' matches.
  const fresh = ["https://apc.tineira.com/*", "https://apc.tineira.com/", "https://apc.tineira.com/?*", "https://apc.tineira.com/dock*", "https://apc.tineira.com/extension*"];
  assert.deepEqual(grantedByPerson(fresh, own), []);
  const withSites = [...fresh, "https://news.example.com/*", "http://localhost:8080/*", "https://*/*", "http://*/*"];
  assert.deepEqual(grantedByPerson(withSites, own), ["https://news.example.com/*", "http://localhost:8080/*"]);
  assert.deepEqual(grantedByPerson(["https://*/*", "http://*/*"], []), []);
});

test("What's sent? says the same three lines everywhere, and Held back follows the numbers setting (TIN-786)", () => {
  assert.equal(WHATS_SENT.label, "What's sent?");
  assert.deepEqual(WHATS_SENT.labels, { goes: "Goes", heldBack: "Held back", where: "Where" });
  assert.equal(WHATS_SENT.goes, "What's inside the outline, typed text included.");
  assert.equal(WHATS_SENT.heldBack("ask"), "Passwords and codes, always. Card, account and id numbers, unless you include them.");
  assert.equal(WHATS_SENT.heldBack("send"), "Passwords and codes, always. Card, account and id numbers go too.");
  assert.equal(WHATS_SENT.heldBack("never"), "Passwords and codes, always. Card, account and id numbers too.");
  assert.equal(WHATS_SENT.heldBack(sensitiveMode(undefined)), WHATS_SENT.heldBack("ask"), "no stored value reads as ask");
  assert.equal(WHATS_SENT.where, "Your dock's hub on Cloudflare (10 minutes at most), then your agent's provider.");
});
