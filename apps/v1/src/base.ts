/**
 * Where V1 lives on its host (TIN-604): apc.tineira.com/v1. The page, its API, the MCP URLs and every
 * link V1 hands out are under it. vite.config.ts (base) and wrangler.jsonc (assets.base_path) match.
 */
export const BASE = "/v1";

/** A path of V1's, from a path written as if V1 were at the root: "/overview" → "/v1/overview". */
export const withBase = (path: string): string => (path === "/" ? `${BASE}/` : `${BASE}${path}`);

/** The path inside V1 ("/v1/overview" → "/overview", "/v1" → "/"); a path outside V1 comes back as is. */
export function stripBase(pathname: string): string {
  if (pathname === BASE) return "/";
  return pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : pathname;
}
