/**
 * The icon a client declared in initialize (clientInfo.icons, MCP 2025-11-25), kept only as a
 * raster data URI: no SVG (it can carry script) and no remote URL (fetching it would track the
 * visitor). The page shows it as an <img> when no curated logo matches the client (TIN-350).
 */
const DATA_URI = /^data:image\/(png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
export const CLIENT_ICON_MAX = 16_384;

export function pickClientIcon(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null;
  for (const icon of icons as Array<{ src?: unknown } | null>) {
    const src = icon?.src;
    if (typeof src === "string" && src.length <= CLIENT_ICON_MAX && DATA_URI.test(src)) return src;
  }
  return null;
}
