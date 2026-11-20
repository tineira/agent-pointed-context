/**
 * The site's Content-Security-Policy (TIN-1013). The site shares the origin apc.tineira.com with the hub that
 * tineira/agent-dock deploys, so any script that runs on a site page runs as the dock's owner: it can call the
 * hub's same-origin APIs with their cookie. Only the site's own built files may run, no inline script, no eval,
 * no inline style, nothing fetched from another origin.
 *
 * One policy for every response: public/_headers carries the same string for what the asset binding serves
 * (scripts/test/site-csp.test.mjs checks they match), and the Worker sets it on its own responses (index.ts).
 * The built pages have no inline script; if one is ever needed, add its 'sha256-…' hash to script-src here and in
 * _headers: scripts/site-routes.mjs fails on any inline script of the build without a matching hash.
 *
 * img-src allows data: for the agent logos (agent-logos.ts embeds them as data: PNGs). The landing's icons and
 * manifest come from the hub on the same origin, so 'self' covers them.
 */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
