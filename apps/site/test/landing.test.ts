/**
 * The site (TIN-620, TIN-627; after the Dock left, TIN-1061; shell redesign, TIN-1064; the landing's sections,
 * TIN-1067). The landing at / runs, in this order: the hero (its copy beside HeroStage), Works with, the two paths,
 * Inside a point, Your agent. Your permission., Free, open and versioned, the closing call, then the footer. Every
 * link it has goes to a page, a docs page or a record that exists; it names neither the Dock nor Autio and states
 * nothing it cannot prove; its styles stay under .landing-home, so /try and /build (pages.test.ts) never pick them up.
 * Every docs link names a page and a heading that exist; the old anchors land on the new pages; the landing's footer
 * leaves out what it links; both themes pass 4.5:1 for text, links and buttons.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { APC_STANDARD_VERSION } from "@tineira/apc-protocol";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { DOT_FIELD_SPECS, type RgbaColor } from "../src/web/dot-field.ts";
import { DOCK_PRODUCT, DOCS, footerLinks, legacyAnchor, PAPER, RECORDS, REPO, SITE_PAGES, sitePageAt, VIDEO } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landingRoot = read("apps/site/src/web/landing.tsx");
const sectionOf = (name: string) => read(`apps/site/src/web/landing/${name}.tsx`);
const heroSection = sectionOf("HeroSection");
const worksWith = sectionOf("WorksWithSection");
const pathsSection = sectionOf("PathsSection");
const howSection = sectionOf("HowItWorksSection");
const accessSection = sectionOf("AccessSection");
const standardSection = sectionOf("StandardSection");
const closingSection = sectionOf("ClosingSection");
/** Every file of the landing: its root, each section and whatever the hero stage keeps under landing/hero/. */
const landingFiles = (dir: string): string[] =>
  readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? landingFiles(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) ? [`${dir}${e.name}`] : []));
const landing = [landingRoot, ...landingFiles("apps/site/src/web/landing/").map(read)].join("\n");
/** The sections this step owns: everything on the landing but the hero's stage. */
const sections = [landingRoot, heroSection, worksWith, pathsSection, howSection, accessSection, standardSection, closingSection].join("\n");
const tryPage = read("apps/site/src/web/try.tsx");
const build = read("apps/site/src/web/build.tsx");
const site = read("apps/site/src/web/site.tsx");
const sitePages = read("apps/site/src/web/site-pages.ts");
const demoApps = read("apps/site/src/web/demo-apps.tsx");
const main = read("apps/site/src/web/main.tsx");
const shellCss = read("apps/site/src/web/styles/shell.css");
const landingCss = read("apps/site/src/web/styles/landing.css");
const pagesCss = read("apps/site/src/web/styles/pages.css");
const docsCss = read("apps/site/src/web/styles/docs.css");

/** JSX text with its line breaks and indentation folded to single spaces. */
const flat = (source: string) => source.replace(/\s+/g, " ");

