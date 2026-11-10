/**
 * The content script (TIN-421, DESIGN.md 13.1 and 13.2), on the sites the person granted: it lets a
 * page take the agent the person drags from their dock or Float. On an APC app it does nothing at all
 * (the app takes the drop itself), except on a Direct-only app that would lose the drop (APC 0.5). On
 * any other page it takes the agent's drop whatever the page's own handlers do: its dragover answer
 * stays last on window, and its drop listener runs first, on window in the capture phase (TIN-572,
 * TIN-573). There it reads the block of text at the drop point, the selection and the form state
 * around it (TIN-571), and hands them to the service worker. When the service worker needs the
 * person's consent for the site (TIN-465, 13.3), a card where the agent was dropped asks, and the
 * answer goes back with the same drop. Once the reading is sent, the agent's mark stays pinned on the
 * paragraph (TIN-469, 13.6), showing whether the agent read it.
 */
import { APC_AGENT_TYPE, APC_DROPS_ATTR, parseAgentDrag } from "../../../packages/web/src/pinning.ts";
import { CONTEXT_MAX } from "../../dock/src/worker/reading.ts";
import { connectLabel, directOnlyGate, appTakes, notTaken, frameNote, hubAllowed, INCLUDE_LABEL, isApcApp, NOT_TAKEN_TEXT, pinState, sensitiveNote, sentWithout, STATUS_TEXT, type Consent, type DirectOnly, type DirectOnlyLookup, type DropStatus, type PinMark, type PinState, type SensitiveMode } from "./drop.ts";
import { chartAxes, describeMark, describeNamed, isMark, isOutlineCopy, type Axes, type Chart, type ChartLabel, type MarkReading, type SvgText } from "./chart.ts";
import { altText, ANYWHERE, blockAbove, BOX_MAX, cardOf, CARD_CONTROLS_MAX, clipPathHides, controlVisible, filterOpacity, classify, formState, intersect, isHeading, isItem, isTitleControl, namesBox, OPACITY_MIN, ownsHeadings, pageLevel, selectTitle, showsIn, tableContext, titleOf, visibleWords, visuallyHidden, within, type Control, type Rect, type Seen } from "./read.ts";

/** What a reading may come from: a block of text, never a form field. */
const BLOCKS = "p,li,td,th,dd,dt,blockquote,pre,figcaption,caption,h1,h2,h3,h4,h5,h6,[role=heading],a,button,label,legend,summary";
const FIELDS = "input,textarea,select,option,[contenteditable=''],[contenteditable='true']";
const TEXT_MAX = 2048;
const HEADER_MAX = 200;
/** A form's card (a question, a field with its label) holds at most this much text (cardOf). */
const CARD_TEXT_MAX = 1200;
/** The most elements the content script looks through for a card's controls. */
const ELEMENTS_SCANNED = 5000;

/**
 * An APC app (Pulse, Signals): a page with the standard's own marks (isApcApp: the agent bar apc-agents,
 * agent marks data-apc-mark, or the attribute enablePinning sets while it takes dock drops; never the
 * generic data-focus, TIN-703). It takes the agent itself, so there the extension reads nothing and pins
 * nothing (TIN-476; it used to step back only when the app had taken the drop, and moving an app's own pin
 * left a second pin from the extension). Checked at each drag, since these apps render their marks after
 * load. Other pages that handle drags for their own sake, such as X, are not APC apps: there the
 * extension takes the agent (TIN-472).
 */
const apcApp = () => isApcApp(document.documentElement);

/** The tab's top frame; a frame inside it (TIN-752) takes its own drops, in its own coordinates. */
const isTop = window === window.top;

/** In a frame, the host of the tab's page (the last of location.ancestorOrigins), or null when Chrome does not say. */
function tabHost(): string | null {
  const origins = location.ancestorOrigins;
  const top = origins?.length ? origins[origins.length - 1] : null;
  try {
    return top && top !== "null" ? new URL(top).host : null;
  } catch {
    return null;
  }
}

/**
 * One exception (APC 0.5): an APC app that connects agents only directly (its apc.json lists no
 * "dock") and does not answer a dock agent's drop itself (no APC_DROPS_ATTR, which @tineira/apc-web sets).
 * There a drop would be lost, so the extension takes it and tells the person how to connect directly.
 * The service worker reads the app's apc.json on the first drag of an agent over it; while it is on its
 * way the drop is taken too, and answered when it comes back (directOnlyGate). A lookup that told
 * nothing is asked again on a later drag.
 */
