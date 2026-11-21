import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./landing.tsx";
import { TryPage } from "./try.tsx";
import { BuildPage } from "./build.tsx";
import { legacyAnchor, SITE_PAGES, sitePageAt, type SitePage } from "./site-pages.ts";
import { Docs } from "./docs.tsx";
import { isDocsPath } from "../docs/pages.ts";
import "./site.css";

const path = location.pathname;
// The one-page landing's old anchors (/#try, /#build) never reach the server: send them on to their pages.
const moved = legacyAnchor(path, location.hash);
if (moved) location.replace(moved);
// The same anchors followed on the landing itself change only the hash, with no new load.
if (path === "/") window.addEventListener("hashchange", () => {
  const to = legacyAnchor(location.pathname, location.hash);
  if (to) location.replace(to);
});
const page = sitePageAt(path);
const SITE: Record<SitePage, ComponentType> = {
  landing: Landing,
  try: TryPage,
  build: BuildPage,
};
if (page) document.title = SITE_PAGES[page].title;
// /docs: the standard's docs (TIN-611); each page sets its own title.
const Page = page ? SITE[page] : null;
if (!moved) {
  createRoot(document.getElementById("root")!).render(
    Page ? <Page /> : isDocsPath(path) ? <Docs path={path} /> : <main><h1>Page not found</h1><a href="/">APC home</a></main>,
  );
}
