/**
 * The content script (TIN-421, DESIGN.md 13.1 and 13.2), on the sites the person granted: it lets a
 * page take the agent the person drags from their dock or Float. An APC app handles its own drops
 * first, so this listens on window in the bubble phase and steps back when the page took the drop.
 * On any other page it reads the block of text at the drop point and hands it to the service worker.
 * When the service worker needs the person's consent for the site (TIN-465, 13.3), a card where the
 * agent was dropped asks, and the answer goes back with the same drop. Once the reading is sent, the
 * agent's mark stays pinned on the paragraph (TIN-469, 13.6), showing whether the agent read it.
 */
import { APC_AGENT_TYPE, parseAgentDrag } from "../../../packages/web/src/pinning.ts";
import { hubAllowed, pinState, STATUS_TEXT, type Consent, type DropStatus, type PinMark, type PinState } from "./drop.ts";

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

/** Where a drop landed, for its pin: the paragraph, or the point on the page, and whose agent it was. */
interface Target {
  anchor: Element | null;
  x: number;
  y: number;
  hub: string;
  agent: string;
}

function listen(): void {
  /** The last drop's place: its pin may come later, once the person allowed this browser in the dock. */
  let pending: Target | null = null;
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
    const target: Target = { anchor: blockAt(e.clientX, e.clientY), x: e.pageX, y: e.pageY, hub: drag.hub, agent: drag.agent };
    pending = target;
    const send = (consent?: Consent) =>
      chrome.runtime
        .sendMessage<{ status: DropStatus; pin?: PinMark }>({ type: "drop", drag: { hub: drag.hub, agent: drag.agent, ticket: drag.ticket }, reading, ...(consent ? { consent } : {}) })
        .then((r) => {
          const status = r?.status ?? "error";
          if (status === "consent" || status === "consent_sensitive") return ask(status, e.clientX, e.clientY, send);
          say(status);
          if (status === "sent" && r?.pin) pin(target, r.pin);
        })
        .catch(() => say("error"));
    void send();
  });
  // The service worker's later word, once the person answered in the dock.
  chrome.runtime.onMessage.addListener((m) => {
    const msg = m as { type?: string; status?: DropStatus; pin?: PinMark };
    if (msg.type !== "status" || !msg.status || !(msg.status in STATUS_TEXT)) return;
    say(msg.status);
    if (msg.status === "sent" && msg.pin && pending) pin(pending, msg.pin);
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

/** The pins on this page, one per dock and agent: a new drop moves it. */
const pins = new Map<string, () => void>();

/**
 * The agent's mark, pinned where it was dropped (TIN-469, 13.6): in the margin at the start of the
 * paragraph, so it covers no text, following it through layout changes. Its ring says whether the
 * agent read the reading (accent, then green), or grey once a newer drop replaced it at the dock.
 * × clears the reading and the agent's focus. Polls the dock every 3 s until read or replaced.
 */
function pin(target: Target, mark: PinMark): void {
  const key = `${target.hub} ${target.agent}`;
  pins.get(key)?.();
  const host = document.createElement("div");
  host.dataset.apcPin = "";
  host.style.cssText = "position:absolute;z-index:2147483646;left:0;top:0;width:0;height:0";
  const root = host.attachShadow({ mode: "closed" });
  const markEl = document.createElement("div");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Remove: your agent forgets this reading";
  close.dataset.apcPinClose = "";
  close.style.cssText = "position:absolute;right:-6px;top:-6px;width:16px;height:16px;padding:0;border-radius:50%;border:none;background:#1f1f1f;color:#fff;font:12px/16px system-ui,sans-serif;cursor:pointer;display:none";
  const face = mark.icon ? Object.assign(document.createElement("img"), { src: mark.icon, alt: "" }) : Object.assign(document.createElement("span"), { textContent: (mark.name.trim()[0] ?? "A").toUpperCase() });
  face.setAttribute("style", mark.icon ? "width:20px;height:20px;object-fit:contain" : "font:600 13px system-ui,sans-serif;color:#1f1f1f");
  markEl.append(face, close);
  markEl.addEventListener("mouseenter", () => (close.style.display = "block"));
  markEl.addEventListener("mouseleave", () => (close.style.display = "none"));
  root.append(markEl);
  document.documentElement.append(host);

  let state: PinState = "unread";
  const draw = () => {
    const ring = state === "read" ? "#2e8b57" : state === "stale" ? "#9a9a9a" : "#d4733a";
    markEl.dataset.apcPinState = state;
    markEl.title = `${mark.name} · ${state === "read" ? "read it" : state === "stale" ? "replaced by a newer drop" : "not read yet"}`;
    markEl.style.cssText = `position:absolute;width:28px;height:28px;box-sizing:border-box;border-radius:50%;background:#fff;border:2px solid ${ring};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25);opacity:${state === "stale" ? 0.6 : 1}`;
    place();
  };
  const place = () => {
    if (target.anchor && !target.anchor.isConnected) return remove();
    let left = target.x - 14;
    let top = target.y - 14;
    if (target.anchor) {
      const r = target.anchor.getBoundingClientRect();
      left = r.left + scrollX - 34;
      if (left < 2) left = r.left + scrollX + 2;
      top = r.top + scrollY;
    }
    markEl.style.left = `${Math.round(left)}px`;
    markEl.style.top = `${Math.round(top)}px`;
  };
  const observer = new ResizeObserver(place);
  observer.observe(document.documentElement);
  if (target.anchor) observer.observe(target.anchor);
  addEventListener("resize", place);
  let timer = 0;
  const poll = async () => {
    if (state !== "unread" || !host.isConnected) return;
    const r = await chrome.runtime.sendMessage<{ ok?: boolean; latest?: string | null; read?: boolean } | null>({ type: "pin_state", hub: target.hub, agent: target.agent }).catch(() => null);
    if (r?.ok) {
      state = pinState(mark.taken_at, r.latest, r.read);
      draw();
    }
    if (state === "unread") timer = window.setTimeout(() => void poll(), 3000);
  };
  const remove = () => {
    clearTimeout(timer);
    observer.disconnect();
    removeEventListener("resize", place);
    host.remove();
    if (pins.get(key) === remove) pins.delete(key);
  };
  close.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    ev.stopPropagation();
    remove();
    void chrome.runtime.sendMessage({ type: "pin_clear", hub: target.hub, agent: target.agent }).catch(() => {});
  });
  pins.set(key, remove);
  draw();
  timer = window.setTimeout(() => void poll(), 2000);
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
