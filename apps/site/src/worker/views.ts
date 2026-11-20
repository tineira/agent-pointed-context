/**
 * The site's page views, counted on the server in Workers Analytics Engine (TIN-1040). The site's CSP blocks
 * Cloudflare Web Analytics' beacon (no third-party script on the dock's origin), so the Worker counts instead: no
 * script in the browser, no cookie, and nothing that identifies a person. A point holds the page's path, the
 * referrer's host, the country Cloudflare gives, a device class from the user agent (never the user agent itself),
 * and whether the browser said it was navigating. No IP, not even hashed: without a secret salt a hash of an IPv4
 * address is reversible, so there is no visitor id and the count is of views, not people.
 * scripts/site-views.mjs reads it back.
 */

/** The Analytics Engine dataset the binding SITE_VIEWS writes to (wrangler.jsonc). */
export const SITE_VIEWS_DATASET = "apc_site_views";

/** The shape of Analytics Engine's AnalyticsEngineDataPoint, kept local so tests run under plain Node. */
export interface ViewPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
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

/** The referrer's host, lower case, or "" when there is none or it is not an http(s) URL. */
export function referrerHost(referer: string | null): string {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host.toLowerCase().slice(0, 100) : "";
  } catch {
    return "";
  }
}

/** Whether the response is a page someone viewed: a GET answered 200 with HTML, outside the asset and media paths. */
export function isPageView(request: Request, response: Response): boolean {
  if (request.method !== "GET" || response.status !== 200) return false;
  if (!/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return false;
  const path = new URL(request.url).pathname;
  return !path.startsWith("/site-assets/") && !path.startsWith("/media/");
}

/**
 * One point for a page view, or null when the response is not one. index1 and blob1 the path (no query: it may carry
 * anything), blob2 the referrer's host, blob3 the country, blob4 the device class, blob5 how the browser fetched it
 * (Sec-Fetch-Dest "document" for a page load; "prefetch" when it only prefetched; "" when it did not say); double1 is 1.
 */
export function viewPoint(request: Request, response: Response): ViewPoint | null {
  if (!isPageView(request, response)) return null;
  const path = new URL(request.url).pathname.slice(0, 200);
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : (request.headers.get("cf-ipcountry") ?? "");
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  const fetched = /prefetch|prerender/i.test(purpose) ? "prefetch" : (request.headers.get("sec-fetch-dest") ?? "").slice(0, 20);
  return {
    indexes: [path.slice(0, 96)],
    blobs: [path, referrerHost(request.headers.get("referer")), country.slice(0, 2).toUpperCase(), deviceClass(request.headers.get("user-agent")), fetched],
    doubles: [1],
  };
}
