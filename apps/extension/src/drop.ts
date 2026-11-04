/**
 * The extension's pure parts (TIN-421, DESIGN.md 13): which docks it talks to, what it calls this
 * browser, and how it keeps one reader token per dock and agent. No chrome.* APIs here, so the tests run it.
 */
import { APC_JSON_MAX_BYTES, APC_JSON_PATH, parseApcManifest } from "@apc/protocol";

/** An APC app that connects agents only directly (APC 0.5): what the extension tells a person who drops a dock agent on it. */
export interface DirectOnly {
  /** What the page calls itself in its apc.json: its own word, never vouched for. */
  name: string;
  /** The page's host: what the card puts first, as the dock names an app it does not know. */
  host: string;
  /** The app's page where the person connects an agent directly, on its own origin. */
  connect: string | null;
  message: string;
}

/**
 * The extension's words on a Direct-only app. They come from the extension, so they lend it no
 * authority: the domain first, and the name only as what the page says it is.
 */
export function directOnlyCardText(name: string, host: string): string {
  return `This page says it is "${name}" (${host}). It connects agents directly, not through a dock: connect your agent to it on its own URL, then drag its mark from the agent bar there.`;
}

/**
 * What the extension makes of an APC app's apc.json: an app that lists no "dock" gets the answer;
 * an app that offers Dock, a hub, or a file that is not a valid apc.json of that origin gets null, and
 * the extension stands back, as before.
 */
export function directOnlyAnswer(raw: unknown, origin: string): DirectOnly | null {
  const parsed = parseApcManifest(raw, origin);
  if (!parsed.ok) return null;
  const m = parsed.manifest;
  if (m.profiles.includes("dock") || m.profiles.includes("hub")) return null;
  const host = new URL(origin).host;
  return { name: m.name, host, connect: m.direct?.connect ?? null, message: directOnlyCardText(m.name, host) };
}

/**
 * A page's apc.json as the extension read it: the answer, and whether the file was read at all. `read`
 * is false when nothing could be told (no file, an error, no answer): a guess the service worker keeps
 * only briefly. A file read and understood, Direct-only or not, is a real answer.
 */
export interface DirectOnlyLookup {
  directOnly: DirectOnly | null;
  read: boolean;
}

/**
 * Read a page's apc.json from its own origin (APC 0.5), for the answer to a drop on a Direct-only app:
 * no cookies, no redirect, 3 s and APC_JSON_MAX_BYTES at most.
 */
export async function lookUpDirectOnly(origin: string, fetcher: typeof fetch = fetch): Promise<DirectOnlyLookup> {
  const unknown = { directOnly: null, read: false };
  try {
    const r = await fetcher(`${origin}${APC_JSON_PATH}`, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    if (!r.ok || !r.body) return unknown;
    // Read up to the cap, never the whole of whatever a page serves there.
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > APC_JSON_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return unknown;
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    const raw = JSON.parse(new TextDecoder().decode(all)) as unknown;
    return { directOnly: directOnlyAnswer(raw, origin), read: parseApcManifest(raw, origin).ok };
  } catch {
    return unknown;
  }
}

/** How long the service worker keeps what a page's apc.json said: a real answer, and a lookup that told nothing. */
export const LOOKUP_KEEP_MS = 5 * 60_000;
export const LOOKUP_KEEP_UNKNOWN_MS = 30_000;

/**
 * What the extension does with a dock agent's drag over an APC app, on one page (APC 0.5). The app's
 * apc.json is read once, on the first drag. A page that answers drops itself (APC_DROPS_ATTR, set by
 * @apc/web) is left alone. Otherwise the drop is taken while the app may be Direct-only: once its file
 * says so, and while the lookup is still on its way, so a quick first drop is never lost; a drop taken
 * during the lookup is answered when the lookup comes back, or let go if the app turns out to take dock
 * agents.
 */
export function directOnlyGate(lookUp: () => Promise<DirectOnly | null>, pageAnswers: () => boolean) {
  let pending: Promise<DirectOnly | null> | null = null;
  let known: DirectOnly | null | undefined;
  const start = () =>
    (pending ??= lookUp()
      .catch(() => null)
      .then((answer) => (known = answer)));
  return {
    /** The agent is dragged over the page: start reading its file. */
    start(): void {
      void start();
    },
    /** dragover: whether the extension takes the drop (the browser refuses it otherwise). */
    accepts(): boolean {
      void start();
      return !pageAnswers() && known !== null;
    },
    /**
     * drop: `now` when the answer is known (the extension answers, and keeps the page's own handlers from
     * answering too), `later` while the lookup is on its way, or null to stand back.
     */
    drop(): { now: DirectOnly } | { later: Promise<DirectOnly | null> } | null {
      if (pageAnswers()) return null;
      if (known) return { now: known };
      if (known === null) return null;
      return { later: start() };
    },
  };
}

/** The docks this extension sends readings to. A drag naming any other hub is refused: a page could forge one. */
export const HUB_ORIGINS = ["https://apc.tineira.com"];

/** A dock this extension talks to: a published one, or under a dev build one on localhost (test pages use 127.0.0.1). */
export function hubAllowed(origin: string, dev: boolean): boolean {
  return HUB_ORIGINS.includes(origin) || (dev && /^http:\/\/localhost:\d{1,5}$/.test(origin));
}

/**
 * The paths of a dock's host that are the dock itself: the landing, the dock window and the install page.
 * The host is shared with V1 (apc.tineira.com/v1/), which is an ordinary page to the extension.
 */
const DOCK_PATHS = ["/", "/?*", "/dock*", "/extension*"];

/** The match patterns of the docks themselves: the extension never takes drops there. Under a dev build, any localhost page. */
export function hubPatterns(dev: boolean): string[] {
  return [...HUB_ORIGINS.flatMap((o) => DOCK_PATHS.map((p) => `${o}${p}`)), ...(dev ? ["http://localhost/*"] : [])];
}

/** Whether a page is a dock's own: a path of a dock's host that is not V1 (or anything else sharing the host). */
export function isDockPage(url: string | undefined, dev: boolean): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (dev && u.protocol === "http:" && u.hostname === "localhost") return true;
    return HUB_ORIGINS.includes(u.origin) && (u.pathname === "/" || /^\/(dock|extension)/.test(u.pathname));
  } catch {
    return false;
  }
}

