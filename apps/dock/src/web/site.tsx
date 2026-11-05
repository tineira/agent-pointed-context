/**
 * What every page of the site shares (TIN-627): the top bar, the footer, numbered steps and code blocks. The top
 * bar's Try it and Build it lead to their own pages, so a visitor can switch paths from anywhere; a visitor who
 * already has a dock also gets "Your dock".
 */
import { useEffect, useState, type ReactNode } from "react";
import { DOCK, DOCS, REPO, SITE_PAGES, footerLinks, type SitePage } from "./site-pages.ts";

/** Whether this visitor already has a dock (the Worker answers by cookie, TIN-610); false until it says so, and if it fails. */
function useHasDock(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/dock/mine", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { has_dock?: unknown } | null) => live && setHas(body?.has_dock === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return has;
}

/** Which top-bar link a page sits under: Try it for /try, Build it for every /build page. */
const section = (page: SitePage): "try" | "build" | null => (page === "try" ? "try" : page.startsWith("build") ? "build" : null);

export function SiteHeader(props: { page: SitePage }) {
  const hasDock = useHasDock();
  const here = section(props.page);
  return (
    <header className="landing-head">
      {props.page === "landing" ? <span className="kicker">Agent Pointed Context</span> : <a className="kicker" href="/">Agent Pointed Context</a>}
      <nav className="landing-nav" aria-label="Site">
        {hasDock && <a href={DOCK}>Your dock</a>}
        <a href={SITE_PAGES.try.path} aria-current={here === "try" ? "page" : undefined}>Try it</a>
        <a href={SITE_PAGES.build.path} aria-current={here === "build" ? "page" : undefined}>Build it</a>
        <a href={DOCS}>Docs</a>
        <a href={REPO}>GitHub</a>
      </nav>
    </header>
  );
}

/** The footer, without any link the page already has (`onPage`). */
export function SiteFooter(props: { onPage?: readonly string[] }) {
  return (
    <footer className="landing-foot">
      {footerLinks(props.onPage ?? []).map((l) => (
        <a key={l.href} className={l.href.startsWith("/v1") ? "muted" : undefined} href={l.href}>
          {l.label}
        </a>
      ))}
    </footer>
  );
}

export function Steps(props: { steps: { title: string; text: ReactNode }[] }) {
  return (
    <ol className="landing-steps">
      {props.steps.map((s, i) => (
        <li key={s.title}>
          <span className="landing-n">{i + 1}</span>
          <div>
            <b>{s.title}</b>
            <p>{s.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Code(props: { children: string; label?: string }) {
  return (
    <pre className="landing-code" aria-label={props.label}>
      <code>{props.children}</code>
    </pre>
  );
}
