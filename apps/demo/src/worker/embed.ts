/**
 * Pulse's framing rules (TIN-1070, design TIN-1063 § 6.1). No Pulse page may be framed by any site, except one view:
 * the landing's hero, `GET /embed/hero`, which only `EMBED_PARENT_ORIGIN` (https://apc.tineira.com) may frame. That view
 * is its own bundle (embed-hero.html): it holds the chart, the agent bar and the connect panel, and none of the app's
 * other actions (Revoke, Allow, Start over, Wake, Settings), so nothing else of Pulse can be clicked through a frame.
 */
import { originOf } from "./dock-app.ts";

/** What the framing rules read from the Worker's `vars`. */
export interface EmbedEnv {
  /** The one origin that may frame /embed/hero: "https://apc.tineira.com". Never derived from a request. */
  EMBED_PARENT_ORIGIN?: string;
}

/** The parents a local `pnpm dev` may frame the hero from, besides EMBED_PARENT_ORIGIN: the site's dev server and a `vite preview`. */
export const LOCAL_DEV_PARENTS: readonly string[] = ["http://localhost:5202", "http://localhost:4173"];

const dev = () => !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

/** EMBED_PARENT_ORIGIN when it is exactly one https origin; null otherwise (then /embed/hero answers 404). */
export function embedParentOrigin(env: EmbedEnv): string | null {
  return originOf((env.EMBED_PARENT_ORIGIN ?? "").trim(), ["https:"]);
}

/** Every origin that may frame the hero: the configured one, and under `vite dev` only, the local parents. */
export function embedAncestors(parent: string): string[] {
  return dev() ? [parent, ...LOCAL_DEV_PARENTS] : [parent];
}

/**
 * The origin the embed posts its messages to and takes `apc:theme` from (the page's `<meta name="apc-embed-parent">`).
 * The configured parent; under `vite dev` only, a local parent named by the frame request's Referer.
 */
export function embedMessageOrigin(parent: string, referer: string | undefined): string {
  if (!dev() || !referer) return parent;
  try {
    const origin = new URL(referer).origin;
    return LOCAL_DEV_PARENTS.includes(origin) ? origin : parent;
  } catch {
    return parent;
  }
}

/** The hero view's policy: its own scripts and styles only, no third party, framed only by its parent(s). */
export function embedHeroCsp(ancestors: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors.join(" ")}`,
  ].join("; ");
}

/** True only if a policy explicitly forbids every framing (`frame-ancestors 'none'`): such a policy is kept as it is. */
export function forbidsFraming(csp: string | null): boolean {
  if (!csp) return false;
  return csp.split(";").some((d) => /^\s*frame-ancestors\s+'none'\s*$/i.test(d));
}

/** Exactly the hero's path. Anything else under /embed/ is a 404. */
export const EMBED_HERO_PATH = "/embed/hero";

/**
 * The headers every Pulse answer carries, set on `headers` in place. The hero's own 200 gets its policy; every other
 * answer (pages, the API, MCP, 404s, redirects) gets `frame-ancestors 'none'` unless it already forbids framing with a
 * fuller policy of its own (/connect/dock). X-Frame-Options: DENY everywhere, the hero too, for browsers without CSP3
 * (a CSP3 browser lets `frame-ancestors` win).
 */
export function applyFramingHeaders(headers: Headers, hero: { csp: string } | null): void {
  if (hero) headers.set("content-security-policy", hero.csp);
  else if (!forbidsFraming(headers.get("content-security-policy"))) headers.set("content-security-policy", "frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
}