test("the landing runs its sections in order, then the footer", () => {
  const order = [...landingRoot.slice(landingRoot.indexOf("<main"), landingRoot.indexOf("</main>")).matchAll(/<([A-Z][A-Za-z]+) \/>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["HeroSection", "WorksWithSection", "PathsSection", "HowItWorksSection", "AccessSection", "StandardSection", "ClosingSection"]);
  assert.ok(landingRoot.indexOf("</main>") < landingRoot.indexOf("<SiteFooter"), "the footer follows the closing call");
  assert.match(landingRoot, /<main className="landing landing-home">/);
  // Each section says what it is, in the order the page shows it.
  const headings: [string, string, RegExp][] = [
    ["hero", heroSection, /<p className="landing-eyebrow landing-dot">An open standard, built on MCP<\/p>/],
    ["works with", worksWith, /<p className="landing-works-lab">Works with<\/p>/],
    ["paths", pathsSection, /<h2>Try it<\/h2>[^]*<h2>Build it<\/h2>/],
    ["inside a point", howSection, /<p className="landing-idx">How it works<\/p>\s*<h2>\s*Inside a point<span className="landing-dotc">\.<\/span>/],
    ["access", accessSection, /<h2>\s*Your agent\.\s*<br \/>\s*Your <em>permission\.<\/em>/],
    ["standard", standardSection, /<h2>\s*Free, open and versioned<span className="landing-dotc">\.<\/span>/],
    ["closing", closingSection, /<h2>Point it at something\.<\/h2>/],
  ];
  for (const [name, source, pattern] of headings) assert.match(source, pattern, name);
});

test("the hero says what APC is, offers the two ways in, and links the full video, never embeds it", () => {
  assert.match(flat(heroSection), /<h1> Point your AI agent at <em>what you see\.<\/em> <\/h1>/);
  assert.match(heroSection, /Drag your agent onto a chart, a row or a paragraph and ask about "this"\. It reads the data underneath, through access it already has\. <b>No screen sharing\.<\/b>/);
  assert.match(flat(heroSection), /<a className="btn primary" href=\{SITE_PAGES\.try\.path\}> Try the demo <span className="landing-arr" aria-hidden="true">→<\/span> <\/a>/);
  assert.match(heroSection, /<a className="btn ghost" href=\{SITE_PAGES\.build\.path\}>Add APC to your app<\/a>/);
  assert.match(heroSection, /<a className="landing-watch" href=\{VIDEO\} target="_blank" rel="noopener">/);
  assert.match(flat(heroSection), /<span aria-hidden="true">▶<\/span> Watch the full video/);
  assert.equal(VIDEO, "https://youtu.be/pb46Sd0UOtM");
  assert.doesNotMatch(landing, /youtube\.com\/embed|youtube-nocookie/, "no YouTube embed: its cookies would break the one-cookie promise");
  // One frame on the landing (TIN-1071): Pulse's hero view, mounted by "Use your own agent" only, and sandboxed.
  assert.doesNotMatch(landing, /<iframe|createElement\("frame"|createElement\("embed"|createElement\("object"/, "no frame in JSX: the hero's one frame is built in hero/live.ts");
  const frames = [...landing.matchAll(/h\("iframe", \{([^}]*)\}\)/g)].map((m) => m[1]!);
  assert.equal(frames.length, 1, "exactly one frame, Pulse's hero");
  assert.match(frames[0]!, /src: PULSE_HERO,/);
  assert.match(frames[0]!, /sandbox: FRAME_SANDBOX,/);
  assert.match(frames[0]!, /allow: FRAME_ALLOW,/);
  assert.match(landing, /export const FRAME_SANDBOX = "allow-scripts allow-same-origin";/);
  assert.match(landing, /export const FRAME_ALLOW = "clipboard-write";/);
  assert.match(read("apps/site/src/web/pulse-status.ts"), /export const PULSE_HERO = `\$\{PULSE_ORIGIN\}\/embed\/hero`;/);
  assert.match(read("apps/site/src/pulse-origin.ts"), /export const PULSE_ORIGIN = "https:\/\/pulse\.apc\.tineira\.com";/);
  // Click-gated: the frame is PulseFrame's, which HeroSwitch renders only when live, and live starts false.
  assert.match(landing, /props\.live \? h\(PulseFrame, \{ onBack: props\.onBack \}\) : h\(Fragment, null, props\.demo\)/);
  assert.match(landing, /const \[live, setLive\] = useState\(false\);/);
  // The stage is its own step's: the hero only places it.
  assert.match(heroSection, /<div className="landing-hero-stage">\s*<HeroStage \/>\s*<\/div>/);
});

test("Works with names Claude, ChatGPT, Cursor and Grok by their logos, and any remote MCP agent", () => {
  const agents = [...worksWith.matchAll(/\{ brand: "([a-z]+)", name: "([^"]+)" \}/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(agents, [["claude", "Claude"], ["openai", "ChatGPT"], ["cursor", "Cursor"], ["grok", "Grok"]]);
  const brands = read("apps/site/src/web/agent-brands.ts");
  for (const [brand] of agents) assert.match(brands, new RegExp(`^\\s+${brand}: mark\\(PATHS\\.${brand},`, "m"), `${brand} has a vector logo in agent-logos.ts`);
  assert.match(worksWith, /<AgentIcon clientName=\{null\} brandId=\{a\.brand\} size=\{23\} \/>/);
  assert.match(worksWith, /<span aria-hidden="true">\s*<AgentIcon/, "the name says it; the logo is not read twice");
  assert.match(worksWith, /<p className="landing-compat">and any agent that accepts a remote MCP server<\/p>/);
});

test("the two paths: Try it with Pulse and Signals, Build it with the four packages, each one link", () => {
  assert.match(pathsSection, /For people using an AI agent<\/p>\s*<h2>Try it<\/h2>/);
  assert.match(pathsSection, /For people building an app<\/p>\s*<h2>Build it<\/h2>/);
  assert.match(flat(pathsSection), /<a className="landing-go" href=\{SITE_PAGES\.try\.path\}> Try the demo <span aria-hidden="true">→<\/span> <\/a>/);
  assert.match(flat(pathsSection), /<a className="landing-go" href=\{SITE_PAGES\.build\.path\}> Add APC to your app <span aria-hidden="true">→<\/span> <\/a>/);
  assert.equal(pathsSection.match(/<a /g)?.length, 2, "one link per card");
  // Try it shows the two demo apps by their own glyphs and names.
  assert.match(pathsSection, /\{APPS\.map\(\(app\) =>/);
  assert.deepEqual([...demoApps.matchAll(/^\s+name: "([A-Za-z]+)",/gm)].map((m) => m[1]), ["Pulse", "Signals"]);
  // Build it shows the four packages, each one that exists in packages/.
  const packages = JSON.parse(pathsSection.match(/const PACKAGES = (\[[^\]]+\]);/)![1]!) as string[];
  const real = readdirSync(new URL("packages/", root)).map((dir) => (JSON.parse(read(`packages/${dir}/package.json`)) as { name: string }).name);
  assert.deepEqual([...packages].sort(), [...real].sort());
  // The card is the link's target; the link keeps a short name.
  assert.match(landingCss, /\.landing-go::after \{[^}]*position: absolute;[^}]*inset: 0;/);
  assert.equal(SITE_PAGES.try.path, "/try");
  assert.equal(SITE_PAGES.build.path, "/build");
});

test("Inside a point: View, Pin and Presence, each a small SVG diagram and a sentence or two", () => {
  const articles = howSection.split("<article>").slice(1);
  assert.deepEqual(articles.map((a) => a.match(/<h3>([^<]+)<\/h3>/)?.[1]), ["View", "Pin", "Presence"]);
  for (const a of articles) {
    assert.match(a, /^\s*<svg className="landing-dg" viewBox="0 0 150 90" aria-hidden="true">/, "each starts with its diagram, hidden from readers");
    const text = a.match(/<p>([^<]+)<\/p>/)?.[1] ?? "";
    const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `one or two sentences: ${text}`);
  }
  assert.doesNotMatch(howSection, /<img|<canvas|<video|\.png|\.jpg|\.webm/, "CSS and SVG only");
  assert.match(howSection, /Three channels connect what you see to what your agent can read\./);
});

test("Your agent. Your permission.: three rows, the item you point at, one connection per app, revoke in the app", () => {
  const rows = [...accessSection.matchAll(/\{ title: "([^"]+)", text: "([^"]+)" \}/g)].map((m) => ({ title: m[1]!, text: m[2]! }));
  assert.deepEqual(rows.map((r) => r.title), ["Only the item you point at", "One connection per app", "Revoke in the app"]);
  assert.match(rows[0]!.text, /identifiers/);
  assert.match(rows[1]!.text, /MCP address/);
  assert.match(rows[2]!.text, /at once/);
  // The band is dark in both themes: its text uses the band's own tokens.
  assert.match(landingCss, /\.landing-home \.landing-access \{[^}]*background: var\(--band\);[^}]*color: var\(--band-fg\);/);
  assert.match(landingCss, /\.landing-home \.landing-access h2,\s*\.landing-home \.landing-access h3 \{\s*color: var\(--band-fg\);/);
  assert.match(landingCss, /\.landing-home \.landing-access p \{[^}]*color: var\(--band-muted\);/);
});

test("Free, open and versioned states the licences, the records and the spec, and nothing it cannot prove", () => {
  assert.match(standardSection, /Its code is MIT, its docs and spec are CC BY 4.0/);
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE-spec"), /CC BY 4\.0/);
  const cards = [...standardSection.matchAll(/\{ title: "([^"]+)", text: "[^"]+", note: "([^"]+)", href: ([^,]+), external: (true|false) \}/g)].map((m) => ({ title: m[1], note: m[2], href: m[3], external: m[4] === "true" }));
  assert.deepEqual(cards, [
    { title: "The spec", note: "Spec and docs: CC BY 4.0", href: "`${DOCS}/spec`", external: false },
    { title: "The code", note: "Code: MIT", href: "REPO", external: true },
    { title: "The paper", note: "doi:10.5281/zenodo.23382909", href: "PAPER", external: true },
    { title: "Payload specification", note: "doi:10.5281/zenodo.23383101", href: "RECORDS", external: true },
  ]);
  assert.equal(PAPER, "https://doi.org/10.5281/zenodo.23382909");
  assert.equal(RECORDS, "https://doi.org/10.5281/zenodo.23383101");
  // The version is read from the protocol package at build time, never typed in.
  assert.match(standardSection, /^import \{ APC_STANDARD_VERSION \} from "@tineira\/apc-protocol";/m);
  assert.match(standardSection, /Standard version \{APC_STANDARD_VERSION\}/);
  assert.match(APC_STANDARD_VERSION, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(sections, new RegExp(APC_STANDARD_VERSION.replace(/\./g, "\\.")), "no version number typed into the landing");
  // No stars, no adopters, no counts: no number on the sections but the two DOIs and the frozen 1.0.
  const copy = sections.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  assert.doesNotMatch(copy, /\bstars?\b|\badopt|\bcompanies\b|\bteams use\b|\bdownloads\b|\btrusted by\b/i);
  const text = [...[...flat(copy).matchAll(/>([^<{}]+)</g)].map((m) => m[1]!), ...[...copy.matchAll(/(?:title|text|note|name): "([^"]+)"/g)].map((m) => m[1]!)].join(" ");
  const numbers = new Set([...text.replace(/doi:10\.5281\/zenodo\.2338(2909|3101)/g, "").matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]));
  assert.deepEqual([...numbers].sort(), ["1.0", "4.0"], "the only numbers in the copy are CC BY 4.0 and the frozen 1.0 contract");
});

/** landing.css's selectors, one per comma, outside comments and keyframes (inside @media too). */
const cssSelectors = (css: string) =>
  [...css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "")
    .matchAll(/([^{};]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => !s.startsWith("@"))
    .flatMap((s) => s.split(",").map((x) => x.trim()));

test("the landing's styles stay under .landing-home: /try and /build pick up none of them", () => {
  // Every class /try and /build render, with the components they import (pages.test.ts covers those pages).
  const pageSources = ["try.tsx", "build.tsx", "site.tsx", "demo-apps.tsx", "agent-mark.tsx", "agent-icon.tsx"].map((f) => read(`apps/site/src/web/${f}`));
  const pageClasses = new Set(
    pageSources.flatMap((src) => [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})|const cls = `([^`]+)`/g)].flatMap((m) => (m[1] ?? m[2] ?? m[3]!).replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean))),
  );
  assert.ok(pageClasses.has("landing") && pageClasses.has("landing-who"), "the class scan reads /try's and /build's markup");
  assert.ok(!pageClasses.has("landing-home"), "/try and /build never carry the landing's scope");
  // What landing.css shares with the other pages on purpose (their main, the "who" line). The stage's rules are in hero.css (TIN-1066).
  const shared = [
    "main.landing", ".landing p", ".landing-who", ".landing-eyebrow",
    ".landing-cta", ".landing-cta.big", ".landing-cta.ghost", ".landing-cta:hover", ".landing-cta.ghost:hover",
    ".landing section[id]", ".landing .landing-title",
  ];
  const selectors = cssSelectors(landingCss);
  assert.ok(selectors.length > 100, "the selector scan reads landing.css");
  for (const selector of selectors) {
    if (selector.startsWith(".landing-home ") || selector === "main.landing.landing-home") continue;
    assert.ok(shared.includes(selector), `${selector} is not under .landing-home`);
    // A compound whose every class /try or /build render would match there: only the shared two may.
    for (const compound of selector.split(/[\s>+~]+/)) {
      const classes = [...compound.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
      if (classes.length > 0 && classes.every((c) => pageClasses.has(c))) assert.ok(classes.every((c) => ["landing", "landing-who"].includes(c)), `${selector} matches what /try or /build render`);
    }
  }
});

test("the path cards keep their paragraph readable at every width: chips beside it only where the card is wide", () => {
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf("}", at));
  };
  const px = (body: string, prop: string) => Number(body.match(new RegExp(`${prop}: (\\d+)px`))![1]);
  // Below the wide breakpoint the chips are a row under the paragraph, never absolute.
  assert.doesNotMatch(rule(landingCss, ".landing-home .landing-path-art"), /position: absolute/);
  const wideAt = landingCss.indexOf("@media (min-width: 1340px) {");
  assert.ok(wideAt >= 0, "the wide layout has its breakpoint");
  const wide = landingCss.slice(wideAt, landingCss.indexOf("\n}\n", wideAt));
  assert.match(rule(wide, "  .landing-home .landing-path-art"), /position: absolute;/);
  assert.equal(landingCss.match(/position: absolute;\s*right: 30px;\s*top: 30px;/g)?.length, 1, "nowhere else");
  // The arithmetic, from the CSS: .wrap is min(1240px, 100% - 80px); two cards and their gap; the card's padding.
  assert.match(shellCss, /\.wrap \{\s*width: min\(1240px, 100% - 80px\);/);
  const gap = px(rule(landingCss, ".landing-home .landing-paths"), "gap");
  const card = rule(landingCss, ".landing-home .landing-path");
  const [, padX] = card.match(/padding: \d+px (\d+)px \d+px;/)!.map(Number);
  const reserve = Number(wide.match(/max-width: min\(25em, 100% - (\d+)px\);/)![1]);
  const content = (viewport: number, scrollbar: number) => (Math.min(1240, viewport - scrollbar - 80) - gap) / 2 - 2 * padX!;
  // Two columns from 861 px: stacked, the paragraph takes the card's whole content width.
  for (let w = 861; w < 1340; w += 1) assert.ok(content(w, 17) >= 300, `${w}px: the paragraph gets ${content(w, 17)}px`);
  // Wide, beside the chips: near 20em of the paragraph's 17px, even with a 17px scrollbar.
  for (const w of [1340, 1440, 1920]) assert.ok(content(w, 17) - reserve >= 19 * 17, `${w}px: the paragraph gets ${content(w, 17) - reserve}px beside the chips`);
});

test("the closing call offers the same two ways in as the hero", () => {
  assert.match(flat(closingSection), /<a className="btn primary" href=\{SITE_PAGES\.try\.path\}> Try the demo <span className="landing-arr" aria-hidden="true">→<\/span> <\/a>/);
  assert.match(closingSection, /<a className="btn ghost" href=\{SITE_PAGES\.build\.path\}>Add APC to your app<\/a>/);
  assert.match(closingSection, /Two demo apps, made-up data, no account\./);
});

test("every link on the landing goes somewhere that exists", () => {
  // Every href is an expression this test can resolve: no bare anchors, no typed-in URLs.
  const hrefs = [...sections.matchAll(/href=(\{[^}]+\}|"[^"]*")/g)].map((m) => m[1]!);
  const resolve: Record<string, string[]> = {
    "{SITE_PAGES.try.path}": [SITE_PAGES.try.path],
    "{SITE_PAGES.build.path}": [SITE_PAGES.build.path],
    "{VIDEO}": [VIDEO],
    // The standard's cards, each checked above against site-pages.ts.
    "{c.href}": [`${DOCS}/spec`, REPO, PAPER, RECORDS],
  };
  for (const href of hrefs) assert.ok(resolve[href], `unexpected link target ${href}`);
  const targets = hrefs.flatMap((h) => resolve[h]!);
  const docs = new Set(DOC_PAGES.map((p) => p.path));
  const external = new Set([VIDEO, REPO, PAPER, RECORDS]);
  for (const to of targets) {
    if (to.startsWith("/")) assert.ok(sitePageAt(to) !== null || docs.has(to), `${to} is neither a site page nor a docs page`);
    else assert.ok(external.has(to) && to.startsWith("https://"), `${to} is not one of the site's known records`);
  }
  assert.ok(targets.includes("/docs/spec"), "the spec is linked at /docs/spec");
  assert.match(REPO, /^https:\/\/github\.com\/tineira\/agent-pointed-context$/);
  // Off-site links open apart and keep the opener out.
  for (const m of sections.matchAll(/target="_blank"( rel="noopener")?/g)) assert.ok(m[1], "target=_blank carries rel=noopener");
  assert.match(standardSection, /\{\.\.\.\(c\.external \? \{ target: "_blank", rel: "noopener" \} : \{\}\)\}/);
  // The strict CSP allows no inline style: nothing on the landing sets one.
  assert.doesNotMatch(landing, /\sstyle=\{|\sstyle="/);
});

test("every animation on the landing's sections has a still state under reduced motion", () => {
  const still = landingCss.slice(landingCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(landingCss, /animation: landing-ring/);
  assert.match(still, /\.landing-dg \.d-ring \{\s*opacity: 0\.5;/, "the presence ring stands still, half lit");
  assert.match(still, /\.landing-channels article::before \{\s*transform: none;/, "the channel lines are drawn");
  // And the shell stops every animation and transition there (shell.css).
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\) \{[^]*animation: none !important;\s*transition: none !important;/);
  // The channel lines are drawn by default: only the reveal's waiting state hides them.
  assert.match(landingCss, /\.landing-channels\.rv-wait article::before \{\s*transform: scaleX\(0\);/);
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
  // The landing's text uses only tokens this test checks: no new colour, no opacity that thins text.
  const tokens = new Set([...landingCss.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  const checked = ["fg", "muted", "accent-text", "btn", "btn-fg", "band", "band-fg", "band-muted", "band-accent", "band-line", "card", "chip", "tint", "tint2", "bg", "ink"];
  const decorative = ["line", "line2", "line3", "accent", "accent-soft", "accent-line", "cool", "btn-glow", "stage-shadow", "paper", "bar-b", "ease", "track", "hw", "mono"];
  for (const token of tokens) assert.ok(checked.includes(token!) || decorative.includes(token!), `landing.css uses --${token}: add it to this test`);
  // No text of the sections is thinned by opacity: the only partial opacities are the presence ring's (a shape).
  const sectionsCss = landingCss.slice(landingCss.indexOf("main.landing.landing-home"));
  const partial = [...sectionsCss.matchAll(/^([^\n{}]*)\{[^{}]*opacity: 0\.\d+/gm)].map((m) => m[1]!.trim());
  for (const selector of partial) assert.match(selector, /^(0%|\.landing-home \.landing-dg \.d-ring)$/, `${selector} thins its content`);

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
    // The landing's surfaces on surfaces: a chip on a path card, a standard card under hover, the diagrams' --bg chip.
    const chipOnCard = parseColor(t["chip"]!, card);
    const tintOnCard = parseColor(t["tint"]!, card);

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
      // The landing's sections (TIN-1067).
      ["path chip (--muted on --chip over --card)", muted, chipOnCard],
      ["path chip hover (--fg on --chip over --card)", fg, chipOnCard],
      ["standard card hover (--fg on --tint over --card)", fg, tintOnCard],
      ["standard card hover (--muted on --tint over --card)", muted, tintOnCard],
      ["standard card hover (--accent-text on --tint over --card)", accentText, tintOnCard],
      ["diagram label (--accent-text on --bg)", accentText, bg],
    ];
    for (const [label, a, b] of pairs) {
      const ratio = contrast(a, b);
      assert.ok(ratio >= 4.5, `${name}: ${label} is ${ratio.toFixed(2)}:1 (below 4.5:1)`);
    }
  }
});

test("the site splits its styles into one sheet per area, all imported by main.tsx", () => {
  for (const sheet of ["shell.css", "landing.css", "pages.css", "docs.css"]) {
    assert.match(main, new RegExp(`import "./styles/${sheet.replace(".", "\\.")}";`), `main.tsx imports ${sheet}`);
  }
  assert.ok(docsCss.includes(".docs-body h2"));
  // /try and /build share main.landing and its type: the landing's own layout stays under .landing-home.
  assert.match(landingCss, /^main\.landing \{\s*width: min\(1100px, 100% - 80px\);/m);
  assert.match(tryPage, /<main className="landing">/);
  assert.match(build, /<main className="landing">/);
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
  // No section of the new landing takes the old anchors' names.
  assert.doesNotMatch(landing, /id="(try|build)"/);
});

test("the top bar leads to the pages from everywhere: Try it, Build it, Docs, Spec, GitHub and the theme toggle, and nothing of the Dock", () => {
  assert.match(site, /href=\{SITE_PAGES\.try\.path\}[^>]*>Try it</);
  assert.match(site, /href=\{SITE_PAGES\.build\.path\}[^>]*>Build it</);
  assert.match(site, /<a href=\{DOCS\} aria-current=\{props\.docsAt === DOCS \? "page" : undefined\}>Docs</);
  assert.match(site, /<a href=\{`\$\{DOCS\}\/spec`\} aria-current=\{props\.docsAt === `\$\{DOCS\}\/spec` \? "page" : undefined\}>Spec</);
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
  assert.doesNotMatch(landing, /DOCK_PRODUCT/, "the landing has no slot for the Dock");
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "")
      .replace(/\{DOCK_PRODUCT && <>[\s\S]*?<\/>\}/g, "");
  for (const [name, source] of [["landing", landing], ["try.tsx", tryPage], ["build.tsx", build]] as const) {
    assert.doesNotMatch(stripComments(source), /\b(Autio|Dock)\b/i, `${name} names Autio or Dock outside comments`);
  }
  assert.doesNotMatch(landing, /autio\.cl|In use|Running in a real product/i, "no \"In use\" section");
  for (const source of [landing, tryPage, build, site]) assert.doesNotMatch(source, /href="\/dock|href="\/extension|DOCK_DESKTOP|Dock for Windows|Pulse for Windows/);
});

test("the landing's footer leaves out what the standard section already links", () => {
  // The footer-guard over every page is pages.test.ts's; here, the landing's own half of it.
  assert.match(landingRoot, /<SiteFooter onPage=\{STANDARD_LINKS\} \/>/);
  assert.match(standardSection, /export const STANDARD_LINKS = CARDS\.map\(\(c\) => c\.href\);/);
  assert.deepEqual(footerLinks([`${DOCS}/spec`, REPO, PAPER, RECORDS]).map((l) => l.href), ["/v1/"]);
  assert.doesNotMatch(landing, /href="\/v1|\{V1\}/, "the landing leaves Version 1 to the footer");
});

test("the docs links name pages and headings that exist", () => {
  const ids = new Map(DOC_PAGES.map((p) => [p.path, new Set(headingIds(parseMarkdown(read(p.file))))]));
  const links = [...[landing, tryPage, build, site, sitePages].join("\n").matchAll(/\$\{DOCS\}(\/[a-z]+)?(#[a-z0-9_-]+)?/g)];
  assert.ok(links.length >= 5);
  assert.ok(links.some((m) => m.index !== undefined && landing.includes(m[0])), "the landing's own docs links are among them");
  for (const [, page = "", hash] of links) {
    const path = `/docs${page}`;
    assert.ok(ids.has(path), `${path} is not a docs page`);
    if (hash) assert.ok(ids.get(path)!.has(hash.slice(1)), `${path}${hash} is not a heading`);
  }
});