const directOnly = directOnlyGate(
  () =>
    chrome.runtime
      .sendMessage<Partial<DirectOnlyLookup> | null>({ type: "apc_json" })
      .then((r): DirectOnlyLookup => ({ directOnly: r?.directOnly ?? null, read: r?.read === true })),
  () => document.documentElement.hasAttribute(APC_DROPS_ATTR),
);

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
  /** Each drop's place, by its id: its pin and its "Include them this time" may come later, once the person allowed this browser in the dock. */
  const pending = new Map<string, { target: Target; x: number; y: number }>();
  const outlining = outliner();
  const light = outlining.light;
  /** On an APC app, whether nothing on the page took the last dragover, so the extension did (TIN-703). */
  let unanswered = false;
  /** With `unanswered`: whether the last dragover was over something the app takes (appTakes), so an app that left it unanswered ignores drops on its own targets (Pulse without v2). */
  let overTarget = false;
  // A copy left from before the extension was reloaded or updated has lost its extension: it stands
  // back, so the fresh copy injected next to it takes the drop.
  const carriesAgent = (e: DragEvent) => !!chrome.runtime?.id && !!e.dataTransfer && [...e.dataTransfer.types].includes(APC_AGENT_TYPE);

  const onDragover = (e: DragEvent) => {
    if (!e.isTrusted || !carriesAgent(e)) return;
    if (apcApp()) {
      unanswered = false;
      if (!directOnly.accepts()) {
        // The app answers its own drops, and its handlers ran before this one (keepLast). When none took this
        // dragover, the browser would refuse the drop with no word (TIN-703): the extension takes it, to say so.
        if (e.defaultPrevented) return;
        unanswered = true;
        overTarget = appTakes(document.elementFromPoint(e.clientX, e.clientY));
      }
      // A Direct-only app that would lose the drop (or one that may be, its file still on its way), or a drop
      // nothing on the page takes: take it anywhere, to answer it. Nothing is outlined: there is nothing to read.
      e.preventDefault();
      e.dataTransfer!.dropEffect = "link";
      keepLast();
      return;
    }
    e.preventDefault();
    // The dock drags a connected agent as "link"; any other answer, the page's own included, makes the browser refuse the drop.
    e.dataTransfer!.dropEffect = "link";
    // The outline is what goes (TIN-619): the same element is read on the drop.
    light(scopeAt(e.clientX, e.clientY));
    // The browser sends dragover every few dozen milliseconds while the agent is over the page. A drag that ends
    // elsewhere (Esc, released outside the page) sends this page neither drop nor dragend: without a dragover for
    // OUTLINE_IDLE_MS, the outline goes, and what was found about the page's charts with it.
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      light(null);
      forgetScopes();
    }, OUTLINE_IDLE_MS);
    keepLast();
  };
  let idleTimer = 0;
  // Whichever handler answers last wins, and a page's own can come after this one and refuse every
  // drag, as Grok's does (TIN-572). Added again, this one runs after them from the next event on.
  const keepLast = () => {
    window.removeEventListener("dragover", onDragover);
    window.addEventListener("dragover", onDragover);
  };
  window.addEventListener("dragover", onDragover);

  /** An APC app's drop (APC 0.5): the app's own, unless it is Direct-only and would lose it. */
  const onAppDrop = (e: DragEvent) => {
    const answer = directOnly.drop();
    if (!answer) {
      // Nothing on the page took the drag (TIN-703): the card of a drop an app cannot take (TIN-579), not silence.
      // Decided at the drop point too: the last dragover may have been off a target and the drop on one, which
      // the app then takes (it decides from the drop point as well).
      // The app's own rule (appTakes = its targetOf), from the element its targetAt starts at. An app that left the
      // last dragover unanswered ON a target does not take drops there at all (Pulse without v2, TIN-756): the card.
      const stale = !notTaken(unanswered, overTarget, appTakes(document.elementFromPoint(e.clientX, e.clientY)));
      unanswered = false;
      overTarget = false;
      if (stale) return;
      e.preventDefault();
      return answerDirectOnly({ name: "", host: location.host, connect: null, message: NOT_TAKEN_TEXT }, e.clientX, e.clientY);
    }
    // The extension took the drop on dragover, so the browser's own action (opening what was dropped) never runs.
    e.preventDefault();
    if ("now" in answer) {
      // Known Direct-only: the extension answers, and a page with an older @tineira/apc-web does not answer it a second time.
      e.stopImmediatePropagation();
      return answerDirectOnly(answer.now, e.clientX, e.clientY);
    }
    // Still reading the app's file: the drop is held, so the page does not act on it and then get a card
    // too. When the file says Direct-only, the card; otherwise the same drop goes back to the page, on the
    // element it landed on, with the same data (untrusted, so this listener lets it through).
    e.stopImmediatePropagation();
    const { clientX, clientY, screenX, screenY, ctrlKey, shiftKey, altKey, metaKey } = e;
    const at = e.target;
    const items = [...e.dataTransfer!.types].filter((t) => t !== "Files").map((t) => [t, e.dataTransfer!.getData(t)] as const);
    void answer.later.then((app) => {
      if (app) return answerDirectOnly(app, clientX, clientY);
      const transfer = new DataTransfer();
      for (const [type, value] of items) transfer.setData(type, value);
      at?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, clientX, clientY, screenX, screenY, ctrlKey, shiftKey, altKey, metaKey, dataTransfer: transfer }));
    });
  };

  /**
   * Any other page's drop: read what was outlined, then send it. The page's own handlers still see the
   * drop. The reading is taken once, here, under an id: the service worker keeps it by that id, and
   * "Include them this time" names the id, never another drop's reading.
   */
  const onPageDrop = (e: DragEvent, outlined: Element | null) => {
    e.preventDefault();
    const drag = parseAgentDrag(e.dataTransfer!.getData(APC_AGENT_TYPE));
    if (!drag?.hub || !drag.ticket) return say("no_ticket");
    if (!hubAllowed(drag.hub, __APC_DEV__)) return say("unknown_dock");
    // A frame with an opaque origin (sandboxed, data:): it has no address a reading could name, so nothing is read (TIN-752).
    if (location.origin === "null") return say("opaque_frame");
    // The page took away what was outlined: what is under the pointer now is not what the person saw outlined, so nothing goes.
    if (outlined && !outlined.isConnected) return say("outline_changed");
    const reading = readAt(e.clientX, e.clientY, outlined);
    const id = crypto.randomUUID();
    const target: Target = { anchor: outlined, x: e.pageX, y: e.pageY, hub: drag.hub, agent: drag.agent };
    pending.set(id, { target, x: e.clientX, y: e.clientY });
    const send = (consent?: Consent) =>
      chrome.runtime
        .sendMessage<Reply>({ type: "drop", id, drag: { hub: drag.hub, agent: drag.agent, ticket: drag.ticket }, reading, ...(consent ? { consent } : {}) })
        .then((r) => {
          const status = r?.status ?? "error";
          if (status === "consent" || status === "consent_sensitive" || status === "consent_update") return ask(status, e.clientX, e.clientY, send, r?.sensitive, r?.asks);
          if (status !== "asking") pending.delete(id);
          sent(r ?? { status }, target, e.clientX, e.clientY);
        })
        .catch(() => say("error"));
    void send();
  };

  // dragenter and drop listen in the capture phase on window, which the content script fills before the
  // page's own scripts run (it runs at document_start), so no listener of the page comes before them.
  // In a tab the script was injected into later, a page's earlier capture listener could stop them:
  // for dragenter that costs little, since each dragover moves the dragover listener too.
  window.addEventListener(
    "dragenter",
    (e) => {
      if (!e.isTrusted || !carriesAgent(e)) return;
      if (isTop) cancelFrameHint();
      else tellTop();
      if (apcApp()) directOnly.start();
      keepLast();
    },
    true,
  );

  /**
   * A frame the extension may not enter (TIN-752): drags over it go to that frame's document, which has no
   * content script, so the browser refuses the drop and the extension never sees it. The top frame notices
   * the agent leaving its document for a frame, waits a moment for a frame with the content script to say it
   * has the drag (frame_drag, through the service worker), and otherwise asks the service worker which of the
   * tab's frames no grant covers: only when some are does it show the note, at most once in HINT_MS.
   */
  let hintTimer = 0;
  let hintedAt = -Infinity;
  const HINT_MS = 10_000;
  const hinted = () => Date.now() - hintedAt < HINT_MS;
  /** Bumped when the drag comes back or a frame has it, so an answer on its way is not shown. */
  let hintRound = 0;
  /** Removes the note shown, when a frame with the content script turns out to have the drag after all. */
  let hintShown: (() => void) | null = null;
  function cancelFrameHint() {
    clearTimeout(hintTimer);
    hintTimer = 0;
    hintRound++;
    hintShown?.();
    hintShown = null;
  }
  const isFrame = (el: EventTarget | null): el is HTMLIFrameElement | HTMLFrameElement => el instanceof Element && (el.tagName === "IFRAME" || el.tagName === "FRAME");
  /** The frame element the agent went into, if the event says. */
  const frameInto = (e: DragEvent) => {
    const at = document.elementFromPoint(e.clientX, e.clientY);
    return isFrame(at) ? at : isFrame(e.target) ? e.target : null;
  };
  const frameHint = async (frame: Element) => {
    hintTimer = 0;
    const round = hintRound;
    // That frame's id, so the note names its origin only when it is the frame under the pointer (-1 when Chrome cannot tell).
    let id: number | null = null;
    try {
      const found = chrome.runtime.getFrameId?.(frame);
      id = typeof found === "number" && found > 0 ? found : null;
    } catch {
      id = null;
    }
    const r = await chrome.runtime.sendMessage<{ note?: boolean; origin?: string | null } | null>({ type: "frames_outside", frame: id }).catch(() => null);
    if (round !== hintRound || hinted() || !r?.note) return;
    hintedAt = Date.now();
    hintShown = notice(frameNote(typeof r.origin === "string" ? r.origin : null), "frame", 6000);
  };
  /** A frame with the content script has the agent's drag: the top frame's note would be wrong. */
  let toldAt = 0;
  function tellTop() {
    if (Date.now() - toldAt < 300) return;
    toldAt = Date.now();
    void chrome.runtime.sendMessage({ type: "frame_drag" }).catch(() => {});
  }
  // The drop before any handler of the page (TIN-573): a page that stops drop on document or body, as it
  // may for its own drags, no longer keeps it from the extension. It used to listen in the bubble phase.
  window.addEventListener(
    "drop",
    (e) => {
      // What was outlined when the agent was let go is what is read (TIN-619).
      const outlined = outlining.lit();
      light(null);
      forgetScopes();
      if (!e.isTrusted || !carriesAgent(e)) return;
      if (apcApp()) onAppDrop(e);
      else onPageDrop(e, outlined);
    },
    true,
  );
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) light(null);
    if (!isTop || hinted() || !e.isTrusted || !carriesAgent(e)) return;
    const frame = frameInto(e);
    if (!frame) return;
    cancelFrameHint();
    hintTimer = window.setTimeout(() => void frameHint(frame), 400);
  });
  window.addEventListener("dragend", () => {
    light(null);
    forgetScopes();
  });
  // The service worker's later word, once the person answered in the dock.
  chrome.runtime.onMessage.addListener((m) => {
    const msg = m as Reply & { type?: string };
    // A frame of this tab has the agent's drag (TIN-752).
    if (msg.type === "frame_drag") return cancelFrameHint();
    if (msg.type !== "status" || !msg.status || !(msg.status in STATUS_TEXT)) return;
    // The drop this word is about, by its id: never whichever drop came last.
    const drop = msg.id ? pending.get(msg.id) : undefined;
    if (!drop) return say(msg.status);
    pending.delete(msg.id!);
    sent(msg, drop.target, drop.x, drop.y);
  });
}

/** The service worker's answer to a drop, a moved pin or "Include them this time". */
interface Reply {
  status: DropStatus;
  pin?: PinMark;
  /** The sensitive values the outline held (TIN-619): how many, the setting, and whether the person may still include them. */
  sensitive?: { count: number; mode: SensitiveMode; offer: boolean };
  /** The drop it is about (its reading's id). */
  id?: string;
  /** On a card that asks every time: the host whose setting or domain makes it ask (the tab's, or a frame's own). */
  asks?: string;
}

/**
 * After a reading went (or did not): the note, the pin, and under Ask per drop, when sensitive values
 * were left out, the card that offers to send that drop's reading with them (TIN-619): it names the
 * drop's id, and the service worker sends the reading it kept for that id.
 */
function sent(r: Reply, target: Target, x: number, y: number): void {
  if (r.status === "sent" && r.sensitive?.offer && r.id) {
    offerInclude(r.sensitive.count, x, y, () =>
      chrome.runtime
        .sendMessage<Reply>({ type: "include", id: r.id })
        .then((again) => {
          say(again?.status ?? "error");
          if (again?.status === "sent" && again.pin) pin(target, again.pin);
        })
        .catch(() => say("error")),
    );
  } else {
    say(r.status);
  }
  if (r.status === "sent" && r.pin) pin(target, r.pin);
}

/** The page's element at a point, under the extension's own pins and cards, which can sit right where the person drops. */
function elementAt(x: number, y: number): Element | null {
  return document.elementsFromPoint(x, y).find((el) => !(el instanceof HTMLElement && ("apcPin" in el.dataset || "apcCard" in el.dataset))) ?? null;
}

/** The host of one of the extension's cards and notes: never what a drop or the outline lands on. */
function cardHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.dataset.apcCard = "";
  return host;
}

/**
 * The last scope found while dragging, by the element under the pointer and the chart mark there (an
 * SVG overlay such as a chart's tracker can lie over many marks): dragover comes many times a second.
 */
let scopeCache: { under: Element | null; mark: Element | null; scope: Element | null } | null = null;

