/**
 * The pages of apc.tineira.com/docs, in their order. Each is a Markdown file in the repo: the docs' own
 * (apps/dock/src/docs/pages) or the standard's changelog (packages/protocol/CHANGELOG.md), rendered by the
 * dock's page (src/web/docs.tsx). Pure, so the link check reads the same list.
 */

export interface DocPage {
  /** The page's path on the site. */
  path: string;
  /** Its name in the docs' navigation. */
  nav: string;
  /** Its source, from the repo root. */
  file: string;
}

export const DOCS_ROOT = "/docs";
/** Where the examples live, from the repo root: `<!-- include file.ts#region -->` names a file here. */
export const EXAMPLES_DIR = "apps/dock/src/docs/examples";

export const DOC_PAGES: readonly DocPage[] = [
  { path: "/docs", nav: "Overview", file: "apps/dock/src/docs/pages/overview.md" },
  { path: "/docs/spec", nav: "Spec", file: "apps/dock/src/docs/pages/spec.md" },
  { path: "/docs/integrate", nav: "Integrate", file: "apps/dock/src/docs/pages/integrate.md" },
  { path: "/docs/conformance", nav: "Conformance", file: "apps/dock/src/docs/pages/conformance.md" },
  { path: "/docs/agents", nav: "For agents", file: "apps/dock/src/docs/pages/agents.md" },
  { path: "/docs/changelog", nav: "Changelog", file: "packages/protocol/CHANGELOG.md" },
];

/** The page at a path (a trailing slash allowed), or null. */
export function docPageAt(pathname: string): DocPage | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return DOC_PAGES.find((p) => p.path === path) ?? null;
}

/** Whether a path is in the docs (a page or not). */
export function isDocsPath(pathname: string): boolean {
  return pathname === DOCS_ROOT || pathname.startsWith(`${DOCS_ROOT}/`);
}

/** The site's other pages a docs page may link to (served by the dock's Worker and its assets, or by V1). */
export const SITE_PATHS: readonly string[] = ["/", "/try", "/build", "/build/direct", "/build/dock", "/build/both", "/dock", "/extension", "/v1/", "/.well-known/apc.json"];
