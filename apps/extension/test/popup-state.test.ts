import assert from "node:assert/strict";
import { test } from "node:test";
import { SITE_LABELS, STATUS_TEXT, type Mode, type SiteChoice } from "../src/drop.ts";
import { agentName, agentRow, domainKind, lastView, pillOf, rowRemove, rowsOf, rowWrite, siteClick, siteView, STATUS_KIND, type SiteClick, type SiteState } from "../src/popup-state.ts";

const ORIGIN = "https://example.com";
const state = (over: Partial<SiteState> & { granted?: boolean }): SiteState => {
  const { granted, ...rest } = over;
  return { origin: ORIGIN, host: "example.com", stored: undefined, mode: "ask", anyPage: false, own: granted ? [`${ORIGIN}/*`] : [], ...rest };
};

/** What the control shows: the selected option, the disabled ones, the tick. */
function shown(s: SiteState) {
  const v = siteView(s);
  if (v.kind !== "control") return v.kind === "domain" ? { kind: v.kind, selected: v.options.find((o) => o.selected)?.value } : { kind: v.kind };
  return { kind: v.kind, options: v.options.map((o) => o.value).join(), selected: v.options.find((o) => o.selected)?.value ?? null, disabled: v.options.filter((o) => o.disabled).map((o) => o.value).join(), tick: v.tick.checked, tickOff: v.tick.disabled };
}

test("the site control reads every stored state (TIN-786)", () => {
  const stored = (v: SiteChoice | undefined) => v;
  // Every site ON, no grant of its own.
  assert.deepEqual(shown(state({ anyPage: true })), { kind: "control", options: "ask,always,never", selected: "ask", disabled: "", tick: false, tickOff: false });
  assert.deepEqual(shown(state({ anyPage: true, stored: stored("always") })), { kind: "control", options: "ask,always,never", selected: "always", disabled: "", tick: false, tickOff: false });
  assert.deepEqual(shown(state({ anyPage: true, stored: stored("never") })), { kind: "control", options: "ask,always,never", selected: "never", disabled: "", tick: false, tickOff: true });
  assert.deepEqual(shown(state({ anyPage: true, stored: stored("sensitive") })), { kind: "control", options: "ask,always,never", selected: "ask", disabled: "always", tick: true, tickOff: false });
  // Granted by itself, Every site ON: counts as Always until a choice is stored.
  assert.equal(shown(state({ anyPage: true, granted: true })).selected, "always");
  // Granted by itself, Every site OFF: Ask first is not offered.
  assert.deepEqual(shown(state({ granted: true })), { kind: "control", options: "always,never", selected: "always", disabled: "", tick: false, tickOff: false });
  assert.deepEqual(shown(state({ granted: true, stored: stored("never") })), { kind: "control", options: "always,never", selected: "never", disabled: "", tick: false, tickOff: true });
  assert.deepEqual(shown(state({ granted: true, stored: stored("sensitive") })), { kind: "control", options: "always,never", selected: null, disabled: "always", tick: true, tickOff: false });
  // Not allowed: no grant of any kind.
  assert.deepEqual(shown(state({})), { kind: "allow" });
});

test("a sensitive domain, and Never ask, read as the issue says", () => {
  const gov = { origin: "https://www.sii.gob.cl", host: "www.sii.gob.cl", anyPage: true };
  assert.deepEqual(shown(state({ ...gov })), { kind: "domain", selected: "sensitive" });
  assert.deepEqual(shown(state({ ...gov, stored: "always" })), { kind: "domain", selected: "sensitive" }, "a stale Always never shows: the domain asks");
  assert.deepEqual(shown(state({ ...gov, stored: "never" })), { kind: "domain", selected: "never" });
  assert.equal(domainKind("www.sii.gob.cl"), "Government domain");
  assert.equal(domainKind("x.bank"), ".bank domain");
  assert.equal(domainKind("x.insurance"), ".insurance domain");
  // Never ask on: the warning, except where the site's own Never beats it.
  assert.deepEqual(shown(state({ anyPage: true, mode: "never_ask" })), { kind: "never-ask" });
  assert.deepEqual(shown(state({ anyPage: true, mode: "never_ask", stored: "sensitive" })), { kind: "never-ask" });
  assert.deepEqual(shown(state({ ...gov, mode: "never_ask" })), { kind: "never-ask" });
  assert.equal(shown(state({ anyPage: true, mode: "never_ask", stored: "never" })).kind, "control");
  assert.deepEqual(shown(state({ mode: "never_ask" })), { kind: "allow" }, "not allowed beats Never ask");
});