/** Without a dragover for this long, the drag is taken as gone: its outline and what was found go. */
const OUTLINE_IDLE_MS = 700;

/** Forgets what was found while dragging (the scope, the page's charts): on a drop, the drag's end, or idle. */
function forgetScopes(): void {
  scopeCache = null;
  charts.clear();
}

/**
 * What the outline covers at a point (scopeOf), as the person drags: a chart's mark (a point, a bar) when
 * the drop lands on one the chart says something about (TIN-760), otherwise scopeOf.
 */
function scopeAt(x: number, y: number): Element | null {
  const under = deepElementAt(x, y);
  const mark = markAt(x, y, under);
  if (scopeCache?.under === under && scopeCache.mark === mark && (!scopeCache.scope || scopeCache.scope.isConnected)) return scopeCache.scope;
  const scope = mark ?? scopeOf(under, elementAt(x, y));
  scopeCache = { under, mark, scope };
  return scope;
}

/** Whether CSS draws an outline on the element: an HTML element, or a drawing's outermost <svg>. */
const outlines = (el: Element | null): el is HTMLElement | SVGSVGElement => el instanceof HTMLElement || (el instanceof SVGSVGElement && !el.ownerSVGElement);

/**
 * What the person sees around the extension's outline: an outline on the element itself (style.outline,
 * put back as it was), or, for an SVG element inside a drawing (a chart's mark), where CSS draws none, a
 * box over it, drawn in a closed shadow root of the extension's own host (as the pin and the cards are),
 * which takes no pointer and is put where the element is on each call (the page may scroll while the agent
 * is dragged).
 */
function outliner(): { light: (el: Element | null) => void; lit: () => Element | null } {
  let lit: Element | null = null;
  let litOutline = "";
  let host: HTMLDivElement | null = null;
  let box: HTMLDivElement | null = null;
  const place = (el: Element) => {
    const r = el.getBoundingClientRect();
    box!.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #d4733a;border-radius:3px`;
  };
  const light = (el: Element | null) => {
    if (lit === el) {
      if (el && box) place(el);
      return;
    }
    if (outlines(lit)) lit.style.outline = litOutline;
    host?.remove();
    host = box = null;
    lit = el;
    if (outlines(el)) {
      litOutline = el.style.outline;
      el.style.outline = "2px solid #d4733a";
    } else if (el) {
      host = cardHost();
      host.dataset.apcOutline = "";
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;pointer-events:none!important;z-index:2147483646!important";
      const root = host.attachShadow({ mode: "closed" });
      box = document.createElement("div");
      box.dataset.apcOutlineBox = "";
      place(el);
      root.append(box);
      document.documentElement.append(host);
    }
  };
  return { light, lit: () => lit };
}

/**
 * What the outline covers, and so what a reading reads (TIN-619): on a form control, its card (the
 * largest box around it that holds no other control: a field with its label, a Google Form's question);
 * on the label, legend or title of a control (a label's control, a legend's fieldset, or a control that
 * names it in aria-labelledby), that control's card; otherwise the nearest block of text, which may be a
 * whole form when the drop lands on its margin. Null on a margin of the page or in a field one edits
 * as rich text. `deep` is the element at the point inside open shadow roots, `under` at the document's level.
 */
function scopeOf(deep: Element | null, under: Element | null): Element | null {
  if (!deep) return null;
  if (deep.closest("[contenteditable=''],[contenteditable='true']")) return null;
  const control = deep.closest(CONTROLS);
  if (control) return controlCard(control);
  const block = blockOf(deep) ?? (under && under !== deep ? blockOf(under) : null);
  if (!block) return null;
  return labelCard(block) ?? block;
}

/** Each control's key for a card: a radio stands for its whole group, any other control for itself. */
const keyIds = new WeakMap<Element, number>();
let keyCount = 0;
function keyOf(c: Element): string {
  const id = (e: Element) => {
    let n = keyIds.get(e);
    if (n === undefined) keyIds.set(e, (n = ++keyCount));
    return n;
  };
  if (c instanceof HTMLInputElement && c.type === "radio" && c.name) return `radio:${c.name}`;
  const group = c.getAttribute("role") === "radio" ? c.closest("[role=radiogroup]") : null;
  return group ? `group:${id(group)}` : `el:${id(c)}`;
}

/**
 * The controls in an element, its open shadow roots included (not hidden inputs), or null when there
 * are more than max of them or the element holds more than elementsMax elements.
 */
function controlsIn(el: Element, max: number, elementsMax = Infinity): Element[] | null {
  if (el.getElementsByTagName("*").length > elementsMax) return null;
  const out: Element[] = [];
  const take = (c: Element) => {
    if (c instanceof HTMLInputElement && c.type === "hidden") return true;
    out.push(c);
    return out.length <= max;
  };
  const visit = (root: Element | ShadowRoot): boolean => {
    for (const c of root.querySelectorAll(CONTROLS)) if (!take(c)) return false;
    for (const e of root.querySelectorAll("*")) if (e.shadowRoot && !visit(e.shadowRoot)) return false;
    return true;
  };
  if (el.matches(CONTROLS) && !take(el)) return null;
  if (el.shadowRoot && !visit(el.shadowRoot)) return null;
  return visit(el) ? out : null;
}

/** An element's control keys, or null when it holds too many controls or elements to be a card. */
function controlKeys(el: Element): Set<string> | null {
  const found = controlsIn(el, CARD_CONTROLS_MAX, ELEMENTS_SCANNED);
  return found ? new Set(found.map(keyOf)) : null;
}

/** An element's parent, across shadow roots. */
const parentOf = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
const isPage = (e: Element) => e === document.body || e === document.documentElement;
const cardText = (e: Element) => readable(e, CARD_TEXT_MAX + 1).trim().length;

/** The card around a control (cardOf). */
function controlCard(control: Element): Element {
  return cardOf(control, new Set([keyOf(control)]), parentOf, controlKeys, cardText, isPage, CARD_TEXT_MAX);
}

/**
 * The card of the control a block of text labels, or null when it labels none, holds controls itself,
 * or sits with other controls: a label's control, a legend's fieldset, or the controls that name it (or
 * an element in it) in aria-labelledby, as a Google Form's answer names its question's title.
 */
function labelCard(block: Element): Element | null {
  // A block that holds a control (a label around its field) is its own scope: null from controlsIn means at least one.
  if (controlsIn(block, 0) === null) return null;
  const targets: Element[] = [];
  const label = block.closest("label");
  if (label?.control) targets.push(label.control);
  const legend = block.closest("legend");
  if (legend?.parentElement instanceof HTMLFieldSetElement) targets.push(legend.parentElement);
  const root = block.getRootNode() as Document | ShadowRoot;
  const ids = [block, ...block.querySelectorAll("[id]")].slice(0, 50).map((e) => e.id).filter(Boolean);
  for (const id of ids) targets.push(...root.querySelectorAll(`[aria-labelledby~="${CSS.escape(id)}"]`));
  if (!targets.length) return null;
  const own = new Set<string>();
  for (const t of targets) for (const c of controlsIn(t, CARD_CONTROLS_MAX) ?? []) own.add(keyOf(c));
  if (!own.size) return null;
  let common: Element | null = block;
  while (common && !targets.every((t) => common!.contains(t))) common = common.parentElement;
  if (!common || isPage(common)) return null;
  const keys = controlKeys(common);
  if (!keys || keys.size !== own.size || [...keys].some((k) => !own.has(k)) || cardText(common) > CARD_TEXT_MAX) return null;
  return cardOf(common, own, parentOf, controlKeys, cardText, isPage, CARD_TEXT_MAX);
}

/** An element's text as the person sees it, spaces folded, counted up to a little past BOX_MAX. */
const seenLength = (e: Element) => readable(e, BOX_MAX + 1).replace(/\s+/g, " ").trim().length;

/** blockAbove on the page, across shadow roots: inline boxes without alternative text give their words to the box around them. */
const climb = {
  up: parentOf,
  top: isPage,
  inline: (e: Element) => {
    const display = getComputedStyle(e).display;
    return (display === "inline" || display === "contents") && !altText(e);
  },
  item: (e: Element) => isItem(e.tagName, e.getAttribute("role")),
  text: seenLength,
};

/**
 * The nearest block of text around an element, or null (a form field, or a box that is most of the page).
 * A block the person sees no text in is none (TIN-697): a link stretched over a card to make all of it
 * clickable holds only words for screen readers, so a drop on the card's photo or text lands on it, and
 * the card around it is what was pointed at. Pages built of divs and spans (X, many web apps) and a drop on
 * a photo get the box around them (blockAbove).
 */
function blockOf(under: Element | null): Element | null {
  // A formula or a drawing as a whole, not the glyph or shape inside it.
  const at = under?.closest("math,svg") ?? under;
  if (!at || at.closest(FIELDS)) return null;
  const block = at.closest(BLOCKS);
  if (block && seenLength(block)) return block;
  return blockAbove(at, climb);
}

// ---- chart marks (TIN-760, TIN-765) ----
// What the page declares, never what has to be guessed, and nothing per chart library: no class name is read. A
// shape is told by its paint, its size, its place among the drawing's labels, and its ARIA (aria-hidden, a
// control's role, its own name).

