/**
 * The extension's pure parts (TIN-421, DESIGN.md 13): which docks it talks to, what it calls this
 * browser, and how it keeps one reader token per dock and agent. No chrome.* APIs here, so the tests run it.
 */
import { APC_JSON_MAX_BYTES, APC_JSON_PATH, parseApcManifest, parseFocusAttrs } from "@tineira/apc-protocol";

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
 * What the extension does with a dock agent's drag over an APC app, on one page (APC 0.5). A page that
 * answers drops itself (APC_DROPS_ATTR, set by @tineira/apc-web) is left alone. Otherwise the app's apc.json is
 * looked up on the first drag, and the drop is taken while the app may be Direct-only: once its file says
 * so, and while the lookup is still on its way, so a quick first drop is never lost. A drop taken during
 * the lookup is answered when the lookup comes back, or handed back to the page if the app takes dock
 * agents. A real answer (the file read, Direct-only or not) holds for the page. A lookup that told
 * nothing is asked again on a later drag, once the service worker's short negative cache
 * (LOOKUP_KEEP_UNKNOWN_MS) has run out; until then the extension stands back, as it did before 0.5.
 */
export function directOnlyGate(lookUp: () => Promise<DirectOnlyLookup>, pageAnswers: () => boolean, now: () => number = Date.now) {
  let pending: Promise<DirectOnly | null> | null = null;
  let inFlight = false;
  /** The real answer, once the file was read; undefined until then. */
  let known: DirectOnly | null | undefined;
  let toldNothingAt = -Infinity;
  const start = (): Promise<DirectOnly | null> | null => {
    if (inFlight) return pending;
    if (known !== undefined || now() - toldNothingAt < LOOKUP_KEEP_UNKNOWN_MS) return null;
    inFlight = true;
    pending = lookUp()
      .catch((): DirectOnlyLookup => ({ directOnly: null, read: false }))
      .then((r) => {
        inFlight = false;
        if (r.read) known = r.directOnly;
        else toldNothingAt = now();
        return r.read ? r.directOnly : null;
      });
    return pending;
  };
  return {
    /** The agent is dragged over the page: look its file up, unless known or asked too recently. */
    start(): void {
      void start();
    },
    /** dragover: whether the extension takes the drop (the browser refuses it otherwise). */
    accepts(): boolean {
      if (pageAnswers()) return false;
      void start();
      return !!known || inFlight;
    },
    /**
     * drop: `now` when the app is known to be Direct-only (the extension answers, and keeps the page's own
     * handlers from answering too), `later` while the lookup is on its way, or null to stand back.
     */
    drop(): { now: DirectOnly } | { later: Promise<DirectOnly | null> } | null {
      if (pageAnswers()) return null;
      if (known) return { now: known };
      const p = start();
      return inFlight && p ? { later: p } : null;
    },
  };
}

/**
 * The attribute `@tineira/apc-web` sets on the page's root while `enablePinning` takes dock agents' drops
 * itself (APC_DROPS_ATTR in packages/web/src/pinning.ts; a test keeps the two equal).
 */
export const NATIVE_DROPS_ATTR = "data-apc-native-drops";

/**
 * Whether a page is an APC app (TIN-476, TIN-703): it carries one of the standard's own marks, the agent
 * bar (`apc-agents`), an agent mark (`[data-apc-mark]`), or the attribute `enablePinning` sets while it
 * takes dock drops (set at mount, before the bar has loaded). Never by `data-focus`: that name is generic,
 * and a page that uses it for something else (or a UI library that sets it on the focused element) lost
 * every drop.
 */
export function isApcApp(root: { hasAttribute(name: string): boolean; querySelector(selector: string): unknown } | null): boolean {
  if (!root) return false;
  return root.hasAttribute(NATIVE_DROPS_ATTR) || !!root.querySelector("apc-agents, [data-apc-mark]");
}

/**
 * The card for a dock agent's drop that nothing on an APC app took (TIN-703): the app answers its own
 * drops, and this one it let pass, so without the card the browser would refuse it with no word.
 */
export const NOT_TAKEN_TEXT = "This page did not take your agent here. It is an APC app: drop your agent on something it highlights. Nothing was sent.";

/** Where a reply about a drop goes (TIN-752): the frame the drop came from, never every frame of the tab. */
export function replyTarget(sender: { tab?: { id?: number }; frameId?: number }): { tabId: number; frameId: number } | null {
  if (typeof sender.tab?.id !== "number") return null;
  return { tabId: sender.tab.id, frameId: typeof sender.frameId === "number" && sender.frameId >= 0 ? sender.frameId : 0 };
}

