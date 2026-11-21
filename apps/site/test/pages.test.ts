/**
 * /try and /build (TIN-627; one page each since the Dock left, TIN-1061; the new design, TIN-1068): /try's two
 * phases (TIN-1094), its buttons and their targets in both connection states, step 3's examples and the optional
 * phase 2, and its phone layout; the numbered rows beside the real payload from Pulse, the packages, the guide links
 * and the open-list note on /build; no Dock and no Autio on either page; every docs link names a page and a heading
 * that exist; no footer repeats its page; the contrast of every /try and /build pairing over the dot field.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { DOT_FIELD_SPECS } from "../src/web/dot-field.ts";
import { FOCUS_EXAMPLE } from "../src/web/landing-example.ts";
import { DOCK_PRODUCT, FOOTER_LINKS, footerLinks, MOVED_PAGES, SITE_PAGES, sitePageAt, V1 } from "../src/web/site-pages.ts";
import { TRY_BAR, TRY_BRIDGE, TRY_CUSTOMER_ROW } from "../src/web/try-examples.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const tryPage = read("apps/site/src/web/try.tsx");
const build = read("apps/site/src/web/build.tsx");
const sitePages = read("apps/site/src/web/site-pages.ts");
const pagesCss = read("apps/site/src/web/styles/pages.css");
const worker = read("apps/site/src/worker/index.ts");
const shellCss = read("apps/site/src/web/styles/shell.css");
/** The landing, whole: its root and every section file, so a section added later is covered without a test edit. */
const landingSources = [
  read("apps/site/src/web/landing.tsx"),
  ...readdirSync(new URL("apps/site/src/web/landing/", root))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => read(`apps/site/src/web/landing/${f}`)),
];