/** The shapes a chart draws its data with. */
const SHAPES = "path,circle,rect,ellipse,polygon";
/** Roles of controls: a shape in one (a legend's toggle, an export button, a scrollbar's handle) is never a mark. */
const CONTROL_ROLES = new Set(["button", "link", "checkbox", "switch", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "slider", "scrollbar", "spinbutton", "combobox", "textbox", "searchbox"]);
/** HTML controls: text over a drawing inside one is no label of the drawing. */
const HTML_CONTROLS = "a[href],button,input,select,textarea,label,summary,[contenteditable=''],[contenteditable='true']";
/** The most labels and shapes looked at in one chart. */
const CHART_SCANNED = 600;
/** How much of its drawing a mark of a chart may cover; one that names itself (a pie's largest slice) may cover more. */
const MARK_SHARE = 0.25;
const NAMED_SHARE = 0.9;

/** The drawing an element is in: its outermost <svg>. */
function drawingOf(el: Element): SVGSVGElement | null {
  let svg = el.closest("svg");
  while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
  return svg;
}

/** A box's area. */
const area = (r: Rect) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/** An element's first role, lower case, or null. */
const roleWord = (e: Element) => e.getAttribute("role")?.trim().toLowerCase().split(/\s+/)[0] || null;

/** Whether an element, or anything it is in below `top`, is a control: its role, or an HTML control. */
function inControl(el: Element, top: Element): boolean {
  for (let at: Element | null = el; at && at !== top; at = at.parentElement) if (CONTROL_ROLES.has(roleWord(at) ?? "") || at.matches(HTML_CONTROLS)) return true;
  return false;
}

/** Whether a shape, or anything it is in below `top`, is hidden from assistive technology (aria-hidden) or is a control. */
function hiddenOrControl(el: Element, top: Element): boolean {
  for (let at: Element | null = el; at && at !== top; at = at.parentElement) if (at.getAttribute("aria-hidden") === "true") return true;
  return inControl(el, top);
}

interface ChartInfo {
  chart: Chart;
  axes: Axes | null;
  /** The drawing's shapes that could be marks (dataShape), and their boxes and kinds in the same order. */
  shapes: Element[];
  /** The group each shape is drawn in: the nearest group around it that holds another shape too (its series). */
  groups: Map<Element, Element>;
  /** The accessible texts of the shapes that name themselves (describeNamed). */
  named: string[];
  marks: Map<Element, MarkReading | null>;
}

/**
 * What was found about each drawing during one drag (its labels, its shapes, whether it is a chart) and about each mark
 * the pointer went over: dragover comes many times a second, and these walks are not cheap. Forgotten on the drop, at
 * the drag's end and when no dragover came for OUTLINE_IDLE_MS (forgetScopes).
 */
const charts = new Map<SVGSVGElement, ChartInfo>();

/**
 * Whether a shape could be a mark by its own looks and markup: a filled shape the person sees (a stroke-only line, a
 * fill that is none or nearly transparent, as a tracker's, is not), not hidden from assistive technology and not in a
 * control, at most `share` of its drawing (no background or plot area). Whether it is one takes more (readMark).
 */
function dataShape(el: Element, share = MARK_SHARE): boolean {
  if (!(el instanceof SVGGraphicsElement) || !el.matches(SHAPES) || el.closest("defs,clipPath,mask,marker,pattern,symbol")) return false;
  const svg = drawingOf(el);
  if (!svg || hiddenOrControl(el, svg)) return false;
  const style = getComputedStyle(el);
  if (style.fill === "none" || alpha(style.fill) < OPACITY_MIN || Number(style.fillOpacity) < OPACITY_MIN || effectiveOpacity(el) < OPACITY_MIN || !rendered(el)) return false;
  const box = area(boxOf(el));
  return box > 0 && box <= area(boxOf(svg)) * share;
}

/**
 * Where a `clip-path: url(#id)` lets an element show, in the viewport (TIN-765). Null when the element has no such clip
 * path. "missing" when the id names no <clipPath> in the element's document or shadow root: what it clips is not read.
 * A clip path of one rect (as a chart clips its plot) gives that rect: in user space for an SVG element, from the
 * element's border box for HTML (in fractions of it with objectBoundingBox, which SVG elements are not read with).
 * "complex" otherwise: what it clips is not read, SVG or HTML, since its words may be cut anywhere.
 */
