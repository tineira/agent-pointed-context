/**
 * V1's Content-Security-Policy (TIN-1038). V1 is frozen, but it shares the origin apc.tineira.com with the dock hub
 * (Worker apc-dock, deployed from tineira/agent-dock), so a script that runs on a V1 page runs as the dock's owner.
 * This header changes nothing on the page: it only stops what the page never does.
 *
 * - script-src: V1's own built files, plus the one inline script of v1/index.html (the theme before first paint), by
 *   its hash. If that script changes, its hash changes here and in public/_headers (test/csp.test.ts fails until then).
 * - style-src and font-src: Google Fonts (Geist). Styles keep 'unsafe-inline': V1 adds two <style> elements at run
 *   time (src/apc/web/agents-bar.ts, pin-badge.ts) and sets style attributes; that is styling, not script.
 * - img-src data: for the agent logos (src/web/agent-logos.ts embeds them as data: PNGs).
 * - connect-src 'self' covers the page's API and its WebSocket on the same host.
 * - object-src, base-uri, frame-ancestors and form-action close the rest; X-Frame-Options says the same to old browsers.
 *
 * One policy for every page response: public/_headers carries the same string for what the assets serve (the
 * platform applies it only there), and the Worker sets it on the page it serves for an app route (index.ts).
 */
export const V1_CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-TEEpJvERoenA4/WV8tDuL8nB+tyeth7ZaMrIcBGqRV0='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** The response with V1's CSP and frame protection; the headers of an asset response are immutable, so a copy. */
export function withCsp(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("content-security-policy", V1_CSP);
  result.headers.set("x-frame-options", "DENY");
  return result;
}
