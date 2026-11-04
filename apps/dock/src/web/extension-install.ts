/** The extension the dock was built with, served from its own assets (apps/dock/vite.config.ts): the version the out-of-date notice compares with is this zip's. The GitHub release apc-extension is a second copy. */
export const EXTENSION_DOWNLOAD = "/extension/apc-extension.zip";

/** Add the store URLs here when the listings are published (#82). The manual steps stay available. */
export const EXTENSION_STORES: { chrome: string | null; edge: string | null } = { chrome: null, edge: null };

export function extensionBrowser(userAgent: string): "chrome" | "edge" {
  return /\bEdg\//.test(userAgent) ? "edge" : "chrome";
}

export function extensionsAddress(browser: "chrome" | "edge"): string {
  return `${browser}://extensions`;
}