type Case = { name: string; s: SiteState; clicks: Partial<Record<SiteClick, ReturnType<typeof siteClick>>> };
const none = null;

test("what each click writes, for every stored state and Every site (TIN-786)", () => {
  const cases: Case[] = [
    { name: "ON, none", s: state({ anyPage: true }), clicks: { ask: { write: null, revoke: null }, always: { write: "always", revoke: null }, never: { write: "never", revoke: null }, "tick-on": { write: "sensitive", revoke: null }, "tick-off": none } },
    { name: "ON, always", s: state({ anyPage: true, stored: "always" }), clicks: { ask: { write: null, revoke: null }, always: { write: "always", revoke: null }, never: { write: "never", revoke: null }, "tick-on": { write: "sensitive", revoke: null } } },
    { name: "ON, never", s: state({ anyPage: true, stored: "never" }), clicks: { ask: { write: null, revoke: null }, always: { write: "always", revoke: null }, "tick-on": none, "tick-off": none } },
    { name: "ON, sensitive", s: state({ anyPage: true, stored: "sensitive" }), clicks: { ask: { write: undefined, revoke: null }, always: none, never: { write: "never", revoke: null }, "tick-off": { write: null, revoke: null }, "tick-on": { write: "sensitive", revoke: null } } },
    { name: "ON, granted by itself: Ask first deletes the key and removes the site's own grant", s: state({ anyPage: true, granted: true }), clicks: { ask: { write: null, revoke: `${ORIGIN}/*` }, always: { write: "always", revoke: null } } },
    { name: "ON, granted, always", s: state({ anyPage: true, granted: true, stored: "always" }), clicks: { ask: { write: null, revoke: `${ORIGIN}/*` } } },
    { name: "OFF, granted: Ask first is not offered, nothing is removed", s: state({ granted: true }), clicks: { ask: none, always: { write: "always", revoke: null }, never: { write: "never", revoke: null }, "tick-on": { write: "sensitive", revoke: null } } },
    { name: "OFF, granted, sensitive", s: state({ granted: true, stored: "sensitive" }), clicks: { ask: none, always: none, never: { write: "never", revoke: null }, "tick-off": { write: null, revoke: null } } },
    { name: "OFF, granted, never", s: state({ granted: true, stored: "never" }), clicks: { ask: none, always: { write: "always", revoke: null }, "tick-on": none } },
    { name: "domain ON", s: state({ anyPage: true, origin: "https://x.gov", host: "x.gov" }), clicks: { ask: { write: null, revoke: null }, never: { write: "never", revoke: null }, always: none, "tick-on": none } },
    { name: "domain, granted, OFF", s: state({ origin: "https://x.gov", host: "x.gov", own: ["https://x.gov/*"] }), clicks: { ask: { write: null, revoke: null }, never: { write: "never", revoke: null } } },
  ];
  for (const { name, s, clicks } of cases) {
    for (const [click, want] of Object.entries(clicks)) assert.deepEqual(siteClick(s, click as SiteClick), want, `${name}: ${click}`);
  }
  // A wildcard grant covers the site but is never removed for it (it is another row's to remove): Ask first would not make it ask.
  assert.equal(siteClick(state({ anyPage: true, origin: "https://www.example.com", host: "www.example.com", own: ["*://*.example.com/*"] }), "ask"), null);
  // A pattern the manifest requires cannot go: Ask first is not offered there either.
  assert.equal(siteClick(state({ anyPage: true, granted: true, required: [`${ORIGIN}/*`] }), "ask"), null);
});

