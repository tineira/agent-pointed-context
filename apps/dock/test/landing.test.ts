/**
 * The site (TIN-620, TIN-627): the landing at / says what APC is and plays a silent loop of the drag, self-hosted,
 * then offers one decision, Try it or Build it, each its own page. /try opens the dock once and links each demo
 * app; /build chooses between Direct and Dock, with a strip for shipping both; each profile page and /build/both
 * show real focus payloads and real code; every docs link names a page and a heading that exist; the old anchors
 * land on the new pages; no footer repeats its page.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { resolveFocus, type Grant } from "../../demo/src/worker/domain.ts";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { clipFallback } from "../src/web/clip-fallback.ts";
import { DOCK_FOCUS_EXAMPLE, FOCUS_EXAMPLE } from "../src/web/landing-example.ts";
import { FOOTER_LINKS, footerLinks, legacyAnchor, SITE_PAGES, sitePageAt } from "../src/web/site-pages.ts";
import { hubFocus } from "../src/worker/logic.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landing = read("apps/dock/src/web/landing.tsx");
const tryPage = read("apps/dock/src/web/try.tsx");
const build = read("apps/dock/src/web/build.tsx");
const site = read("apps/dock/src/web/site.tsx");
const sitePages = read("apps/dock/src/web/site-pages.ts");
const main = read("apps/dock/src/web/main.tsx");
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
  const sizes = ["apc-hero.webm", "apc-hero.mp4", "apc-hero-poster.jpg"].map((f) => statSync(new URL(`apps/dock/public/media/${f}`, root)).size);
  for (const size of sizes.slice(0, 2)) assert.ok(size < 1.5 * 1024 * 1024, `a clip is ${size} bytes, over 1.5 MB`);
  assert.ok(sizes[2]! < 200 * 1024, "the poster stays small");
  for (const path of ["/media/apc-hero.webm", "/media/apc-hero.mp4", "/media/apc-hero-poster.jpg"]) assert.ok(landing.includes(path), path);
  // The MP4 has one track, the video: no audio from the promo's licensed music or voice.
  const mp4 = readFileSync(new URL("apps/dock/public/media/apc-hero.mp4", root));
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
  const css = read("apps/dock/src/web/dock.css");
  assert.doesNotMatch(css.match(/^\.landing-stage-toggle \{[^}]*\}/m)![0], /opacity: 0;/, "the button is always visible");
});

test("the orange buttons and links pass 4.5:1 in both themes", () => {
  const css = read("apps/dock/src/web/dock.css");
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
});

test("each page has its path, a trailing slash allowed, and its own title", () => {
  for (const [page, { path }] of Object.entries(SITE_PAGES)) {
    assert.equal(sitePageAt(path), page);
    if (path !== "/") assert.equal(sitePageAt(`${path}/`), page);
    if (path !== "/") assert.equal(sitePageAt(`${path}//`), page);
  }
  for (const other of ["/dock", "/dock/agents/ag_1", "/docs", "/extension", "/builder", "/build/other", "/try/x"]) assert.equal(sitePageAt(other), null, other);
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

test("the top bar leads to the new pages from everywhere, and keeps Your dock, Docs and GitHub", () => {
  assert.match(site, /\{hasDock && <a href=\{DOCK\}>Your dock<\/a>\}/);
  assert.match(site, /href=\{SITE_PAGES\.try\.path\}[^>]*>Try it</);
  assert.match(site, /href=\{SITE_PAGES\.build\.path\}[^>]*>Build it</);
  assert.match(site, /href=\{DOCS\}>Docs</);
  assert.match(site, /href=\{REPO\}>GitHub</);
  for (const [file, source] of [["landing", landing], ["try", tryPage], ["build", build]] as const) {
    const pages = source.match(/<SiteHeader page="[a-z-]+" \/>/g) ?? [];
    assert.ok(pages.length >= 1, `${file} has the top bar`);
    assert.equal(pages.length, (source.match(/<SiteFooter/g) ?? []).length, `${file}: every page has its footer`);
  }
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
  for (const [name, source] of [["Landing", landing], ["TryPage", tryPage], ["BuildDirectPage", build], ["BuildDockPage", build], ["BuildBothPage", build]] as const) {
    const body = name === "Landing" || name === "TryPage" ? source : pageOf(source, name);
    assert.doesNotMatch(body, /\{PAPER\}|\{RECORDS\}|href=\{`\$\{DOCS\}\/spec`\}|href="\/v1/, `${name} links a footer link itself`);
  }
});

test("Try it opens the dock once and links each demo app; the dock does not launch them", () => {
  assert.equal(tryPage.match(/Open your dock/g)?.length, 1, "only the button says it; the step and the top bar say \"Your dock\"");
  assert.equal(tryPage.match(/<Cta \/>/g)?.length, 1, "one button");
  assert.match(tryPage, /href=\{PULSE\.url/);
  assert.match(tryPage, /href=\{SIGNALS\.url\}/);
  assert.match(tryPage, /Download for \{d\.label\}/);
  assert.match(tryPage, /href="\/extension"/);
  assert.match(tryPage, /href=\{DIRECT_TRY\}/, "Direct, as a note");
  assert.doesNotMatch(tryPage, /dock opens Pulse|checklist opens|Open them from your dock|sets up the same world/i, "the dock no longer launches the demo apps (TIN-621)");
});

test("Try it's steps do not overlap, and only the starter question stands out", () => {
  const steps = [...tryPage.matchAll(/\{ title: "([^"]+)", text: "((?:[^"\\]|\\.)*)" \}/g)].map((m) => ({ title: m[1]!, text: m[2]! }));
  assert.deepEqual(steps.map((s) => s.title), ["Your dock", "Connect your agent", "Open Pulse or Signals", "Point and ask"]);
  assert.match(steps[2]!.text, /allow it/);
  assert.doesNotMatch(steps[2]!.text, /drop|drag/i, "step 3 opens an app and allows the agent; pointing is step 4");
  assert.match(steps[3]!.text, /^Drag your agent/);
  // The starter question is the one highlighted block; the extension and Direct are quieter asides.
  assert.equal(tryPage.match(/className="landing-starter"/g)?.length, 1);
  assert.doesNotMatch(tryPage, /landing-note/);
  const starter = tryPage.slice(tryPage.indexOf('className="landing-starter"'), tryPage.indexOf('className="landing-asides"'));
  assert.match(starter, /href=\{TRY_POST\}>Tallyfin's offer to Team teams in North America</);
  assert.match(starter, /href=\{TRY_CUSTOMER\}>Deep Harbor Logistics</);
  const asides = tryPage.slice(tryPage.indexOf('className="landing-asides"'));
  assert.match(asides, /browser extension/);
  assert.match(asides, /DIRECT_TRY/);
  const css = read("apps/dock/src/web/dock.css");
  assert.match(css, /^\.landing-starter \{[^}]*border: 2px solid var\(--accent\)/m);
  assert.match(css, /^\.landing-asides p \{[^}]*font-size: 13px; color: var\(--muted\)/m);
});

test("/build: Direct and Dock as two equal cards, each to its page, and a strip (not a card) for both", () => {
  const page = pageOf(build, "BuildPage");
  assert.match(page, /New to APC\? <a href=\{SITE_PAGES\.try\.path\}>Try the demo first →<\/a>/);
  assert.match(page, /\(\["direct", "dock"\] as const\)\.map/, "one component draws both cards");
  for (const key of ["direct", "dock"]) {
    const block = build.slice(build.indexOf(`  ${key}: {\n    page:`), build.indexOf("},\n", build.indexOf(`  ${key}: {\n    page:`)));
    for (const field of ["users:", "pros:", "cons:"]) assert.ok(block.includes(field), `${key} has ${field}`);
  }
  assert.match(page, /href=\{SITE_PAGES\[p\.page\]\.path\}>Build \{p\.name\} →/);
  assert.match(build, /page: "build-direct" as SitePage/);
  assert.match(build, /page: "build-dock" as SitePage/);
  assert.match(page, /<a className="landing-both" href=\{SITE_PAGES\["build-both"\]\.path\}>/);
  assert.match(build, /Let each person choose: Direct for whoever uses only your app, Dock for whoever uses several\. The same agent on both paths shows as one\./);
  assert.doesNotMatch(page, /<Code|<Steps|FOCUS_EXAMPLE|apc_link|APC_PROFILES/, "no implementation detail on /build");
  // Direct has no dock: its mark lives in the app's page.
  assert.match(build, /There is no dock: their agent's mark lives in your page/);
});

test("/build groups the references: Start here, Deep dive, Code", () => {
  const groups = [...build.matchAll(/title: "(Start here|Deep dive|Code)",\s*refs: \[([^]*?)\],\n  \}/g)].map((m) => ({ title: m[1]!, refs: [...m[2]!.matchAll(/title: "([^"]+)"/g)].map((r) => r[1]) }));
  assert.deepEqual(groups, [
    { title: "Start here", refs: ["Integration guide", "Docs"] },
    { title: "Deep dive", refs: ["Spec", "Payload specification", "Design record", "Paper"] },
    { title: "Code", refs: ["GitHub"] },
  ]);
  assert.match(build, /MIT/);
  for (const ref of ["https://doi.org/10.5281/zenodo.23382909", "https://doi.org/10.5281/zenodo.23383101", "blob/main/DESIGN.md", "https://github.com/tineira/agent-pointed-context"]) assert.ok(sitePages.includes(ref), ref);
});

test("each profile page has the core, its own part, a real payload, its references, and ends on Ship both", () => {
  for (const [name, other] of [["BuildDirectPage", "Dock"], ["BuildDockPage", "Direct"]] as const) {
    const page = pageOf(build, name);
    assert.match(page, /<Section title="What every app implements">\s*<Steps steps=\{CORE_STEPS\} \/>/);
    assert.match(page, /<Section title="What (Direct|Dock) adds">/);
    assert.match(page, /\{json\(FOCUS_EXAMPLE\)\}/);
    assert.match(page, /<Refs refs=\{PROFILE_REFS\.(direct|dock)\} \/>/);
    assert.match(page, new RegExp(`<ShipBothNext other="${other}" />\\s*<SiteFooter />`), `${name} ends with Ship both`);
  }
  assert.match(pageOf(build, "BuildDockPage"), /\{json\(DOCK_FOCUS_EXAMPLE\)\}/);
  for (const core of ["MCP endpoint", "data-focus", "apc.json", "@tineira/apc-conformance"]) assert.ok(build.slice(build.indexOf("const CORE_STEPS"), build.indexOf("const PROFILES")).includes(core), core);
});

test("the payloads are Pulse's real output for the March bar, and the hub's real rewrite of it", () => {
  const grant: Grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, pinned_at: FOCUS_EXAMPLE.pinned_at, seen_at: null };
  assert.deepEqual(resolveFocus(pin, grant, generateDataset(7), "https://pulse.apc.tineira.com"), FOCUS_EXAMPLE);
  // Pulse is verified on apc.tineira.com (APP_ORIGINS), so nothing marks it untrusted; its id is "pulse".
  assert.deepEqual(hubFocus(FOCUS_EXAMPLE, { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" }), DOCK_FOCUS_EXAMPLE);
  assert.equal(hubFocus(FOCUS_EXAMPLE, { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" }, true).next, "pulse__get_figure", "the prefixed name the page mentions");
  assert.match(read("apps/dock/wrangler.jsonc"), /"APP_ORIGINS": "https:\/\/pulse\.apc\.tineira\.com,/);
});

test("/build/both: the profiles, apc_link, the bar and the dock hint, in code the repo runs", () => {
  const page = pageOf(build, "BuildBothPage");
  for (const title of ["Declare both profiles", "One agent on both paths: apc_link", "The linked agent in the agent bar", "Offer the dock to Direct users (optional)", "Test it"]) assert.ok(page.includes(`<Section title="${title}">`), title);
  // Every line of code shown is a line of the integration guide's Orders, or of Signals.
  const orders = read("apps/dock/src/docs/examples/orders-app.ts");
  const signals = read("apps/signals/src/worker/index.ts") + read("apps/signals/wrangler.jsonc");
  const snippet = (name: string) => {
    const m = build.match(new RegExp(`export const ${name} = \`([^\`]*)\`;`));
    assert.ok(m, name);
    return m[1]!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  };
  for (const line of snippet("LINK_SNIPPET")) assert.ok(orders.includes(line), `not in orders-app.ts: ${line}`);
  for (const line of snippet("PROFILES_SNIPPET")) assert.ok(signals.includes(line.replace(/^"vars": \{ /, "").replace(/ \}$/, "")), `not in Signals: ${line}`);
  // The bar's words and switches are the package's own.
  const bar = read("packages/web/src/agents-bar.ts");
  const words = read("packages/web/src/strings.ts");
  assert.ok(words.includes('dockHint: "Use this agent across apps with the dock"') && page.includes('"Use this agent across apps with the dock"'));
  assert.ok(bar.includes('"dock-hint") === "off"') && page.includes('dock-hint="off"'));
  assert.ok(words.includes('pathBoth: "direct + dock"') && page.includes("direct + dock"));
  assert.ok(read("apps/dock/src/docs/examples/orders-page.ts").includes('"apc-unlink"') && page.includes("apc-unlink"));
  const server = read("packages/server/src/direct.ts");
  assert.match(server, /export function parseProfiles\(/);
  assert.match(server, /Unset or blank means both/);
});

test("the docs links name pages and headings that exist", () => {
  const ids = new Map(DOC_PAGES.map((p) => [p.path, new Set(headingIds(parseMarkdown(read(p.file))))]));
  const links = [...[landing, tryPage, build, site, sitePages].join("\n").matchAll(/\$\{DOCS\}(\/[a-z]+)?(#[a-z0-9_-]+)?/g)];
  assert.ok(links.length >= 10);
  for (const [, page = "", hash] of links) {
    const path = `/docs${page}`;
    assert.ok(ids.has(path), `${path} is not a docs page`);
    if (hash) assert.ok(ids.get(path)!.has(hash.slice(1)), `${path}${hash} is not a heading`);
  }
});