function urlClip(at: Element): Rect | "missing" | "complex" | null {
  const url = /^url\(["']?#([^"')]+)["']?\)$/.exec(getComputedStyle(at).clipPath);
  if (!url) return /^url\(/.test(getComputedStyle(at).clipPath) ? "missing" : null;
  const clip = (at.getRootNode() as Document | ShadowRoot).getElementById?.(url[1]!) ?? null;
  if (!(clip instanceof SVGClipPathElement)) return "missing";
  const shapes = [...clip.children];
  const rect = shapes.length === 1 && shapes[0] instanceof SVGRectElement && !shapes[0].hasAttribute("transform") && !clip.hasAttribute("transform") ? shapes[0] : null;
  if (!rect) return "complex";
  const { x, y, width, height } = rect.getBBox();
  const units = clip.getAttribute("clipPathUnits") === "objectBoundingBox";
  if (at instanceof SVGGraphicsElement) {
    const ctm = at.getScreenCTM();
    if (!ctm || units) return "complex";
    const corners = [new DOMPoint(x, y), new DOMPoint(x + width, y + height)].map((p) => p.matrixTransform(ctm));
    return { left: Math.min(corners[0]!.x, corners[1]!.x), top: Math.min(corners[0]!.y, corners[1]!.y), right: Math.max(corners[0]!.x, corners[1]!.x), bottom: Math.max(corners[0]!.y, corners[1]!.y) };
  }
  if (at instanceof SVGElement) return "complex";
  const b = boxOf(at);
  const [w, h] = [b.right - b.left, b.bottom - b.top];
  return units ? { left: b.left + x * w, top: b.top + y * h, right: b.left + (x + width) * w, bottom: b.top + (y + height) * h } : { left: b.left + x, top: b.top + y, right: b.left + x + width, bottom: b.top + y + height };
}

/** How a `clip-path: url()` cuts what an element shows (urlClip): "hide" when nothing of it is read, a rect, or null. */
function clipCut(at: Element): Rect | "hide" | null {
  const clip = urlClip(at);
  return clip === "missing" || clip === "complex" ? "hide" : clip;
}

/** The most characters of one chart label. */
const LABEL_MAX = 200;

/**
 * The words of a text a chart's reading may use (TIN-765, rule C): an SVG <text>, HTML laid over the drawing, or what
 * aria-labelledby names. Each is taken with readable's own walk, so only words whose boxes show count: transparent ink
 * (an SVG fill, an HTML colour or -webkit-text-fill-color), opacity, `clip`, `clip-path` (one the extension cannot
 * resolve hides all), the overflow boxes around it and its own are honoured, as are its descendants' (a hidden span
 * inside it is left out). Its whole box must lie inside the drawing's, so nothing off screen or outside the chart is
 * read; and it is never a control or text inside one (a textarea's, a select's options). "" when nothing shows.
 */
function chartText(e: Element, drawn: Rect): string {
  if (inControl(e, document.documentElement) || !within(boxOf(e), drawn)) return "";
  // What clips the elements around it, which readable's walk (starting at the text) does not see: a clip path that
  // hides, `clip`, and a `clip-path: url()` (clipCut: a plot's rect cuts; one that is missing hides all).
  let bound = drawn;
  for (let at = parentOf(e); at && at !== document.documentElement; at = parentOf(at)) {
    const style = getComputedStyle(at);
    if (clipPathHides(style.clipPath)) return "";
    if ((style.position === "absolute" || style.position === "fixed") && style.clip !== "auto" && style.clip !== "") return "";
    const cut = clipCut(at);
    if (cut === "hide") return "";
    if (cut) bound = intersect(bound, cut);
  }
  return readable(e, LABEL_MAX, bound).replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
}

/** How an SVG text is painted: with a stroke at all, and with a stroke only (a fill that is none, transparent or the stroke's own colour). */
function paintOf(e: Element): { stroked: boolean; strokeOnly: boolean } {
  const style = getComputedStyle(e);
  const stroked = style.stroke !== "none" && alpha(style.stroke) * Number(style.strokeOpacity) >= OPACITY_MIN && parseFloat(style.strokeWidth) > 0;
  return { stroked, strokeOnly: stroked && (style.fill === "none" || alpha(style.fill) * Number(style.fillOpacity) < OPACITY_MIN || style.fill === style.stroke) };
}

/**
 * Whether an SVG text or tspan is the outline copy of a label drawn twice (isOutlineCopy): drawn with a stroke only,
 * with an unstroked twin with the same words at the same place, a text or tspan beside it or the text written
 * straight after it in the same <text>.
 */
function outlineCopy(e: Element): boolean {
  if (!(e instanceof SVGTextElement || e instanceof SVGTSpanElement)) return false;
  const paint = paintOf(e);
  if (!paint.strokeOnly) return false;
  const parent = e.parentElement;
  const twins: SvgText[] = [];
  for (const s of [...(parent?.children ?? [])].slice(0, CHART_SCANNED)) {
    if (s !== e && (s instanceof SVGTextElement || s instanceof SVGTSpanElement)) twins.push({ text: s.textContent ?? "", box: boxOf(s), ...paintOf(s) });
  }
  if (e instanceof SVGTSpanElement && parent) {
    const range = document.createRange();
    for (const node of parent.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      twins.push({ text: node.textContent, box: range.getBoundingClientRect(), ...paintOf(parent) });
    }
  }
  return isOutlineCopy({ text: e.textContent ?? "", box: boxOf(e), ...paint }, twins);
}

/** The element a drawing's HTML labels may be in: the drawing's own parent, unless that is the page. */
function holderOf(svg: SVGSVGElement): Element | null {
  const parent = svg.parentElement;
  return parent && !isPage(parent) ? parent : null;
}

/**
 * The text a page declares as a name: aria-label, else the words of what aria-labelledby names, when that is inside
 * `scope` (the drawing's holder) and inside the drawing's box, and taken as any chart text is (chartText): what the
 * person sees of it, never a control.
 */
function declaredName(el: Element, scope: Element, drawn: Rect): string | null {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label.slice(0, LABEL_MAX);
  const ids = el.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const texts = ids.map((id): Element | null => root.getElementById?.(id) ?? null).filter((t): t is Element => !!t && scope.contains(t)).map((t) => chartText(t, drawn));
  return texts.join(" ").trim() || null;
}

/** A shape's own accessible text: its declared name, or its <title> or <desc>. */
function accessibleOf(mark: Element, scope: Element, drawn: Rect): string | null {
  const name = declaredName(mark, scope, drawn);
  if (name) return name;
  for (const child of mark.children) if (child.tagName === "title" || child.tagName === "desc") return child.textContent?.trim() || null;
  return null;
}

/**
 * Whether a mark grows from a baseline (a bar, a column, a stack segment) or sits at its value (a point): a rect is a
 * bar, a circle or ellipse a point, and a path or polygon a bar when it has an edge on a line (along the same axis)
 * that half the shapes of its group or more have an edge on too, as bars share their baseline.
 */
function kindOf(shape: Element, box: Rect, siblings: readonly Rect[]): "point" | "bar" {
  if (shape.tagName === "rect") return "bar";
  if (shape.tagName === "circle" || shape.tagName === "ellipse") return "point";
  if (!siblings.length) return "point";
  const on = (p: number, a: number, b: number) => Math.abs(p - a) <= 1 || Math.abs(p - b) <= 1;
  const sharing = Math.max(
    ...[box.top, box.bottom].map((p) => siblings.filter((s) => on(p, s.top, s.bottom)).length),
    ...[box.left, box.right].map((p) => siblings.filter((s) => on(p, s.left, s.right)).length),
  );
  return sharing >= Math.ceil(siblings.length / 2) ? "bar" : "point";
}

/**
 * What a drawing draws, as chartAxes and describeMark take it, and whether it is a chart: every label the person sees
 * in it and every HTML text laid over it (in its parent, inside its box, no control; chartText), its shapes that
 * could be marks and the groups they are drawn in. Once per drawing and drag (charts).
 */
function chartInfo(svg: SVGSVGElement): ChartInfo {
  const known = charts.get(svg);
  if (known) return known;
  const drawn = boxOf(svg);
  const labels: ChartLabel[] = [];
  for (const t of [...svg.querySelectorAll("text")].slice(0, CHART_SCANNED)) {
    if (outlineCopy(t)) continue;
    const text = chartText(t, drawn);
    if (text) labels.push({ text, box: boxOf(t) });
  }
  const holder = holderOf(svg);
  if (holder) {
    const leaves = [...holder.querySelectorAll("*")].slice(0, ELEMENTS_SCANNED).filter((e) => !(e instanceof SVGElement) && !e.children.length && e.textContent?.trim());
    for (const e of leaves.slice(0, CHART_SCANNED)) {
      const text = chartText(e, drawn);
      if (text) labels.push({ text, box: boxOf(e) });
    }
  }
  const all = [...svg.querySelectorAll(SHAPES)].slice(0, CHART_SCANNED);
  const shapes = all.filter((s) => dataShape(s));
  // A shape's group: the nearest group around it that holds another of the shapes too (its series), else the drawing.
  const counts = new Map<Element, number>();
  for (const s of shapes) for (let at: Element | null = s.parentElement; at && at !== svg; at = at.parentElement) counts.set(at, (counts.get(at) ?? 0) + 1);
  const groups = new Map<Element, Element>();
  for (const s of shapes) {
    let group: Element = svg;
    for (let at: Element | null = s.parentElement; at && at !== svg; at = at.parentElement) if (counts.get(at)! >= 2) { group = at; break; }
    groups.set(s, group);
  }
  const boxes = new Map(shapes.map((s) => [s, boxOf(s)]));
  const members = new Map<Element, Element[]>();
  for (const s of shapes) members.set(groups.get(s)!, [...(members.get(groups.get(s)!) ?? []), s]);
  const kinds = shapes.map((s) => ({ box: boxes.get(s)!, kind: kindOf(s, boxes.get(s)!, members.get(groups.get(s)!)!.filter((o) => o !== s).map((o) => boxes.get(o)!)) }));
  const axes = chartAxes({ labels, shapes: kinds });
  const series = new Set(shapes.filter((s) => axes && isMark(boxes.get(s)!, { labels, shapes: kinds }, axes)).map((s) => groups.get(s))).size;
  // Only a drawing with no axes can have shapes that name themselves (describeNamed).
  const named = axes ? [] : all.filter((s) => dataShape(s, NAMED_SHARE)).map((s) => accessibleOf(s, holder ?? svg, drawn)).filter((t): t is string => !!t);
  const info: ChartInfo = { chart: { labels, shapes: kinds, series }, axes, shapes, groups, named, marks: new Map() };
  charts.set(svg, info);
  return info;
}

/**
 * What the person sees at a mark (describeMark), or null when it is no mark: in a confirmed chart (chartAxes), a shape
 * that could be a mark, in the plot, whose category or value the chart tells; in a drawing with no axes, a shape that
 * names itself among others that do (describeNamed), read from that name only.
 */
function readMark(mark: Element): MarkReading | null {
  const svg = drawingOf(mark);
  if (!svg) return null;
  const info = chartInfo(svg);
  if (info.marks.has(mark)) return info.marks.get(mark)!;
  const scope = holderOf(svg) ?? svg;
  const drawn = boxOf(svg);
  let reading: MarkReading | null = null;
  const i = info.shapes.indexOf(mark);
  if (info.axes && i >= 0) {
    const group = info.groups.get(mark)!;
    const siblings = info.shapes.filter((s) => s !== mark && info.groups.get(s) === group).map(boxOf);
    // A series' name is declared on its group, never on the drawing itself (that names the chart).
    const series = group === svg ? null : declaredName(group, scope, drawn);
    reading = describeMark({ ...info.chart.shapes[i]!, accessible: accessibleOf(mark, scope, drawn), series, siblings }, info.chart, info.axes, headingFor(mark));
  } else if (!info.axes && dataShape(mark, NAMED_SHARE)) {
    reading = describeNamed(accessibleOf(mark, scope, drawn), info.named);
  }
  info.marks.set(mark, reading);
  return reading;
}

/**
 * The chart mark at a point, or null: going down the elements at the point inside the drawing there, the first that is
 * a mark (readMark), so a data label or a tracker over a bar passes through to the bar. HTML laid over the drawing is
 * passed through too, when the drawing's holder lays it there (its parent, not the page), inside the drawing's box, and
 * it is no control; anything else on top (a banner, a dialog, a button) means the drop is on that, not on a mark. A drop on the background, a gridline, an axis
 * or the title finds none.
 */
function markAt(x: number, y: number, deep: Element | null): Element | null {
  if (!deep) return null;
  const list = (deep.getRootNode() as Document | ShadowRoot).elementsFromPoint(x, y).filter((e) => !(e instanceof HTMLElement && ("apcPin" in e.dataset || "apcCard" in e.dataset)));
  const first = list.findIndex((e) => e instanceof SVGElement);
  const svg = first < 0 ? null : drawingOf(list[first]!);
  if (!svg) return null;
  // Only what the drawing's own holder lays over it, inside the drawing's box and no control, passes through.
  const drawn = boxOf(svg);
  const holder = holderOf(svg);
  for (const e of list.slice(0, first)) {
    if (!holder?.contains(e) || inControl(e, document.documentElement) || !within(boxOf(e), drawn)) return null;
  }
  for (const el of list.slice(first)) if (el !== svg && svg.contains(el) && el.matches(SHAPES) && readMark(el)) return el;
  return null;
}


/** Whether the person can see this element. display: contents has no box of its own, but what is in it shows. */
function rendered(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display !== "contents") return el.checkVisibility({ visibilityProperty: true });
  return style.visibility === "visible" && (!el.parentElement || rendered(el.parentElement));
}

/** Elements whose text is not page text: a form's values go as fields (formIn), scripts and templates never. */
const NOT_TEXT = "select,textarea,option,datalist,input,script,style,noscript,template";