test("the popup's words are one set (TIN-786)", () => {
  assert.deepEqual(Object.values(SITE_LABELS), ["Ask first", "Always send", "Never send", "Ask every time", "Sensitive site: ask every time"]);
});

test("Your sites: which rows, what the select writes, what x does for each kind of row", () => {
  const sites = { "https://a.com": "always", "https://b.com": "never", "https://c.com": "sensitive", "https://d.gov": "always", "https://junk.com": "maybe" };
  const own = ["https://a.com/*", "https://e.com/*", "*://*.wild.com/*", "https://f.gov/*"];
  const rows = rowsOf(sites, own, false);
  assert.deepEqual(rows.map((r) => `${r.label}:${r.value}`), ["a.com:always", "b.com:never", "c.com:sensitive", "d.gov:sensitive", "e.com:always", "*://*.wild.com:always", "f.gov:sensitive"]);
  const by = (label: string) => rows.find((r) => r.label === label)!;
  // x: a stored row with its own grant deletes the key and removes that one grant; "Remove" says so while Every site is off.
  assert.deepEqual(rowRemove(by("a.com")), { deleteKey: "https://a.com", revoke: "https://a.com/*" });
  assert.equal(by("a.com").tip, "Remove");
  // x: a stored row with no grant only deletes its key.
  assert.deepEqual(rowRemove(by("b.com")), { deleteKey: "https://b.com", revoke: null });
  assert.equal(by("b.com").tip, "Back to Ask first");
  // x: a granted-only row removes that one pattern and no key.
  assert.deepEqual(rowRemove(by("e.com")), { deleteKey: null, revoke: "https://e.com/*" });
  assert.deepEqual(rowRemove(by("*://*.wild.com")), { deleteKey: null, revoke: "*://*.wild.com/*" });
  assert.equal(rowWrite(by("*://*.wild.com"), "never"), null, "a pattern that is not one origin has no select");
  assert.deepEqual(rowWrite(by("e.com"), "never"), { origin: "https://e.com", value: "never" });
  assert.equal(by("d.gov").alwaysDisabled, true);
  // With Every site on the site stays reachable and asking: the tooltip is the old one.
  assert.equal(rowsOf(sites, own, true).find((r) => r.label === "a.com")!.tip, "Back to Ask first");
  // The extension's own patterns are never in `own` (grantedByPerson), so they never get a row.
  assert.equal(rowsOf({}, [], false).length, 0);
  // x never names the any-page grant: no row can carry it.
  assert.ok(rows.every((r) => r.revoke !== "https://*/*" && r.revoke !== "http://*/*"));
});

