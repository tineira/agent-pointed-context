/**
 * The service worker (TIN-421, DESIGN.md 13.5). It holds no channel: a drop wakes it, it pushes the
 * reading to the dropped agent's dock and is done. The first drop of an agent in this browser asks
 * the dock for a reader token with the drag's ticket, and the person allows it in the dock. Before
 * that, the person's consent for the site (TIN-465, 13.3): a new site asks on a card in the page. It
 * also keeps the content script registered on the sites the person granted, and opens the welcome
 * page on install.
 */
import { chooseSensitive, shapeReadingCounted, type PageReading } from "../../dock/src/worker/reading.ts";
import { openDock } from "./open-dock.ts";
import { askingSite, browserLabel, decide, frameConsent, scriptMatches, frameTitle, frameOutside, grantedAlone, originOf, replyTarget, devHubHosts, heldForInclude, holdReading, hubAllowed, hubPatterns, includeSensitive, isSensitive, readingId, type Held, LOOKUP_KEEP_MS, LOOKUP_KEEP_UNKNOWN_MS, lookUpDirectOnly, NOTICE_ALL, NOTICE_SITES, readerKey, reask, sensitiveMode, sitePattern, type Consent, type DirectOnlyLookup, type DropStatus, type Mode, type PinMark, type SensitiveMode, type SiteChoice } from "./drop.ts";

const SCRIPT_ID = "apc-drop";
/** How long the extension waits for the person's answer in the dock. */
const ASK_MS = 60_000;
const POLL_MS = 2_000;

interface Drop {
  type: "drop";
  drag: { hub: string; agent: string; ticket: string };
  reading: unknown;
  /** The drop's id, made in the page when the reading was taken: "Include them this time" names it (TIN-619). */
  id?: string;
  /** The person's answer on the consent card, when the first try asked for one. */
  consent?: Consent;
}

/** The readings kept for "Include them this time", by their drop's id (Held): in session storage, memory only, so a sleeping service worker keeps them. */
async function heldReadings(): Promise<Record<string, Held>> {
  return ((await chrome.storage.session.get("held")).held ?? {}) as Record<string, Held>;
}

/** Keep a drop's reading for "Include them this time", or update it (its consent given). */
async function hold(id: string, entry: Omit<Held, "at">): Promise<void> {
  const held = await heldReadings();
  await chrome.storage.session.set({ held: holdReading(held, id, { ...entry, at: held[id]?.at ?? Date.now() }, Date.now()) });
}

/** What the person chose for sensitive numbers (TIN-619): read at each drop, so a change takes effect on the next one. */
async function sensitiveSetting(): Promise<SensitiveMode> {
  return sensitiveMode((await chrome.storage.local.get("sensitive")).sensitive);
}

/**
 * A reading as it goes to the hub (TIN-619): with its sensitive values or without, as the person chose,
 * and how many are left out. Null when it is not a reading.
 */
function prepare(raw: unknown, include: boolean): { reading: PageReading; withheld: number } | null {
  return shapeReadingCounted(chooseSensitive(raw, include));
}

/** What a reply says of sensitive values: how many the outline held, the setting, and whether the person may still include them. */
interface Sensitive {
  count: number;
  mode: SensitiveMode;
  offer: boolean;
}

// A registered content script reaches only pages loaded after it, so the tabs already open on a granted
// site get it injected too: when the person grants the site (the permission prompt closes the popup,
// so the popup cannot do it) and when the extension is installed or updated.
chrome.runtime.onInstalled.addListener((details) => {
  void injectDockPresence();
  void syncScripts().then(() => injectOpenTabs());
  // The welcome page asks for the one grant (13.3), so it is never hidden in the collapsed popup.
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  // A new install learns what readings carry from the welcome page and the card: only an update asks once more (TIN-571, TIN-619).
  if (details.reason === "install") void chrome.storage.local.set({ [NOTICE_ALL]: true });
});

