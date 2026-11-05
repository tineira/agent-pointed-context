/**
 * The site around the dock (TIN-627): a light landing at /, the demo at /try, and the developer's pages under
 * /build, one per profile and one for shipping both. Plain data, so the routing, the titles, the old anchors and
 * the footer can be tested without a browser.
 */

export const DOCK = "/dock";
/** The standard's docs (TIN-611): spec, integration guide, conformance. */
export const DOCS = "/docs";
export const REPO = "https://github.com/tineira/agent-pointed-context";
export const PAPER = "https://doi.org/10.5281/zenodo.23382909";
/** The companion record: the design records and the payload specification. */
export const RECORDS = "https://doi.org/10.5281/zenodo.23383101";
export const DESIGN = `${REPO}/blob/main/DESIGN.md`;
export const VIDEO = "https://youtu.be/pb46Sd0UOtM";
export const V1 = "/v1/";

export type SitePage = "landing" | "try" | "build" | "build-direct" | "build-dock" | "build-both";

/** Each page, its path and its title. */
export const SITE_PAGES: Record<SitePage, { path: string; title: string }> = {
  landing: { path: "/", title: "Agent Pointed Context: point your AI agent at what you see" },
  try: { path: "/try", title: "Try APC: your agent, two demo apps, one drag" },
  build: { path: "/build", title: "Build with APC: make your app pointable" },
  "build-direct": { path: "/build/direct", title: "Build with APC: the Direct profile" },
  "build-dock": { path: "/build/dock", title: "Build with APC: the Dock profile" },
  "build-both": { path: "/build/both", title: "Build with APC: ship both profiles" },
};

/** The page at a path, a trailing slash allowed; null for any other path (the dock, /docs, /extension). */
export function sitePageAt(pathname: string): SitePage | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const [page, { path: p }] of Object.entries(SITE_PAGES) as [SitePage, { path: string }][]) if (p === path) return page;
  return null;
}

/**
 * Where a shared link to the old one-page landing's sections goes now: `/#try` and `/#build` were anchors, which
 * never reach the server, so the page sends them on itself. Null when there is nothing to redirect.
 */
export function legacyAnchor(pathname: string, hash: string): string | null {
  if (pathname !== "/") return null;
  if (hash === "#try") return SITE_PAGES.try.path;
  if (hash === "#build") return SITE_PAGES.build.path;
  return null;
}

/** The footer's links; a page leaves out any it already links to, so the footer never repeats the page. */
export const FOOTER_LINKS = [
  { label: "Spec", href: `${DOCS}/spec` },
  { label: "Payload specification", href: RECORDS },
  { label: "Paper", href: PAPER },
  { label: "Version 1, as described in the paper →", href: V1 },
] as const;

export function footerLinks(onPage: readonly string[]): { label: string; href: string }[] {
  return FOOTER_LINKS.filter((l) => !onPage.includes(l.href));
}