/** One page component's source, from its `export function` to the end of the file. */
const pageOf = (source: string, name: string) => {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("export function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

/** /try's markup between two class names (or to the end of the component). */
const tryPart = (from: string, to?: string) => {
  const start = tryPage.indexOf(from);
  assert.ok(start >= 0, from);
  const end = to ? tryPage.indexOf(to, start) : -1;
  return tryPage.slice(start, end < 0 ? undefined : end);
};

test("/try is two phases: the hero maps them, phase 1 is three steps, phase 2 is optional (TIN-1094)", () => {
  assert.match(tryPage, /<h1>\s*Your agent, a demo app, <em>one drag\.<\/em>\s*<\/h1>/);
  assert.equal(SITE_PAGES.try.title, "Try APC: your agent, a demo app, one drag");
  // The hero's map: two cards, phase 2 marked optional, linking the two sections; no CTA of its own (the button is in step 1).
  const rail = tryPart('className="try-rail"', "</nav>");
  assert.match(rail, /href="#phase-1">\s*<small>Phase 1<\/small>\s*<b>Try APC<\/b>/);
  assert.match(rail, /href="#phase-2" className="opt">\s*<small>\s*Phase 2 <i>optional<\/i>\s*<\/small>\s*<b>Get even more out of APC<\/b>/);
  assert.doesNotMatch(tryPart('className="page-hero"', 'className="try-phase"'), /className="btn|page-cta-row/, "the hero has no button");
  assert.match(tryPage, /<section className="try-phase" id="phase-1" aria-labelledby="phase-1-title">/);
  assert.match(tryPage, /<section className="try-more rv" id="phase-2" aria-labelledby="phase-2-title">/);
  // Phase 1: three steps, in order, then the line that ends it.
  const steps = tryPart('className="try-steps"', 'className="try-examples"');
  assert.deepEqual([...steps.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]), ["Open Pulse", "Connect your agent", "Point and ask"]);
  assert.deepEqual([...steps.matchAll(/<span className="n">(\d)<\/span>/g)].map((m) => m[1]), ["1", "2", "3"]);
  assert.doesNotMatch(tryPage, /Add a second app|DONE_IN_HERO/, "Signals is no step: it is phase 2");
  assert.match(steps, /Add it to Claude, ChatGPT or Grok as a remote MCP server\./, "the agents the landing's Works with row shows (TIN-1088)");
  assert.doesNotMatch(tryPage, /Cursor/);
  assert.match(steps, /Drag your agent's mark from Pulse's agent bar onto a bar, a customer or a step, and ask about "this"\./);
  assert.ok(tryPage.indexOf('className="try-end"') > tryPage.indexOf('className="try-examples"') && tryPage.indexOf('className="try-end"') < tryPage.indexOf('id="phase-2"'), "phase 1 ends before phase 2");
  assert.match(tryPart('className="try-end"', "</p>"), /<b>That is APC\.<\/b> You pointed, and your agent read the data behind it\. You can stop here\./);
  assert.match(tryPart('className="try-aside'), /Cut it off any time\.[\s\S]*keeps the other/);
  assert.doesNotMatch(tryPage, /Download|\.exe|window\.open|extension/i, "no downloads, no popup dock, no extension");
});

test("/try's buttons: Open Pulse in step 1 by connection (TIN-1090, TIN-1087), one Open Signals to its Connect panel (TIN-1091)", () => {
  const OUT = /\{\.\.\.OUT\}/;
  assert.match(tryPage, /const OUT = \{ target: "_blank", rel: "noopener" \} as const;/);
  // Exactly two buttons on the page: Open Pulse, the only filled one, and Open Signals.
  assert.deepEqual([...tryPage.matchAll(/className="btn ([a-z]+)"/g)].map((m) => m[1]), ["primary", "ghost"]);
  const step1 = tryPart('<li className={stepClass("open"', '<li className={stepClass("connect"');
  assert.match(step1, /<a className="btn primary" href=\{pulse\.openHref\} \{\.\.\.OUT\}>\s*Open Pulse <span aria-hidden="true">↗<\/span>/);
  assert.match(step1, /<span className="try-host">\{host\(PULSE_ORIGIN\)\}<\/span>/);
  // Its target in both states comes from the shared connection state (connected.test.ts: Overview, else Agents).
  assert.match(step1, /pulse\.connected\s*\?\s*"Your agent is already connected, so Pulse opens on its overview, with the charts to point at\."\s*:\s*"A demo app: product analytics for a made-up SaaS, with its customers, plans, seats and monthly activity\. It opens a private copy for you, on its Agents page\."/);
  // Phase 2: one button, always Signals' Connect panel, and no "Connect an agent" anywhere.
  assert.ok(tryPage.includes("const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;"));
  const more = tryPart('id="phase-2"', 'className="try-aside');
  assert.match(more, /<a className="btn ghost" href=\{SIGNALS_CONNECT\} \{\.\.\.OUT\}>\s*Open Signals <span aria-hidden="true">↗<\/span>/);
  assert.equal(tryPage.match(/href=\{SIGNALS_CONNECT\}/g)?.length, 1);
  assert.doesNotMatch(tryPage, /Connect an agent|href=\{SIGNALS\.url\}/, "Signals keeps only Open Signals, to ?connect");
  assert.doesNotMatch(more, /pulse\.|connected/, "Signals has no state on /try");
  assert.match(more, /It opens with an agent already made and its MCP address showing\./, "true once TIN-1093 is in production");
  assert.match(more, /\{host\(SIGNALS\.url\)\}/);
  // The cross-app question, worded as before, inside phase 2.
  assert.match(more, /href=\{TRY_POST\} \{\.\.\.OUT\}>\s*Tallyfin's offer to Team teams in North America\s*<\/a>/);
  assert.match(more, /href=\{TRY_CUSTOMER\} \{\.\.\.OUT\}>\s*Deep Harbor Logistics\s*<\/a>/);
  assert.match(more, /Which of our customers did this offer take\?/);
  assert.match(more, /How do the two connect\?/);
  assert.ok(tryPage.includes("const TRY_POST = `${SIGNALS.url}?post=post_013`;"));
  assert.ok(tryPage.includes('const TRY_CUSTOMER = inPulse("/customers/cus_0048");'));
  // Every link to an app opens a new tab, so /try stays open beside it.
  for (const link of tryPage.matchAll(/<a [^>]*href=\{(?!`)[^}]+\}[^>]*>/g)) assert.match(link[0], OUT, link[0]);
  assert.match(pagesCss, /\.try-more\s*\{[^}]*border:\s*1px dashed var\(--accent-line\)/, "phase 2 is a dashed card");
  assert.match(pagesCss, /\.try-rail a\.opt\s*\{[^}]*border-style:\s*dashed/);
});

test("/try's examples: a bar, a customer, a step of the bridge, each with its deep link into Pulse and two questions", () => {
  assert.ok(tryPage.includes("const inPulse = (path: string) => `${PULSE_ORIGIN}${path}`;"), "on the origin Open Pulse uses");
  const examples = tryPart('className="try-examples"', 'className="try-end"');
  assert.match(examples, /<h3 id="examples-title">What "this" can mean<\/h3>/);
  assert.deepEqual([...examples.matchAll(/<small>([^<]+)<\/small>/g)].map((m) => m[1]), ["A bar of a chart", "A customer", "A step of the bridge"]);
  assert.equal(examples.match(/<article className="try-ex rv">/g)?.length, 3, "three examples, not four");
  for (const [name, part] of [["TRY_BAR", "TRY_BAR.label"], ["TRY_CUSTOMER_ROW", "TRY_CUSTOMER_ROW.name"], ["TRY_BRIDGE", "TRY_BRIDGE.label"]] as const) {
    assert.match(examples, new RegExp(`<a href=\\{inPulse\\(${name}\\.path\\)\\} \\{\\.\\.\\.OUT\\}>\\s*\\{${part.replace(".", "\\.")}\\}\\s*</a>`), name);
    assert.match(examples, new RegExp(`<Asks asks=\\{${name}\\.asks\\} />`), name);
  }
  // What the examples show (scripts/test/site-try-examples.test.mjs pins every number to Pulse's own functions).
  assert.equal(TRY_BAR.label, "March 2026");
  assert.equal(TRY_BAR.series.length, 18);
  assert.equal(TRY_BAR.series[11], TRY_BAR.active, "the accented bar (BAR_ON) is March");
  assert.match(tryPage, /const BAR_ON = 11;/);
  assert.equal(TRY_CUSTOMER_ROW.name, "Lumen Delta Systems");
  assert.equal(TRY_BRIDGE.label, "September 2026");
  assert.deepEqual(TRY_BRIDGE.steps.map((s) => s.label), ["Start", "New", "Reactivated", "Churned", "End"]);
  for (const ex of [TRY_BAR, TRY_CUSTOMER_ROW, TRY_BRIDGE]) {
    assert.equal(ex.asks.length, 2);
    for (const a of ex.asks) assert.match(a, /^[A-Z][^"<>]+\?$/, a);
  }
  // The drawings are decoration: the text says the same, and the agent's mark sits on the pointed part.
  assert.equal(examples.match(/className="try-ex-art" aria-hidden="true"/g)?.length, 3);
  assert.equal(tryPage.match(/<AgentMark size=\{26\} className="try-ex-pin" \/>/g)?.length, 3);
});

test("/try shows Pulse connected from the hero's hint only: only Connect your agent is done, Open Pulse is where to start", () => {
  // TIN-1072: the hint is read through pulse-status.ts (TTL, schema, cleanName; pulse-status.test.ts), never fetched.
  assert.doesNotMatch(tryPage, /sessionStorage|localStorage|fetch\(|useEffect|dangerouslySetInnerHTML|innerHTML/, "no storage of its own, no request, no HTML");
  assert.match(tryPage, /const pulse = usePulseView\(\);/);
  // Decided by Tomas (TIN-1094): connected, step 2 is done, step 1 is "start here", step 3 is as it was.
  assert.match(tryPage, /const stepClass = \(step: Step, connected: boolean\) => \(!connected \? "try-step rv" : step === "connect" \? "try-step done rv" : step === "open" \? "try-step next rv" : "try-step rv"\);/);
  for (const step of ["open", "connect", "point"]) assert.match(tryPage, new RegExp(`<li className=\\{stepClass\\("${step}", pulse\\.connected\\)\\}>`));
  // Who is connected: in the hero once, and in step 2, as text nodes.
  const status = tryPart("{pulse.connected && (", "</p>");
  assert.match(status, /<p className="try-status">\s*<span className="try-conn">/);
  assert.match(status, /\{pulse\.agentName \? `\$\{pulse\.agentName\} connected` : "Connected directly"\}/);
  assert.match(status, /to Pulse, from the home page\.<span className="try-status-more"> Start at step 1: it opens ready to point\.<\/span>/);
  assert.match(tryPage, /\{pulse\.agentName \? `\$\{pulse\.agentName\} is connected to Pulse\.` : "Your agent is connected to Pulse\."\}<\/span> Nothing to do here\./);
  assert.match(pagesCss, /\.try-step\.done b::after\s*\{[^}]*content:\s*"done on the home page";/);
  assert.match(pagesCss, /\.try-step\.next b::after\s*\{[^}]*content:\s*"start here";/);
  for (const room of [".try-step.done", ".try-step.next", ".try-status .try-conn", ".try-step.done .try-conn-sentence"]) {
    assert.ok(pagesCss.includes(room), `pages.css styles ${room}`);
  }
  assert.doesNotMatch(pagesCss, /\.try-app\.on|\.try-starter|\.try-side|\.try-links|\.try-joiner/, "the old walk's rules are gone");
  assert.match(pagesCss, /TIN-1072/);
  assert.match(tryPage, /TIN-1072/);
});

test("/try at 375 px: the phase cards collapse and step 1's button reaches the first screen; nothing is wider than the page", () => {
  const phone = pagesCss.slice(pagesCss.indexOf("@media (max-width: 760px) {"));
  // The cards become one compact row: their descriptions go, the row stays two columns.
  assert.match(phone, /\.try-rail span\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(phone, /\.try-rail\s*\{[^}]*grid-template-columns/, "two cards side by side, not stacked");
  assert.match(phone, /\.try-status-more,\s*\.try-phase-head p:not\(\.landing-who\)\s*\{\s*display:\s*none;/);
  // Below 980 px every /try grid is one column; at 760 px the examples stack their drawing over their text.
  const narrow = pagesCss.slice(pagesCss.indexOf("@media (max-width: 980px) {"), pagesCss.indexOf("@media (max-width: 760px) {"));
  assert.match(narrow, /\.try-grid,\s*\.build-grid\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(narrow, /\.try-more-grid\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(phone, /\.try-ex\s*\{\s*grid-template-columns:\s*1fr;/);
  // Every /try grid track can shrink (minmax(0, …)) or is the drawing's fixed 240 px column that the phone layout drops.
  const tracks = [...pagesCss.slice(0, pagesCss.indexOf("/* ───────── /build")).matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1]!);
  for (const t of tracks) assert.ok(/^(minmax\(0, [^)]+\)(?:\s+minmax\(0, [^)]+\))*|repeat\(\d, minmax\(0, 1fr\)\)|44px 1fr|1fr 1fr|240px minmax\(0, 1fr\))$/.test(t), `a /try track that cannot shrink: ${t}`);
  // The step's tag never splits at 375 px.
  assert.match(pagesCss, /\.try-step b::after\s*\{[^}]*white-space:\s*nowrap;/);
});

test("/build is one page: four numbered rows, the payload from Pulse beside them, the packages, the guides, the open list", () => {
  const page = pageOf(build, "BuildPage");
  assert.match(page, /New to APC\? <a href=\{SITE_PAGES\.try\.path\}>Try the demo first →<\/a>/);
  assert.match(page, /className="btn primary" href=\{`\$\{DOCS\}\/integrate`\}>\s*Integrate your app in an afternoon/);
  assert.match(page, /className="btn ghost" href=\{`\$\{DOCS\}\/spec`\}>Read the spec/);
  assert.match(page, /<h2 className="build-h2">What to implement<\/h2>/);
  const steps = [...build.slice(build.indexOf("const CORE_STEPS"), build.indexOf("const PACKAGES")).matchAll(/title: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["Serve an MCP endpoint", "Make things pointable", "Publish apc.json and offer Revoke", "Pass the conformance suite"]);
  for (const core of ["get_current_view", "wait_for_focus", "data-focus", "next", "next_args", "apc.json", "@tineira/apc-conformance"]) {
    assert.ok(build.slice(build.indexOf("const CORE_STEPS"), build.indexOf("const PACKAGES")).includes(core), core);
  }
  const packages = [...build.slice(build.indexOf("const PACKAGES"), build.indexOf("const GUIDES")).matchAll(/"(@tineira\/[a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(packages, ["@tineira/apc-protocol", "@tineira/apc-server", "@tineira/apc-web", "@tineira/apc-conformance"]);
  assert.match(page, /Free and open: code MIT, docs and spec CC BY 4\.0\./);
  assert.doesNotMatch(build, /apc_link|DOCK_FOCUS_EXAMPLE|call_app_tool|requestConnect|ShipBoth|build-both/, "nothing of the Dock's profile");
});

test("the payload /build shows is Pulse's real focus for the March bar", () => {
  assert.equal(FOCUS_EXAMPLE.params.month, "2026-03", "the example is March");
  assert.equal(FOCUS_EXAMPLE.next, "get_figure", "the example names the call that reads it");
  assert.match(build, /const json = \(value: unknown\) => JSON\.stringify\(value, null, 2\);/);
  assert.match(build, /\{json\(FOCUS_EXAMPLE\)\}/, "the page renders FOCUS_EXAMPLE, unmodified");
  const caption = build.slice(build.indexOf("What the agent receives"), build.indexOf("</pre>"));
  assert.match(caption, /March in the chart of active\s*customers/, "the caption says what the pin is");
  assert.match(caption, /href=\{`\$\{DOCS\}\/spec#the-pin-and-the-focus-format`\}/, "it links the focus format");
});

test("/build's guide row names every reference, and nothing repeats in the footer", () => {
  const guides = [...build.matchAll(/\{ title: "([^"]+)", href: ((?:[^}]+))[^}]*\}/g)].map((m) => m[1]);
  assert.deepEqual(guides, ["Integration guide", "Conformance suite", "Docs", "Spec", "Payload specification", "Paper", "GitHub"]);
  for (const part of ["`${DOCS}/integrate`", "`${DOCS}/conformance`", "`${DOCS}/spec`", "RECORDS, out: true", "PAPER, out: true", "REPO, out: true"]) assert.ok(build.includes(part), part);
  for (const ref of ["https://doi.org/10.5281/zenodo.23382909", "https://doi.org/10.5281/zenodo.23383101", "https://github.com/tineira/agent-pointed-context"]) assert.ok(sitePages.includes(ref), ref);
  // The top bar has Docs and GitHub on every page, so the footer never does.
  for (const l of FOOTER_LINKS as readonly { label: string; href: string }[]) assert.ok(l.href !== "/docs" && !l.href.startsWith("https://github.com"), l.label);
  assert.deepEqual(footerLinks(["/docs/spec", "https://doi.org/10.5281/zenodo.23382909"]).map((l) => l.href), ["https://doi.org/10.5281/zenodo.23383101", "/v1/"]);
  assert.match(pageOf(build, "BuildPage"), /<SiteFooter onPage=\{BUILD_LINKS\} \/>/);
  assert.match(build, /const BUILD_LINKS = GUIDES\.map\(\(g\) => g\.href\);/);
  assert.match(sitePages, /label: "Version 1, as described in the paper →"/);
  assert.match(sitePages, /export const V1 = "\/v1\/";/);
  assert.match(sitePages, /href: V1 \}/);
});

test("no page links an href the footer also carries: the landing, /try and /build", () => {
  // The footer keeps Spec, the payload specification, the paper and Version 1. A page that links one leaves it out of
  // its footer (/build does, through BUILD_LINKS); a page that passes nothing must link none of them.
  assert.deepEqual(FOOTER_LINKS.map((l) => l.href), ["/docs/spec", "https://doi.org/10.5281/zenodo.23383101", "https://doi.org/10.5281/zenodo.23382909", V1]);
  const footerLink = /\{PAPER\}|\{RECORDS\}|\{V1\}|href=\{`\$\{DOCS\}\/spec`\}|href="(?:\/docs\/spec|\/v1\/?)"|10\.5281\/zenodo/;
  assert.ok(landingSources.length >= 2, "the landing's root and its sections");
  // The landing's standard section (TIN-1067) links the spec and both records, and the landing passes exactly what it
  // links (STANDARD_LINKS, its cards' hrefs) to its footer, as /build does. Every other landing source links none.
  const standard = read("apps/site/src/web/landing/StandardSection.tsx");
  const landingRoot = read("apps/site/src/web/landing.tsx");
  landingSources
    .filter((source) => source !== standard)
    .forEach((source, i) => assert.doesNotMatch(source, footerLink, `landing source #${i} links a footer link itself`));
  assert.match(standard, /export const STANDARD_LINKS = CARDS\.map\(\(c\) => c\.href\);/);
  assert.doesNotMatch(standard.slice(standard.indexOf("export const STANDARD_LINKS")), /\{PAPER\}|\{RECORDS\}|\{V1\}|href=\{`/, "the section links footer hrefs only through CARDS");
  assert.match(landingRoot, /<SiteFooter onPage=\{STANDARD_LINKS\} \/>/);
  assert.doesNotMatch(tryPage, footerLink, "TryPage links a footer link itself");
  for (const source of [...landingSources.filter((s) => s !== landingRoot), tryPage]) assert.doesNotMatch(source, /<SiteFooter onPage/, "a page that links none of the footer's passes none to its footer");
});

test("neither the Dock nor Autio is named on /try or /build", () => {
  assert.equal(DOCK_PRODUCT, null);
  assert.equal(build.match(/DOCK_PRODUCT\.url/g)?.length, 1);
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "")
      .replace(/\{DOCK_PRODUCT && <>[\s\S]*?<\/>\}/g, "");
  for (const [name, source] of [["try.tsx", tryPage], ["build.tsx", build]] as const) {
    assert.doesNotMatch(stripComments(source), /\b(Autio|Dock)\b/i, `${name} names Autio or Dock outside comments`);
  }
  for (const source of [tryPage, build]) assert.doesNotMatch(source, /href="\/dock|href="\/extension|DOCK_DESKTOP|Dock for Windows|Pulse for Windows/);
});

test("the docs links of both pages name pages and headings that exist", () => {
  const ids = new Map(DOC_PAGES.map((p) => [p.path, new Set(headingIds(parseMarkdown(read(p.file))))]));
  const links = [...[tryPage, build, sitePages].join("\n").matchAll(/\$\{DOCS\}(\/[a-z]+)?(#[a-z0-9_-]+)?/g)];
  assert.ok(links.length >= 5);
  for (const [, page = "", hash] of links) {
    const path = `/docs${page}`;
    assert.ok(ids.has(path), `${path} is not a docs page`);
    if (hash) assert.ok(ids.get(path)!.has(hash.slice(1)), `${path}${hash} is not a heading`);
  }
});

test("the old /build pages still answer a permanent redirect to /build, keeping the query", () => {
  assert.deepEqual(Object.keys(MOVED_PAGES).sort(), ["/build/both", "/build/direct", "/build/dock"]);
  for (const to of Object.values(MOVED_PAGES)) assert.equal(sitePageAt(to), "build");
  assert.equal(SITE_PAGES.build.path, "/build");
  assert.ok(worker.includes('const to = MOVED_PAGES[url.pathname.replace(/\\/+$/, "")];'));
  assert.ok(worker.includes("c.redirect(`${to}${url.search}`, 301)"));
});

type Rgb = [number, number, number];

/** The declarations of every rule of a stylesheet whose selector list names `selector` exactly. */
function declarationsOf(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, list, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list!.split(",").some((s) => s.trim() === selector)) continue;
    for (const [, prop, value] of body!.matchAll(/([a-z-]+):\s*([^;]+);/g)) out[prop!] = value!.trim();
  }
  return out;
}

test("the ink, chip, connected-walk and two-phase /try pairings pass 4.5:1 (3:1 for the checks) in both themes, over the dot field", () => {
  const blockOf = (selector: string) => {
    const open = shellCss.indexOf("{", shellCss.indexOf(selector));
    return Object.fromEntries([...shellCss.slice(open + 1, shellCss.indexOf("}", open)).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const over = (c: { r: number; g: number; b: number; a: number }, under: Rgb): Rgb => [c.r, c.g, c.b].map((v, i) => Math.round(v * c.a + under[i]! * (1 - c.a))) as Rgb;
  const parse = (raw: string, under: Rgb): Rgb => {
    if (raw.startsWith("#")) return [1, 3, 5].map((i) => parseInt(raw.slice(i, i + 2), 16)) as Rgb;
    const m = raw.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([0-9.]+)\s*\)$/);
    assert.ok(m, `unsupported color: ${raw}`);
    return over({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) }, under);
  };
  const lum = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  const light = blockOf(':root[data-theme="light"] {');
  assert.deepEqual(blockOf(':root:not([data-theme="dark"]) {'), light, "no-JS light tokens stay in sync with [data-theme=light]");

  // The "Pulse already connected" walk (TIN-1072 turns it on): what each part paints, read from pages.css itself.
  const doneAll = [".try-step.done b", ".try-step.done p", ".try-step.done b::after", ".try-step.done .n", ".try-step.done .n::after"];
  for (const selector of doneAll) {
    assert.ok(Object.keys(declarationsOf(pagesCss, selector)).length > 0, `pages.css styles ${selector}`);
    assert.ok(!("opacity" in declarationsOf(pagesCss, selector)), `${selector} fades nothing: opacity is not composited by the contrast checks`);
  }
  const tokenOf = (value: string | undefined) => {
    const m = value?.match(/var\(--([a-z0-9-]+)\)/);
    assert.ok(m, `a solid token, got ${value}`);
    return m[1]!;
  };
  const colorOf = (selector: string) => tokenOf(declarationsOf(pagesCss, selector)["color"]);
  const bgOf = (selector: string) => tokenOf(declarationsOf(pagesCss, selector)["background"]);
  const titleToken = colorOf(".try-step.done b");
  const bodyToken = colorOf(".try-step.done p");
  const pillToken = colorOf(".try-step.done b::after");
  const checkToken = tokenOf(declarationsOf(pagesCss, ".try-step.done .n::after")["border"]);
  const discToken = bgOf(".try-step.done .n");
  const connCheckToken = tokenOf(declarationsOf(pagesCss, ".try-conn i::after")["border"]);
  const connDiscToken = bgOf(".try-conn i");
  const connTextToken = colorOf(".try-conn");
  const connPillBgToken = bgOf(".try-status .try-conn");
  const endCheckToken = tokenOf(declarationsOf(pagesCss, ".try-end i::after")["border"]);
  const endDiscToken = bgOf(".try-end i");
  const barLabelToken = tokenOf(declarationsOf(pagesCss, ".try-ex-bars text")["fill"]);
  const nextPillToken = colorOf(".try-step.next b::after");
  const nextPillBgToken = bgOf(".try-step.next b::after");
  const nextNumberToken = colorOf(".try-step.next .n");
  const nextNumberBgToken = bgOf(".try-step.next .n");
  const askToken = colorOf(".try-ask");
  const askBgToken = bgOf(".try-ask");
  const codeToken = colorOf(".build-code");
  const codeBgToken = bgOf(".build-code");
  const codeTitleToken = colorOf(".build-code h3");
  const codeBodyToken = colorOf(".build-code p");
  const codeIdxToken = colorOf(".build-code-idx");

  for (const [name, t] of [["dark", blockOf(":root {")], ["light", light]] as const) {
    const spec = DOT_FIELD_SPECS[name];
    const bg = parse(t["bg"]!, [0, 0, 0]);
    // The worst pixel the dot field can leave under text, built as landing.test.ts builds it.
    const onGlowMax = over(spec.glowMax, bg);
    const canvas: Rgb[] = [
      over(spec.dot, bg),
      over(spec.glowMin, bg),
      onGlowMax,
      over({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringAlphaMax }, bg),
      over({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringDotAlphaMax }, bg),
      over({ r: spec.tagRgb[0], g: spec.tagRgb[1], b: spec.tagRgb[2], a: spec.tagAlphaMax }, bg),
      over({ r: spec.tagRgb[0], g: spec.tagRgb[1], b: spec.tagRgb[2], a: spec.tagAlphaMax }, onGlowMax),
      over({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringAlphaMax }, onGlowMax),
    ];
    const worstCanvas = canvas.sort((a, b) => (name === "dark" ? lum(b) - lum(a) : lum(a) - lum(b)))[0]!;
    const field = parse(t["haze-b"]!, parse(t["haze-a"]!, worstCanvas));
    const card = parse(t["card"]!, field);
    const c = (token: string, under: Rgb = bg) => parse(t[token]!, under);

    const text: [string, Rgb, Rgb][] = [
      ["--ink-fg on --ink", c("ink-fg"), c("ink")],
      ["--ink-fg on --ink-bubble", c("ink-fg"), c("ink-bubble")],
      ["--paper on --ink", c("paper"), c("ink")],
      ["--ink-muted on --ink", c("ink-muted"), c("ink")],
      ["--ink-accent on --ink", c("ink-accent"), c("ink")],
      ["--muted on --chip", c("muted"), c("chip")],
      [`the ask bubble (${askToken} on ${askBgToken})`, c(askToken), c(askBgToken)],
      [`the payload card (${codeToken} on ${codeBgToken})`, c(codeToken), c(codeBgToken)],
      [`the payload card title (${codeTitleToken} on ${codeBgToken})`, c(codeTitleToken), c(codeBgToken)],
      [`the payload card text (${codeBodyToken} on ${codeBgToken})`, c(codeBodyToken), c(codeBgToken)],
      [`the payload card index (${codeIdxToken} on ${codeBgToken})`, c(codeIdxToken), c(codeBgToken)],
      // The done state, over the page and over the worst the dot field can paint.
      [`done step title (${titleToken}) on --bg`, c(titleToken), bg],
      [`done step title (${titleToken}) on the worst field`, c(titleToken), field],
      [`done step text (${bodyToken}) on --bg`, c(bodyToken), bg],
      [`done step text (${bodyToken}) on the worst field`, c(bodyToken), field],
      [`"done on the home page" pill (${pillToken}) on --bg`, c(pillToken), bg],
      [`"done on the home page" pill (${pillToken}) on the worst field`, c(pillToken), field],
      // The hero's connected pill keeps a solid surface: --ok as text over the bare field is 3.36:1 in light (TIN-1094).
      [`connected pill (${connTextToken} on ${connPillBgToken}) over the worst field`, c(connTextToken), c(connPillBgToken, field)],
      [`"start here" pill (${nextPillToken}) on ${nextPillBgToken} over the worst field`, c(nextPillToken), c(nextPillBgToken, field)],
      [`next step number (${nextNumberToken} on ${nextNumberBgToken})`, c(nextNumberToken), c(nextNumberBgToken)],
    ];
    // /try in two phases (TIN-1094): every text the page adds, its token read from pages.css, over each surface it sits
    // on. Phase 2's card is --card with --accent-soft fading over its top, so its text is held to both.
    const phase2 = parse(t["accent-soft"]!, card);
    const surfaces: Record<string, Rgb> = { "the worst field": field, "--card over the field": card, "--card-solid": c("card-solid"), "phase 2's top": phase2 };
    const onTry: [string, string[]][] = [
      [".try-status", ["the worst field"]],
      [".try-rail a", ["--card over the field"]],
      [".try-rail small", ["--card over the field"]],
      [".try-rail b", ["--card over the field"]],
      [".try-opt", ["--card over the field", "phase 2's top"]],
      [".try-phase-head p:not(.landing-who)", ["the worst field"]],
      [".try-step p", ["the worst field"]],
      [".try-step.done .try-conn-sentence", ["the worst field"]],
      [".try-host", ["the worst field", "--card-solid"]],
      [".try-ex-body", ["--card over the field"]],
      [".try-ex-body small", ["--card over the field"]],
      [".try-ex-body a", ["--card over the field"]],
      [".try-ex-row", ["--card-solid"]],
      [".try-ex-row b", ["--card-solid"]],
      [".try-ex-row .num", ["--card-solid"]],
      [".try-ex-bridge li", ["--card-solid"]],
      [".try-ex-bridge b", ["--card-solid"]],
      [".try-end", ["the worst field"]],
      [".try-end b", ["the worst field"]],
      [".try-more-head p:not(.landing-who)", ["--card over the field", "phase 2's top"]],
      [".try-app b", ["--card-solid"]],
      [".try-app > p", ["--card-solid"]],
      [".try-join-app", ["--card over the field", "phase 2's top"]],
      [".try-join-cap", ["--card over the field", "phase 2's top"]],
      [".try-move", ["--card over the field", "phase 2's top"]],
      [".try-move small", ["--card over the field", "phase 2's top"]],
      [".try-move a", ["--card over the field", "phase 2's top"]],
      [".try-aside", ["the worst field"]],
      [".try-aside b", ["the worst field"]],
    ];
    for (const [selector, on] of onTry) {
      const token = colorOf(selector);
      for (const surface of on) text.push([`${selector} (${token}) on ${surface}`, c(token, surfaces[surface]), surfaces[surface]!]);
    }
    text.push([`the bar's label (${barLabelToken}) on --tint over --card`, c(barLabelToken), parse(t["tint"]!, card)]);
    for (const [label, a, b] of text) assert.ok(contrast(a, b) >= 4.5, `${name}: ${label} is ${contrast(a, b).toFixed(2)}:1 (below 4.5:1)`);

    const graphics: [string, Rgb, Rgb][] = [
      [`done check (${checkToken} on ${discToken})`, c(checkToken), c(discToken)],
      [`connected check (${connCheckToken} on ${connDiscToken})`, c(connCheckToken), c(connDiscToken)],
      [`done disc (${discToken}) on --bg`, c(discToken), bg],
      [`phase 1's end check (${endCheckToken} on ${endDiscToken})`, c(endCheckToken), c(endDiscToken)],
    ];
    for (const [label, a, b] of graphics) assert.ok(contrast(a, b) >= 3, `${name}: ${label} is ${contrast(a, b).toFixed(2)}:1 (below 3:1)`);
  }
});
