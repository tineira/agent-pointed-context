/**
 * The docs without JavaScript (TIN-914): every page of /docs as HTML in the build, and as Markdown at
 * /docs/<page>.md, so a crawler or an agent with only HTTP GET reads them. The page (src/web/docs.tsx) still
 * renders itself once its script runs; this is the same text, already there.
 *
 * Pure, from the same parser and the same example regions as the page: the dock's Vite build writes what
 * `staticDocFiles` returns next to its index.html (vite.config.ts), and test/docs.test.ts checks it.
 */
import { APC_STANDARD_VERSION } from "@tineira/apc-protocol";
import { exampleRegion, parseMarkdown, plainText, REPO, resolveHref, type Block, type Inline } from "./markdown.ts";
import { DOC_PAGES, EXAMPLES_DIR, type DocPage } from "./pages.ts";

/** Where a page's Markdown is served: /docs/spec.md for /docs/spec, /docs/overview.md for /docs itself. */
export function docMarkdownPath(page: DocPage): string {
  return page.path === "/docs" ? "/docs/overview.md" : `${page.path}.md`;
}

/** Where a page's HTML is in the build, as the asset server maps it to the page's path: docs.html for /docs, docs/spec.html for /docs/spec. */
export function docHtmlFile(page: DocPage): string {
  return `${page.path.slice(1)}.html`;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inlines(nodes: Inline[], file: string): string {
  return nodes
    .map((n) => {
      if (n.t === "text") return escapeHtml(n.v);
      if (n.t === "code") return `<code>${escapeHtml(n.v)}</code>`;
      if (n.t === "strong") return `<strong>${inlines(n.c, file)}</strong>`;
      if (n.t === "em") return `<em>${inlines(n.c, file)}</em>`;
      const href = resolveHref(n.href, file);
      // As the page does: a link with any other scheme is shown as its text, never as a link.
      return href ? `<a href="${escapeHtml(href)}">${inlines(n.c, file)}</a>` : `<span>${inlines(n.c, file)}</span>`;
    })
    .join("");
}

function blocks(list: Block[], file: string, examples: Record<string, string>): string {
  return list
    .map((b) => {
      switch (b.t) {
        case "heading": {
          const level = Math.min(b.level, 4);
          const anchor = b.level > 1 ? `<a class="docs-anchor" href="#${escapeHtml(b.id)}" aria-label="${escapeHtml(`Link to ${plainText(b.c)}`)}">#</a>` : "";
          return `<h${level} id="${escapeHtml(b.id)}">${inlines(b.c, file)}${anchor}</h${level}>`;
        }
        case "para":
          return `<p>${inlines(b.c, file)}</p>`;
        case "list": {
          const items = b.items.map((item) => `<li>${inlines(item, file)}</li>`).join("");
          return b.ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
        }
        case "code":
          return `<pre class="docs-pre"><code>${escapeHtml(b.v)}</code></pre>`;
        case "table": {
          const head = b.head.map((c) => `<th>${inlines(c, file)}</th>`).join("");
          const rows = b.rows.map((row) => `<tr>${row.map((c) => `<td>${inlines(c, file)}</td>`).join("")}</tr>`).join("");
          return `<div class="docs-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        case "quote":
          return `<blockquote>${blocks(b.c, file, examples)}</blockquote>`;
        case "include": {
          const code = exampleRegion(examples[b.file] ?? "", b.region) ?? `(missing: ${b.file}#${b.region})`;
          return `<figure class="docs-example"><figcaption><a href="${REPO}/blob/main/${EXAMPLES_DIR}/${escapeHtml(b.file)}">${escapeHtml(b.file)}</a></figcaption><pre class="docs-pre"><code>${escapeHtml(code)}</code></pre></figure>`;
        }
      }
    })
    .join("\n");
}

/** A page's description, for search results and link previews: its first paragraph as text, cut at a word near 200 characters. */
export function docDescription(source: string): string {
  const para = parseMarkdown(source).find((b) => b.t === "para");
  const text = para?.t === "para" ? plainText(para.c).replace(/\s+/g, " ").trim() : "";
  if (!text) return "The docs of the Agent Pointed Context (APC) standard.";
  return text.length <= 200 ? text : `${text.slice(0, 200).replace(/\s+\S*$/, "")}…`;
}

/** A page's title, as its one `#` heading says it. */
export function docTitle(source: string): string {
  const title = parseMarkdown(source).find((b) => b.t === "heading" && b.level === 1);
  return title?.t === "heading" ? plainText(title.c) : "APC docs";
}

/** The page as src/web/docs.tsx draws it, as HTML: the same header, navigation, draft note, text and footer. */
export function docPageHtml(page: DocPage, source: string, examples: Record<string, string>): string {
  const nav = DOC_PAGES.map((p) => `<a href="${p.path}"${p === page ? ' aria-current="page"' : ""}>${escapeHtml(p.nav)}</a>`).join("");
  return [
    `<main class="docs">`,
    `<header class="docs-head"><a class="kicker" href="/">Agent Pointed Context</a><span class="row small"><a href="/dock">Your dock</a><a href="${REPO}">GitHub</a></span></header>`,
    `<nav class="docs-nav" aria-label="Docs">${nav}</nav>`,
    `<aside class="docs-draft" role="note"><b>Draft.</b> The APC standard is at ${APC_STANDARD_VERSION}, a 0.x draft: any release may still change the contract. Version 1.0 will freeze it, and from then on it changes only by the <a href="/docs/spec#versioning-and-deprecation">versioning and deprecation policy</a>.</aside>`,
    `<article class="docs-body">${blocks(parseMarkdown(source), page.file, examples)}</article>`,
    `<footer class="docs-foot"><p>The text of these docs and of the APC specification is licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; the code, the examples included, is MIT. Source of this page: <a href="${REPO}/blob/main/${page.file}">${page.file}</a>. This page as Markdown: <a href="${docMarkdownPath(page)}">${docMarkdownPath(page)}</a>.</p><p><a href="/">Home</a> · <a href="/v1/">Version 1, as described in the paper</a></p></footer>`,
    `</main>`,
  ].join("\n");
}

const FENCE = /^```/;
const INCLUDE_LINE = /^<!--\s*include\s+([\w.-]+\.ts)(?:#([\w-]+))?\s*-->\s*$/;
const CODE_SPAN = /(`[^`]*`)/;
const LINK_TARGET =/(\]\()([^()\s]+)(\))/g;

/**
 * The page as Markdown, to read with no renderer: its source, with each `<!-- include -->` replaced by the
 * code it shows and each link into the repo made a GitHub URL. Site links (`/docs/spec#…`) stay as they are.
 */
export function docPageMarkdown(page: DocPage, source: string, examples: Record<string, string>): string {
  const out: string[] = [];
  let code = false;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) code = !code;
    const include = code ? null : line.match(INCLUDE_LINE);
    if (include) {
      const [, file, region] = include;
      const text = exampleRegion(examples[file!] ?? "", region ?? null) ?? `(missing: ${file}#${region})`;
      out.push(`From [${file}](${REPO}/blob/main/${EXAMPLES_DIR}/${file}):`, "", "```ts", text, "```");
      continue;
    }
    // Links are rewritten only outside code: a code span (`[a](b.md)` in backticks) stays as written.
    const rewrite = (part: string) =>
      part.replace(LINK_TARGET, (all, open: string, href: string, close: string) => {
        if (href.startsWith("/") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return all;
        const resolved = resolveHref(href, page.file);
        return resolved ? `${open}${resolved}${close}` : all;
      });
    out.push(code ? line : line.split(CODE_SPAN).map((part, i) => (i % 2 ? part : rewrite(part))).join(""));
  }
  const text = out.join("\n").trimEnd();
  return `${text}\n\n---\n\nThe APC standard is at ${APC_STANDARD_VERSION}, a 0.x draft: any release may still change the contract. This page as HTML: ${page.path}. Text CC BY 4.0, code MIT. Source: ${REPO}/blob/main/${page.file}\n`;
}