/** The granted host patterns that are a dock's whole host in a dev build: the extension never takes drops there either. */
export function devHubHosts(dev: boolean): string[] {
  return dev ? ["http://localhost/*"] : [];
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
/** What the person chose for a site, kept by the extension. "sensitive": always ask, never offer Always (TIN-478). */
export type SiteChoice = "always" | "never" | "sensitive";
/** What the person answered on the card. */
export type Consent = "once" | "always" | "never";

/** What happens to a drop before anything is sent. */
export type Decision = "send" | "ask" | "ask_sensitive" | "blocked";

/**
 * A sensitive site by its domain alone (TIN-478): a government domain (a gov, gob or mil label, as in
 * sii.gob.cl or gov.uk) or the restricted .bank and .insurance TLDs, which only verified institutions
 * can register. Nothing is guessed from a site's name: no list could keep a promise to recognise every
 * bank, email or health site, so the person marks any other site sensitive themselves (SiteChoice).
 */
export function isSensitive(host: string): boolean {
  const labels = host.toLowerCase().replace(/:\d+$/, "").split(".");
  if (labels.some((l) => l === "gov" || l === "gob" || l === "mil")) return true;
  const tld = labels.at(-1);
  return tld === "bank" || tld === "insurance";
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
 * "Not here" to never sends. A sensitive site, by its domain or marked by the person, always asks. A
 * site marked Always, or granted by itself from the popup, sends. Any other site asks.
 */
export function decide(mode: Mode, choice: SiteChoice | undefined, sensitive: boolean, grantedAlone: boolean): Decision {
  if (mode === "never_ask") return "send";
  if (choice === "never") return "blocked";
  if (sensitive || choice === "sensitive") return "ask_sensitive";
  if (choice === "always" || grantedAlone) return "send";
  return "ask";
}

/** The agent's mark for the pin on the page (TIN-469): its name, its PNG badge if the dock drew one, and which reading it marks. */
export interface PinMark {
  name: string;
  icon: string | null;
  taken_at: string;
}

/** A pin's state: not read yet, read by the agent, or replaced by a newer drop at the dock. */
export type PinState = "unread" | "read" | "stale";

/** What the dock's answer means for a pin taken at taken_at. */
export function pinState(takenAt: string, latest: string | null | undefined, read: boolean | undefined): PinState {
  if (latest !== takenAt) return "stale";
  return read ? "read" : "unread";
}

/** What the content script tells the person after a drop. */
export type DropStatus = "sent" | "asking" | "denied" | "timeout" | "no_ticket" | "unknown_dock" | "error" | "consent" | "consent_sensitive" | "blocked" | "not_here";

/** The link on the card for a Direct-only app. */
export const connectLabel = (host: string) => `Connect an agent on ${host}`;

/** Where the text goes (13.5), said before anything is sent. */
const PASSES_THROUGH = "It passes through your dock, on Cloudflare, and is kept 10 minutes at most.";

export const STATUS_TEXT: Record<DropStatus, string> = {
  sent: "Sent to your agent",
  asking: "Allow this browser in your dock to send this page",
  denied: "Your dock said no: nothing was sent",
  timeout: "Your dock did not answer in time: nothing was sent",
  no_ticket: "Drag your agent again from your dock",
  unknown_dock: "This agent is from a dock this extension does not know: nothing was sent",
  error: "Could not reach your dock: nothing was sent",
  consent: `Send this to your agent? ${PASSES_THROUGH}`,
  consent_sensitive: `This site is set to ask every time. Send this to your agent? ${PASSES_THROUGH}`,
  blocked: "You chose not to send from this site. Change it in the APC extension.",
  not_here: "Nothing was sent. Drops here will not be sent; change it in the APC extension.",
};
