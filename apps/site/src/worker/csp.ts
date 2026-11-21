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
 * The landing at / reaches the browser through the hub's proxy (tineira/agent-dock), which keeps this policy whole
 * because it forbids every framing (`frame-ancestors 'none'`; TIN-1036): drop that directive and the hub replaces
 * the policy with `frame-ancestors 'none'` alone. `scripts/dock-pairing.mjs --production` reads it back on / and
 * /docs/spec.
 *
 * img-src allows data: for the agent logos (agent-logos.ts embeds them as data: PNGs). The landing's icons and
 * manifest come from the hub on the same origin, so 'self' covers them.
 *
 * frame-src allows one thing, by Tomas's decision (TIN-1063, TIN-1071): Pulse's views under /embed/, which the landing
 * mounts only after "Use your own agent" (the hero view, https://pulse.apc.tineira.com/embed/hero). The path prefix
 * keeps every other Pulse page out of a frame here, even if Pulse lost its own framing headers. connect-src stays
 * 'self': the frame talks to the landing by postMessage only. No page of the build carries an <iframe> (site-csp.mjs).
 */
import { PULSE_ORIGIN } from "../pulse-origin.ts";

/** The one source frame-src allows: Pulse's embeddable views. */
export const PULSE_EMBED_FRAMES = `${PULSE_ORIGIN}/embed/`;

export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${PULSE_EMBED_FRAMES}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