/** An element's box in the viewport. */
const boxOf = (el: Element): Rect => el.getBoundingClientRect();

/** What clips an element: the boxes around it, across shadow roots, that clip what overflows them (overflow other than visible). */
function clipOf(el: Element): Rect {
  let clip = ANYWHERE;
  for (let at = parentOf(el); at && at !== document.documentElement; at = parentOf(at)) {
    const style = getComputedStyle(at);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") clip = intersect(clip, boxOf(at));
  }
  return clip;
}

/** Where what an outline shows can be: inside the outlined element's box, cut to what clips it. */
const outlineBox = (scope: Element): Rect => intersect(boxOf(scope), clipOf(scope));

/**
 * An element's text as the person sees it (TIN-422, TIN-619), with images and formulas giving their
 * alternative text in place. Stops soon after max characters. It walks what is rendered, not innerText,
 * which gives text nobody can see: text in an element (or under ancestors) under 0.1 opacity, through
 * `opacity` or `filter: opacity()`; in a transparent colour; clipped away (`clip`, `clip-path`); or outside
 * the element's own box, or cut off by a box around it that clips what overflows it. A formula often
 * sits next to a hidden copy of itself.
 */
function readable(el: Element, max: number, bound: Rect = ANYWHERE): string {
  if (!rendered(el)) return "";
  const parts: string[] = [];
  let size = 0;
  /** The last alternative text, until words follow it: Wikipedia clips a formula's MathML out of sight beside an image of it, with the same text. */
  let lastAlt: string | null = null;
  const add = (text: string) => {
    parts.push(text);
    size += text.length;
    if (text.trim()) lastAlt = null;
  };
  const range = document.createRange();
  /** Whether a text node draws anything inside the clip. */
  /**
   * What of a text node shows inside the clip (Grok's review on #132): all of it when every line box is
   * inside; otherwise word by word (and the spaces between kept words), each kept only when its own box
   * shows inside, so a paragraph wrapped past an overflow box gives only the lines the person sees.
   */
  const visiblePart = (node: Text, clip: Rect): string => {
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    if (!rects.some((r) => showsIn(r, clip))) return "";
    if (rects.every((r) => within(r, clip))) return node.data;
    return visibleWords(
      node.data,
      (start, end) => {
        range.setStart(node, start);
        range.setEnd(node, end);
        return [...range.getClientRects()];
      },
      clip,
    );
  };
  const parent = parentOf(el);
  const walk = (e: Element, opacity: number, clip: Rect) => {
    // A chart's label drawn twice (its halo under it) is read once (TIN-760).
    if (size > max || !rendered(e) || e.matches(NOT_TEXT) || outlineCopy(e)) return;
    const style = getComputedStyle(e);
    const seen = opacity * Number(style.opacity) * filterOpacity(style.filter);
    if (seen < OPACITY_MIN || clipPathHides(style.clipPath)) return;
    if ((style.position === "absolute" || style.position === "fixed") && style.clip !== "auto" && style.clip !== "") return;
    const alt = altText(e);
    if (alt !== null) {
      if (alt !== lastAlt && showsIn(boxOf(e), clip)) add(alt);
      lastAlt = alt;
      return;
    }
    let inner = style.overflowX !== "visible" || style.overflowY !== "visible" ? intersect(clip, boxOf(e)) : clip;
    // A `clip-path: url()` (a chart's plot) cuts what is drawn in it as an overflow box does (TIN-760). One whose
    // <clipPath> is missing, or is more than one rect, hides all (clipCut): hidden beats leaked.
    const cut = clipCut(e);
    if (cut === "hide") return;
    if (cut) inner = intersect(inner, cut);
    // SVG text is painted by its fill, or with `fill: none` by a stroke that paints (TIN-765); HTML text by its colour
    // and -webkit-text-fill-color.
    const inked = e instanceof SVGElement
      ? style.fill === "none" ? paintOf(e).stroked : Math.min(alpha(style.fill), Number(style.fillOpacity)) >= OPACITY_MIN
      : Math.min(alpha(style.color), alpha(style.getPropertyValue("-webkit-text-fill-color") || style.color)) >= OPACITY_MIN;
    // An SVG <text> is a label of its own, drawn apart from the next, though SVG calls it inline; so is a tspan that
    // starts a line of its own (x or dy).
    const apart = e.tagName === "BR" || !style.display.startsWith("inline") || e instanceof SVGTextElement || (e instanceof SVGTSpanElement && (e.hasAttribute("x") || e.hasAttribute("dy")));
    if (apart) add(" ");
    for (const node of e.childNodes) {
      if (size > max) break;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        if (!text.trim()) add(text);
        else if (inked) add(visiblePart(node as Text, inner));
      } else if (node.nodeType === Node.ELEMENT_NODE) walk(node as Element, seen, inner);
    }
    if (apart) add(" ");
  };
  walk(el, parent ? effectiveOpacity(parent) : 1, intersect(intersect(boxOf(el), clipOf(el)), bound));
  return parts.join("");
}


/**
 * What the person pointed at (TIN-619): what the outline covered (scope), its text, the heading above it
 * and its place in a table, or only the page; their selection, with where it is when that is elsewhere;
 * and every control the person can see inside the outline (formIn). Taken only here, on a drop or a
 * moved pin: nothing is read while the person fills a form.
 */
function readAt(x: number, y: number, scope: Element | null) {
  const selection = String(getSelection() ?? "").slice(0, TEXT_MAX);
  // A chart's mark (TIN-760, TIN-765): what the page writes for it, as a "chart point", "chart bar" or "chart mark" (a shape that
  // names itself), under the chart's heading. Should the chart no longer tell anything about it at the drop, no element goes
  // (the dock says the page), and nothing beyond the mark is read.
  const shape = scope instanceof SVGElement && scope.matches(SHAPES);
  const mark = shape ? readMark(scope) : null;
  const cell = scope?.closest<HTMLTableCellElement>("td,th");
  const table = cell?.closest("table");
  return {
    // In a frame (TIN-752), the frame's own address: where the text came from. A frame without one of its own
    // (about:blank, srcdoc) gives the origin it belongs to.
    url: /^https?:/.test(location.href) || location.origin === "null" ? location.href : `${location.origin}/`,
    title: document.title,
    element: mark
      ? { tag: scope!.tagName.toLowerCase(), role: `chart ${mark.kind}`, name: null, text: mark.text.slice(0, TEXT_MAX), heading: headingFor(scope!) }
      : scope && !shape
      ? {
          tag: scope.tagName.toLowerCase(),
          role: scope.getAttribute("role"),
          name: scope.getAttribute("aria-label") || (scope as HTMLElement).title || null,
          // A little past the cap, so a number cut at the end is still seen whole and left out.
          text: readable(scope, TEXT_MAX).slice(0, TEXT_MAX + 64),
          heading: headingFor(scope),
          ...(cell && table ? tableContext(table, cell, (c) => readable(c, HEADER_MAX).slice(0, HEADER_MAX)) : {}),
        }
      : null,
    selection: selection || null,
    selection_context: selection ? selectionContext(scope, selection) : null,
    form: formIn(scope, x, y),
  };
}

/**
 * Where the selection is (TIN-571): the heading above it and the text of its block, when that is not
 * the pointed block, which the reading already gives with its heading. Null otherwise.
 */
function selectionContext(pointed: Element | null, selection: string): { heading: string | null; text: string | null } | null {
  const sel = getSelection();
  if (!sel?.rangeCount) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const at = node instanceof Element ? node : node.parentElement;
  if (!at) return null;
  const block = blockOf(at);
  if (pointed && block && (block === pointed || pointed.contains(block))) return null;
  const heading = headingFor(block ?? at);
  const fold = (s: string) => s.replace(/\s+/g, " ").trim();
  const words = block ? fold(readable(block, CONTEXT_MAX)).slice(0, CONTEXT_MAX + 64) : "";
  // The whole block selected: its text is the selection already.
  const text = words && words !== fold(selection) ? words : null;
  return heading || text ? { heading, text } : null;
}

/** Form controls, native and ARIA. A hidden input matches too, and is dropped when described. */
const CONTROLS = "input,select,textarea,[role=radio],[role=checkbox],[role=switch]";
/** The most controls read inside one outline. */
const CONTROLS_SCANNED = 300;

/**
 * The element at a point for the form state, inside open shadow roots too: a field in a web component
 * is under its host at the document's level.
 */
