/**
 * The service worker (TIN-421, DESIGN.md 13.5). It holds no channel: a drop wakes it, it pushes the
 * reading to the dropped agent's dock and is done. The first drop of an agent in this browser asks
 * the dock for a reader token with the drag's ticket, and the person allows it in the dock. Before
 * that, the person's consent for the site (TIN-465, 13.3): a new site asks on a card in the page. It
 * also keeps the content script registered on the sites the person granted, and opens the welcome
 * page on install.
 */
import { shapeReading } from "../../dock/src/worker/reading.ts";
import { browserLabel, decide, grantedAlone, hubAllowed, hubPatterns, isSensitive, readerKey, type Consent, type DropStatus, type Mode, type SiteChoice } from "./drop.ts";

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
  void syncScripts().then(() => injectOpenTabs());
  // The welcome page asks for the one grant (13.3), so it is never hidden in the collapsed popup.
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
chrome.runtime.onStartup.addListener(() => void syncScripts());
chrome.permissions.onAdded.addListener((p) => void syncScripts().then(() => injectOpenTabs(p.origins)));
chrome.permissions.onRemoved.addListener(() => void syncScripts());

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const m = message as Partial<Drop> | null;
  if (m?.type !== "drop" || !m.drag || typeof sender.tab?.id !== "number") return;
  void handleDrop(m as Drop, sender.tab.id).then((status) => reply({ status }));
  return true;
});

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

async function handleDrop(m: Drop, tabId: number): Promise<DropStatus> {
  const { hub, agent, ticket } = m.drag;
  if (!hubAllowed(hub, __APC_DEV__)) return "unknown_dock";
  const reading = shapeReading(m.reading);
  if (!reading) return "error";
  const consented = await consent(new URL(reading.url).origin, m.consent);
  if (consented !== true) return consented;
  const key = readerKey(hub, agent);
  const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const token = tokens[key];
  if (token) {
    const sent = await send(hub, token, reading);
    if (sent !== "not_paired") return note(hub, reading.url, sent ? "sent" : "error");
    // The person unpaired this browser in the dock, or the dock expired: ask again with this drag's ticket.
    delete tokens[key];
    await chrome.storage.local.set({ readers: tokens });
  }
  const asked = await post(`${hub}/apc/reader`, { ticket, agent, label: browserLabel(navigator.userAgentData?.brands, navigator.userAgentData?.platform, navigator.userAgent) });
  if (!asked?.ok || typeof asked.claim !== "string") return note(hub, reading.url, asked?.error === "ticket_expired" ? "no_ticket" : "error");
  void waitForAnswer(hub, agent, asked.claim, reading, tabId);
  return note(hub, reading.url, "asking");
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
    if (answer === "never" || (answer === "always" && !sensitive)) {
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
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // An extension API call keeps the service worker alive between polls (it stops after 30 s idle, 13.1).
    const tokens = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
    const answer = await post(`${hub}/apc/reader/status`, { claim });
    if (answer?.status === "pending") continue;
    if (answer?.status === "paired" && typeof answer.token === "string") {
      tokens[readerKey(hub, agent)] = answer.token;
      await chrome.storage.local.set({ readers: tokens });
      status = (await send(hub, answer.token, reading)) === true ? "sent" : "error";
    } else {
      status = answer ? "denied" : "error";
    }
    break;
  }
  await note(hub, reading.url, status);
  await chrome.tabs.sendMessage(tabId, { type: "status", status }).catch(() => {});
}

/**
 * Push one reading: true when the dock took it, "not_paired" when it no longer knows this token. A
 * network error or a 5xx is tried once more: sending the same reading again only replaces it.
 */
async function send(hub: string, token: string, reading: unknown): Promise<true | false | "not_paired"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${hub}/apc/reading`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ reading }) });
      if (r.status === 401) return "not_paired";
      if (r.status < 500) return r.ok;
    } catch {
      // network: try again
    }
  }
  return false;
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
