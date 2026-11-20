/**
 * The site's page views, counted on the server in Workers Analytics Engine (TIN-1040). The site's CSP blocks
 * Cloudflare Web Analytics' beacon (no third-party script on the dock's origin), so the Worker counts instead: no
 * script in the browser, no cookie, and nothing that identifies a person. A point holds which page it was (one of
 * the site's own pages, or "(other)": never the text a visitor typed in the address), the referrer's host name, the
 * country Cloudflare gives, a device class from the user agent (never the user agent itself), and whether the
 * browser said it was loading the page or only prefetching it. No IP, not even hashed: without a secret salt a hash
 * of an IPv4 address is reversible, so there is no visitor id and the count is of views, not people.
 * scripts/site-views.mjs reads it back.
 */
import { DOC_PAGES } from "../docs/pages.ts";
import { SITE_PAGES } from "../web/site-pages.ts";

/** The Analytics Engine dataset the binding SITE_VIEWS writes to (wrangler.jsonc). */
export const SITE_VIEWS_DATASET = "apc_site_views";

/** The page name of any path that is not one of the site's pages (an old link, a typo, a probe). */
export const OTHER_PAGE = "(other)";

/** The site's pages: its own (/, /try, /build…) and the docs. Nothing else is ever stored as a path. */
const PAGES = new Set([...Object.values(SITE_PAGES).map((p) => p.path), ...DOC_PAGES.map((p) => p.path)]);

/** The shape of Analytics Engine's AnalyticsEngineDataPoint, kept local so tests run under plain Node. */
export interface ViewPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** The page a path is (a trailing slash allowed), or OTHER_PAGE. */
export function pageOf(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGES.has(path) ? path : OTHER_PAGE;
}

/** User agents that are not a person reading: crawlers, link previews, monitors, scripts, and our own checks. */
const BOT = /bot\b|bot\/|crawl|spider|slurp|preview|monitor|uptime|lighthouse|headless|curl\/|wget\/|python|httpx|axios|node-fetch|undici|okhttp|go-http|java\/|libwww|facebookexternalhit|embedly|whatsapp|apc-[a-z-]+\//i;

/** "bot", "mobile", "tablet" or "desktop", from the user agent; an empty one is a bot. */
export function deviceClass(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (!ua.trim() || BOT.test(ua)) return "bot";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
}

/** The referrer's host name (no port), lower case, or "" when there is none or it is not an http(s) URL. */
export function referrerHost(referer: string | null): string {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase().slice(0, 100) : "";
  } catch {
    return "";
  }
}

/** How the browser fetched it: "document" (a page load), "prefetch", "" when it did not say, or "other". */
export function fetchKind(request: Request): string {
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  if (/prefetch|prerender/i.test(purpose)) return "prefetch";
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === null || dest === "") return "";
  return dest === "document" ? "document" : "other";
}

/**
 * Whether the response is a page someone viewed: a GET outside the asset and media paths, answered 200 with HTML, or
 * 304 on one of the site's pages (a returning browser revalidating its copy: a view too).
 */
export function isPageView(request: Request, response: Response): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/site-assets/") || path.startsWith("/media/")) return false;
  if (response.status === 304) return pageOf(path) !== OTHER_PAGE;
  return response.status === 200 && /^text\/html\b/i.test(response.headers.get("content-type") ?? "");
}

/**
 * One point for a page view, or null when the response is not one. index1 and blob1 the page (pageOf), blob2 the
 * referrer's host name, blob3 the country, blob4 the device class, blob5 the fetch kind (fetchKind); double1 is 1.
 */
export function viewPoint(request: Request, response: Response): ViewPoint | null {
  if (!isPageView(request, response)) return null;
  const page = pageOf(new URL(request.url).pathname);
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : (request.headers.get("cf-ipcountry") ?? "");
  return {
    indexes: [page],
    blobs: [page, referrerHost(request.headers.get("referer")), country.slice(0, 2).toUpperCase(), deviceClass(request.headers.get("user-agent")), fetchKind(request)],
    doubles: [1],
  };
}
