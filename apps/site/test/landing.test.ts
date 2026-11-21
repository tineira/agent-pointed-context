/**
 * The site (TIN-620, TIN-627; after the Dock left, TIN-1061; shell redesign, TIN-1064): the landing at / says what
 * APC is and plays a silent loop of the drag (inside HeroStage), self-hosted, then offers one decision, Try it or
 * Build it, each its own page. /try connects the person's agent to each demo app on its own address, with no dock;
 * /build is one page with a real focus payload; the Dock is named once, as a separate product; every docs link
 * names a page and a heading that exist; the old anchors and the old /build pages land on the new pages; no footer
 * repeats its page; both light and dark themes pass 4.5:1 contrast for text, links, and buttons.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { clipFallback } from "../src/web/clip-fallback.ts";
import { DOT_FIELD_SPECS, type RgbaColor } from "../src/web/dot-field.ts";
import { DOCK_PRODUCT, FOOTER_LINKS, footerLinks, legacyAnchor, MOVED_PAGES, SITE_PAGES, sitePageAt } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landingRoot = read("apps/site/src/web/landing.tsx");
const heroSection = read("apps/site/src/web/landing/HeroSection.tsx");
const heroStage = read("apps/site/src/web/landing/HeroStage.tsx");
const worksWith = read("apps/site/src/web/landing/WorksWithSection.tsx");
const pathsSection = read("apps/site/src/web/landing/PathsSection.tsx");
const howSection = read("apps/site/src/web/landing/HowItWorksSection.tsx");
const accessSection = read("apps/site/src/web/landing/AccessSection.tsx");
const landing = [landingRoot, heroSection, heroStage, worksWith, pathsSection, howSection, accessSection].join("\n");
const tryPage = read("apps/site/src/web/try.tsx");
const build = read("apps/site/src/web/build.tsx");
const site = read("apps/site/src/web/site.tsx");
const sitePages = read("apps/site/src/web/site-pages.ts");
const main = read("apps/site/src/web/main.tsx");
const worker = read("apps/site/src/worker/index.ts");
const shellCss = read("apps/site/src/web/styles/shell.css");
const landingCss = read("apps/site/src/web/styles/landing.css");
const pagesCss = read("apps/site/src/web/styles/pages.css");
const docsCss = read("apps/site/src/web/styles/docs.css");

/** One page component's source, from its `export function` to the next one. */
const pageOf = (source: string, name: string) => {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("export function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};
const video = heroStage.slice(heroStage.indexOf("<video"), heroStage.indexOf("</video>"));

test("the hero says what APC is, plays the clip, and links the full video", () => {
  assert.match(heroSection, /<h1>Point your AI agent at what you see<\/h1>/);
  assert.match(heroSection, /Drag your agent onto a chart, a row or a paragraph and ask about "this"\. It reads the data underneath, through access it already has\. No screen sharing\./);
  assert.match(heroSection, /<HeroStage \/>/);
  assert.match(video, /^<video\s[^]*?\sautoPlay\s+muted\s+loop\s+playsInline\s/, "a muted loop, inline");
  assert.doesNotMatch(video, /\bcontrols\b/, "no player controls");
  assert.match(heroSection, /href=\{VIDEO\}/);
  assert.match(sitePages, /const VIDEO = "https:\/\/youtu\.be\/pb46Sd0UOtM"/);
  assert.doesNotMatch(landing, /youtube\.com\/embed|youtube-nocookie|<iframe/, "no YouTube embed: its cookies would break the one-cookie promise");
  for (const agent of ["Claude", "ChatGPT", "Cursor", "Grok"]) assert.match(worksWith, new RegExp(`name: "${agent}"`));
  assert.match(worksWith, /any agent that takes an MCP server/);
});

test("the clip is small, silent where it can be checked, and its poster stands in under reduced motion", () => {
  const sizes = ["apc-hero.webm", "apc-hero.mp4", "apc-hero-poster.jpg"].map((f) => statSync(new URL(`apps/site/public/media/${f}`, root)).size);
  for (const size of sizes.slice(0, 2)) assert.ok(size < 1.5 * 1024 * 1024, `a clip is ${size} bytes, over 1.5 MB`);
  assert.ok(sizes[2]! < 200 * 1024, "the poster stays small");
  for (const path of ["/media/apc-hero.webm", "/media/apc-hero.mp4", "/media/apc-hero-poster.jpg"]) assert.ok(heroStage.includes(path), path);
  // The MP4 has one track, the video: no audio from the promo's licensed music or voice.
  const mp4 = readFileSync(new URL("apps/site/public/media/apc-hero.mp4", root));
  assert.equal(mp4.toString("latin1").split("trak").length - 1, 1, "the MP4 has exactly one track");
  assert.ok(!mp4.includes("soun"), "the MP4 has no sound track");
  assert.match(heroStage, /prefers-reduced-motion: reduce/);
  assert.match(heroStage, /reduce \|\| failed \? \(\s*<img src=\{CLIP\.poster\}/, "under reduced motion (or with no playable clip) the poster replaces the video");
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
  assert.match(heroStage, /\{paused \? "Play animation" : "Pause animation"\}/);
  assert.doesNotMatch(heroStage, /aria-pressed/, "a label that changes, so no pressed state");
  const toggleRule = landingCss.match(/^\.landing-stage-toggle \{[^}]*\}/m);
  assert.ok(toggleRule, "landing-stage-toggle rule exists");
  assert.doesNotMatch(toggleRule[0], /opacity:\s*0[;}]/, "the button is always visible");
});

test("text, links and buttons pass 4.5:1 contrast over solid bg, worst-case dot field + haze, and translucent surfaces in both themes", () => {
  type Rgb = [number, number, number];
  const parseBlock = (selector: string) => {
    const start = shellCss.indexOf(selector);
    assert.ok(start >= 0, `missing block ${selector}`);
    const open = shellCss.indexOf("{", start);
    const close = shellCss.indexOf("}", open);
    const body = shellCss.slice(open + 1, close);
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const compositeRgba = (fg: RgbaColor, under: Rgb): Rgb =>
    [fg.r, fg.g, fg.b].map((c, i) => Math.round(c * fg.a + under[i]! * (1 - fg.a))) as Rgb;
  const parseColor = (raw: string, under: Rgb): Rgb => {
    if (raw.startsWith("#")) {
      const hex = raw.length === 4 ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}` : raw;
      return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
    }
    const m = raw.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([0-9.]+)\s*\)$/);
    assert.ok(m, `unsupported color format: ${raw}`);
    return compositeRgba({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) }, under);
  };
  const lum = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  assert.match(shellCss, /\.btn\.primary\s*\{[^}]*background:\s*var\(--btn\);[^}]*color:\s*var\(--btn-fg\);/, "primary buttons use --btn / --btn-fg");
  assert.match(landingCss, /\.landing-cta\s*\{[^}]*background:\s*var\(--btn\);[^}]*color:\s*var\(--btn-fg\);/, "landing CTA buttons use --btn / --btn-fg");
  assert.match(shellCss, /^a\s*\{[^}]*color:\s*var\(--accent-text\);/m, "links use --accent-text");

  // --dim is reserved for surface-backed chrome (nav badge, footer), never bare over the moving field.
  for (const [sheetName, css] of [["landing.css", landingCss], ["pages.css", pagesCss], ["docs.css", docsCss]] as const) {
    assert.doesNotMatch(css, /var\(--dim\)/, `${sheetName} does not place --dim directly over the backdrop`);
  }

  const dark = parseBlock(":root {");
  const light = parseBlock(':root[data-theme="light"] {');
  const lightNoJs = parseBlock(':root:not([data-theme="dark"]) {');
  assert.deepEqual(lightNoJs, light, "no-JS prefers-color-scheme light tokens stay in sync with [data-theme=light]");

  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    const isDark = name === "dark";
    const bg = parseColor(t["bg"]!, [0, 0, 0]);
    const spec = DOT_FIELD_SPECS[name];

    // Worst-case pixel the canvas can paint over --bg, using the exact DOT_FIELD_SPECS constants
    // that dot-field.ts renders with: base dot, glow range, gutter ring/dot/tag, and tag or ring
    // crossing a peak-glow dot.
    const onGlowMax = compositeRgba(spec.glowMax, bg);
    const canvasCandidates: [string, Rgb][] = [
      ["base dot", compositeRgba(spec.dot, bg)],
      ["glowMin", compositeRgba(spec.glowMin, bg)],
      ["glowMax", onGlowMax],
      ["gutter ring", compositeRgba({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringAlphaMax }, bg)],
      ["gutter ringDot", compositeRgba({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringDotAlphaMax }, bg)],
      ["gutter tag", compositeRgba({ r: spec.tagRgb[0], g: spec.tagRgb[1], b: spec.tagRgb[2], a: spec.tagAlphaMax }, bg)],
      ["gutter tag over glowMax", compositeRgba({ r: spec.tagRgb[0], g: spec.tagRgb[1], b: spec.tagRgb[2], a: spec.tagAlphaMax }, onGlowMax)],
      ["gutter ring over glowMax", compositeRgba({ r: spec.ringRgb[0], g: spec.ringRgb[1], b: spec.ringRgb[2], a: spec.ringAlphaMax }, onGlowMax)],
    ];
    canvasCandidates.sort((a, b) => (isDark ? lum(b[1]) - lum(a[1]) : lum(a[1]) - lum(b[1])));
    const [worstCanvasLabel, worstCanvas] = canvasCandidates[0]!;

    // Stack both CSS haze layers over the worst canvas pixel to get the worst-case backdrop pixel.
    const hazeAOnly = parseColor(t["haze-a"]!, bg);
    const hazeBOnly = parseColor(t["haze-b"]!, bg);
    const glowPlusHazeA = parseColor(t["haze-a"]!, onGlowMax);
    const glowPlusHazeB = parseColor(t["haze-b"]!, glowPlusHazeA);
    const worstField = parseColor(t["haze-b"]!, parseColor(t["haze-a"]!, worstCanvas));

    // Every translucent surface composited over the worst-case backdrop (canvas + haze).
    const card = parseColor(t["card"]!, worstField);
    const foot = parseColor(t["foot"]!, worstField);
    const nav = parseColor(t["nav"]!, worstField);
    const navTint = parseColor(t["tint"]!, nav);
    const tint = parseColor(t["tint"]!, worstField);
    const tint2 = parseColor(t["tint2"]!, worstField);
    const chip = parseColor(t["chip"]!, worstField);
    const band = parseColor(t["band"]!, worstField);
    const codeBgOnField = parseColor(t["code-bg"]!, worstField);
    const codeBgOnCard = parseColor(t["code-bg"]!, card);

    const fg = parseColor(t["fg"]!, bg);
    const muted = parseColor(t["muted"]!, bg);
    const dim = parseColor(t["dim"]!, bg);
    const accentText = parseColor(t["accent-text"]!, bg);
    const btnBg = parseColor(t["btn"]!, bg);
    const btnFg = parseColor(t["btn-fg"]!, bg);
    const codeFg = parseColor(t["code-fg"]!, bg);
    const bandFg = parseColor(t["band-fg"]!, band);
    const bandMuted = parseColor(t["band-muted"]!, band);
    const bandAccent = parseColor(t["band-accent"]!, band);

    const pairs: [string, Rgb, Rgb][] = [
      ["text (--fg) on --bg", fg, bg],
      ["text (--fg) on glowMax", fg, onGlowMax],
      [`text (--fg) on worst field (${worstCanvasLabel} + haze)`, fg, worstField],
      ["text (--fg) on --card over worst field", fg, card],
      ["text (--fg) on --nav over worst field", fg, nav],
      ["text (--fg) on --chip", fg, chip],
      ["muted text (--muted) on --bg", muted, bg],
      ["muted text (--muted) on --haze-a", muted, hazeAOnly],
      ["muted text (--muted) on --haze-b", muted, hazeBOnly],
      ["muted text (--muted) on glowMax", muted, onGlowMax],
      ["muted text (--muted) on glowMax + haze", muted, glowPlusHazeB],
      [`muted text (--muted) on worst field (${worstCanvasLabel} + haze)`, muted, worstField],
      ["muted text (--muted) on --card over worst field", muted, card],
      ["muted text (--muted) on --foot over worst field", muted, foot],
      ["muted text (--muted) on --nav over worst field", muted, nav],
      ["theme toggle (--muted) on --tint over --nav", muted, navTint],
      ["dim text (--dim) on solid --bg", dim, bg],
      ["dim text (--dim) on --card over worst field", dim, card],
      ["dim text (--dim) on --nav over worst field", dim, nav],
      ["dim text (--dim) on --foot over worst field", dim, foot],
      ["link (--accent-text) on --bg", accentText, bg],
      ["link (--accent-text) on glowMax", accentText, onGlowMax],
      [`link (--accent-text) on worst field (${worstCanvasLabel} + haze)`, accentText, worstField],
      ["link (--accent-text) on --card over worst field", accentText, card],
      ["link (--accent-text) on --foot over worst field", accentText, foot],
      ["link (--accent-text) on --chip", accentText, chip],
      ["primary button (--btn-fg on --btn)", btnFg, btnBg],
      ["ghost button (--fg on --tint over worst field)", fg, tint],
      ["ghost button hover (--fg on --tint2 over worst field)", fg, tint2],
      ["inline code (--code-fg on --code-bg over worst field)", codeFg, codeBgOnField],
      ["inline code (--code-fg on --code-bg over --card)", codeFg, codeBgOnCard],
      ["band text (--band-fg on --band)", bandFg, band],
      ["band muted (--band-muted on --band)", bandMuted, band],
      ["band accent (--band-accent on --band)", bandAccent, band],
    ];
    for (const [label, a, b] of pairs) {
      const ratio = contrast(a, b);
      assert.ok(ratio >= 4.5, `${name}: ${label} is ${ratio.toFixed(2)}:1 (below 4.5:1)`);
    }
  }
});

test("the landing offers one decision: Try it or Build it, each its own page, and splits into per-section files", () => {
  assert.match(pathsSection, /For people using an AI agent<\/span>\s*<h3>Try it<\/h3>/);
  assert.match(pathsSection, /For people building an app<\/span>\s*<h3>Build it<\/h3>/);
  assert.match(pathsSection, /href=\{SITE_PAGES\.try\.path\}>Try the demo →</);
  assert.match(pathsSection, /href=\{SITE_PAGES\.build\.path\}>Add APC to your app →</);
  assert.equal(SITE_PAGES.try.path, "/try");
  assert.equal(SITE_PAGES.build.path, "/build");
  // Nothing else: no steps, no payload, no references, no anchors.
  assert.doesNotMatch(landing, /<section id=|href="#|<Steps|FOCUS_EXAMPLE|Open your dock|landing-refs/);
  assert.ok(landingRoot.indexOf("<PathsSection />") < landingRoot.indexOf("<AccessSection />"), "what the agent can see closes the page");
  assert.equal(landing.match(/<li>/g)?.length, 5, "the agents' \"any agent\" line and the four lines of what the agent can see");
  assert.match(howSection, /<h2 className="landing-title">How it works<\/h2>/);
  assert.match(accessSection, /<h2 className="landing-title">What your agent can and cannot see<\/h2>/);
  // Split stylesheets imported in main.tsx
  for (const sheet of ["shell.css", "landing.css", "pages.css", "docs.css"]) {
    assert.match(main, new RegExp(`import "./styles/${sheet.replace(".", "\\.")}";`), `main.tsx imports ${sheet}`);
  }
  assert.ok(docsCss.includes(".docs-body h2"));
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

test("the top bar leads to the pages from everywhere: Try it, Build it, Docs, Spec, GitHub and the theme toggle, and nothing of the Dock", () => {
  assert.match(site, /href=\{SITE_PAGES\.try\.path\}[^>]*>Try it</);
  assert.match(site, /href=\{SITE_PAGES\.build\.path\}[^>]*>Build it</);
  assert.match(site, /href=\{DOCS\}>Docs</);
  assert.match(site, /href=\{`\$\{DOCS\}\/spec`\}>Spec</);
  assert.match(site, /href=\{REPO\}[^>]*>\s*GitHub/);
  assert.match(site, /className="site-theme-toggle"/);
  assert.doesNotMatch(site, /Your dock|\/api\/|fetch\(/, "the site asks no server about the visitor");
  for (const [file, source] of [["landing", landingRoot], ["try", tryPage], ["build", build]] as const) {
    const pages = source.match(/<SiteHeader page="[a-z-]+" \/>/g) ?? [];
    assert.equal(pages.length, 1, `${file} has the top bar`);
    assert.equal(pages.length, (source.match(/<SiteFooter/g) ?? []).length, `${file}: every page has its footer`);
    assert.equal(pages.length, (source.match(/<SiteBackdrop \/>/g) ?? []).length, `${file}: every page has the dot-field backdrop`);
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
  for (const [name, source] of [["landing", landing], ["try.tsx", tryPage], ["build.tsx", build]] as const) {
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
    assert.doesNotMatch(source, /\{PAPER\}|\{RECORDS\}|href=\{`\$\{DOCS\}\/spec`\}|href="\/v1/, `${name} links a footer link itself`);
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
  assert.equal(tryPage.match(/className="landing-starter\b/g)?.length, 1);
  assert.doesNotMatch(tryPage, /landing-note/);
  const starter = tryPage.slice(tryPage.indexOf('className="landing-starter'), tryPage.indexOf('className="landing-asides'));
  assert.match(starter, /href=\{TRY_POST\}>Tallyfin's offer to Team teams in North America</);
  assert.match(starter, /href=\{TRY_CUSTOMER\}>Deep Harbor Logistics</);
  assert.match(tryPage.slice(tryPage.indexOf('className="landing-asides')), /Revoke/);
  assert.match(pagesCss, /\.landing-starter\s*\{[^}]*border:\s*2px solid var\(--accent\)/);
  assert.match(pagesCss, /\.landing-asides p\s*\{[^}]*color:\s*var\(--muted\)/);
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
