/**
 * The hero view's entry (embed-hero.html, TIN-1070): the one Pulse page apc.tineira.com may frame. Its own bundle: it
 * never imports the app (App.tsx), its router, its agent bar with Revoke, its Agents page, Start over, Wake or the
 * dock's consent. Opened top level, it goes to Pulse itself (the Worker redirects a top-level visit too).
 */
// Under `vite dev` only, React's Fast Refresh preamble as a module (the page's policy allows no inline script); empty in a build.
import "@vitejs/plugin-react/preamble";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EmbedHero } from "./embed/Hero.tsx";
import { createPoster, parentOriginFrom, themeFrom, type Scheme } from "./embed/messages.ts";

if (window.self === window.top) {
  location.replace("/");
} else {
  const parentOrigin = parentOriginFrom(document.querySelector('meta[name="apc-embed-parent"]')?.getAttribute("content"));
  const poster = createPoster(parentOrigin, window.parent);

  // The theme: the parent's, once it says (apc:theme); until then, the system's (embed.css follows prefers-color-scheme).
  const setScheme = (scheme: Scheme) => document.documentElement.setAttribute("data-scheme", scheme);
  window.addEventListener("message", (event) => {
    const scheme = themeFrom(event, parentOrigin, window.parent);
    if (scheme) setScheme(scheme);
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <EmbedHero poster={poster} />
    </StrictMode>,
  );

  // The view's height, for the landing to size the frame (it clamps it): on every change of the page's size. The body's
  // own box, not the document's scrollHeight, which never drops below the frame's height: the frame can shrink back too.
  const measure = () => poster.resize(document.body.getBoundingClientRect().height);
  new ResizeObserver(measure).observe(document.body);
  measure();
}
