/**
 * Shared pieces in the style of hue.tineira.com (hue-switch-console: app/page.tsx,
 * app/landing/theme-toggle.tsx, app/landing/parts-list.tsx, app/site-footer.tsx).
 */
import { useEffect, useState, type ReactNode } from "react";
import { applyTheme, chooseTheme, currentTheme, type ThemeId } from "./theme.ts";

export const PAPER_URL = "https://doi.org/10.5281/zenodo.23382909";
export const SPEC_URL = "https://doi.org/10.5281/zenodo.23383101";

export const BUTTON = "inline-flex min-h-[46px] cursor-pointer items-center rounded-lg px-5 text-[15px] font-medium";
export const PRIMARY = `${BUTTON} bg-filament text-filament-ink`;
export const SECONDARY = `${BUTTON} border border-line bg-background hover:border-filament`;
export const H2 = "text-[clamp(26px,3cqi,36px)] font-semibold leading-[1.1] tracking-[-0.025em]";
export const EYEBROW = "font-mono text-xs uppercase tracking-[0.08em] text-muted";
export const CARD_LABEL = "flex justify-between gap-3 px-[18px] py-3.5 font-mono text-[11px] uppercase tracking-[0.06em] text-muted";
export const CARD_HEADER = `${CARD_LABEL} border-b border-line`;
export const GROUP_LABEL = "text-[10px] font-medium uppercase tracking-[0.14em] text-muted";
export const ICON_BUTTON = "flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line bg-cream hover:border-filament";

/** The mark: an agent's square with its pin in the corner. */
export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative box-border block h-[18px] w-[18px] rounded-[4px] border-2 border-filament ${className}`}>
      <span className="absolute -right-[5px] -top-[5px] block h-[8px] w-[8px] rounded-full bg-filament ring-2 ring-background" />
    </span>
  );
}

/** Flips light and dark, like the toggle on hue.tineira.com. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeId | null>(null);
  useEffect(() => {
    const id = currentTheme();
    applyTheme(id);
    setTheme(id);
  }, []);
  const label = theme === "slate" ? "Switch to light" : "Switch to dark";
  return (
    <button
      type="button"
      onClick={() => {
        const next: ThemeId = (theme ?? currentTheme()) === "slate" ? "slate-light" : "slate";
        chooseTheme(next);
        setTheme(next);
      }}
      aria-label={label}
      title={label}
      className={ICON_BUTTON}
    >
      <span className="block h-4 w-4 rounded-full border-[1.5px] border-foreground bg-[linear-gradient(90deg,var(--foreground)_50%,transparent_50%)]" />
    </button>
  );
}

export function PaperIcon({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M5 2.5h7l3.5 3.5v11.5H5z" />
      <path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h5" strokeLinecap="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Client-side navigation: links inside the app push history instead of reloading. */
export function navigateTo(href: string): void {
  if (href === `${location.pathname}${location.search}`) return;
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function AppLink(props: { href: string; className?: string; children: ReactNode; "aria-labelledby"?: string }) {
  return (
    <a
      href={props.href}
      className={props.className}
      aria-labelledby={props["aria-labelledby"]}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigateTo(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

const PROFILE_LINK = "rounded p-1 text-muted transition-colors hover:text-foreground";
const TEXT_LINK = "hover:text-foreground hover:underline";

export function SiteFooter() {
  return (
    <footer className="mt-auto w-full border-t border-line">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 text-xs text-muted">
        <span>Built by Tomas Neira</span>
        <span className="flex items-center">
          <a href="https://github.com/tineira" target="_blank" rel="me noopener noreferrer" aria-label="Tomas Neira on GitHub" className={PROFILE_LINK}>
            <GitHubIcon />
          </a>
          <a href="https://x.com/tomneira" target="_blank" rel="me noopener noreferrer" aria-label="Tomas Neira on X" className={PROFILE_LINK}>
            <XIcon />
          </a>
        </span>
        <span aria-hidden="true">·</span>
        <AppLink href="/how-to" className={TEXT_LINK}>
          How-to
        </AppLink>
        <span aria-hidden="true">·</span>
        <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
          Paper
        </a>
        <span aria-hidden="true">·</span>
        <a href={SPEC_URL} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
          Payload spec
        </a>
        <span className="ml-auto">Synthetic data. Pulse is fictional.</span>
        <span className="basis-full">
          Claude, ChatGPT, Grok, Gemini, Antigravity, Cursor, Kimi, Z.ai, dots and other names and logos are trademarks of their respective owners, shown only to identify the
          connected agent. Pulse is not affiliated with any of them.
        </span>
      </div>
    </footer>
  );
}

/** A numbered row (hue: PartRow). */
export function PartRow(props: { n: string; name: string; text: ReactNode; link?: { href: string; label: string; external?: boolean }; active?: boolean }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 border-b border-line px-[18px] py-3 last:border-b-0">
      <span
        className={`grid h-6 w-6 place-items-center rounded-full border-[1.5px] font-mono text-filament ${props.active ? "border-filament" : "border-transparent"} ${props.n === "→" ? "text-sm" : "text-[13px]"}`}
      >
        {props.n}
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
          <span className="text-[15px] font-semibold">{props.name}</span>
          {props.link ? (
            props.link.external ? (
              <a href={props.link.href} target="_blank" rel="noopener noreferrer" className="text-sm text-filament hover:underline">
                {props.link.label}
              </a>
            ) : (
              <AppLink href={props.link.href} className="text-sm text-filament hover:underline">
                {props.link.label}
              </AppLink>
            )
          ) : null}
        </div>
        <span className="text-sm leading-normal text-muted">{props.text}</span>
      </div>
    </li>
  );
}
