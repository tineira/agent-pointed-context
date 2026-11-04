/**
 * The APC docs at /docs (TIN-611): the standard's overview, spec, integration guide, conformance, a page for
 * agents and the standard's changelog. Markdown files in the repo (src/docs/pages, packages/protocol/CHANGELOG.md),
 * bundled as text and rendered here as React elements; code samples come from the type-checked, tested examples
 * in src/docs/examples. Static, like the landing: the Worker never runs for /docs.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { APC_STANDARD_VERSION } from "@tineira/apc-protocol";
import { exampleRegion, fragmentTarget, parseMarkdown, plainText, REPO, resolveHref, type Block, type Inline } from "../docs/markdown.ts";
import { DOC_PAGES, docPageAt, EXAMPLES_DIR, type DocPage } from "../docs/pages.ts";
import overview from "../docs/pages/overview.md?raw";
import spec from "../docs/pages/spec.md?raw";
import integrate from "../docs/pages/integrate.md?raw";
import conformance from "../docs/pages/conformance.md?raw";
import agents from "../docs/pages/agents.md?raw";
import changelog from "../../../../packages/protocol/CHANGELOG.md?raw";

const SOURCES: Record<string, string> = {
  "/docs": overview,
  "/docs/spec": spec,
  "/docs/integrate": integrate,
  "/docs/conformance": conformance,
  "/docs/agents": agents,
  "/docs/changelog": changelog,
};

const EXAMPLES = Object.fromEntries(
  Object.entries(import.meta.glob("../docs/examples/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>).map(([path, text]) => [path.split("/").pop()!, text]),
);

function Inlines({ nodes, file }: { nodes: Inline[]; file: string }): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === "text") return n.v;
    if (n.t === "code") return <code key={i}>{n.v}</code>;
    if (n.t === "strong") return <strong key={i}><Inlines nodes={n.c} file={file} /></strong>;
    if (n.t === "em") return <em key={i}><Inlines nodes={n.c} file={file} /></em>;
    const href = resolveHref(n.href, file);
    // A link with a scheme that is not http(s) or mailto is shown as its text, never as a link.
    return href ? <a key={i} href={href}><Inlines nodes={n.c} file={file} /></a> : <span key={i}><Inlines nodes={n.c} file={file} /></span>;
  });
}

function Blocks({ blocks, file }: { blocks: Block[]; file: string }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "heading": {
        const H = `h${Math.min(b.level, 4)}` as "h1" | "h2" | "h3" | "h4";
        return (
          <H key={i} id={b.id}>
            <Inlines nodes={b.c} file={file} />
            {b.level > 1 && <a className="docs-anchor" href={`#${b.id}`} aria-label={`Link to ${plainText(b.c)}`}>#</a>}
          </H>
        );
      }
      case "para":
        return <p key={i}><Inlines nodes={b.c} file={file} /></p>;
      case "list": {
        const items = b.items.map((item, j) => <li key={j}><Inlines nodes={item} file={file} /></li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case "code":
        return <pre key={i} className="docs-pre"><code>{b.v}</code></pre>;
      case "table":
        return (
          <div key={i} className="docs-table">
            <table>
              <thead><tr>{b.head.map((c, j) => <th key={j}><Inlines nodes={c} file={file} /></th>)}</tr></thead>
              <tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((c, j) => <td key={j}><Inlines nodes={c} file={file} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      case "quote":
        return <blockquote key={i}><Blocks blocks={b.c} file={file} /></blockquote>;
      case "include": {
        const code = exampleRegion(EXAMPLES[b.file] ?? "", b.region);
        const path = `${EXAMPLES_DIR}/${b.file}`;
        return (
          <figure key={i} className="docs-example">
            <figcaption><a href={`${REPO}/blob/main/${path}`}>{b.file}</a></figcaption>
            <pre className="docs-pre"><code>{code ?? `(missing: ${b.file}#${b.region})`}</code></pre>
          </figure>
        );
      }
    }
  });
}

function Nav({ current }: { current: DocPage | null }) {
  return (
    <nav className="docs-nav" aria-label="Docs">
      {DOC_PAGES.map((p) => (
        <a key={p.path} href={p.path} aria-current={p === current ? "page" : undefined}>{p.nav}</a>
      ))}
    </nav>
  );
}

export function Docs({ path }: { path: string }) {
  const page = docPageAt(path);
  const blocks = useMemo(() => (page ? parseMarkdown(SOURCES[page.path] ?? "") : []), [page]);
  const titleBlock = blocks.find((b) => b.t === "heading" && b.level === 1);
  const title = titleBlock?.t === "heading" ? plainText(titleBlock.c) : "Not found";
  useEffect(() => {
    document.title = `${title} · APC docs`;
  }, [title]);
  useEffect(() => {
    // The page renders after load, so the browser could not scroll to #anchor itself.
    const id = fragmentTarget(location.hash);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [page]);
  return (
    <main className="docs">
      <header className="docs-head">
        <a className="kicker" href="/">Agent Pointed Context</a>
        <span className="row small">
          <a href="/dock">Your dock</a>
          <a href={REPO}>GitHub</a>
        </span>
      </header>
      <Nav current={page} />
      <aside className="docs-draft" role="note">
        <b>Draft.</b> The APC standard is at {APC_STANDARD_VERSION}, a 0.x draft: any release may still change the contract. Version 1.0 will freeze it, and from then on it changes only by the <a href="/docs/spec#versioning-and-deprecation">versioning and deprecation policy</a>.
      </aside>
      <article className="docs-body">
        {page ? <Blocks blocks={blocks} file={page.file} /> : (
          <>
            <h1>No such page</h1>
            <p>There is no docs page at {path}. Start from the <a href="/docs">overview</a>.</p>
          </>
        )}
      </article>
      <footer className="docs-foot">
        <p>
          The text of these docs and of the APC specification is licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; the code, the examples included, is MIT.
          {page && <> Source of this page: <a href={`${REPO}/blob/main/${page.file}`}>{page.file}</a>.</>}
        </p>
        <p>
          <a href="/">Home</a> · <a href="/v1/">Version 1, as described in the paper</a>
        </p>
      </footer>
    </main>
  );
}