/** Whether a host pattern list lets the extension into an origin: the grant for any page (for its scheme), or the site by itself. */
export function covered(origin: string, patterns: readonly string[]): boolean {
  const u = new URL(origin);
  if (patterns.includes(`${u.protocol}//*/*`)) return true;
  return grantedAlone(origin, patterns);
}

/**
 * The origins of a tab's frames that the extension may not enter (TIN-752): http(s) frames other than the
 * top one whose origin the granted patterns do not cover, docks left out, each once, in order.
 */
export function framesOutside(frames: ReadonlyArray<{ url?: string; frameId?: number }>, patterns: readonly string[], dev: boolean): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.frameId === 0) continue;
    const site = sitePattern(f.url);
    if (!site || hubAllowed(site.origin, dev) || out.includes(site.origin) || covered(site.origin, patterns)) continue;
    out.push(site.origin);
  }
  return out;
}

/**
 * What allowing a site asks Chrome for (TIN-752, "ask for the whole site"): the site, and with it, in the
 * same prompt, the origins of the tab's frames not allowed yet, so a dashboard in a frame from another
 * origin (Tableau in Datamind) takes the agent too.
 */
export function siteGrant(site: { origin: string; pattern: string }, frames: ReadonlyArray<{ url?: string; frameId?: number }>, patterns: readonly string[], dev: boolean): string[] {
  return [site.pattern, ...framesOutside(frames, patterns, dev).filter((o) => o !== site.origin).map((o) => `${o}/*`)];
}

/**
 * The note when the person drags over a frame the extension may not enter (TIN-752): it cannot see that
 * drop at all. It names the frame's host only when it is the frame under the pointer (frameOutside);
 * otherwise "another site".
 */
export function frameNote(origin: string | null): string {
  const from = origin ? new URL(origin).host : "another site";
  return `This part of the page comes from ${from}. Allow this site again in the APC extension to include it.`;
}

/**
 * What the top frame says about the frame under the pointer (TIN-752), from the tab's frames: that frame
 * known (runtime.getFrameId) and outside every grant, its origin; known and inside one, nothing (its content
 * script has the drag, or will); not known, "another site" when some frame of the tab is outside.
 */
export function frameOutside(frames: ReadonlyArray<{ url?: string; frameId?: number }>, frameId: number | null, patterns: readonly string[], dev: boolean): { note: true; origin: string | null } | { note: false } {
  if (frameId !== null && frameId > 0) {
    const frame = frames.find((f) => f.frameId === frameId);
    if (!frame) return { note: false };
    const [origin] = framesOutside([frame], patterns, dev);
    return origin ? { note: true, origin } : { note: false };
  }
  return framesOutside(frames, patterns, dev).length ? { note: true, origin: null } : { note: false };
}

/**
 * What a frame's own origin adds to the consent of the tab's site (TIN-752): a sensitive domain, or a site
 * the person set to Always ask, makes the drop ask every time; a site set to Not here sends nothing. The
 * card's answers are still kept for the tab's site.
 */
export function frameConsent(frameOrigin: string | null, sites: Readonly<Record<string, SiteChoice>>): { sensitive: boolean; blocked: boolean } {
  if (!frameOrigin) return { sensitive: false, blocked: false };
  return { sensitive: isSensitive(new URL(frameOrigin).host) || sites[frameOrigin] === "sensitive", blocked: sites[frameOrigin] === "never" };
}

/** The origin of an http(s) address, or null (an opaque frame's about:blank, data: or "null"): never a URL parse that throws. */
export const originOf = (url: string | null | undefined): string | null => sitePattern(url ?? undefined)?.origin ?? null;

/** What appTakes reads of an element: a DOM Element has all of it. */
export interface FocusNode {
  closest(selector: string): FocusNode | null;
  getAttribute(name: string): string | null;
  readonly parentElement: FocusNode | null;
}

/**
 * Whether an APC app takes a drop on this element (TIN-703): the app's own rule, `targetOf` in
 * packages/web/src/pinning.ts, step for step. From the element at the drop point (the document's
 * elementFromPoint, as `targetAt` starts), the nearest `[data-focus]` by `closest` (never across a shadow
 * root), parsed by the protocol's `parseFocusAttrs`; one that does not parse (`data-focus=""`, `"true"`, no
 * `kind:id`) is skipped for the next one above its parent element. The app pins only on a target it parses,
 * so the extension's "not taken" card stays silent only then, whatever the last dragover said.
 */