/** An install can happen while the instructions or dock are already open. */
async function injectDockPresence(): Promise<void> {
  for (const tab of await chrome.tabs.query({ url: hubPatterns(__APC_DEV__) })) {
    if (typeof tab.id === "number") await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dock-presence.js"] }).catch(() => {});
  }
}
chrome.runtime.onStartup.addListener(() => void syncScripts());
// Open dock (Alt+Shift+A) and Float (Alt+Shift+F), TIN-473; the person can change them at chrome://extensions/shortcuts.
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-dock" || command === "float") void openDock(command === "float");
});
// Every granted tab, not only those whose address is a new origin: a frame's origin granted alone (TIN-752) is
// in tabs whose top page is another site. A copy already in a frame stands back (__apcDrop).
chrome.permissions.onAdded.addListener(() => void syncScripts().then(() => injectOpenTabs()));
chrome.permissions.onRemoved.addListener(() => void syncScripts());

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const m = message as (Partial<Omit<Drop, "type">> & { type?: string; hub?: string; agent?: string }) | null;
  const from = replyTarget(sender);
  if (!from) return;
  if (m?.type === "drop" && m.drag) {
    void handleDrop({ ...(m as Drop), reading: inFrame(m.reading, sender) }, from, sender).then(reply);
    return true;
  }
  // A pin dragged to another paragraph of its page (TIN-471): the new reading, with no new consent.
  if (m?.type === "move" && typeof m.hub === "string" && typeof m.agent === "string") {
    void handleMove(m.hub, m.agent, inFrame(m.reading, sender), readingId(m.id)).then(reply);
    return true;
  }
  // An agent dragged into a frame that has the content script (TIN-752): the top frame then shows no note about frames it cannot enter.
  if (m?.type === "frame_drag") {
    if (from.frameId !== 0) void chrome.tabs.sendMessage(from.tabId, { type: "frame_drag" }, { frameId: 0 }).catch(() => {});
    return;
  }
  // The top frame saw the agent go into a frame and heard nothing from it (TIN-752): the tab's frames the extension may not enter.
  if (m?.type === "frames_outside") {
    const frame = (m as { frame?: unknown }).frame;
    void outsideFrames(from.tabId, typeof frame === "number" ? frame : null).then(reply);
    return true;
  }
  // "Include them this time" (TIN-619): only the reading kept for that drop's id, never what the page sends now.
  if (m?.type === "include") {
    const id = readingId(m.id);
    void (id ? handleInclude(id) : Promise.resolve<DropReply>({ status: "error" })).then(reply);
    return true;
  }
  // The pin on the page (TIN-469): whether the agent read the reading, and × to clear it.
  if ((m?.type === "pin_state" || m?.type === "pin_clear") && typeof m.hub === "string" && typeof m.agent === "string") {
    void pinCall(m.type === "pin_state" ? "state" : "clear", m.hub, m.agent).then(reply);
    return true;
  }
  // An APC app the agent is dragged over (APC 0.5): whether it connects agents only directly, from its apc.json.
  if (m?.type === "apc_json") {
    void directOnlyOf(sender.url ?? sender.tab?.url).then(reply);
    return true;
  }
});

/**
 * What each APC app's apc.json said, per origin (memory only: the service worker comes and goes): a
 * file read and understood for five minutes, a lookup that told nothing (no file, an error, no answer)
 * for 30 s, so a page that was briefly unreachable is asked again soon.
 */
const apcApps = new Map<string, { at: number; keep: number; lookup: Promise<DirectOnlyLookup> }>();

/**
 * What the tab's origin says about itself: the answer for a Direct-only app (or null), and whether its
 * file was read at all, so the page asks again later when it was not. Read from that origin only.
 */
async function directOnlyOf(url: string | undefined): Promise<DirectOnlyLookup> {
  const site = sitePattern(url);
  if (!site) return { directOnly: null, read: false };
  const kept = apcApps.get(site.origin);
  if (kept && Date.now() - kept.at < kept.keep) return kept.lookup;
  const entry = { at: Date.now(), keep: LOOKUP_KEEP_MS, lookup: lookUpDirectOnly(site.origin) };
  apcApps.set(site.origin, entry);
  const result = await entry.lookup;
  if (!result.read) entry.keep = LOOKUP_KEEP_UNKNOWN_MS;
  return result;
}

