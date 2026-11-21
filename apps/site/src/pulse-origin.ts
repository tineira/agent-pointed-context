/**
 * Pulse's origin, as the site frames its hero view (TIN-1071) and links it: the production one. Under `vite dev`, and
 * in a build made with `--mode local-pulse` for `vite preview`, vite.config.ts swaps this file for
 * pulse-origin.local.ts (the local Pulse of `pnpm dev`), so a production build holds the production origin only
 * (scripts/site-routes.mjs checks the built files). The site's CSP builds its one frame-src from it (worker/csp.ts).
 */
export const PULSE_ORIGIN = "https://pulse.apc.tineira.com";