function deepElementAt(x: number, y: number): Element | null {
  let el = elementAt(x, y);
  for (let depth = 0; el?.shadowRoot && depth < 8; depth++) {
    const inner = el.shadowRoot.elementsFromPoint(x, y)[0];
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * The form state inside the outline (TIN-619): every control in it, its open shadow roots too, the one
 * under the pointer (or the one its label names) marked; formState keeps those the person can see, inside
 * the outlined box and not cut off by a box around them.
 */
function formIn(scope: Element | null, x: number, y: number) {
  if (!scope) return null;
  const under = deepElementAt(x, y);
  const label = under?.closest("label");
  const pointed = under?.closest(CONTROLS) ?? label?.control ?? label?.querySelector(CONTROLS) ?? null;
  const found = controlsIn(scope, CONTROLS_SCANNED) ?? [...scope.querySelectorAll(CONTROLS)].slice(0, CONTROLS_SCANNED);
  const outline = outlineBox(scope);
  const controls = found.map((el) => describe(el, el === pointed, outline)).filter((c): c is Control => c !== null);
  return formState(controls);
}

/** An element's opacity times its ancestors', across shadow roots, `filter: opacity()` included. */
function effectiveOpacity(el: Element): number {
  let opacity = 1;
  for (let at: Element | null = el; at && opacity > 0; at = parentOf(at)) {
    const style = getComputedStyle(at);
    opacity *= Number(style.opacity) * filterOpacity(style.filter);
  }
  return opacity;
}

/** A computed colour's alpha: rgb() is 1, rgba() and color() say it, transparent is 0. */
function alpha(color: string): number {
  if (color === "transparent") return 0;
  // rgb(0 0 0 / 0.5), rgba(0, 0, 0, 0.5), color(srgb 0 0 0 / 50%); four numbers in rgba() means the last is alpha.
  const m = /\/\s*([\d.]+%?)\s*\)$/.exec(color) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\s*\)$/.exec(color);
  if (!m) return 1;
  return m[1]!.endsWith("%") ? Number(m[1]!.slice(0, -1)) / 100 : Number(m[1]);
}

/** What visuallyHidden needs of an element; with an outline, whether its box shows inside it, cut to what clips it. */
function seenOf(el: Element, outline?: Rect): Seen {
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const page = document.documentElement;
  return {
    checkVisible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    opacity: effectiveOpacity(el),
    textAlpha: Math.min(alpha(style.color), alpha(style.getPropertyValue("-webkit-text-fill-color") || style.color)),
    width: box.width,
    height: box.height,
    left: box.left + scrollX,
    top: box.top + scrollY,
    right: box.right + scrollX,
    bottom: box.bottom + scrollY,
    pageWidth: Math.max(page.scrollWidth, innerWidth),
    pageHeight: Math.max(page.scrollHeight, innerHeight),
    position: style.position,
    clip: style.clip,
    clipPath: style.clipPath,
    ariaHidden: !!el.closest('[aria-hidden="true"]'),
    ...(outline ? { inOutline: showsIn(box, intersect(outline, clipOf(el))) } : {}),
  };
}

/** A control as formState takes it, or null: a hidden input, or not a control. */
function describe(el: Element, pointed: boolean, outline: Rect): Control | null {
  if (el instanceof HTMLInputElement && el.type === "hidden") return null;
  const labels = "labels" in el ? [...((el as HTMLInputElement).labels ?? [])] : [];
  const nativeChoice = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox");
  const typed = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !nativeChoice);
  // A choice is seen through a label the person sees; a typed field only by itself.
  // Only a native radio or checkbox may be seen through its label (custom widgets); anything else must be seen itself.
  const visible = controlVisible(nativeChoice, typed, seenOf(el, outline), nativeChoice ? labels.map((l) => seenOf(l, outline)) : []);
  const attr = (name: string) => el.getAttribute(name);
  const base = { label: labelOf(el, labels), group: null, groupKey: null, name: attr("name"), id: el.id || null, autocomplete: attr("autocomplete"), placeholder: attr("placeholder"), checked: false, value: "", pointed, visible };
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "radio") return { ...base, kind: "radio", type, group: groupLabel(el), groupKey: el.name ? `name:${el.name}` : null, checked: el.checked, value: el.value === "on" ? "" : el.value };
    if (type === "checkbox") return { ...base, kind: "checkbox", type, checked: el.checked };
    return { ...base, kind: "text", type, value: el.value };
  }
  if (el instanceof HTMLTextAreaElement) return { ...base, kind: "text", type: "textarea", value: el.value };
  if (el instanceof HTMLSelectElement) return { ...base, kind: "select", type: "select", value: [...el.selectedOptions].map((o) => o.label || o.text).join(", ") };
  const role = attr("role");
  const checked = attr("aria-checked") === "true";
  if (role === "radio") {
    const group = el.closest("[role=radiogroup]");
    return { ...base, kind: "radio", type: "aria", label: base.label ?? (textWithout(el) || null), group: groupLabel(el), groupKey: group ? `group:${[...document.querySelectorAll("[role=radiogroup]")].indexOf(group)}` : null, checked };
  }
  if (role === "checkbox" || role === "switch") return { ...base, kind: "checkbox", type: "aria", label: base.label ?? (textWithout(el) || null), checked };
  return null;
}

/** A control's accessible label: aria-labelledby (in its own document or shadow root), aria-label, its label elements, or its title. */
function labelOf(el: Element, labels: Element[]): string | null {
  const by = el.getAttribute("aria-labelledby");
  const root = el.getRootNode() as Document | ShadowRoot;
  const named = by
    ? by
        .split(/\s+/)
        .map((id) => root.getElementById?.(id) ?? document.getElementById(id))
        .filter((n): n is HTMLElement => !!n)
        .map(textWithout)
        .join(" ")
    : "";
  return named.trim() || el.getAttribute("aria-label")?.trim() || labels.map(textWithout).join(" ").trim() || (el as HTMLElement).title?.trim() || null;
}

/** A radio group's label: its fieldset's legend, or its group's own label. */
function groupLabel(el: Element): string | null {
  const group = el.closest("fieldset,[role=radiogroup],[role=group]");
  if (!group) return null;
  const legend = group instanceof HTMLFieldSetElement ? group.querySelector(":scope > legend") : null;
  return (legend ? textWithout(legend) : "") || labelOf(group, []);
}

