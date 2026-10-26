/**
 * The extension's pure parts (TIN-421, DESIGN.md 13): which docks it talks to, what it calls this
 * browser, and how it keeps one reader token per dock and agent. No chrome.* APIs here, so the tests run it.
 */

/** The docks this extension sends readings to. A drag naming any other hub is refused: a page could forge one. */
export const HUB_ORIGINS = ["https://v2.apc.tineira.com"];

/** A dock this extension talks to: a published one, or under a dev build one on localhost (test pages use 127.0.0.1). */
export function hubAllowed(origin: string, dev: boolean): boolean {
  return HUB_ORIGINS.includes(origin) || (dev && /^http:\/\/localhost:\d{1,5}$/.test(origin));
}

/** The match patterns of the docks themselves: the extension never takes drops there. */
export function hubPatterns(dev: boolean): string[] {
  return [...HUB_ORIGINS.map((o) => `${o}/*`), ...(dev ? ["http://localhost/*"] : [])];
}

/** "Chrome on Windows": how the dock names this browser when it asks the person. */
export function browserLabel(brands: ReadonlyArray<{ brand: string }> | undefined, platform: string | undefined, userAgent: string): string {
  const names = (brands ?? []).map((b) => b.brand);
  const browser = names.includes("Microsoft Edge") || /\bEdg\//.test(userAgent) ? "Edge" : names.includes("Google Chrome") ? "Chrome" : names.includes("Brave") ? "Brave" : names.includes("Opera") ? "Opera" : "Chromium";
  const os = platform || (/Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "");
  return os ? `${browser} on ${os}` : browser;
}

/** Where a reader token is kept: one per dock and agent, since the person allows each agent. */
export const readerKey = (hub: string, agent: string) => `${hub} ${agent}`;

/** A site the person can grant: an http(s) page's origin as a match pattern, or null. */
export function sitePattern(url: string | undefined): { origin: string; pattern: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { origin: u.origin, pattern: `${u.origin}/*` };
  } catch {
    return null;
  }
}

/** What the content script tells the person after a drop. */
export type DropStatus = "sent" | "asking" | "denied" | "timeout" | "no_ticket" | "unknown_dock" | "error";

export const STATUS_TEXT: Record<DropStatus, string> = {
  sent: "Sent to your agent",
  asking: "Allow this browser in your dock to send this page",
  denied: "Your dock said no: nothing was sent",
  timeout: "Your dock did not answer in time: nothing was sent",
  no_ticket: "Drag your agent again from your dock",
  unknown_dock: "This agent is from a dock this extension does not know: nothing was sent",
  error: "Could not reach your dock: nothing was sent",
};
