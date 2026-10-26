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

/** Every page: the one browser grant the welcome page asks for (TIN-465, DESIGN.md 13.3). */
export const ANY_PAGE = ["https://*/*", "http://*/*"];

/** "ask": the first drop on a site asks the person. "never_ask": every drop is sent at once, everywhere. */
export type Mode = "ask" | "never_ask";
/** What the person chose for a site, kept by the extension. */
export type SiteChoice = "always" | "never";
/** What the person answered on the card. */
export type Consent = "once" | "always" | "never";

/** What happens to a drop before anything is sent. */
export type Decision = "send" | "ask" | "ask_sensitive" | "blocked";

const MAIL_HOSTS = ["mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "mail.proton.me", "app.fastmail.com", "mail.zoho.com", "www.icloud.com"];
const SENSITIVE_WORDS = /bank|banco|banca|banque|bancaria|credit|health|salud|sante|clinic|clinica|hospital|medic|pharma|farmacia|isapre|fonasa|insurance|seguro/;

/**
 * A bank, email, health or government site: built in, by host (TIN-465). Such a site always asks and
 * never offers "Always"; making the list editable is TIN-423.
 */
export function isSensitive(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (MAIL_HOSTS.includes(h)) return true;
  const labels = h.split(".");
  if (labels.some((l) => l === "gov" || l === "gob" || l === "mil")) return true;
  return labels.slice(0, -1).some((l) => SENSITIVE_WORDS.test(l));
}

/**
 * Whether the person granted this page's site by itself (from the popup), not only through the grant
 * for any page: a match pattern for its scheme and host. A pattern names no port, so it covers them all.
 */
export function grantedAlone(origin: string, patterns: readonly string[]): boolean {
  const u = new URL(origin);
  return patterns.some((p) => {
    if (ANY_PAGE.includes(p)) return false;
    const m = p.match(/^(https?|\*):\/\/([^/]+)\/\*$/);
    if (!m) return false;
    const [, scheme, host] = m as unknown as [string, string, string];
    const hostname = host.replace(/:\d+$/, "");
    return (scheme === "*" || `${scheme}:` === u.protocol) && (hostname === u.hostname || (hostname.startsWith("*.") && u.hostname.endsWith(hostname.slice(1))));
  });
}

/**
 * Whether a drop is sent, asks, or is refused. "Never ask" sends everything. A site the person said
 * "Not here" to never sends. A sensitive site always asks. A site marked Always, or granted by itself
 * from the popup, sends. Any other site asks.
 */
export function decide(mode: Mode, choice: SiteChoice | undefined, sensitive: boolean, grantedAlone: boolean): Decision {
  if (mode === "never_ask") return "send";
  if (choice === "never") return "blocked";
  if (sensitive) return "ask_sensitive";
  if (choice === "always" || grantedAlone) return "send";
  return "ask";
}

/** What the content script tells the person after a drop. */
export type DropStatus = "sent" | "asking" | "denied" | "timeout" | "no_ticket" | "unknown_dock" | "error" | "consent" | "consent_sensitive" | "blocked" | "not_here";

export const STATUS_TEXT: Record<DropStatus, string> = {
  sent: "Sent to your agent",
  asking: "Allow this browser in your dock to send this page",
  denied: "Your dock said no: nothing was sent",
  timeout: "Your dock did not answer in time: nothing was sent",
  no_ticket: "Drag your agent again from your dock",
  unknown_dock: "This agent is from a dock this extension does not know: nothing was sent",
  error: "Could not reach your dock: nothing was sent",
  consent: "Send this to your agent?",
  consent_sensitive: "This looks like a bank, email, health or government site. Send this to your agent?",
  blocked: "You chose not to send from this site. Change it in the APC extension.",
  not_here: "Nothing was sent. Drops here will not be sent; change it in the APC extension.",
};
