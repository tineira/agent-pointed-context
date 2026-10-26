/**
 * The content script (TIN-421, DESIGN.md 13.1 and 13.2), on the sites the person granted: it lets a
 * page take the agent the person drags from their dock or Float. An APC app handles its own drops
 * first, so this listens on window in the bubble phase and steps back when the page took the drop.
 * On any other page it reads the block of text at the drop point and hands it to the service worker.
 * When the service worker needs the person's consent for the site (TIN-465, 13.3), a card where the
 * agent was dropped asks, and the answer goes back with the same drop.
 */
import { APC_AGENT_TYPE, parseAgentDrag } from "../../../packages/web/src/pinning.ts";
import { hubAllowed, STATUS_TEXT, type Consent, type DropStatus } from "./drop.ts";

/** What a reading may come from: a block of text, never a form field. */
const BLOCKS = "p,li,td,th,dd,dt,blockquote,pre,figcaption,caption,h1,h2,h3,h4,h5,h6,a,button,label,summary";
const FIELDS = "input,textarea,select,option,[contenteditable=''],[contenteditable='true']";
const TEXT_MAX = 2048;

const w = window as Window & { __apcDrop?: boolean };
// Injected again when the person grants the site from the popup: one listener set per page.
if (!w.__apcDrop && !hubAllowed(location.origin, __APC_DEV__)) {
  w.__apcDrop = true;
  listen();
}

function listen(): void {
  let lit: HTMLElement | null = null;
  let litOutline = "";
  // A copy left from before the extension was reloaded or updated has lost its extension: it stands
  // back, so the fresh copy injected next to it takes the drop.
  const carriesAgent = (e: DragEvent) => !!chrome.runtime?.id && !!e.dataTransfer && [...e.dataTransfer.types].includes(APC_AGENT_TYPE);
  const light = (el: HTMLElement | null) => {
    if (lit === el) return;
    if (lit) lit.style.outline = litOutline;
    lit = el;
    if (el) {
      litOutline = el.style.outline;
      el.style.outline = "2px solid #d4733a";
    }
  };

  window.addEventListener("dragover", (e) => {
    if (!e.isTrusted || e.defaultPrevented || !carriesAgent(e)) return;
    e.preventDefault();
    // The dock drags a connected agent as "link"; any other answer makes the browser refuse the drop.
    e.dataTransfer!.dropEffect = "link";
    light(blockAt(e.clientX, e.clientY) as HTMLElement | null);
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) light(null);
  });
  window.addEventListener("dragend", () => light(null));
  window.addEventListener("drop", (e) => {
    light(null);
    if (!e.isTrusted || !carriesAgent(e) || e.defaultPrevented) return;
    e.preventDefault();
    const drag = parseAgentDrag(e.dataTransfer!.getData(APC_AGENT_TYPE));
    if (!drag?.hub || !drag.ticket) return say("no_ticket");
    if (!hubAllowed(drag.hub, __APC_DEV__)) return say("unknown_dock");
    const reading = readAt(e.clientX, e.clientY);
    const send = (consent?: Consent) =>
      chrome.runtime
        .sendMessage<{ status: DropStatus }>({ type: "drop", drag: { hub: drag.hub, agent: drag.agent, ticket: drag.ticket }, reading, ...(consent ? { consent } : {}) })
        .then((r) => {
          const status = r?.status ?? "error";
          if (status === "consent" || status === "consent_sensitive") ask(status, e.clientX, e.clientY, send);
          else say(status);
        })
        .catch(() => say("error"));
    void send();
  });
  // The service worker's later word, once the person answered in the dock.
  chrome.runtime.onMessage.addListener((m) => {
    const status = (m as { type?: string; status?: DropStatus }).type === "status" ? (m as { status: DropStatus }).status : null;
    if (status && status in STATUS_TEXT) say(status);
  });
}

/** The nearest block of text at a point, or null (a margin, a form field). */
function blockAt(x: number, y: number): Element | null {
  const at = document.elementFromPoint(x, y);
  if (!at || at.closest(FIELDS)) return null;
  return at.closest(BLOCKS);
}

/** What the person pointed at: the block's text and the heading above it, or only the page. */
function readAt(x: number, y: number) {
  const block = blockAt(x, y);
  const selection = String(getSelection() ?? "").slice(0, TEXT_MAX);
  return {
    url: location.href,
    title: document.title,
    element: block
      ? {
          tag: block.tagName.toLowerCase(),
          role: block.getAttribute("role"),
          name: block.getAttribute("aria-label") || (block as HTMLElement).title || null,
          text: ((block as HTMLElement).innerText ?? block.textContent ?? "").slice(0, TEXT_MAX),
          heading: headingBefore(block),
        }
      : null,
    selection: selection || null,
  };
}

/** The nearest h1 to h3 before an element in the document, or its own text when it is one. */
function headingBefore(el: Element): string | null {
  let found: Element | null = null;
  for (const h of document.querySelectorAll("h1,h2,h3")) {
    if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found ? ((found as HTMLElement).innerText ?? found.textContent ?? "").trim().slice(0, 200) || null : null;
}

/**
 * The consent card (13.3), where the agent was dropped, in a closed shadow root. Its buttons take
 * trusted clicks only. A sensitive site gets Send and Not now, never Always.
 */
function ask(status: "consent" | "consent_sensitive", x: number, y: number, send: (c: Consent) => void): void {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "APC");
  const left = Math.max(8, Math.min(x - 160, innerWidth - 336));
  const top = Math.max(8, Math.min(y + 12, innerHeight - 150));
  card.style.cssText = `position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:320px;box-sizing:border-box;padding:12px 14px;border-radius:12px;background:#1f1f1f;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)`;
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 10px";
  text.textContent = STATUS_TEXT[status];
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  const choices: Array<[Consent | null, string]> = status === "consent_sensitive" ? [["once", "Send"], [null, "Not now"]] : [["once", "Just this once"], ["always", "Always on this site"], ["never", "Not here"]];
  const close = () => host.remove();
  for (const [consent, label] of choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.apcConsent = consent ?? "dismiss";
    b.style.cssText = `font:inherit;padding:5px 10px;border-radius:7px;cursor:pointer;border:1px solid ${consent === "once" ? "#d4733a" : "#555"};background:${consent === "once" ? "#d4733a" : "transparent"};color:#fff`;
    b.addEventListener("click", (ev) => {
      // A page can click a button by script; only the person's own click counts.
      if (!ev.isTrusted) return;
      close();
      if (consent) send(consent);
    });
    row.append(b);
  }
  card.append(text, row);
  root.append(card);
  document.documentElement.append(host);
  setTimeout(close, 45_000);
}

/** A short note in the page's corner, in its own shadow root so the page's styles cannot touch it. */
function say(status: DropStatus): void {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const note = document.createElement("div");
  note.textContent = STATUS_TEXT[status];
  note.setAttribute("role", "status");
  note.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;padding:10px 14px;border-radius:10px;background:#1f1f1f;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  root.append(note);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), status === "asking" ? 8000 : 3500);
}