test("Last drop reads every status and both shapes of `last` (TIN-786)", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const at = "2026-11-10T11:59:00Z";
  // Every key of STATUS_TEXT has a branch.
  for (const key of Object.keys(STATUS_TEXT)) assert.ok(key in STATUS_KIND, `${key} has a branch in lastView`);
  for (const key of Object.keys(STATUS_KIND)) assert.ok(key in STATUS_TEXT, `${key} is a status`);
  // Old shape: no agent, no leftOut.
  assert.deepEqual(lastView({ at, hub: "https://apc.tineira.com", site: "en.wikipedia.org", status: "sent" }, now), { kind: "sent", lead: "✓ Sent to your agent", at, detail: "en.wikipedia.org" });
  // New shape.
  assert.deepEqual(lastView({ at, site: "a.com", status: "sent", agent: "Claude", leftOut: 1 }, now), { kind: "sent", lead: "✓ Sent to Claude", at, detail: "a.com · 1 number left out" });
  assert.equal((lastView({ at, site: "a.com", status: "sent", leftOut: 2 }, now) as { detail: string }).detail, "a.com · 2 numbers left out");
  for (const bad of [0, -1, 1.5, "3", null, undefined]) assert.equal((lastView({ at, site: "a.com", status: "sent", leftOut: bad }, now) as { detail: string }).detail, "a.com", `leftOut ${String(bad)} is absent`);
  // Waiting, and a wait nobody is on any more.
  assert.deepEqual(lastView({ at, hub: "https://apc.tineira.com", site: "a.com", status: "asking" }, now), { kind: "waiting", text: "Allow this browser in your dock", hub: "https://apc.tineira.com" });
  assert.equal(lastView({ at: "2026-11-10T11:55:00Z", site: "a.com", status: "asking" }, now)?.kind, "failed");
  // Every failure: "✕ Not sent" and a reason, never "Not sent" twice.
  for (const [status, kind] of Object.entries(STATUS_KIND)) {
    const v = lastView({ at, site: "a.com", status }, now);
    if (kind === "failed") {
      assert.ok(v && v.kind === "failed" && v.lead === "✕ Not sent" && v.reason.length > 0 && !/^Not sent/.test(v.reason), status);
    } else if (kind === "none") assert.equal(v, null, status);
  }
  assert.equal(lastView({ at, site: "a.com", status: "not_here" }, now)?.kind, "failed");
  // Nothing to draw: no `last`, or a status this build does not know.
  for (const bad of [undefined, null, {}, { at, status: "from_the_future" }, { status: "sent" }, "x"]) assert.equal(lastView(bad, now), null);
});

test("the pill, from what is stored", () => {
  assert.deepEqual(pillOf({}, {}, undefined), { text: "Not paired", on: false });
  assert.deepEqual(pillOf({ "https://h ag_1": "t" }, {}, undefined), { text: "Paired", on: true });
  assert.deepEqual(pillOf({ "https://h ag_1": "t" }, { "https://h ag_1": "Claude" }, undefined), { text: "Claude", on: true });
  assert.deepEqual(pillOf({ "https://h ag_1": "t" }, {}, { hub: "https://h", agent: "Grok" }), { text: "Grok", on: true });
  assert.deepEqual(pillOf({ "https://h ag_1": "t" }, {}, { hub: "https://other", agent: "Grok" }), { text: "Paired", on: true });
  assert.deepEqual(pillOf({ "https://h ag_1": "t", "https://h ag_2": "t" }, {}, undefined), { text: "2 agents", on: true });
  assert.deepEqual(agentRow("https://apc.tineira.com ag_1", {}), { name: "your agent", hub: "apc.tineira.com" });
  assert.deepEqual(agentRow("https://apc.tineira.com ag_1", { "https://apc.tineira.com ag_1": "Claude" }), { name: "Claude", hub: "apc.tineira.com" });
});

test("an agent's name is cleaned as Part 2 specifies", () => {
  const ch = (...n: number[]) => String.fromCharCode(...n);
  assert.equal(agentName("Claude"), "Claude");
  assert.equal(agentName("  Claude  "), "Claude");
  assert.equal(agentName("a" + ch(10) + "b"), null, "a newline rejects it");
  assert.equal(agentName("   "), null);
  assert.equal(agentName(""), null);
  assert.equal(agentName(42), null);
  assert.equal(agentName(ch(0x202e) + "Evil" + ch(0x2066) + "x" + ch(0x2069, 0x200f)), "Evilx", "bidi controls go");
  assert.equal(agentName("a" + ch(7) + "b" + ch(0x85) + "c"), "abc", "C0 and C1 controls go");
  assert.equal([...agentName("x".repeat(100))!].length, 60);
  assert.equal([...agentName("😀".repeat(70))!].length, 60, "code points, not units");
});

test("the type of a Mode stays what drop.ts says", () => {
  const modes: Mode[] = ["ask", "never_ask"];
  assert.equal(modes.length, 2);
});
