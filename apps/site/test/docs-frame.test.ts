/**
 * The docs wear the site's frame (TIN-1069): the shell's header with the theme toggle, its footer and its two themes,
 * and no dot field behind the text, with the text unchanged. The React page (src/web/docs.tsx) and the static HTML the
 * build writes (src/docs/static.ts) carry the same frame, so a page with no script still reads as part of the site.
 * The worst-case contrast of every token the docs use is proven in landing.test.ts over the dot field; the docs sit
 * on the plain --bg, a subset of that.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DOC_PAGES, EXAMPLES_DIR } from "../src/docs/pages.ts";
import { docPageHtml, siteFooterHtml, siteHeaderHtml } from "../src/docs/static.ts";
import { DOCS, footerLinks, REPO, SITE_PAGES } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const docsTsx = read("apps/site/src/web/docs.tsx");
const docsCss = read("apps/site/src/web/styles/docs.css");
const siteTsx = read("apps/site/src/web/site.tsx");
const examplesDir = new URL(`${EXAMPLES_DIR}/`, root);
const examples = Object.fromEntries(readdirSync(examplesDir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(new URL(f, examplesDir), "utf8")]));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

test("the docs page is the site's frame around the docs: header, then the docs, then the footer, and no dot field", () => {
  assert.match(docsTsx, /<SiteHeader page="docs" \/>/);
  assert.match(docsTsx, /<SiteFooter onPage=\{\[`\$\{DOCS\}\/spec`\]\} \/>/);
  assert.ok(docsTsx.indexOf("<SiteHeader") < docsTsx.indexOf('<main className="docs">') && docsTsx.indexOf("</main>") < docsTsx.indexOf("<SiteFooter"));
  // Reading comes first: no dot field and no haze behind long text.
  assert.doesNotMatch(docsTsx, /SiteBackdrop|site-backdrop|site-field|site-haze/);
  assert.doesNotMatch(docsCss, /site-backdrop|site-field|site-haze|backdrop-filter/);
  for (const page of DOC_PAGES) {
    const html = docPageHtml(page, read(page.file), examples);
    assert.doesNotMatch(html, /site-backdrop|site-field|site-haze|<canvas/, page.path);
    assert.ok(html.indexOf('<header class="site-nav">') < html.indexOf('<main class="docs">') && html.indexOf("</main>") < html.indexOf('<footer class="site-foot">'), `${page.path}: header, main, footer`);
  }
});

test("the static header and footer carry the same links as the React ones, and the docs link is the current page", () => {
  const header = siteHeaderHtml();
  assert.deepEqual(hrefs(header).filter((h) => h !== "/"), [SITE_PAGES.try.path, SITE_PAGES.build.path, DOCS, `${DOCS}/spec`, REPO, SITE_PAGES.build.path, SITE_PAGES.try.path]);
  assert.match(header, /<a href="\/docs" aria-current="page">Docs<\/a>/);
  assert.match(header, /class="site-theme-toggle"/);
  // The React header names the same links, in the same order.
  const order = ["{SITE_PAGES.try.path}", "{SITE_PAGES.build.path}", "{DOCS}", "{`${DOCS}/spec`}", "{REPO}"].map((s) => siteTsx.indexOf(`href=${s}`));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1]!)), "the React header's links");
  const footer = siteFooterHtml();
  assert.deepEqual(hrefs(footer).filter((h) => h !== "/"), footerLinks([`${DOCS}/spec`]).map((l) => l.href), "the footer, less the Spec link the docs' note has");
  assert.ok(!hrefs(footer).includes(`${DOCS}/spec`));
  for (const html of [header, footer]) assert.doesNotMatch(html, /\sstyle=|<script|\sonclick=/, "nothing a strict CSP refuses");
  assert.ok(!hrefs(header).join().includes("/dock"), "the Dock is not on the site");
});

test("the docs' text stays 1.x: the frame changes no page under src/docs/pages", () => {
  const html = docPageHtml(DOC_PAGES[0]!, read(DOC_PAGES[0]!.file), examples);
  assert.ok(html.includes("<b>APC "), "the standard's note stays");
  assert.ok(html.includes('<article class="docs-body">'), "the text stays in its article");
});

test("docs.css uses the shell's tokens only, and never --dim bare over the page", () => {
  const used = new Set([...docsCss.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!));
  const shellCss = read("apps/site/src/web/styles/shell.css");
  const defined = new Set([...shellCss.slice(0, shellCss.indexOf(':root[data-theme="light"]')).matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));
  for (const token of used) assert.ok(defined.has(token), `--${token} is a token of the shell`);
  assert.ok(!used.has("dim"));
  // Long text reads in --fg or --muted on --bg, --card or --chip; links in --accent-text; inline code in --code-fg: the pairs landing.test.ts proves.
  for (const token of used) assert.ok(["bg", "fg", "muted", "card", "chip", "line", "line2", "line3", "accent", "accent-text", "accent-line", "code-bg", "code-fg", "mono"].includes(token), `--${token} is one the contrast test covers`);
});