/** An element's words, without what its form controls hold (a label around a select would give every option). */
function textWithout(el: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const control = node.parentElement?.closest("select,textarea,option,script,style");
    if (!control || !el.contains(control)) parts.push(node.textContent ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The words of a control that titles a box, as the person sees them: a select's chosen option, or a combobox's own shown text; null when it shows none or they are a secret. */
function titleWords(el: Element): string | null {
  const popup = el.getAttribute("aria-haspopup");
  const select = el instanceof HTMLSelectElement ? el : null;
  // Editable: its words may be what the person typed (a search box drawn as a combobox, an input inside it).
  const editable = el.hasAttribute("aria-autocomplete") || (el as HTMLElement).isContentEditable || !!el.querySelector("input,textarea,[contenteditable]:not([contenteditable=false])");
  if (!isTitleControl(el.tagName, el.getAttribute("role"), popup, !!select?.multiple, editable)) return null;
  // What a person sees of it: a control hidden, clipped away or transparent shows nothing.
  if (!rendered(el) || visuallyHidden(seenOf(el), true)) return null;
  let words: string | null;
  if (select) words = selectTitle([...select.options].map((o) => ({ text: o.label || o.text, selected: o.selected })));
  // A widget that draws its list inside itself shows every option: its shown value cannot be told from them.
  else if (el.querySelector('select,option,[role=listbox],[role=option],[role=menu],ul,ol')) words = null;
  else words = readable(el, 200).replace(/\s+/g, " ").trim() || null;
  if (!words) return null;
  const labels = "labels" in el ? [...((el as HTMLInputElement).labels ?? [])] : [];
  const word = (name: string) => el.getAttribute(name);
  // A value is a title by the same classification as a form's: a control that holds a secret never is one.
  if (classify({ kind: "select", type: "select", label: labelOf(el, labels), group: null, name: word("name"), id: el.id || null, autocomplete: word("autocomplete"), placeholder: null, value: words })) return null;
  return words.slice(0, 200);
}

/** What a box names itself by: the words aria-labelledby points at that the person sees, else its aria-label (on a box that is a region, table, group, dialog...). */
function namedBy(el: Element): string | null {
  // Who may name a box (namesBox) comes before either attribute is read; so does being shown: a box the person does not see names nothing.
  if (!namesBox(el.tagName, el.getAttribute("role"), el instanceof SVGElement)) return null;
  if (!rendered(el) || el.closest('[aria-hidden="true"]')) return null;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const seen = by
      .split(/\s+/)
      .map((id) => root.getElementById?.(id) ?? document.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => readable(n, 200).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (seen) return seen.slice(0, 200);
  }
  return el.getAttribute("aria-label")?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/**
 * Whether an element shows nothing that stops the search for a box's title control: no words, no control, no
 * drawing or picture that names itself. A decorative icon (an svg or img with no alt, aria-label, title or
 * words) is nothing; a picture that says what it is, a canvas, a video or a frame is something.
 */
const BLANK_KEEPS = 'select,input,textarea,button,canvas,video,iframe,[role=combobox],[role=button],img[alt]:not([alt=""]),[aria-label],[title],svg:has(title)';
const showsNothing = (e: Element): boolean => !rendered(e) || (!e.matches(BLANK_KEEPS) && !e.querySelector(BLANK_KEEPS) && seenLength(e) === 0);

/** headingOf on the page: headings the person sees, across open shadow roots. */
const outline = {
  up: parentOf,
  // A host's shadow tree is what it shows, with its light children slotted in.
  children: (e: Element) => [...(e.shadowRoot?.children ?? []), ...e.children],
  heading: (e: Element) => isHeading(e.tagName, e.getAttribute("role")) && seenLength(e) > 0,
  owns: (e: Element) => ownsHeadings(e.tagName, e.getAttribute("role")),
  // A box's title control (TIN-766): the first thing it shows, with no words before it in the same element.
  title: (e: Element) => {
    for (let p = e.previousSibling; p; p = p.previousSibling) if (p.nodeType === Node.TEXT_NODE && p.textContent?.trim()) return false;
    return titleWords(e) !== null;
  },
  blank: showsNothing,
  named: namedBy,
  page: (e: Element) => pageLevel(e.tagName, e.getAttribute("role")) || !parentOf(e),
};

/** The heading an element is under (titleOf), as the person sees it (readable, or a title control's chosen value), never innerText. */
function headingFor(el: Element): string | null {
  const found = titleOf<Element>(el, outline);
  if (!found) return null;
  if ("label" in found) return found.label;
  const words = titleWords(found.el) ?? readable(found.el, 200);
  return words.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/**
 * The consent card (13.3), where the agent was dropped, in a closed shadow root. Its buttons take
 * trusted clicks only. A sensitive site gets Send and Not now, never Always.
 */
function ask(status: "consent" | "consent_sensitive" | "consent_update", x: number, y: number, send: (c: Consent) => void, sensitive?: Reply["sensitive"], asks?: string): void {
  const host = cardHost();
  const root = host.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "APC");
  const left = Math.max(8, Math.min(x - 160, innerWidth - 336));
  const top = Math.max(8, Math.min(y + 12, innerHeight - 280));
  card.style.cssText = `position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:320px;box-sizing:border-box;padding:12px 14px;border-radius:12px;background:#1f1f1f;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)`;
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 10px";
  // In a frame (TIN-752) the answers are kept for the tab's site, not the frame's: the card says so by name.
  const tabSite = isTop ? null : tabHost();
  // "is set to ask every time" names whichever site carries that setting: the tab's, or the frame's own (askingSite).
  const setBy = isTop ? null : (asks ?? tabSite);
  text.textContent = setBy ? STATUS_TEXT[status].replace("This site is set", `${setBy} is set`) : STATUS_TEXT[status];
  // What happens to the sensitive values in this outline, by the person's setting (TIN-619).
  if (sensitive?.count) {
    const note = document.createElement("b");
    note.dataset.apcSensitive = String(sensitive.count);
    note.textContent = ` ${sensitiveNote(sensitive.count, sensitive.mode)}`;
    text.append(note);
  }
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  const choices: Array<[Consent | null, string]> = status === "consent_sensitive" ? [["once", "Send"], [null, "Not now"]] : [["once", "Just this once"], ["always", tabSite ? `Always on ${tabSite}` : "Always on this site"], ["never", tabSite ? `Not on ${tabSite}` : "Not here"]];
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

/** The card that offers sensitive values left out, at most one at a time. */
let includeCard: (() => void) | null = null;

/**
 * After a drop under Ask per drop that left sensitive values out (TIN-619): where the agent was dropped,
 * in a closed shadow root, "Sent to your agent. N sensitive values left out." with "Include them this
 * time", which sends the same reading, taken at the drop, with them. Trusted clicks only.
 */
function offerInclude(count: number, x: number, y: number, include: () => void): void {
  includeCard?.();
  const host = cardHost();
  const root = host.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "APC");
  const left = Math.max(8, Math.min(x - 160, innerWidth - 336));
  const top = Math.max(8, Math.min(y + 12, innerHeight - 140));
  card.style.cssText = `position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:320px;box-sizing:border-box;padding:12px 14px;border-radius:12px;background:#1f1f1f;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)`;
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 10px";
  text.setAttribute("role", "status");
  text.textContent = sentWithout(count);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    host.remove();
    if (includeCard === close) includeCard = null;
  };
  for (const [what, label] of [["include", INCLUDE_LABEL], ["dismiss", "Close"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.apcInclude = what;
    b.style.cssText = `font:inherit;padding:5px 10px;border-radius:7px;cursor:pointer;border:1px solid ${what === "include" ? "#d4733a" : "#555"};background:${what === "include" ? "#d4733a" : "transparent"};color:#fff`;
    b.addEventListener("click", (ev) => {
      if (!ev.isTrusted) return;
      close();
      if (what === "include") include();
    });
    row.append(b);
  }
  card.append(text, row);
  root.append(card);
  document.documentElement.append(host);
  includeCard = close;
  timer = window.setTimeout(close, 30_000);
}

/**
 * The answer to a dock agent dropped on a Direct-only APC app (APC 0.5), where it was dropped, in a
 * closed shadow root: the app connects agents directly, with a link to its connect page (from its
 * apc.json, on its own origin) and ×. Nothing is sent anywhere.
 */
let directOnlyCard: (() => void) | null = null;
function answerDirectOnly(app: DirectOnly, x: number, y: number): void {
  // A new drop replaces the card: never a stack of them.
  directOnlyCard?.();
  const host = cardHost();
  const root = host.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.setAttribute("role", "status");
  card.setAttribute("aria-label", "APC");
  // Which answer it is: a Direct-only app's, or a drop nothing on an APC app took (TIN-703).
  card.dataset.apcAnswer = app.message === NOT_TAKEN_TEXT ? "not_taken" : "direct_only";
  const left = Math.max(8, Math.min(x - 160, innerWidth - 336));
  const top = Math.max(8, Math.min(y + 12, innerHeight - 150));
  card.style.cssText = `position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:320px;box-sizing:border-box;padding:12px 30px 12px 14px;border-radius:12px;background:#1f1f1f;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)`;
  // The domain first, as the dock names an app it does not know; the name, when there is one, is only what the page says it is.
  const domain = document.createElement("p");
  domain.style.cssText = "margin:0 0 4px;font-weight:600";
  domain.textContent = app.host;
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 8px";
  text.textContent = app.message;
  card.append(domain, text);
  if (app.connect) {
    const link = document.createElement("a");
    link.href = app.connect;
    link.textContent = connectLabel(app.host);
    link.style.cssText = "color:#f2a46b;font-weight:600";
    card.append(link);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");
  close.style.cssText = "position:absolute;top:6px;right:8px;background:none;border:0;color:#ccc;font:16px system-ui,sans-serif;cursor:pointer";
  let timer = 0;
  const remove = () => {
    clearTimeout(timer);
    host.remove();
    if (directOnlyCard === remove) directOnlyCard = null;
  };
  close.addEventListener("click", (ev) => {
    if (ev.isTrusted) remove();
  });
  card.append(close);
  root.append(card);
  document.documentElement.append(host);
  directOnlyCard = remove;
  timer = window.setTimeout(remove, 20_000);
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
  moveWith(markEl, badge, place, (x, y, outlined) => {
    // What was outlined on this page: send its reading with the browser's token, no new consent (TIN-471, TIN-619).
    // Taken away by the page before the release: nothing goes, and the pin goes back.
    if (outlined && !outlined.isConnected) {
      say("outline_changed");
      return false;
    }
    const anchor = outlined;
    if (!anchor || anchor === target.anchor) return false;
    const reading = readAt(x, y, anchor);
    const id = crypto.randomUUID();
    const moved: Target = { anchor, x: x + scrollX, y: y + scrollY, hub: target.hub, agent: target.agent };
    void chrome.runtime
      .sendMessage<Reply>({ type: "move", id, hub: target.hub, agent: target.agent, reading })
      .then((r) => sent(r ?? { status: "error" }, moved, x, y))
      .catch(() => say("error"));
    return true;
  });
  pins.set(key, remove);
  draw();
  timer = window.setTimeout(() => void poll(), 2000);
}

/**
 * Drag a pin by its mark (TIN-471): past a few pixels it follows the pointer and outlines what a drop
 * there would read (scopeAt). On release, drop(x, y, outlined) says whether it took the place (the pin
 * is then drawn there anew); if not, or on Esc, the pin goes back. A trusted pointer only.
 */
function moveWith(handle: HTMLElement, badge: HTMLElement, back: () => void, drop: (x: number, y: number, outlined: Element | null) => boolean): void {
  // The browser's own drag (of the logo image, or of selected text) would cancel the pointer: none.
  handle.addEventListener("dragstart", (e) => e.preventDefault());
  handle.addEventListener("pointerdown", (down) => {
    if (!down.isTrusted || down.button !== 0) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    let moving = false;
    const outlining = outliner();
    const light = outlining.light;
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
      light(scopeAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const outlined = outlining.lit();
      end();
      forgetScopes();
      if (moving && e.isTrusted && drop(e.clientX, e.clientY, outlined)) return;
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
  notice(STATUS_TEXT[status], status, status === "asking" ? 8000 : 3500);
}

/** A note in the corner of this frame (the page, or the frame a drop landed in): what it says, which note it is, how long it stays. Returns what removes it. */
function notice(text: string, kind: string, ms: number): () => void {
  const host = cardHost();
  const root = host.attachShadow({ mode: "closed" });
  const note = document.createElement("div");
  note.textContent = text;
  note.dataset.apcNote = kind;
  note.setAttribute("role", "status");
  note.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;padding:10px 14px;border-radius:10px;background:#1f1f1f;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  root.append(note);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), ms);
  return () => host.remove();
}
