/**
 * What every page of the site shares: the moving dot field + haze backdrop, the sticky header
 * (brand, nav: Try it, Build it, Docs, Spec, GitHub, plus the theme toggle), the footer
 * (keeping Spec, Payload specification, Paper, Version 1), numbered steps and code blocks.
 * It asks nothing of any server: the site holds no visitor state of its own.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { AgentMark } from "./agent-mark.tsx";
import { createDotField, type CanvasLike } from "./dot-field.ts";
import { DOCS, REPO, SITE_PAGES, footerLinks, type SitePage } from "./site-pages.ts";
import { currentTheme, subscribeTheme, useTheme } from "./theme.ts";

/** Which top-bar link a page sits under. */
const section = (page: SitePage): "try" | "build" | null => (page === "landing" ? null : page);

/** The fixed dot grid and slow haze behind the page, paused when hidden or under reduced motion. */
export function SiteBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const field = createDotField({
      canvas: canvas as unknown as CanvasLike,
      createOffscreenCanvas: () => document.createElement("canvas") as unknown as CanvasLike,
      getSize: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
      getScrollY: () => window.scrollY,
      isHidden: () => document.hidden,
      isReducedMotion: () => mq?.matches ?? false,
      getTheme: () => currentTheme(),
    });
    const onResize = () => field.resize();
    const onScroll = () => field.onScroll();
    const onPointer = (e: PointerEvent) => field.onPointerMove(e.clientX, e.clientY);
    const onVisibility = () => field.onVisibilityChange();
    const onMotion = () => field.onReducedMotionChange();
    const unsubTheme = subscribeTheme(() => field.onThemeChange());

    field.start();
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    mq?.addEventListener("change", onMotion);

    return () => {
      field.stop();
      unsubTheme();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      mq?.removeEventListener("change", onMotion);
    };
  }, []);

  return (
    <div className="site-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="site-field" />
      <div className="site-haze site-haze-a" />
      <div className="site-haze site-haze-b" />
    </div>
  );
}

export function SiteHeader(props: { page: SitePage }) {
  const here = section(props.page);
  const { theme, toggleTheme } = useTheme();
  const nextLabel = theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme";

  return (
    <header className="site-nav">
      <div className="wrap site-nav-inner">
        <a className="site-brand" href="/" aria-current={props.page === "landing" ? "page" : undefined}>
          <AgentMark size={28} track />
          Agent Pointed Context <small>APC</small>
        </a>
        <nav className="site-nav-links" aria-label="Site">
          <a href={SITE_PAGES.try.path} aria-current={here === "try" ? "page" : undefined}>Try it</a>
          <a href={SITE_PAGES.build.path} aria-current={here === "build" ? "page" : undefined}>Build it</a>
          <a href={DOCS}>Docs</a>
          <a href={`${DOCS}/spec`}>Spec</a>
          <a href={REPO} target="_blank" rel="noopener">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
        <div className="site-nav-right">
          <button
            className="site-theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={nextLabel}
            title="Light or dark. Follows your system until you choose."
          >
            <svg className="moon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
            </svg>
            <svg className="sun" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
            </svg>
          </button>
          <a className="btn ghost sm site-nav-cta" href={SITE_PAGES.build.path}>Add APC to your app</a>
          <a className="btn primary sm site-nav-cta" href={SITE_PAGES.try.path}>Try the demo</a>
        </div>
      </div>
    </header>
  );
}

/** The footer, keeping the current links without repeating any the page already has (`onPage`). */
export function SiteFooter(props: { onPage?: readonly string[] }) {
  const links = footerLinks(props.onPage ?? []);
  return (
    <footer className="site-foot">
      <div className="wrap site-foot-grid">
        <div>
          <a className="site-brand" href="/">
            <AgentMark size={26} />
            Agent Pointed Context
          </a>
          <p className="site-foot-fine">
            An open standard built on the Model Context Protocol. Code MIT; docs and spec CC BY 4.0. The agents' marks are trademarks of their owners.
          </p>
        </div>
        {links.length > 0 && (
          <div>
            <h5>Standard and research</h5>
            <ul>
              {links.map((l) => (
                <li key={l.href}>
                  <a className={l.href.startsWith("/v1") ? "muted" : undefined} href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
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