export function appTakes(start: FocusNode | null): boolean {
  let node: FocusNode | null = start;
  while (node) {
    const host = node.closest("[data-focus]");
    if (!host) return false;
    if (parseFocusAttrs(host.getAttribute("data-focus"), host.getAttribute("data-focus-part"), host.getAttribute("data-focus-params"))) return true;
    node = host.parentElement;
  }
  return false;
}

/**
 * Whose setting makes a drop ask every time (TIN-752, fix check on #142), for the card to name it: the
 * tab's site when its own domain or the person's Always ask says so, else the frame's when its domain or
 * its own Always ask does; the tab's site otherwise.
 */
export function askingSite(tabOrigin: string, frameOrigin: string | null, sites: Readonly<Record<string, SiteChoice>>): string {
  const marked = (o: string) => isSensitive(new URL(o).host) || sites[o] === "sensitive";
  return !marked(tabOrigin) && frameOrigin && marked(frameOrigin) ? frameOrigin : tabOrigin;
}

/**
 * A reading's title when it came from a frame (TIN-752): the tab's title, which the person sees, then the
 * frame's own when it says something else. The reading's address stays the frame's: that is where the text came from.
 */
export function frameTitle(tabTitle: string | undefined, title: string | undefined): string {
  const tab = tabTitle?.trim() ?? "";
  const own = title?.trim() ?? "";
  if (!tab) return own;
  if (!own || own === tab) return tab;
  return `${tab} · ${own}`;
}

/**
 * The granted patterns the content script is registered on: whole hosts only, never a dev dock's. With
 * matchOriginAsFallback Chrome refuses the whole registration for a pattern with any other path, and the
 * dock's own paths (which the presence script's matches add to the granted list) are excluded anyway.
 */
export function scriptMatches(patterns: readonly string[], docks: ReadonlySet<string>): string[] {
  return patterns.filter((p) => !docks.has(p) && /^[^:/]+:\/\/[^/]+\/\*$/.test(p));
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

/** A URL's port, the scheme's default when it names none. */
const portOf = (u: URL) => (u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80);

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
    const port = /:(\d+)$/.exec(host)?.[1];
    const hostname = port ? host.slice(0, -port.length - 1) : host;
    // A pattern with a port covers that port only (the popup's grant for a page on a port of its own); one without, every port.
    if (port && Number(port) !== portOf(u)) return false;
    return (scheme === "*" || `${scheme}:` === u.protocol) && (hostname === u.hostname || (hostname.startsWith("*.") && u.hostname.endsWith(hostname.slice(1))));
  });
}

/**
 * Whether a drop is sent, asks, or is refused. A site the person said "Not here" to never sends,
 * under Never ask too (TIN-571). Otherwise "Never ask" sends everything. A sensitive site, by its domain or marked by the person, always asks. A
 * site marked Always, or granted by itself from the popup, sends. Any other site asks.
 */