/** /llms.txt: what the docs are, and every page as Markdown (https://llmstxt.org). */
export function llmsTxt(sources: Record<string, string>): string {
  const lines = DOC_PAGES.map((p) => `- [${p.nav}: ${docTitle(sources[p.path] ?? "")}](${docMarkdownPath(p)})`);
  return [
    "# Agent Pointed Context (APC)",
    "",
    `> APC is an open standard for pointing an AI agent at something on screen: the person drags their agent onto a row, a cell or a step of a figure in any app that speaks APC, and the agent receives that thing's identifiers through MCP. The standard is at ${APC_STANDARD_VERSION}, a 0.x draft.`,
    "",
    "Every docs page is plain HTML at its path (/docs, /docs/spec, …) and Markdown at the paths below.",
    "",
    "## Docs",
    "",
    ...lines,
    "",
    "## Optional",
    "",
    `- [Source and issues](${REPO})`,
    "",
  ].join("\n");
}

/**
 * Every file the build adds for the docs, by its path in the build's output: each page's HTML (the app's
 * index.html, `shell`, with the page's text in #root, its title and a link to its Markdown), each page's
 * Markdown, and /llms.txt. `sources` are the pages' Markdown by page path; `examples` the example files by name.
 * Throws when the shell is not the one it knows, so a build never ships a page without its text.
 */
export function staticDocFiles(shell: string, sources: Record<string, string>, examples: Record<string, string>): { file: string; content: string }[] {
  if (!shell.includes('<div id="root"></div>') || !/<title>[^<]*<\/title>/.test(shell) || !shell.includes("</head>")) {
    throw new Error("the docs' static pages: index.html has no empty <div id=\"root\"></div>, <title> or </head>");
  }
  const files: { file: string; content: string }[] = [];
  for (const page of DOC_PAGES) {
    const source = sources[page.path];
    if (source === undefined) throw new Error(`the docs' static pages: no source for ${page.path}`);
    const md = docMarkdownPath(page);
    const html = shell
      .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(`${docTitle(source)} · APC docs`)}</title>`)
      // The page's own description, in place of the dock's.
      .replace(/\s*<meta name="description"[^>]*>/, "")
      .replace("</head>", () => `  <meta name="description" content="${escapeHtml(docDescription(source))}" />\n  <link rel="alternate" type="text/markdown" href="${md}" />\n  </head>`)
      .replace('<div id="root"></div>', () => `<div id="root">${docPageHtml(page, source, examples)}</div>`);
    files.push({ file: docHtmlFile(page), content: html }, { file: md.slice(1), content: docPageMarkdown(page, source, examples) });
  }
  files.push({ file: "llms.txt", content: llmsTxt(sources) });
  return files;
}
