/**
 * The service worker (TIN-421, DESIGN.md 13.5). It holds no channel: a drop wakes it, it pushes the
 * reading to the dropped agent's dock and is done. The first drop of an agent in this browser asks
 * the dock for a reader token with the drag's ticket, and the person allows it in the dock. Before
 * that, the person's consent for the site (TIN-465, 13.3): a new site asks on a card in the page. It
 * also keeps the content script registered on the sites the person granted, and opens the welcome
 * page on install.
 */
import { shapeReading } from "../../dock/src/worker/reading.ts";
import { openDock } from "./open-dock.ts";
import { browserLabel, decide, grantedAlone, hubAllowed, hubPatterns, isSensitive, readerKey, type Consent, type DropStatus, type Mode, type PinMark, type SiteChoice } from "./drop.ts";

const SCRIPT_ID = "apc-drop";
/** How long the extension waits for the person's answer in the dock. */
const ASK_MS = 60_000;
const POLL_MS = 2_000;

interface Drop {
  type: "drop";
  drag: { hub: string; agent: string; ticket: string };
  reading: unknown;
  /** The person's answer on the consent card, when the first try asked for one. */
  consent?: Consent;
}

// A registered content script reaches only pages loaded after it, so the tabs already open on a granted
// site get it injected too: when the person grants the site (the permission prompt closes the popup,
// so the popup cannot do it) and when the extension is installed or updated.
chrome.runtime.onInstalled.addListener((details) => {
  void injectDockPresence();
  void syncScripts().then(() => injectOpenTabs());
  // The welcome page asks for the one grant (13.3), so it is never hidden in the collapsed popup.
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
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
chrome.permissions.onAdded.addListener((p) => void syncScripts().then(() => injectOpenTabs(p.origins)));
chrome.permissions.onRemoved.addListener(() => void syncScripts());

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const m = message as (Partial<Omit<Drop, "type">> & { type?: string; hub?: string; agent?: string }) | null;
  if (typeof sender.tab?.id !== "number") return;
  if (m?.type === "drop" && m.drag) {
    void handleDrop(m as Drop, sender.tab.id).then(reply);
    return true;
  }
  // A pin dragged to another paragraph of its page (TIN-471): the new reading, with no new consent.
  if (m?.type === "move" && typeof m.hub === "string" && typeof m.agent === "string") {
    void handleMove(m.hub, m.agent, m.reading).then(reply);
    return true;
  }
  // The pin on the page (TIN-469): whether the agent read the reading, and × to clear it.
  if ((m?.type === "pin_state" || m?.type === "pin_clear") && typeof m.hub === "string" && typeof m.agent === "string") {
    void pinCall(m.type === "pin_state" ? "state" : "clear", m.hub, m.agent).then(reply);
    return true;
  }
});

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

/** The content script runs on the sites the person granted, and never on a dock. */
async function syncScripts(): Promise<void> {
  const docks = new Set(hubPatterns(__APC_DEV__));
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter((o) => !docks.has(o));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const script = { id: SCRIPT_ID, js: ["content.js"], matches, excludeMatches: [...docks], runAt: "document_idle" as const, allFrames: false, persistAcrossSessions: true };
  await (existing.length ? chrome.scripting.updateContentScripts([script]) : chrome.scripting.registerContentScripts([script]));
}

/** Inject the content script into the open tabs on granted sites (all granted sites when none are given). */
async function injectOpenTabs(origins?: string[]): Promise<void> {
  const docks = new Set(hubPatterns(__APC_DEV__));
  const patterns = (origins ?? (await chrome.permissions.getAll()).origins ?? []).filter((o) => !docks.has(o));
  if (!patterns.length) return;
  for (const tab of await chrome.tabs.query({ url: patterns })) {
    if (typeof tab.id === "number") await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
}

/** What the content script gets back: what to tell the person, and the agent's mark when the reading went (TIN-469). */
interface DropReply {
  status: DropStatus;
  pin?: PinMark;
}

async function handleDrop(m: Drop, tabId: number): Promise<DropReply> {
  const { hub, agent, ticket } = m.drag;
  if (!hubAllowed(hub, __APC_DEV__)) return { status: "unknown_dock" };
  const reading = shapeReading(m.reading);
  if (!reading) return { status: "error" };
  const consented = await consent(new URL(reading.url).origin, m.consent);
  if (consented !== true) return { status: consented };
  const key = readerKey(hub, agent);
  const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const token = tokens[key];
  if (token) {
    const sent = await send(hub, token, reading);
    if (sent.result !== "not_paired") return { status: await note(hub, reading.url, sent.result ? "sent" : "error"), ...(sent.pin ? { pin: sent.pin } : {}) };
    // The person unpaired this browser in the dock, or the dock expired: ask again with this drag's ticket.
    delete tokens[key];
    await chrome.storage.local.set({ readers: tokens });
  }
  const asked = await post(`${hub}/apc/reader`, { ticket, agent, label: browserLabel(navigator.userAgentData?.brands, navigator.userAgentData?.platform, navigator.userAgent) });
  if (!asked?.ok || typeof asked.claim !== "string") return { status: await note(hub, reading.url, asked?.error === "ticket_expired" ? "no_ticket" : "error") };
  void waitForAnswer(hub, agent, asked.claim, reading, tabId);
  return { status: await note(hub, reading.url, "asking") };
}

/**
 * A pin moved within its page (TIN-471): the person consented when they dropped the agent there, so
 * no card; the browser's token for that agent, so no ticket. Without a token, the person drags again.
 */
async function handleMove(hub: string, agent: string, raw: unknown): Promise<DropReply> {
  if (!hubAllowed(hub, __APC_DEV__)) return { status: "unknown_dock" };
  const reading = shapeReading(raw);
  if (!reading) return { status: "error" };
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
async function consent(origin: string, answer: Consent | undefined): Promise<true | DropStatus> {
  const stored = await chrome.storage.local.get(["mode", "sites"]);
  const sites = (stored.sites ?? {}) as Record<string, SiteChoice>;
  const sensitive = isSensitive(new URL(origin).host);
  if (answer) {
    // Always is never kept for a sensitive site, by its domain or set to Always ask by the person (TIN-478).
    if (answer === "never" || (answer === "always" && !sensitive && sites[origin] !== "sensitive")) {
      sites[origin] = answer;
      await chrome.storage.local.set({ sites });
    }
    return answer === "never" ? "not_here" : true;
  }
  const { origins = [] } = await chrome.permissions.getAll();
  const decision = decide((stored.mode as Mode | undefined) ?? "ask", sites[origin], sensitive, grantedAlone(origin, origins));
  return decision === "send" ? true : decision === "ask" ? "consent" : decision === "ask_sensitive" ? "consent_sensitive" : "blocked";
}

/** Poll the dock until the person answers; then send the held reading, or drop it. */
async function waitForAnswer(hub: string, agent: string, claim: string, reading: NonNullable<ReturnType<typeof shapeReading>>, tabId: number): Promise<void> {
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
  await chrome.tabs.sendMessage(tabId, { type: "status", status, ...(pin ? { pin } : {}) }).catch(() => {});
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