export function decide(mode: Mode, choice: SiteChoice | undefined, sensitive: boolean, grantedAlone: boolean): Decision {
  // A site the person said Not here to never sends, under Never ask too: the card offers Not here then (TIN-571).
  if (choice === "never") return "blocked";
  if (mode === "never_ask") return "send";
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
export type DropStatus = "sent" | "asking" | "denied" | "timeout" | "no_ticket" | "unknown_dock" | "error" | "consent" | "consent_sensitive" | "consent_update" | "blocked" | "not_here" | "outline_changed" | "opaque_frame";

/** The link on the card for a Direct-only app. */
export const connectLabel = (host: string) => `Connect an agent on ${host}`;

/** Where the text goes (13.5), said before anything is sent. */
const PASSES_THROUGH = "It passes through the APC hub of your dock, on Cloudflare (kept 10 minutes at most), and then to your agent's provider.";
/** What goes along (TIN-571, TIN-619), said before anything is sent. */
export const FORM_NOTE = "Everything you can see inside the outline goes along, including what you typed there. Sensitive numbers (card, account, id) go only as your setting in the APC extension says; passwords and codes never.";

/**
 * What the person chose for sensitive numbers, once for every site (TIN-619): "ask" leaves them out and
 * offers "Include them this time" after the drop (the default); "send" sends what is in the outline;
 * "never" always leaves them out. Passwords and one-time codes never go, whatever this says.
 */
export type SensitiveMode = "ask" | "send" | "never";
export const SENSITIVE_MODES: readonly SensitiveMode[] = ["ask", "send", "never"];
export const sensitiveMode = (value: unknown): SensitiveMode => (value === "send" || value === "never" ? value : "ask");

/** Whether a reading goes with its sensitive values: by the setting, or "Include them this time" under Ask per drop. */
export function includeSensitive(mode: SensitiveMode, includeThisTime: boolean): boolean {
  return mode === "send" || (mode === "ask" && includeThisTime);
}

/**
 * A reading the service worker keeps for "Include them this time" (TIN-619): exactly the one taken at
 * that drop, with its sensitive values, for that drop's dock and agent, and whether that drop's consent
 * was given. Kept by the drop's id in chrome.storage.session (memory only), at most HELD_MAX of them and
 * HELD_MS each, so a later drop never replaces it and an Include never sends another drop.
 */
export interface Held {
  raw: unknown;
  hub: string;
  agent: string;
  consented: boolean;
  at: number;
}
export const HELD_MS = 2 * 60_000;
export const HELD_MAX = 10;

/** A drop's id as the content script makes it (crypto.randomUUID). */
export const readingId = (value: unknown): string | null => (typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : null);

/** The held readings with this one kept (or updated), the old ones and the oldest past HELD_MAX gone. */
export function holdReading(held: Readonly<Record<string, Held>>, id: string, entry: Held, now: number): Record<string, Held> {
  const kept = Object.entries({ ...held, [id]: entry })
    .filter(([, h]) => now - h.at < HELD_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, HELD_MAX);
  return Object.fromEntries(kept);
}

/** The reading "Include them this time" may send for this id: only one whose drop the person consented to, still kept. */
export function heldForInclude(held: Readonly<Record<string, Held>>, id: string, now: number): Held | null {
  const h = held[id];
  return h && h.consented && now - h.at < HELD_MS ? h : null;
}

/** "1 sensitive value", "3 sensitive values". */
export const sensitiveCount = (n: number) => (n === 1 ? "1 sensitive value" : `${n} sensitive values`);

/** What the consent card adds when the outline holds sensitive values, by the setting. */
export function sensitiveNote(n: number, mode: SensitiveMode): string {
  if (mode === "send") return `${sensitiveCount(n)} in the outline go along, as your setting says.`;
  if (mode === "never") return `${sensitiveCount(n)} will be left out, as your setting says.`;
  return `${sensitiveCount(n)} will be left out; you can include them after sending.`;
}

/** The card after a drop under Ask per drop, when values were left out. */
export const sentWithout = (n: number) => `Sent to your agent. ${sensitiveCount(n)} left out.`;
export const INCLUDE_LABEL = "Include them this time";

/**
 * The storage keys that say the person has seen what readings carry now (TIN-571; version 2 since
 * TIN-619, "the outline is what goes"): a new version asks once more on sites that send without asking.
 */
export const NOTICE_SITES = "readingNoticeSites2";
export const NOTICE_ALL = "readingNoticeAll2";

/**
 * Whether a drop that would be sent without a question (Always, a site granted by itself, Never ask)
 * asks once more, because the person has not seen what readings now carry (TIN-571, TIN-619). The answer
 * is kept as on any card, and the site's setting stays.
 */
export function reask(decision: Decision, seen: boolean): boolean {
  return decision === "send" && !seen;
}

export const STATUS_TEXT: Record<DropStatus, string> = {
  sent: "Sent to your agent",
  asking: "Allow this browser in your dock to send this page",
  denied: "Your dock said no: nothing was sent",
  timeout: "Your dock did not answer in time: nothing was sent",
  no_ticket: "Drag your agent again from your dock",
  unknown_dock: "This agent is from a dock this extension does not know: nothing was sent",
  error: "Could not reach your dock: nothing was sent",
  consent: `Send this to your agent? ${FORM_NOTE} ${PASSES_THROUGH}`,
  consent_sensitive: `This site is set to ask every time. Send this to your agent? ${FORM_NOTE} ${PASSES_THROUGH}`,
  consent_update: `New: the outline is what goes. ${FORM_NOTE} Send this to your agent? ${PASSES_THROUGH} This asks once: your setting for this site stays unless you choose Not here.`,
  blocked: "You chose not to send from this site. Change it in the APC extension.",
  not_here: "Nothing was sent. Drops here will not be sent; change it in the APC extension.",
  outline_changed: "The page changed what was outlined: nothing was sent. Drop again.",
  opaque_frame: "This part of the page has no address of its own, so your agent cannot read it: nothing was sent.",
};
