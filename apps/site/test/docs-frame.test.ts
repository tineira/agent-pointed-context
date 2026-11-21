/**
 * The docs wear the site's frame (TIN-1069): the shell's header with the theme toggle, its footer and its two themes,
 * and no dot field behind the text, with the text unchanged. The React page (src/web/docs.tsx) and the static HTML the
 * build writes (src/docs/static.ts) carry the same frame, so a page with no script still reads as part of the site.
 * The worst-case contrast of every token the docs use is proven in landing.test.ts over the dot field; the docs sit
 * on the plain --bg, a subset of that.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DOC_PAGES, EXAMPLES_DIR } from "../src/docs/pages.ts";
import { docPageHtml, siteFooterHtml, siteHeaderHtml } from "../src/docs/static.ts";
import { DOCS, docsHeaderCurrent, footerLinks, REPO, SITE_PAGES } from "../src/web/site-pages.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const docsTsx = read("apps/site/src/web/docs.tsx");
const docsCss = read("apps/site/src/web/styles/docs.css");
const siteTsx = read("apps/site/src/web/site.tsx");
const examplesDir = new URL(`${EXAMPLES_DIR}/`, root);
const examples = Object.fromEntries(readdirSync(examplesDir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(new URL(f, examplesDir), "utf8")]));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

test("the docs page is the site's frame around the docs: header, then the docs, then the footer, and no dot field", () => {
  assert.match(docsTsx, /<SiteHeader page="docs" docsAt=\{docsHeaderCurrent\(path\)\} \/>/);
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
  assert.equal(header.includes("aria-current"), false, "with no docs page given, nothing is current");
  assert.match(siteHeaderHtml("/docs"), /<a href="\/docs" aria-current="page">Docs<\/a><a href="\/docs\/spec">Spec<\/a>/);
  assert.match(siteHeaderHtml("/docs/spec"), /<a href="\/docs">Docs<\/a><a href="\/docs\/spec" aria-current="page">Spec<\/a>/);
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

/**
 * The docs' text is frozen at 1.x until the 2.0 cut (TIN-1069): a fingerprint of every source the docs are built from.
 * A change to any of these files fails here. If the change is meant (the 2.0 cut, or a deliberate fix of the text), update
 * the fingerprint below in the same PR, on purpose; a frame, style or generator change never needs to.
 */
const DOCS_TEXT_SHA256: Record<string, string> = {
  "apps/site/src/docs/pages/agents.md": "0270957100668bdd5a308ed8471d6279f4136b76d743c1e2050bd32a9e95361c",
  "apps/site/src/docs/pages/conformance.md": "7047fb263027f96b90001ee3649bf691c5a66be4038b847a8a941b7dc9e73b09",
  "apps/site/src/docs/pages/integrate.md": "98c55744a5f715839a40aa6c91e89634a63d3bad135bc5b01d132d24003146fc",
  "apps/site/src/docs/pages/overview.md": "02e6d8f080d4d5c1d0b181dce963bf87edbf754f7cd3fa187cb81a80323bb47a",
  "apps/site/src/docs/pages/spec.md": "4f69e52219da10050854f08f1cf1e476e888aa96fa67571e84fa4c395b105e10",
  "apps/site/src/docs/pages/ux.md": "3093f6eccffbe9e1f492948e0266ee748850ad07171d52e1e1304d5eb6fd58e2",
  "packages/protocol/CHANGELOG.md": "b21307feb183316845523a181d5d5840e00899bdd1c438a5c6a98a0d33445361",
};

test("the docs' text is frozen: every page's source, and the protocol changelog, matches its committed fingerprint", () => {
  const files = [...DOC_PAGES.map((p) => p.file), "packages/protocol/CHANGELOG.md"];
  assert.deepEqual([...new Set(files)].sort(), Object.keys(DOCS_TEXT_SHA256).sort(), "the fingerprints cover every page the docs have");
  for (const file of Object.keys(DOCS_TEXT_SHA256)) {
    const sha = createHash("sha256").update(read(file).replace(/\r\n?/g, "\n")).digest("hex");
    assert.equal(sha, DOCS_TEXT_SHA256[file], `${file} changed. The docs' text stays 1.x until the 2.0 cut: if this change is meant, update its fingerprint in docs-frame.test.ts on purpose.`);
  }
});

test("the header marks as current only the link that is exactly this page, in the page and in the static HTML", () => {
  assert.equal(docsHeaderCurrent("/docs"), "/docs");
  assert.equal(docsHeaderCurrent("/docs/"), "/docs");
  assert.equal(docsHeaderCurrent("/docs/spec"), "/docs/spec");
  assert.equal(docsHeaderCurrent("/docs/integrate"), null);
  const headerCurrent = (html: string) => [...html.split("</header>")[0]!.matchAll(/<a href="([^"]*)"[^>]* aria-current="page"/g)].map((m) => m[1]);
  for (const page of DOC_PAGES) {
    const html = docPageHtml(page, read(page.file), examples);
    const want = page.path === "/docs" || page.path === "/docs/spec" ? [page.path] : [];
    assert.deepEqual(headerCurrent(html), want, `${page.path}: the header's current link`);
    // The docs' own navigation marks the page too: one current link there, and none between the header and it.
    const docsNav = html.match(/<nav class="docs-nav"[^>]*>.*?<\/nav>/s)![0];
    assert.equal(docsNav.match(/aria-current="page"/g)?.length, 1, `${page.path}: one current link in the docs nav`);
    assert.equal(html.split("</header>")[0]!.includes(docsNav), false);
    // No two links of the page are current for the same address.
    const currents = [...html.matchAll(/<a href="([^"]*)"[^>]* aria-current="page"/g)].map((m) => m[1]);
    assert.equal(new Set(currents).size, currents.length - (want.length ? 1 : 0), `${page.path}: the header and the docs nav agree on the page`);
  }
  // The React page passes the same value to the header, which sets aria-current on exactly those two links.
  assert.match(docsTsx, /<SiteHeader page="docs" docsAt=\{docsHeaderCurrent\(path\)\} \/>/);
  assert.match(siteTsx, /<a href=\{DOCS\} aria-current=\{props\.docsAt === DOCS \? "page" : undefined\}>Docs<\/a>/);
  assert.match(siteTsx, /<a href=\{`\$\{DOCS\}\/spec`\} aria-current=\{props\.docsAt === `\$\{DOCS\}\/spec` \? "page" : undefined\}>Spec<\/a>/);
  assert.doesNotMatch(siteTsx, /props\.page === "docs" \?/, "the docs page does not mark Docs current by its name");
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
