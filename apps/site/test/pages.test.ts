/**
 * /try and /build (TIN-627; one page each since the Dock left, TIN-1061; the new design, TIN-1068): the walk's
 * steps and links, the app cards and the starter question on /try; the numbered rows beside the real payload from
 * Pulse, the packages, the guide links and the open-list note on /build; no Dock and no Autio on either page; every
 * docs link names a page and a heading that exist; no footer repeats its page.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { DOT_FIELD_SPECS } from "../src/web/dot-field.ts";
import { FOCUS_EXAMPLE } from "../src/web/landing-example.ts";
import { DOCK_PRODUCT, FOOTER_LINKS, footerLinks, MOVED_PAGES, SITE_PAGES, sitePageAt, V1 } from "../src/web/site-pages.ts";

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

test("the ink, chip and reserved connected-walk pairings pass 4.5:1 (3:1 for the check) in both themes", () => {
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
      [`"done in the hero" pill (${pillToken}) on --bg`, c(pillToken), bg],
      [`"done in the hero" pill (${pillToken}) on the worst field`, c(pillToken), field],
      [`connected label (${connTextToken}) on --bg`, c(connTextToken), bg],
      [`connected label (${connTextToken}) on --card over the worst field`, c(connTextToken), card],
      [`"start here" pill (${nextPillToken}) on ${nextPillBgToken} over the worst field`, c(nextPillToken), c(nextPillBgToken, field)],
      [`next step number (${nextNumberToken} on ${nextNumberBgToken})`, c(nextNumberToken), c(nextNumberBgToken)],
    ];
    for (const [label, a, b] of text) assert.ok(contrast(a, b) >= 4.5, `${name}: ${label} is ${contrast(a, b).toFixed(2)}:1 (below 4.5:1)`);

    const graphics: [string, Rgb, Rgb][] = [
      [`done check (${checkToken} on ${discToken})`, c(checkToken), c(discToken)],
      [`connected check (${connCheckToken} on ${connDiscToken})`, c(connCheckToken), c(connDiscToken)],
      [`done disc (${discToken}) on --bg`, c(discToken), bg],
    ];
    for (const [label, a, b] of graphics) assert.ok(contrast(a, b) >= 3, `${name}: ${label} is ${contrast(a, b).toFixed(2)}:1 (below 3:1)`);
  }
});
