export const EXTENSION_DOWNLOAD = "https://github.com/tineira/agent-pointed-context/releases/download/apc-extension/apc-extension.zip";

/** Add the store URLs here when the listings are published (#82). The manual steps stay available. */
export const EXTENSION_STORES: { chrome: string | null; edge: string | null } = { chrome: null, edge: null };

export function extensionBrowser(userAgent: string): "chrome" | "edge" {
  return /\bEdg\//.test(userAgent) ? "edge" : "chrome";
}

export function extensionsAddress(browser: "chrome" | "edge"): string {
  return `${browser}://extensions`;
}
