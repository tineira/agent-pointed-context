/**
 * The APC docs at /docs (TIN-611): the Markdown renderer, and a link check over every page as the site shows
 * it. Site links must name a docs page and a heading on it, or another page of the site; links into the repo
 * must name a file that exists; every included example region must exist. The landing and the extension page
 * link to the docs, and the dock's assets keep their frame protection.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { exampleRegion, fragmentTarget, headingIds, linksOf, parseInline, parseMarkdown, REPO, repoPath, resolveHref, slugify, type Block, type Inline } from "../src/docs/markdown.ts";
import { DOC_PAGES, docPageAt, EXAMPLES_DIR, isDocsPath, SITE_PATHS } from "../src/docs/pages.ts";
import { docHtmlFile, docMarkdownPath, staticDocFiles } from "../src/docs/static.ts";
import { readdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const exists = (path: string) => existsSync(new URL(path.replace(/\/$/, ""), root));

const pages = DOC_PAGES.map((page) => ({ page, blocks: parseMarkdown(read(page.file)) }));
const idsOf = new Map(pages.map(({ page, blocks }) => [page.path, new Set(headingIds(blocks))]));

test("the renderer reads the Markdown the docs use", () => {
  assert.deepEqual(parseInline("a `b*c` **d *e* f** [f `g`](/h#i) 2 * 3 snake_case"), [
    { t: "text", v: "a " },
    { t: "code", v: "b*c" },
    { t: "text", v: " " },
    { t: "strong", c: [{ t: "text", v: "d " }, { t: "em", c: [{ t: "text", v: "e" }] }, { t: "text", v: " f" }] },
    { t: "text", v: " " },
    { t: "link", href: "/h#i", c: [{ t: "text", v: "f " }, { t: "code", v: "g" }] },
    { t: "text", v: " 2 * 3 snake_case" },
  ]);
  const blocks = parseMarkdown("# T\n\n## `apc.json` (0.5)\n\npara\nmore\n\n- one\n  cont\n- two\n\n1. a\n2. b\n\n| x | `a|b` |\n|---|---|\n| `c\\|d` | e\\|f |\n\n```ts\ncode\n```\n\n> quote\n\n<!-- include f.ts#r -->\n<!-- a comment -->\n## `apc.json` (0.5)");
  assert.deepEqual(blocks.map((b) => b.t), ["heading", "heading", "para", "list", "list", "table", "code", "quote", "include", "heading"]);
  assert.deepEqual(headingIds(blocks), ["t", "apcjson-05", "apcjson-05-1"]);
  assert.deepEqual((blocks[3] as Extract<Block, { t: "list" }>).items, [[{ t: "text", v: "one cont" }], [{ t: "text", v: "two" }]]);
  assert.equal((blocks[4] as Extract<Block, { t: "list" }>).ordered, true);
  assert.deepEqual((blocks[5] as Extract<Block, { t: "table" }>).head[1], [{ t: "code", v: "a|b" }]);
  assert.deepEqual((blocks[5] as Extract<Block, { t: "table" }>).rows[0], [[{ t: "code", v: "c|d" }], [{ t: "text", v: "e|f" }]], "\\| is a pipe, in code or not");
  // As GitHub reads them: an escaped pipe at the end of a row with no closing border, and \\ before a border.
  const rowOf = (row: string) => (parseMarkdown(`| h | h |\n|---|---|\n${row}`)[0] as Extract<Block, { t: "table" }>).rows[0]!.map((c) => c.map((x) => ("v" in x ? x.v : "")).join(""));
  assert.deepEqual(rowOf("| a | b\\|"), ["a", "b|"], "a trailing \\| is a pipe, not the border");
  assert.deepEqual(rowOf("| a | c\\\\| d |"), ["a", "c\\", "d"], "\\\\ is one backslash, and the | after it a border");
  assert.deepEqual(rowOf("| a | `c\\\\` | d |"), ["a", "c\\\\", "d"], "inside code both backslashes stay");
  assert.deepEqual(rowOf("| a |  |"), ["a", ""], "an empty last cell before the closing border");
  assert.deepEqual(blocks[8], { t: "include", file: "f.ts", region: "r" });
});

test("headings get GitHub's ids, and links resolve to the site or the repo", () => {
  assert.equal(slugify("0.7.0 (draft, 2026-11-04)"), "070-draft-2026-11-04");
  assert.equal(slugify("The hub's trust model"), "the-hubs-trust-model");
  assert.equal(resolveHref("/docs/spec#mobile", "x/y.md"), "/docs/spec#mobile");
  assert.equal(resolveHref("https://example.com", "x/y.md"), "https://example.com");
  assert.equal(resolveHref("../../CHANGELOG.md", "packages/protocol/CHANGELOG.md"), `${REPO}/blob/main/CHANGELOG.md`);
  assert.equal(repoPath("src/core.ts#L3", "packages/protocol/README.md"), "packages/protocol/src/core.ts#L3");
  assert.equal(resolveHref("mailto:a@example.com", "x/y.md"), "mailto:a@example.com");
  assert.equal(resolveHref("HTTPS://example.com", "x/y.md"), "HTTPS://example.com");
});

test("a link is only ever http(s), mailto, a site path, an anchor or a file in the repo: never a script", () => {
  const unsafe = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript\u0000:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "VbScript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "1javascript:alert(1)",
    "",
    " \t",
  ];
  for (const href of unsafe) assert.equal(resolveHref(href, "x/y.md"), null, JSON.stringify(href));
  // In a page, such a link is text: the link check reports it.
  assert.deepEqual(brokenIn({ path: "/docs/x", file: "apps/dock/README.md" }, parseMarkdown("# T\n\n[x](javascript:alert%281%29) [y](data:,x)")), ["javascript:alert%281%29: unsafe link", "data:,x: unsafe link"]);
});

test("a malformed #fragment names nothing, and never throws", () => {
  assert.equal(fragmentTarget("#versioning-and-deprecation"), "versioning-and-deprecation");
  assert.equal(fragmentTarget("#caf%C3%A9"), "café");
  assert.equal(fragmentTarget("#%E0%A4%A"), null);
  assert.equal(fragmentTarget("#%"), null);
  assert.equal(fragmentTarget("#"), null);
  assert.equal(fragmentTarget(""), null);
});

test("an example region is shown without its markers, dedented", () => {
  const src = "a\n  // #region outer\n  x\n  // #region inner\n    y\n  // #endregion\n  // #endregion\nb";
  assert.equal(exampleRegion(src, "outer"), "x\n  y");
  assert.equal(exampleRegion(src, "inner"), "y");
  assert.equal(exampleRegion(src, null), "a\n  x\n    y\nb");
  assert.equal(exampleRegion(src, "missing"), null);
});

test("the docs' paths: every page by its path, a trailing slash too, and nothing else", () => {
  assert.equal(docPageAt("/docs")?.nav, "Overview");
  assert.equal(docPageAt("/docs/spec/")?.nav, "Spec");
  assert.equal(docPageAt("/docs/nope"), null);
  assert.equal(isDocsPath("/docs/nope"), true);
  assert.equal(isDocsPath("/dock"), false);
  assert.equal(isDocsPath("/docsx"), false);
});

/** What is broken in a page: links to no page, heading, file or template, and includes of no example region. */
function brokenIn(page: { path: string; file: string }, blocks: Block[]): string[] {
  const broken: string[] = [];
  const own = new Set(headingIds(blocks));
  for (const href of linksOf(blocks)) {
    const resolved = resolveHref(href, page.file);
    const inRepo = resolved?.match(new RegExp(`^${REPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:blob|tree)/main/([^?#]+)`));
    const issue = resolved?.startsWith(`${REPO}/issues/new?`) ? new URL(resolved) : null;
    if (resolved === null) broken.push(`${href}: unsafe link`);
    else if (resolved.startsWith("#")) {
      if (!own.has(resolved.slice(1))) broken.push(`${href}: no such heading here`);
    } else if (resolved.startsWith("/")) {
      const [path = "", anchor] = resolved.split("#", 2);
      const target = docPageAt(path.split("?")[0]!);
      if (target) {
        if (anchor && !idsOf.get(target.path)!.has(anchor)) broken.push(`${href}: no heading #${anchor} on ${target.path}`);
      } else if (isDocsPath(path) || !SITE_PATHS.includes(path)) broken.push(`${href}: no such page on the site`);
    } else if (inRepo) {
      const file = decodeURIComponent(inRepo[1]!);
      if (!exists(file)) broken.push(`${href}: no ${file} in the repo`);
    } else if (issue) {
      const template = issue.searchParams.get("template") ?? "";
      if (!/^[\w.-]+\.md$/.test(template) || !exists(`.github/ISSUE_TEMPLATE/${template}`)) broken.push(`${href}: no issue template ${template}`);
    } else if (!/^https:\/\//.test(resolved)) broken.push(`${href}: not https`);
  }
  for (const b of blocks) {
    if (b.t !== "include") continue;
    const path = `${EXAMPLES_DIR}/${b.file}`;
    if (!exists(path)) broken.push(`include ${b.file}: no such example`);
    else if (exampleRegion(read(path), b.region) === null) broken.push(`include ${b.file}#${b.region}: no such region`);
  }
  return broken;
}

test("the link check finds what is broken", () => {
  const md = `# T

## Here

[a](#here) [b](#nowhere) [c](/docs/spec#mobile) [d](/docs/spec#nope) [e](/docs/nope) [f](/nope) [g](/dock) [h](../../README.md) [i](../../NOPE.md) [j](http://x.example)

<!-- include orders-app.ts#mcp -->
<!-- include orders-app.ts#nope -->
<!-- include nope.ts -->`;
  assert.deepEqual(brokenIn({ path: "/docs/x", file: "apps/dock/README.md" }, parseMarkdown(md)), [
    "#nowhere: no such heading here",
    "/docs/spec#nope: no heading #nope on /docs/spec",
    "/docs/nope: no such page on the site",
    "/nope: no such page on the site",
    "../../NOPE.md: no NOPE.md in the repo",
    "http://x.example: not https",
    "include orders-app.ts#nope: no such region",
    "include nope.ts: no such example",
  ]);
});

for (const { page, blocks } of pages) {
  test(`${page.path}: one title, and no broken link or example`, () => {
    assert.equal(blocks.filter((b) => b.t === "heading" && b.level === 1).length, 1, "one # title");
    assert.deepEqual(brokenIn(page, blocks), []);
  });
}

test("the docs and their examples name the packages as published: @tineira/apc-*, never @apc/*", () => {
  const examples = ["orders-app.ts", "orders-page.ts", "orders-conformance.ts"].map((f) => `${EXAMPLES_DIR}/${f}`);
  for (const file of [...DOC_PAGES.filter((p) => p.file.startsWith("apps/dock/")).map((p) => p.file), ...examples, "apps/dock/src/web/docs.tsx"]) {
    assert.doesNotMatch(read(file), /@apc\//, `${file} still names @apc/`);
  }
  assert.match(read("apps/dock/src/docs/pages/integrate.md"), /npm i @tineira\/apc-server @modelcontextprotocol/);
  assert.match(read("apps/dock/src/docs/pages/conformance.md"), /npx @tineira\/apc-conformance https:\/\/\S+ --grant /);
  // No install line on a dist-tag (TIN-914): both tags carry the same release, and the minor version is the standard's.
  for (const file of ["apps/dock/src/docs/pages/integrate.md", "apps/dock/src/docs/pages/conformance.md", "README.md", ...["protocol", "server", "web", "conformance"].map((p) => `packages/${p}/README.md`)]) {
    assert.doesNotMatch(read(file), /@tineira\/apc-[a-z]+@next/, `${file} still installs @next`);
  }
});

test("the docs page has a source for every page, and says on every page that the standard is a draft", () => {
  const docs = read("apps/dock/src/web/docs.tsx");
  for (const { path } of DOC_PAGES) assert.match(docs, new RegExp(`"${path}": \\w+,`), `${path} has no source in docs.tsx`);
  assert.match(docs, /<b>Draft\.<\/b> The APC standard is at \{APC_STANDARD_VERSION\}, a 0\.x draft/);
  assert.match(docs, /CC BY 4\.0/);
});

test("every page of the site (its top bar) and the extension page link to the docs", () => {
  // The top bar has Docs on every page (TIN-627), so the footers, which never repeat their page, do not.
  assert.match(read("apps/dock/src/web/site.tsx"), /<a href=\{DOCS\}>Docs<\/a>/);
  assert.match(read("apps/dock/src/web/landing.tsx"), /<SiteHeader page="landing" \/>/);
  assert.match(read("apps/dock/src/web/extension.tsx"), /href="\/docs/);
});

test("the docs are static assets, and the assets keep their frame protection", () => {
  const wrangler = read("apps/dock/wrangler.jsonc");
  assert.doesNotMatch(wrangler.match(/"run_worker_first": \[[^\]]*\]/)![0], /\/docs/);
  const headers = read("apps/dock/public/_headers");
  assert.match(headers, /^\/\*$/m);
  assert.match(headers, /Content-Security-Policy: frame-ancestors 'none'/);
  assert.match(headers, /X-Frame-Options: DENY/);
});

// The docs without JavaScript (TIN-914): what the build writes beside index.html. scripts/dock-pairing.mjs GETs
// the built pages in workerd too.
const SHELL = '<!doctype html><html><head><title>Agent dock</title><script type="module" src="/assets/x.js"></script></head><body><div id="root"></div></body></html>';
const sources = Object.fromEntries(DOC_PAGES.map((p) => [p.path, read(p.file)]));
const examplesDir = new URL(`${EXAMPLES_DIR}/`, root);
const examples = Object.fromEntries(readdirSync(examplesDir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(new URL(f, examplesDir), "utf8")]));
const built = new Map(staticDocFiles(SHELL, sources, examples).map((f) => [f.file, f.content]));
/** What a reader with no JavaScript sees of an HTML page: its text, tags left out. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const inlineText = (nodes: Inline[]): string => nodes.map((n) => ("v" in n ? n.v : inlineText(n.c))).join("");

for (const { page, blocks } of pages) {
  test(`${page.path} reads with a plain GET: its whole text in the HTML, and its Markdown beside it`, () => {
    const html = built.get(docHtmlFile(page));
    assert.ok(html, `no ${docHtmlFile(page)} in the build`);
    assert.ok(html.includes('<div id="root"><main class="docs">'), "the text is in #root");
    assert.ok(html.includes('<script type="module" src="/assets/x.js"></script>'), "the page's script stays, so it still renders itself");
    assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${docMarkdownPath(page)}" />`), "the page names its Markdown");
    const text = textOf(html);
    const missing: string[] = [];
    const walk = (list: Block[]) => {
      for (const b of list) {
        if (b.t === "heading" || b.t === "para") {
          const want = squash(inlineText(b.c));
          if (want && !text.includes(want)) missing.push(want.slice(0, 60));
        } else if (b.t === "list") {
          for (const item of b.items) if (!text.includes(squash(inlineText(item)))) missing.push(squash(inlineText(item)).slice(0, 60));
        } else if (b.t === "quote") walk(b.c);
        else if (b.t === "include") {
          if (!text.includes(squash(exampleRegion(examples[b.file] ?? "", b.region)!))) missing.push(`include ${b.file}#${b.region}`);
        }
      }
    };
    walk(blocks);
    assert.deepEqual(missing, []);
    const title = blocks.find((b) => b.t === "heading" && b.level === 1);
    assert.ok(title?.t === "heading" && textOf(html.split("</title>")[0]!.split("<title>")[1]!) === `${inlineText(title.c)} · APC docs`, "the page's own title");
    const md = built.get(docMarkdownPath(page).slice(1));
    assert.ok(md !== undefined && md.startsWith("# "), `no ${docMarkdownPath(page)} in the build`);
    assert.ok(!/<!--\s*include/.test(md), "every include is replaced by its code");
    for (const b of blocks) if (b.t === "include") assert.ok(md.includes(exampleRegion(examples[b.file] ?? "", b.region)!), `${b.file}#${b.region} in the Markdown`);
  });
}

test("the static pages escape the text, and /llms.txt names every page's Markdown", () => {
  const page = DOC_PAGES[0]!;
  const hostile = "# A <b>&</b>\n\n<script>alert(1)</script> [x](javascript:alert) $& $'";
  const html = staticDocFiles(SHELL, { ...sources, [page.path]: hostile }, examples).find((f) => f.file === docHtmlFile(page))!.content;
  const body = html.split('<article class="docs-body">')[1]!.split("</article>")[0]!;
  assert.ok(!/<script|<b>|href="javascript/.test(body), "nothing from the text becomes markup");
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt; <span>x</span> $&amp; $&#39;"), "the text is escaped, and $ patterns stay text");
  const llms = built.get("llms.txt")!;
  for (const p of DOC_PAGES) assert.ok(llms.includes(`(${docMarkdownPath(p)})`), `llms.txt names ${docMarkdownPath(p)}`);
  assert.throws(() => staticDocFiles("<html><body></body></html>", sources, examples), /index\.html has no empty/);
  // The asset server answers /docs with docs.html and /docs/spec with docs/spec.html.
  assert.deepEqual(DOC_PAGES.map(docHtmlFile).slice(0, 2), ["docs.html", "docs/spec.html"]);
  assert.match(read("apps/dock/vite.config.ts"), /plugins: \[[^\]]*staticDocs\(\)/, "the dock's build writes the static docs");
});
