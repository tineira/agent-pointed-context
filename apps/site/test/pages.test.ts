/**
 * /try and /build (TIN-627; one page each since the Dock left, TIN-1061; the new design, TIN-1068): the walk's
 * steps and links, the app cards and the starter question on /try; the numbered rows beside the real payload from
 * Pulse, the packages, the guide links and the open-list note on /build; no Dock and no Autio on either page; every
 * docs link names a page and a heading that exist; no footer repeats its page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { FOCUS_EXAMPLE } from "../src/web/landing-example.ts";
import { DOCK_PRODUCT, FOOTER_LINKS, footerLinks, MOVED_PAGES, SITE_PAGES, sitePageAt } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const tryPage = read("apps/site/src/web/try.tsx");
const build = read("apps/site/src/web/build.tsx");
const sitePages = read("apps/site/src/web/site-pages.ts");
const pagesCss = read("apps/site/src/web/styles/pages.css");
const worker = read("apps/site/src/worker/index.ts");

/** One page component's source, from its `export function` to the end of the file. */
const pageOf = (source: string, name: string) => {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("export function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

test("Try it walks Connect, Point, then Join, with each app on its own address and nothing to install", () => {
  assert.match(tryPage, /className="btn primary" href=\{PULSE_CONNECT\}>\s*Open Pulse and connect your agent/);
  assert.ok(tryPage.includes('const PULSE_CONNECT = PULSE.url.replace(/overview$/, "agents");'), "Pulse's Agents page");
  assert.ok(tryPage.includes("const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;"), "Signals' Connect panel");
  // Each card opens its app and connects an agent on that app's own page, and names the origin it lives on.
  assert.match(tryPage, /href=\{PULSE\.url\.replace\(\/overview\$\/, ""\)\}>\s*Open Pulse/);
  assert.match(tryPage, /href=\{PULSE_CONNECT\}>\s*Connect an agent/);
  assert.match(tryPage, /href=\{SIGNALS\.url\}>\s*Open Signals/);
  assert.match(tryPage, /href=\{SIGNALS_CONNECT\}>\s*Connect an agent/);
  assert.ok(tryPage.includes("const host = (url: string) => new URL(url).host;"), "the card names its app's origin");
  assert.match(tryPage, /\{host\(PULSE\.url\)\}/);
  assert.match(tryPage, /\{host\(SIGNALS\.url\)\}/);
  assert.doesNotMatch(tryPage, /Download|\.exe|window\.open|extension/i, "no downloads, no popup dock, no extension");
});

test("Try it's steps do not overlap, and only the starter question stands out", () => {
  const steps = [...tryPage.matchAll(/\{ title: "([^"]+)", text: "((?:[^"\\]|\\.)*)" \}/g)].map((m) => ({ title: m[1]!, text: m[2]! }));
  assert.deepEqual(steps.map((s) => s.title), ["Open Pulse", "Connect your agent", "Point and ask", "Add a second app"]);
  assert.match(steps[1]!.text, /MCP address/);
  assert.doesNotMatch(steps[1]!.text, /drop|drag/i, "step 2 connects; pointing is step 3");
  assert.match(steps[2]!.text, /^Drag your agent's mark from Pulse's agent bar/);
  assert.match(steps[3]!.text, /Signals' own address/);
  assert.equal(tryPage.match(/className="try-starter\b/g)?.length, 1);
  const starter = tryPage.slice(tryPage.indexOf('className="try-starter'), tryPage.indexOf('className="try-aside'));
  assert.match(starter, /href=\{TRY_POST\}>Tallyfin's offer to Team teams in North America</);
  assert.match(starter, /href=\{TRY_CUSTOMER\}>Deep Harbor Logistics</);
  assert.match(starter, /Which of our customers did this offer take\?/);
  assert.match(starter, /How do the two connect\?/);
  assert.match(tryPage.slice(tryPage.indexOf('className="try-aside')), /Cut it off any time\./);
  assert.match(tryPage.slice(tryPage.indexOf('className="try-aside')), /keeps the other/);
  assert.match(pagesCss, /\.try-starter\s*\{[^}]*border:\s*1px solid var\(--accent-line\)/);
  assert.match(pagesCss, /\.try-aside\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.match(pagesCss, /\.try-ask\s*\{[^}]*background:\s*var\(--ink-bubble\);[^}]*color:\s*var\(--ink-fg\)/);
});

test("/try leaves room for the connected walk, but ships no state of its own", () => {
  // TIN-1072 fills the "Pulse already connected" state from Pulse; until then the page always shows the walk above.
  assert.doesNotMatch(tryPage, /sessionStorage|localStorage|fetch\(|useState|useEffect/, "no stored or simulated connection");
  for (const room of [".try-step.done", ".try-step.next", ".try-app.on", ".try-conn"]) {
    assert.ok(pagesCss.includes(room), `pages.css keeps room for ${room}`);
  }
  assert.match(pagesCss, /TIN-1072/);
  assert.match(tryPage, /TIN-1072/);
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
  // /try links none of the footer's: it gets it whole.
  assert.doesNotMatch(tryPage, /\{PAPER\}|\{RECORDS\}|href=\{`\$\{DOCS\}\/spec`\}|href="\/v1/, "TryPage links a footer link itself");
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
