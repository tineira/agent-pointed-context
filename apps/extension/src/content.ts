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
/** A box of text bigger than this is most of the page, not what the person pointed at. */
const BOX_MAX = 4000;

/**
 * An APC app (Pulse, Signals): a page with APC targets (data-focus), the agent bar (apc-agents) or
 * agent marks (data-apc-mark). It takes the agent itself, so there the extension does nothing at all:
 * no outline, no reading, no pin (TIN-476; it used to step back only when the app had taken the drop,
 * and moving an app's own pin left a second pin from the extension). Checked at each drag, since these
 * apps render their targets after load. Other pages that handle drags for their own sake, such as X,
 * are not APC apps: there the extension takes the agent (TIN-472).
 */
const apcApp = () => !!document.querySelector("[data-focus], apc-agents, [data-apc-mark]");

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
    if (!e.isTrusted || !carriesAgent(e) || apcApp()) return;
    e.preventDefault();
    // The dock drags a connected agent as "link"; any other answer, the page's own included, makes the browser refuse the drop.
    e.dataTransfer!.dropEffect = "link";
    light(blockAt(e.clientX, e.clientY) as HTMLElement | null);
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) light(null);
  });
  window.addEventListener("dragend", () => light(null));
  window.addEventListener("drop", (e) => {
    light(null);
    if (!e.isTrusted || !carriesAgent(e) || apcApp()) return;
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
  // Under the extension's own pins, which can sit right where the person drops.
  const at = document.elementsFromPoint(x, y).find((el) => !(el instanceof HTMLElement && "apcPin" in el.dataset)) ?? null;
  if (!at || at.closest(FIELDS)) return null;
  const block = at.closest(BLOCKS);
  if (block) return block;
  // Pages built of divs and spans (X, many web apps): the nearest box with text in it, unless that
  // box is most of the page.
  for (let el: Element | null = at; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const display = getComputedStyle(el).display;
    if (display === "inline" || display === "contents") continue;
    const text = ((el as HTMLElement).innerText ?? "").trim();
    if (text) return text.length <= BOX_MAX ? el : null;
  }
  return null;
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
 * The standard pin badge (TIN-482, `<apc-pin>` in packages/web/src/pin-badge.ts, which Pulse and
 * Signals use), drawn in the page: a rounded square with the agent's logo; a dashed, breathing
 * accent outline until the agent reads the reading, then a green check; × in its corner; the name
 * as tooltip; dimmed while dragged. Grey (faded) once a newer drop replaced the reading at the dock.
 * This is a copy of that element's look, not the element: a content script has no customElements
 * (its isolated world gets none), so the badge is built by hand in the shadow root. Keep the two in
 * step; the spec is DESIGN.md 12.8, "The pin badge".
 */
const PIN_CSS = `
.badge { position: absolute; width: 28px; height: 28px; }
.mark { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-user-drag: none; }
.mark img { -webkit-user-drag: none; pointer-events: none; }
.badge.moving { pointer-events: none; opacity: 0.35; }
.badge.moving .mark { cursor: grabbing; }
.mark { box-sizing: border-box; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: #fff; color: #141a24; box-shadow: 0 2px 6px rgb(0 0 0 / 0.18); outline-offset: 2px; }
.badge[data-apc-pin-state="unread"] .mark { outline: 2px dashed #b85209; animation: breathe 1.8s ease-in-out infinite; }
.badge[data-apc-pin-state="stale"] { opacity: 0.45; }
.face { width: 18px; height: 18px; object-fit: contain; }
.initial { font: 600 12px system-ui, sans-serif; }
.check { position: absolute; right: -7px; bottom: -7px; width: 15px; height: 15px; border-radius: 50%; background: #157a3a; color: #fff; font: 700 10px/15px ui-monospace, monospace; text-align: center; }
.unpin { position: absolute; right: -8px; top: -8px; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid #d6dce5; background: #fff; color: #56627a; font: 12px/13px system-ui, sans-serif; cursor: pointer; opacity: 0.85; }
.unpin:hover { color: #141a24; opacity: 1; }
@keyframes breathe { 0%, 100% { outline-offset: 2px; } 50% { outline-offset: 4px; } }
@media (prefers-reduced-motion: reduce) { .mark { animation: none !important; } }
`;

/**
 * The agent's mark, pinned where it was dropped (TIN-469, 13.6), in the standard pin badge's look (PIN_CSS): in the
 * margin at the start of the paragraph, so it covers no text, following it through layout changes.
 * Dashed and breathing until the agent reads the reading, then a check; faded once a newer drop
 * replaced it at the dock. × clears the reading and the agent's focus. Dragging the mark to another
 * paragraph of the page moves the agent's focus there (TIN-471), as dragging a pin's badge does in
 * Pulse (TIN-354); Esc, or a drop off any paragraph, puts it back. Asks the dock every 3 s until
 * read, then every 10 s until replaced: a read pin still fades when a newer drop replaces its reading.
 */
function pin(target: Target, mark: PinMark): void {
  const key = `${target.hub} ${target.agent}`;
  pins.get(key)?.();
  const host = document.createElement("div");
  host.dataset.apcPin = "";
  host.style.cssText = "position:absolute;z-index:2147483646;left:0;top:0;width:0;height:0";
  const root = host.attachShadow({ mode: "closed" });
  const badge = Object.assign(document.createElement("div"), { className: "badge" });
  const markEl = Object.assign(document.createElement("span"), { className: "mark" });
  markEl.append(
    mark.icon ? Object.assign(document.createElement("img"), { src: mark.icon, alt: "", className: "face" }) : Object.assign(document.createElement("span"), { textContent: (mark.name.trim()[0] ?? "A").toUpperCase(), className: "initial" }),
  );
  const check = Object.assign(document.createElement("span"), { className: "check", textContent: "✓", hidden: true });
  check.setAttribute("aria-hidden", "true");
  const close = Object.assign(document.createElement("button"), { type: "button", className: "unpin", textContent: "×", title: "Remove: your agent forgets this reading" });
  close.setAttribute("aria-label", `Remove ${mark.name}'s pin`);
  close.dataset.apcPinClose = "";
  badge.append(markEl, check, close);
  root.append(Object.assign(document.createElement("style"), { textContent: PIN_CSS }), badge);
  document.documentElement.append(host);

  let state: PinState = "unread";
  const draw = () => {
    badge.dataset.apcPinState = state;
    check.hidden = state !== "read";
    badge.title = `${mark.name}: ${state === "read" ? "read this" : state === "stale" ? "replaced by a newer drop" : "has not read this yet"}. Drag to point it at something else.`;
    place();
  };
  const place = () => {
    if (target.anchor && !target.anchor.isConnected) return remove();
    let left = target.x - 14;
    let top = target.y - 14;
    if (target.anchor) {
      const r = target.anchor.getBoundingClientRect();
      // In the left margin; with no room there, past the right edge; with no room there either,
      // inside the top right corner, as Pulse places a badge on a row: never over the first words.
      const room = 34;
      if (r.left >= room) left = r.left + scrollX - room;
      else if (r.right + room <= document.documentElement.clientWidth) left = r.right + scrollX + 6;
      else left = r.right + scrollX - 30;
      top = r.top + scrollY;
    }
    badge.style.left = `${Math.round(left)}px`;
    badge.style.top = `${Math.round(top)}px`;
  };
  const observer = new ResizeObserver(place);
  observer.observe(document.documentElement);
  if (target.anchor) observer.observe(target.anchor);
  addEventListener("resize", place);
  let timer = 0;
  const poll = async () => {
    if (state === "stale" || !host.isConnected) return;
    const r = await chrome.runtime.sendMessage<{ ok?: boolean; latest?: string | null; read?: boolean } | null>({ type: "pin_state", hub: target.hub, agent: target.agent }).catch(() => null);
    if (r?.ok) {
      state = pinState(mark.taken_at, r.latest, r.read);
      draw();
    }
    if (state !== "stale") timer = window.setTimeout(() => void poll(), state === "read" ? 10_000 : 3000);
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
  moveWith(markEl, badge, place, (x, y) => {
    // A paragraph of this page: send its reading with the browser's token, no new consent (TIN-471).
    const anchor = blockAt(x, y);
    if (!anchor || anchor === target.anchor) return false;
    const reading = readAt(x, y);
    void chrome.runtime
      .sendMessage<{ status: DropStatus; pin?: PinMark }>({ type: "move", hub: target.hub, agent: target.agent, reading })
      .then((r) => {
        if (r?.status === "sent" && r.pin) pin({ anchor, x: x + scrollX, y: y + scrollY, hub: target.hub, agent: target.agent }, r.pin);
        else say(r?.status ?? "error");
      })
      .catch(() => say("error"));
    return true;
  });
  pins.set(key, remove);
  draw();
  timer = window.setTimeout(() => void poll(), 2000);
}

/**
 * Drag a pin by its mark (TIN-471): past a few pixels it follows the pointer and outlines the paragraph
 * under it. On release, drop(x, y) says whether it took the place (the pin is then drawn there anew);
 * if not, or on Esc, the pin goes back. A trusted pointer only.
 */
function moveWith(handle: HTMLElement, badge: HTMLElement, back: () => void, drop: (x: number, y: number) => boolean): void {
  // The browser's own drag (of the logo image, or of selected text) would cancel the pointer: none.
  handle.addEventListener("dragstart", (e) => e.preventDefault());
  handle.addEventListener("pointerdown", (down) => {
    if (!down.isTrusted || down.button !== 0) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    let moving = false;
    let lit: HTMLElement | null = null;
    let litOutline = "";
    const light = (el: HTMLElement | null) => {
      if (lit === el) return;
      if (lit) lit.style.outline = litOutline;
      lit = el;
      if (el) {
        litOutline = el.style.outline;
        el.style.outline = "2px solid #d4733a";
      }
    };
    const end = () => {
      light(null);
      badge.classList.remove("moving");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      removeEventListener("keydown", onKey, true);
    };
    const onMove = (e: PointerEvent) => {
      if (!moving && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return;
      moving = true;
      badge.classList.add("moving");
      badge.style.left = `${Math.round(e.pageX - 14)}px`;
      badge.style.top = `${Math.round(e.pageY - 14)}px`;
      light(blockAt(e.clientX, e.clientY) as HTMLElement | null);
    };
    const onUp = (e: PointerEvent) => {
      end();
      if (moving && e.isTrusted && drop(e.clientX, e.clientY)) return;
      back();
    };
    const onCancel = () => {
      end();
      back();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    addEventListener("keydown", onKey, true);
  });
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
