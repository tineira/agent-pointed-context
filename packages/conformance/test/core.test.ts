/**
 * The suite's core checks, tested (TIN-912): a minimal conforming Direct app (`core-fixture.ts`) passes every check,
 * and for the checks the 1.0 traceability review found open (REV-2, THEN-3, EP-5, the revoked tool error) and the most
 * important others, an app broken in one way fails the check that must catch it. The Dock consent's nonce (CONS-2) is
 * tested on the Dock fixture. A check that passes a broken app is worse than none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError, type ConformanceCheck } from "../src/index.ts";
import { coreFixture, type CoreBreak } from "./core-fixture.ts";
import { dockFixture, type FixtureBreak, type FixtureOptions } from "./dock-fixture.ts";

const named = (checks: ConformanceCheck[], part: string) => {
  const found = checks.filter((c) => c.name.includes(part));
  assert.equal(found.length, 1, `one check named "${part}", found ${found.length}: ${found.map((c) => c.name).join(" | ")}`);
  return found[0]!;
};
const fails = async (check: ConformanceCheck, message: RegExp) =>
  assert.rejects(check.run(), (error: unknown) => {
    assert.ok(error instanceof ConformanceError, `a ConformanceError, not ${String(error)}`);
    assert.match(error.message, message);
    return true;
  });

{
  const { adapter } = coreFixture();
  const checks = apcConformance(adapter);
  for (const check of checks) {
    test(`the conforming core fixture passes: ${check.name}`, async () => {
      await check.run();
    });
  }
}

test("a revoked tool error that carries the RevokedAnswer as structuredContent too passes (it is no app data)", async () => {
  const { adapter } = coreFixture({ structuredRevokedError: true });
  await named(apcConformance(adapter), "a call already running when the grant is revoked").run();
});

const broken: Array<[CoreBreak, string, RegExp]> = [
  // REV-2: every request with a revoked grant, whatever the method, answers revoked, naming the app's host.
  ["revoked_serves_ping", "revoke from the app cuts that agent", /ping on a revoked grant: HTTP 200, expected 403/],
  ["revoked_takes_notifications", "revoke from the app cuts that agent", /a notification \(notifications\/initialized\) on a revoked grant: HTTP 202, expected 403/],
  ["revoked_parses_first", "revoke from the app cuts that agent", /a body that is not JSON-RPC on a revoked grant: HTTP 400, expected 403/],
  ["revoked_by_other_host", "revoke from the app cuts that agent", /revoked_by is "elsewhere\.test", not the app's host core\.test/],
  ["revoke_cuts_everyone", "revoke from the app cuts that agent", /tools\/call: HTTP 403/],
  ["revoked_error_with_data", "a call already running when the grant is revoked", /carries no focus, view or other data: view, focus/],
  // THEN-3: no then on a wait_for_focus result with no focus, whatever ended it.
  ["then_on_timeout", "wait_for_focus times out cleanly", /a wait that timed out came back with no focus, and carries then/],
  ["then_on_taken_over", "one wait per grant", /the wait a newer one took over came back with no focus, and carries then/],
  ["then_on_refused", "a second wait started right after the first", /the refused wait came back with no focus, and carries then/],
  ["then_on_cancelled", "cancelled wait (notifications/cancelled)", /the cancelled wait came back with no focus, and carries then/],
  ["then_on_cancelled", "cancelled wait (an HTTP abort)", /the cancelled wait came back with no focus, and carries then/],
  ["then_page_closed", "then rides on results only while", /with no page open, no then/],
  // The pin, attention and presence.
  ["attention_structured_only", "a pin rides as attention", /attention is in the structured result or the text, not both/],
  ["pin_marked_seen_by_poll", "a pin rides as attention", /an unread pin puts attention/],
  ["presence_no_target", "presence names what a read touched", /the read of order:ord_1 names it/],
  // One wait per grant.
  ["no_takeover", "one wait per grant", /the wait a newer one took over ends with focus null, timed_out false/],
  ["cancel_ignored", "cancelled wait (notifications/cancelled)", /still unread/],
  // EP-5: nothing but grants under P/{secret}.
  ["spa_fallback", "nothing but grants is served under a {secret} entry", /a GET of \/mcp\/<a secret no grant has> answers HTTP 200/],
];

for (const [brk, part, message] of broken) {
  test(`a broken core app (${brk}) fails: ${part}`, async () => {
    const { adapter } = coreFixture({ break: brk });
    await fails(named(apcConformance(adapter), part), message);
  });
}

test("every check the review found open has a broken core app that fails it", () => {
  const checks = apcConformance(coreFixture().adapter);
  const covered = new Set(broken.map(([, part]) => named(checks, part).name));
  for (const part of ["revoke from the app cuts that agent", "a call already running when the grant is revoked", "wait_for_focus times out cleanly", "one wait per grant", "a second wait started right after the first", "cancelled wait (notifications/cancelled)", "cancelled wait (an HTTP abort)", "nothing but grants is served under a {secret} entry"]) {
    assert.ok(covered.has(named(checks, part).name), part);
  }
});

// CONS-2: the Dock consent's nonce.
const CONSENT = "(dock): consent:";

test("the conforming Dock fixture passes the consent check, and gives back every pairing it made", async () => {
  const { adapter, hub } = dockFixture();
  const check = named(apcConformance(adapter), CONSENT);
  const before = hub.received.length;
  await check.run();
  assert.equal(check.note, undefined, check.note);
  assert.equal(hub.received.length, before + 1, "the right Allow paired, and nothing else did");
  for (const url of hub.received.slice(-1).map((b) => b.mcp_url).filter((u): u is string => typeof u === "string")) {
    const r = await adapter.fetch!(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    await r.body?.cancel();
    assert.equal(r.status, 404, "the pairing the check made was given back");
  }
});

const designs: Array<[string, FixtureOptions, RegExp?]> = [
  ["an app whose Allow carries no hub (bound to the consent on the server)", { hubBoundToConsent: true }],
  ["an app whose Allow carries only the consent and the ticket", { hubBoundToConsent: true, allowNoAgent: true }, /another agent's nonce not checked: the Allow does not name its agent/],
];
for (const [what, options, note] of designs) {
  test(`${what} passes the consent check`, async () => {
    const check = named(apcConformance(dockFixture(options).adapter), CONSENT);
    await check.run();
    if (note) assert.match(check.note ?? "", note);
    else assert.equal(check.note, undefined, check.note);
  });
}

const brokenConsent: Array<[FixtureBreak, RegExp]> = [
  ["nonce_unchecked", /an Allow with a forged nonce paired/],
  ["nonce_any_agent", /an Allow with another agent's nonce paired/],
  ["nonce_reusable", /the same Allow, sent again once it paired, paired again: a nonce works once/],
  ["nonce_optional", /an Allow with no nonce \(consent left out\) paired/],
];
for (const [brk, message] of brokenConsent) {
  test(`a broken Dock app (${brk}) fails the consent check`, async () => {
    await fails(named(apcConformance(dockFixture({ break: brk }).adapter), CONSENT), message);
  });
}

test("an adapter without dock.lifecycle passes the consent check with a note, not checked", async () => {
  const { adapter } = dockFixture();
  const check = named(apcConformance({ ...adapter, dock: { ...adapter.dock!, lifecycle: undefined } as never }), CONSENT);
  await check.run();
  assert.match(check.note ?? "", /not checked: the consent's nonce is reached through dock\.lifecycle\.owner/);
});
