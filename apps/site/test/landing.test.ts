/**
 * The site (TIN-620, TIN-627; after the Dock left, TIN-1061): the landing at / says what APC is and plays a silent
 * loop of the drag, self-hosted, then offers one decision, Try it or Build it, each its own page. /try connects the
 * person's agent to each demo app on its own address, with no dock; /build is one page with a real focus payload;
 * the Dock is named once, as a separate product; every docs link names a page and a heading that exist; the old
 * anchors and the old /build pages land on the new pages; no footer repeats its page.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { clipFallback } from "../src/web/clip-fallback.ts";
import { DOCK_PRODUCT, FOOTER_LINKS, footerLinks, legacyAnchor, MOVED_PAGES, SITE_PAGES, sitePageAt } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landing = read("apps/site/src/web/landing.tsx");
const tryPage = read("apps/site/src/web/try.tsx");
const build = read("apps/site/src/web/build.tsx");
const site = read("apps/site/src/web/site.tsx");
const sitePages = read("apps/site/src/web/site-pages.ts");
const main = read("apps/site/src/web/main.tsx");
const worker = read("apps/site/src/worker/index.ts");
/** One page component's source, from its `export function` to the next one. */
const pageOf = (source: string, name: string) => {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("export function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};
const video = landing.slice(landing.indexOf("<video"), landing.indexOf("</video>"));

test("the hero says what APC is, plays the clip, and links the full video", () => {
  assert.match(landing, /<h1>Point your AI agent at what you see<\/h1>/);
  assert.match(landing, /Drag your agent onto a chart, a row or a paragraph and ask about "this"\. It reads the data underneath, through access it already has\. No screen sharing\./);
  assert.match(video, /^<video\s[^]*?\sautoPlay\s+muted\s+loop\s+playsInline\s/, "a muted loop, inline");
  assert.doesNotMatch(video, /\bcontrols\b/, "no player controls");
  assert.match(landing, /href=\{VIDEO\}/);
  assert.match(sitePages, /const VIDEO = "https:\/\/youtu\.be\/pb46Sd0UOtM"/);
  assert.doesNotMatch(landing, /youtube\.com\/embed|youtube-nocookie|<iframe/, "no YouTube embed: its cookies would break the one-cookie promise");
  for (const agent of ["Claude", "ChatGPT", "Cursor", "Grok"]) assert.match(landing, new RegExp(`name: "${agent}"`));
  assert.match(landing, /any agent that takes an MCP server/);
});

test("the clip is small, silent where it can be checked, and its poster stands in under reduced motion", () => {
  const sizes = ["apc-hero.webm", "apc-hero.mp4", "apc-hero-poster.jpg"].map((f) => statSync(new URL(`apps/site/public/media/${f}`, root)).size);
  for (const size of sizes.slice(0, 2)) assert.ok(size < 1.5 * 1024 * 1024, `a clip is ${size} bytes, over 1.5 MB`);
  assert.ok(sizes[2]! < 200 * 1024, "the poster stays small");
  for (const path of ["/media/apc-hero.webm", "/media/apc-hero.mp4", "/media/apc-hero-poster.jpg"]) assert.ok(landing.includes(path), path);
  // The MP4 has one track, the video: no audio from the promo's licensed music or voice.
  const mp4 = readFileSync(new URL("apps/site/public/media/apc-hero.mp4", root));
  assert.equal(mp4.toString("latin1").split("trak").length - 1, 1, "the MP4 has exactly one track");
  assert.ok(!mp4.includes("soun"), "the MP4 has no sound track");
  assert.match(landing, /prefers-reduced-motion: reduce/);
  assert.match(landing, /reduce \|\| failed \? \(\s*<img src=\{CLIP\.poster\}/, "under reduced motion (or with no playable clip) the poster replaces the video");
});

test("a clip that fails falls back: a failed WebM to the MP4, and no playable clip to the poster", () => {
  // <source> errors do not bubble to the video: the browser moves on to the next source, and only the last one failing means no clip.
  assert.equal(clipFallback({ on: "source", last: false }), "wait");
  assert.equal(clipFallback({ on: "source", last: true }), "poster");
  // A file that loads but cannot be decoded fires on the video.
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.webm" }), "mp4");
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.webm?v=2" }), "mp4");
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.mp4" }), "poster");
  assert.equal(clipFallback({ on: "video", currentSrc: "" }), "poster");
  // And the page wires every one of them: both sources and the video.
  assert.match(video, /<source src=\{CLIP\.webm\} type="video\/webm" onError=\{\(\) => fallBack\(\{ on: "source", last: false \}\)\} \/>/);
  assert.match(video, /<source src=\{CLIP\.mp4\} type="video\/mp4" onError=\{\(\) => fallBack\(\{ on: "source", last: true \}\)\} \/>/);
  // React bubbles a source's error to the video's onError: the video acts on its own errors only.
  assert.match(video, /onError=\{\(e\) => e\.target === e\.currentTarget && fallBack\(\{ on: "video", currentSrc: e\.currentTarget\.currentSrc \}\)\}/);
});

test("the clip's button follows the video and says what it does", () => {
  assert.match(video, /onPlay=\{\(\) => setPaused\(false\)\}/);
  assert.match(video, /onPause=\{\(\) => setPaused\(true\)\}/);
  assert.match(landing, /\{paused \? "Play animation" : "Pause animation"\}/);
  assert.doesNotMatch(landing, /aria-pressed/, "a label that changes, so no pressed state");
  const css = read("apps/site/src/web/site.css");
  assert.doesNotMatch(css.match(/^\.landing-stage-toggle \{[^}]*\}/m)![0], /opacity: 0;/, "the button is always visible");
});

test("the orange buttons and links pass 4.5:1 in both themes", () => {
  const css = read("apps/site/src/web/site.css");
  const tokens = (line: string) => Object.fromEntries([...line.matchAll(/--([a-z]+): (#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const light = tokens(css.split("\n")[0]!);
  const dark = tokens(css.split("\n").find((l) => l.startsWith("@media (prefers-color-scheme: dark)"))!);
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  assert.match(css, /^\.landing-cta \{[^}]*background: var\(--accent\); color: var\(--card\);/m, "the button's ink is the card colour, not white");
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    assert.ok(contrast(t.card!, t.accent!) >= 4.5, `${name}: button text ${contrast(t.card!, t.accent!).toFixed(2)}:1`);
    for (const bg of ["bg", "card"]) assert.ok(contrast(t.accent!, t[bg]!) >= 4.5, `${name}: an orange link on --${bg} is ${contrast(t.accent!, t[bg]!).toFixed(2)}:1`);
  }
});

test("the landing offers one decision: Try it or Build it, each its own page", () => {
  assert.match(landing, /For people using an AI agent<\/span>\s*<h3>Try it<\/h3>/);
  assert.match(landing, /For people building an app<\/span>\s*<h3>Build it<\/h3>/);
  assert.match(landing, /href=\{SITE_PAGES\.try\.path\}>Try the demo →</);
  assert.match(landing, /href=\{SITE_PAGES\.build\.path\}>Add APC to your app →</);
  assert.equal(SITE_PAGES.try.path, "/try");
  assert.equal(SITE_PAGES.build.path, "/build");
  // Nothing else: no steps, no payload, no references, no anchors.
  assert.doesNotMatch(landing, /<section id=|href="#|<Steps|FOCUS_EXAMPLE|Open your dock|landing-refs/);
  assert.ok(landing.indexOf("landing-paths") < landing.lastIndexOf("What your agent can and cannot see"), "what the agent can see closes the page");
  assert.equal(landing.match(/<li>/g)?.length, 5, "the agents' \"any agent\" line and the four lines of what the agent can see");
  assert.match(landing, /<h2 className="landing-title">How it works<\/h2>/);
});

test("each page has its path, a trailing slash allowed, and its own title", () => {
  for (const [page, { path }] of Object.entries(SITE_PAGES)) {
    assert.equal(sitePageAt(path), page);
    if (path !== "/") assert.equal(sitePageAt(`${path}/`), page);
    if (path !== "/") assert.equal(sitePageAt(`${path}//`), page);
  }
  for (const other of ["/dock", "/docs", "/extension", "/builder", "/build/other", "/build/direct", "/build/dock", "/build/both", "/try/x"]) assert.equal(sitePageAt(other), null, other);
  assert.equal(new Set(Object.values(SITE_PAGES).map((p) => p.title)).size, Object.keys(SITE_PAGES).length, "no two pages share a title");
  for (const page of Object.keys(SITE_PAGES)) assert.match(main, new RegExp(`"?${page}"?: [A-Z][A-Za-z]+,`), `main.tsx renders ${page}`);
});

test("the old anchors land on the new pages", () => {
  assert.equal(legacyAnchor("/", "#try"), "/try");
  assert.equal(legacyAnchor("/", "#build"), "/build");
  assert.equal(legacyAnchor("/", ""), null);
  assert.equal(legacyAnchor("/", "#other"), null);
  assert.equal(legacyAnchor("/docs", "#try"), null, "only the landing had those sections");
  assert.match(main, /const moved = legacyAnchor\(path, location\.hash\);\s*if \(moved\) location\.replace\(moved\);/);
});

test("the top bar leads to the pages from everywhere: Try it, Build it, Docs and GitHub, and nothing of the Dock", () => {
  assert.match(site, /href=\{SITE_PAGES\.try\.path\}[^>]*>Try it</);
  assert.match(site, /href=\{SITE_PAGES\.build\.path\}[^>]*>Build it</);
  assert.match(site, /href=\{DOCS\}>Docs</);
  assert.match(site, /href=\{REPO\}>GitHub</);
  assert.doesNotMatch(site, /Your dock|\/api\/|fetch\(/, "the site asks no server about the visitor");
  for (const [file, source] of [["landing", landing], ["try", tryPage], ["build", build]] as const) {
    const pages = source.match(/<SiteHeader page="[a-z-]+" \/>/g) ?? [];
    assert.equal(pages.length, 1, `${file} has the top bar`);
    assert.equal(pages.length, (source.match(/<SiteFooter/g) ?? []).length, `${file}: every page has its footer`);
  }
});

test("neither the Dock nor Autio is named on the landing, /try or /build, and nothing of the Dock is in the navigation", () => {
  assert.equal(DOCK_PRODUCT, null);
  assert.equal(build.match(/DOCK_PRODUCT\.url/g)?.length, 1);
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "")
      .replace(/\{DOCK_PRODUCT && <>[\s\S]*?<\/>\}/g, "");
  for (const [name, source] of [["landing.tsx", landing], ["try.tsx", tryPage], ["build.tsx", build]] as const) {
    assert.doesNotMatch(stripComments(source), /\b(Autio|Dock)\b/i, `${name} names Autio or Dock outside comments`);
  }
  for (const source of [landing, tryPage, build, site]) assert.doesNotMatch(source, /href="\/dock|href="\/extension|DOCK_DESKTOP|Dock for Windows|Pulse for Windows/);
});

test("the old /build pages answer a permanent redirect to /build, keeping the query", () => {
  assert.deepEqual(Object.keys(MOVED_PAGES).sort(), ["/build/both", "/build/direct", "/build/dock"]);
  for (const to of Object.values(MOVED_PAGES)) assert.equal(sitePageAt(to), "build");
  assert.ok(worker.includes('const to = MOVED_PAGES[url.pathname.replace(/\\/+$/, "")];'));
  assert.ok(worker.includes("c.redirect(`${to}${url.search}`, 301)"));
});

test("no footer repeats a link of its page", () => {
  // The top bar has Docs and GitHub on every page, so the footer never does.
  for (const l of FOOTER_LINKS as readonly { label: string; href: string }[]) assert.ok(l.href !== "/docs" && !l.href.startsWith("https://github.com"), l.label);
  assert.deepEqual(footerLinks(["/docs/spec", "https://doi.org/10.5281/zenodo.23382909"]).map((l) => l.href), ["https://doi.org/10.5281/zenodo.23383101", "/v1/"]);
  // /build has the references, so its footer keeps only what they lack: Version 1.
  assert.match(pageOf(build, "BuildPage"), /<SiteFooter onPage=\{BUILD_LINKS\} \/>/);
  assert.match(build, /const BUILD_LINKS = REF_GROUPS\.flatMap\(\(g\) => g\.refs\.map\(\(r\) => r\.href\)\);/);
  assert.match(sitePages, /href: V1 \}/);
  assert.match(sitePages, /export const V1 = "\/v1\/";/);
  assert.match(sitePages, /label: "Version 1, as described in the paper →"/);
  // Every other page links none of the footer's: they get it whole.
  for (const [name, source] of [["Landing", landing], ["TryPage", tryPage]] as const) {
    const body = source;
    assert.doesNotMatch(body, /\{PAPER\}|\{RECORDS\}|href=\{`\$\{DOCS\}\/spec`\}|href="\/v1/, `${name} links a footer link itself`);
  }
});

test("Try it connects the agent to each demo app on its own address, with nothing to install", () => {
  assert.equal(tryPage.match(/className="landing-cta big"/g)?.length, 1, "one button");
  assert.match(tryPage, /href=\{PULSE_CONNECT\}>Open Pulse and connect your agent</);
  assert.ok(tryPage.includes('const PULSE_CONNECT = PULSE.url.replace(/overview$/, "agents");'), "Pulse's Agents page");
  assert.ok(tryPage.includes("const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;"), "Signals' Connect panel");
  assert.match(tryPage, /href=\{SIGNALS_CONNECT\}>Connect an agent</);
  assert.match(tryPage, /href=\{PULSE\.url/);
  assert.match(tryPage, /href=\{SIGNALS\.url\}/);
  assert.doesNotMatch(tryPage, /Download|\.exe|window\.open|extension/i, "no downloads, no popup dock, no extension");
});

test("Try it's steps do not overlap, and only the starter question stands out", () => {
  const steps = [...tryPage.matchAll(/\{ title: "([^"]+)", text: "((?:[^"\\]|\\.)*)" \}/g)].map((m) => ({ title: m[1]!, text: m[2]! }));
  assert.deepEqual(steps.map((s) => s.title), ["Open Pulse", "Connect your agent", "Point and ask", "Add a second app"]);
  assert.match(steps[1]!.text, /MCP address/);
  assert.doesNotMatch(steps[1]!.text, /drop|drag/i, "step 2 connects; pointing is step 3");
  assert.match(steps[2]!.text, /^Drag your agent's mark from Pulse's agent bar/);
  assert.match(steps[3]!.text, /Signals' own address/);
  assert.equal(tryPage.match(/className="landing-starter"/g)?.length, 1);
  assert.doesNotMatch(tryPage, /landing-note/);
  const starter = tryPage.slice(tryPage.indexOf('className="landing-starter"'), tryPage.indexOf('className="landing-asides"'));
  assert.match(starter, /href=\{TRY_POST\}>Tallyfin's offer to Team teams in North America</);
  assert.match(starter, /href=\{TRY_CUSTOMER\}>Deep Harbor Logistics</);
  assert.match(tryPage.slice(tryPage.indexOf('className="landing-asides"')), /Revoke/);
  const css = read("apps/site/src/web/site.css");
  assert.match(css, /^\.landing-starter \{[^}]*border: 2px solid var\(--accent\)/m);
  assert.match(css, /^\.landing-asides p \{[^}]*font-size: 13px; color: var\(--muted\)/m);
});

test("/build is one page: the core, how agents connect, a real payload, other profiles, the references", () => {
  const page = pageOf(build, "BuildPage");
  assert.match(page, /New to APC\? <a href=\{SITE_PAGES\.try\.path\}>Try the demo first →<\/a>/);
  const sections = [...page.matchAll(/<Section title="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["What every app implements", "How agents connect", "What the agent receives", "Other profiles"]);
  assert.match(page, /<Section title="What every app implements">\s*<Steps steps=\{CORE_STEPS\} \/>/);
  assert.match(page, /\{json\(FOCUS_EXAMPLE\)\}/);
  for (const core of ["MCP endpoint", "data-focus", "apc.json", "@tineira/apc-conformance"]) assert.ok(build.slice(build.indexOf("const CORE_STEPS"), build.indexOf("const REF_GROUPS")).includes(core), core);
  for (const part of ["newDirectGrant", "&lt;apc-direct-agents&gt;", "&lt;apc-agents&gt;", "direct.connect"]) assert.ok(page.includes(part), part);
  assert.doesNotMatch(build, /apc_link|DOCK_FOCUS_EXAMPLE|call_app_tool|requestConnect|ShipBoth|build-both/, "nothing of the Dock's profile");
});

test("/build groups the references: Start here, Deep dive, Code", () => {
  const groups = [...build.matchAll(/title: "(Start here|Deep dive|Code)",\s*refs: \[([^]*?)\],\n  \}/g)].map((m) => ({ title: m[1]!, refs: [...m[2]!.matchAll(/title: "([^"]+)"/g)].map((r) => r[1]) }));
  assert.deepEqual(groups, [
    { title: "Start here", refs: ["Integration guide", "Conformance suite", "Docs"] },
    { title: "Deep dive", refs: ["Spec", "Payload specification", "Design record", "Paper"] },
    { title: "Code", refs: ["GitHub"] },
  ]);
  assert.match(build, /MIT/);
  for (const ref of ["https://doi.org/10.5281/zenodo.23382909", "https://doi.org/10.5281/zenodo.23383101", "blob/main/DESIGN.md", "https://github.com/tineira/agent-pointed-context"]) assert.ok(sitePages.includes(ref), ref);
});

test("the docs links name pages and headings that exist", () => {
  const ids = new Map(DOC_PAGES.map((p) => [p.path, new Set(headingIds(parseMarkdown(read(p.file))))]));
  const links = [...[landing, tryPage, build, site, sitePages].join("\n").matchAll(/\$\{DOCS\}(\/[a-z]+)?(#[a-z0-9_-]+)?/g)];
  assert.ok(links.length >= 5);
  for (const [, page = "", hash] of links) {
    const path = `/docs${page}`;
    assert.ok(ids.has(path), `${path} is not a docs page`);
    if (hash) assert.ok(ids.get(path)!.has(hash.slice(1)), `${path}${hash} is not a heading`);
  }
});