/** The pin's state or ×, at the dock, with this browser's token for that agent. */
async function pinCall(what: "state" | "clear", hub: string, agent: string): Promise<Record<string, unknown> | null> {
  if (!hubAllowed(hub, __APC_DEV__)) return null;
  const token = (((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>)[readerKey(hub, agent)];
  if (!token) return null;
  try {
    const r = await fetch(`${hub}/apc/reading/${what}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A reading from a frame (TIN-752): its address is the frame's, where the text came from; its title is the
 * tab's, which the person sees, then the frame's own. The top frame's reading is left as it is.
 */
function inFrame(raw: unknown, sender: chrome.runtime.MessageSender): unknown {
  if (!sender.frameId || !raw || typeof raw !== "object") return raw;
  const reading = raw as { title?: unknown };
  return { ...reading, title: frameTitle(sender.tab?.title, typeof reading.title === "string" ? reading.title : undefined) };
}

/**
 * Whether the top frame should say that the frame under the pointer is one the extension may not enter
 * (TIN-752), and which origin to name (frameOutside). Nothing when the frames cannot be listed.
 */
async function outsideFrames(tabId: number, frameId: number | null): Promise<{ note: boolean; origin?: string | null }> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames) return { note: false };
  const { origins = [] } = await chrome.permissions.getAll();
  return frameOutside(frames, frameId, origins, __APC_DEV__);
}

/**
 * The content script runs on the sites the person granted, and never on a dock: in every frame (TIN-752),
 * so a drop on a frame from a granted origin (a dashboard from another site) lands; the frames Chrome makes
 * without an address of their own (about:blank, srcdoc, blob:) count by the origin that made them.
 */
async function syncScripts(): Promise<void> {
  const docks = new Set(devHubHosts(__APC_DEV__));
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = scriptMatches(origins, docks);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  // document_start: its capture listeners on window come before any of the page's own (TIN-573).
  const script = { id: SCRIPT_ID, js: ["content.js"], matches, excludeMatches: hubPatterns(__APC_DEV__), runAt: "document_start" as const, allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true };
  await (existing.length ? chrome.scripting.updateContentScripts([script]) : chrome.scripting.registerContentScripts([script]));
}

/** Inject the content script into the open tabs on granted sites (all granted sites when none are given), in each frame it may enter. */
async function injectOpenTabs(origins?: string[]): Promise<void> {
  const docks = new Set(devHubHosts(__APC_DEV__));
  const patterns = (origins ?? (await chrome.permissions.getAll()).origins ?? []).filter((o) => !docks.has(o));
  if (!patterns.length) return;
  for (const tab of await chrome.tabs.query({ url: patterns })) {
    if (typeof tab.id === "number") await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] }).catch(() => {});
  }
}

/**
 * What the content script gets back: what to tell the person, the agent's mark when the reading went
 * (TIN-469), and the sensitive values the outline held (TIN-619), for the consent card and for "Include
 * them this time".
 */
interface DropReply {
  status: DropStatus;
  pin?: PinMark;
  sensitive?: Sensitive;
  /** The drop this answers, so the page offers "Include them this time" for that drop and no other. */
  id?: string;
  /** On consent_sensitive: the host whose setting or domain makes the drop ask (askingSite). */
  asks?: string;
}

/** What to say of sensitive values for a reading sent (or about to be) under this setting, or nothing when there were none. */
function sensitiveReply(count: number, mode: SensitiveMode, included: boolean): { sensitive?: Sensitive } {
  return count ? { sensitive: { count, mode, offer: mode === "ask" && !included } } : {};
}

async function handleDrop(m: Drop, from: { tabId: number; frameId: number }, sender: chrome.runtime.MessageSender): Promise<DropReply> {
  const { hub, agent, ticket } = m.drag;
  if (!hubAllowed(hub, __APC_DEV__)) return { status: "unknown_dock" };
  const id = readingId(m.id);
  const mode = await sensitiveSetting();
  const include = includeSensitive(mode, false);
  // How many sensitive values the outline holds, whatever the setting does with them: the card says so.
  const without = prepare(m.reading, false);
  const prepared = include ? prepare(m.reading, true) : without;
  if (!without || !prepared) return { status: "error" };
  const { reading } = prepared;
  const sensitive = sensitiveReply(without.withheld, mode, include);
  const offered = id && sensitive.sensitive?.offer;
  // This drop's reading, kept as taken for "Include them this time": usable only once this drop's consent is given.
  if (offered) await hold(id, { raw: m.reading, hub, agent, consented: false });
  // Consent is the site's the person sees in the address bar; a frame from another origin is part of it (TIN-752).
  // Never a URL parse that throws: an address that is not http(s) (an opaque frame's) has no origin here.
  const frameOrigin = originOf(reading.url);
  const site = originOf(sender.tab?.url) ?? frameOrigin;
  if (!site) return { status: "opaque_frame", ...(id ? { id } : {}) };
  const consented = await consent(site, m.consent, frameOrigin);
  if (consented !== true) {
    const asks = consented === "consent_sensitive" ? new URL(askingSite(site, frameOrigin, ((await chrome.storage.local.get("sites")).sites ?? {}) as Record<string, SiteChoice>)).host : undefined;
    return { status: consented, ...sensitive, ...(id ? { id } : {}), ...(asks ? { asks } : {}) };
  }
  if (offered) await hold(id, { raw: m.reading, hub, agent, consented: true });
  const key = readerKey(hub, agent);
  const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const token = tokens[key];
  if (token) {
    const sent = await send(hub, token, reading);
    if (sent.result !== "not_paired") return { status: await note(hub, reading.url, sent.result ? "sent" : "error"), ...(sent.pin ? { pin: sent.pin } : {}), ...sensitive, ...(id ? { id } : {}) };
    // The person unpaired this browser in the dock, or the dock expired: ask again with this drag's ticket.
    delete tokens[key];
    await chrome.storage.local.set({ readers: tokens });
  }
  const asked = await post(`${hub}/apc/reader`, { ticket, agent, label: browserLabel(navigator.userAgentData?.brands, navigator.userAgentData?.platform, navigator.userAgent) });
  if (!asked?.ok || typeof asked.claim !== "string") return { status: await note(hub, reading.url, asked?.error === "ticket_expired" ? "no_ticket" : "error"), ...(id ? { id } : {}) };
  void waitForAnswer(hub, agent, asked.claim, reading, from, { ...sensitive, ...(id ? { id } : {}) });
  return { status: await note(hub, reading.url, "asking"), ...(id ? { id } : {}) };
}

/**
 * A pin moved within its page (TIN-471): the person consented when they dropped the agent there, so
 * no card; the browser's token for that agent, so no ticket. Without a token, the person drags again.
 * Its reading is kept for "Include them this time" as a drop's is, consented with the drop.
 */
async function handleMove(hub: string, agent: string, raw: unknown, id: string | null): Promise<DropReply> {
  if (!hubAllowed(hub, __APC_DEV__)) return { status: "unknown_dock" };
  const mode = await sensitiveSetting();
  const include = includeSensitive(mode, false);
  const without = prepare(raw, false);
  const prepared = include ? prepare(raw, true) : without;
  if (!without || !prepared) return { status: "error" };
  const sensitive = sensitiveReply(without.withheld, mode, include);
  if (id && sensitive.sensitive?.offer) await hold(id, { raw, hub, agent, consented: true });
  return { ...(await sendWithToken(hub, agent, prepared.reading)), ...sensitive, ...(id ? { id } : {}) };
}

/**
 * "Include them this time" (TIN-619): the reading kept for that drop's id, taken at the drop and sent
 * again with its sensitive values, to that drop's dock and agent. Only under Ask per drop, only once
 * that drop's consent was given, and once: a later drop never takes its place, and the page sends
 * nothing but the id.
 */
async function handleInclude(id: string): Promise<DropReply> {
  if ((await sensitiveSetting()) !== "ask") return { status: "error", id };
  const held = await heldReadings();
  const entry = heldForInclude(held, id, Date.now());
  if (!entry) return { status: "error", id };
  delete held[id];
  await chrome.storage.session.set({ held });
  if (!hubAllowed(entry.hub, __APC_DEV__)) return { status: "unknown_dock", id };
  const prepared = prepare(entry.raw, true);
  if (!prepared) return { status: "error", id };
  return { ...(await sendWithToken(entry.hub, entry.agent, prepared.reading)), id };
}

/** Send a reading with this browser's token for that agent: no ticket, so without a token the person drags again. */
async function sendWithToken(hub: string, agent: string, reading: PageReading): Promise<DropReply> {
  const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const token = tokens[readerKey(hub, agent)];
  if (!token) return { status: await note(hub, reading.url, "no_ticket") };
  const sent = await send(hub, token, reading);
  if (sent.result === "not_paired") {
    delete tokens[readerKey(hub, agent)];
    await chrome.storage.local.set({ readers: tokens });
    return { status: await note(hub, reading.url, "no_ticket") };
  }
  return { status: await note(hub, reading.url, sent.result ? "sent" : "error"), ...(sent.pin ? { pin: sent.pin } : {}) };
}


/**
 * The person's consent for this site (13.3): true to send, or what the content script shows instead
 * (the card, or a note). An answer from the card is kept: Always and Not here for the site; Always is
 * never kept for a sensitive site, which asks every time.
 */
async function consent(origin: string, answer: Consent | undefined, frameOrigin: string | null = origin): Promise<true | DropStatus> {
  const stored = await chrome.storage.local.get(["mode", "sites", NOTICE_SITES, NOTICE_ALL]);
  const sites = (stored.sites ?? {}) as Record<string, SiteChoice>;
  const mode = (stored.mode as Mode | undefined) ?? "ask";
  // The key is the tab's site; a frame's own origin adds two exceptions (TIN-752, frameConsent): a sensitive
  // domain or a site the person set to Always ask makes the drop ask every time, and Not here sends nothing.
  const frame = frameConsent(frameOrigin, sites);
  const sensitive = isSensitive(new URL(origin).host) || frame.sensitive;
  if (!answer && frame.blocked) return "blocked";
  const noticeSites = (stored[NOTICE_SITES] ?? []) as string[];
  if (answer) {
    // Any answer on a card means the person read what readings carry now (TIN-571, TIN-619): on this site,
    // and under Never ask, everywhere. A new install read it on the welcome page and the card (NOTICE_ALL).
    const noticed = new Set(noticeSites).add(origin);
    await chrome.storage.local.set({ [NOTICE_SITES]: [...noticed], ...(mode === "never_ask" ? { [NOTICE_ALL]: true } : {}) });
    // Always is never kept for a sensitive site, by its domain or set to Always ask by the person (TIN-478).
    if (answer === "never" || (answer === "always" && !sensitive && sites[origin] !== "sensitive")) {
      sites[origin] = answer;
      await chrome.storage.local.set({ sites });
    }
    return answer === "never" ? "not_here" : true;
  }
  const { origins = [] } = await chrome.permissions.getAll();
  const decision = decide(mode, sites[origin], sensitive, grantedAlone(origin, origins));
  // A site that sends without asking asks once more, with what readings now carry (TIN-571, TIN-619).
  const seen = stored[NOTICE_ALL] === true || (mode !== "never_ask" && noticeSites.includes(origin));
  if (reask(decision, seen)) return "consent_update";
  return decision === "send" ? true : decision === "ask" ? "consent" : decision === "ask_sensitive" ? "consent_sensitive" : "blocked";
}

/** Poll the dock until the person answers; then send the held reading, or drop it. */
async function waitForAnswer(hub: string, agent: string, claim: string, reading: PageReading, to: { tabId: number; frameId: number }, about: { sensitive?: Sensitive; id?: string }): Promise<void> {
  const until = Date.now() + ASK_MS;
  let status: DropStatus = "timeout";
  let pin: PinMark | undefined;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // An extension API call keeps the service worker alive between polls (it stops after 30 s idle, 13.1).
    const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
    const answer = await post(`${hub}/apc/reader/status`, { claim });
    if (answer?.status === "pending") continue;
    if (answer?.status === "paired" && typeof answer.token === "string") {
      tokens[readerKey(hub, agent)] = answer.token;
      await chrome.storage.local.set({ readers: tokens });
      const sent = await send(hub, answer.token, reading);
      status = sent.result === true ? "sent" : "error";
      pin = sent.pin;
    } else {
      status = answer ? "denied" : "error";
    }
    break;
  }
  await note(hub, reading.url, status);
  // To the frame the drop came from (TIN-752): another frame of the tab would show the note too.
  await chrome.tabs.sendMessage(to.tabId, { type: "status", status, ...(pin ? { pin } : {}), ...(about.id ? { id: about.id } : {}), ...(status === "sent" && about.sensitive ? { sensitive: about.sensitive } : {}) }, { frameId: to.frameId }).catch(() => {});
}


/**
 * Push one reading: true when the dock took it (with the agent's mark for the pin, TIN-469),
 * "not_paired" when it no longer knows this token. A network error or a 5xx is tried once more:
 * sending the same reading again only replaces it.
 */
async function send(hub: string, token: string, reading: unknown): Promise<{ result: true | false | "not_paired"; pin?: PinMark }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${hub}/apc/reading`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reading }) });
      if (r.status === 401) return { result: "not_paired" };
      if (r.status >= 500) continue;
      if (!r.ok) return { result: false };
      const body = (await r.json().catch(() => ({}))) as { agent?: { name?: unknown; icon?: unknown }; taken_at?: unknown };
      const name = typeof body.agent?.name === "string" ? body.agent.name.slice(0, 60) : "Your agent";
      const icon = typeof body.agent?.icon === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.agent.icon) ? body.agent.icon : null;
      return { result: true, ...(typeof body.taken_at === "string" ? { pin: { name, icon, taken_at: body.taken_at } } : {}) };
    } catch {
      // network: try again
    }
  }
  return { result: false };
}

async function post(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The last drop's outcome, for the popup: the site and what happened, never the text. */
async function note(hub: string, url: string, status: DropStatus): Promise<DropStatus> {
  await chrome.storage.local.set({ last: { at: new Date().toISOString(), hub, site: new URL(url).host, status } });
  return status;
}
