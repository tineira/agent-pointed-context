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
import { AGENT_FALLBACK, agentName, CARD_LABELS, connectLabel, CONSENT_QUESTION, consentReason, directOnlyGate, appTakes, notTaken, frameNote, hubAllowed, includeLabel, isApcApp, isolate, NOT_TAKEN_TEXT, NOTE_TEXT, pinState, SENT_TO, sensitiveMode, sensitiveNote, sentWithout, STATUS_TEXT, WAIT_LOST_MS, WAIT_LOST_TEXT, WAITING_TEXT, WHATS_SENT, type Consent, type DirectOnly, type DirectOnlyLookup, type DropStatus, type NoteText, type PinMark, type PinState, type SensitiveMode } from "./drop.ts";
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
  const pending = new Map<string, Target>();
  const outlining = outliner();
  const light = outlining.light;
  /** The open drop's question (TIN-786): from the drop until it is answered, closed, or another drag starts. At most one. */
  let question: Question | null = null;
  // A pin dragged to another paragraph closes the question as Not now before its own outline lights.
  closeQuestion = () => question?.end("drag");
  /** A trusted drag of an agent starts: the open question closes as Not now, before the outline moves. */
  const newDrag = () => question?.end("drag");
  /** Whether a drop's outline is held for its question: then only that question's end clears it. */
  const holding = () => question !== null && question.node !== null;

  /**
   * The drop's question, from the drop on (TIN-786). Its node keeps the outline, drawn as the extension's own box, until
   * the question ends: answered, dismissed (×, Esc, Not now, 45 s), the outline changed, a new agent drag or a pin drag,
   * or the service worker's answer was not a card. Nothing was sent when it ends unanswered, so that drop's held
   * reading goes; when a drag closes it before the answer came, only a card answer (nothing sent) forgets it.
   */
  const openQuestion = (id: string, node: Element | null, pointed: Element | null, reading: Reading, x: number, y: number): Question => {
    question?.end("drag");
    let removeCard: (() => void) | null = null;
    const q: Question = {
      id,
      node,
      pointed,
      reading,
      x,
      y,
      state: "waiting",
      shown(remove) {
        removeCard = remove;
        q.state = "open";
      },
      ring() {
        if (node && outlining.lit() === node) light(node, true);
      },
      end(how) {
        if (q.state !== "waiting" && q.state !== "open") return;
        const was = q.state;
        q.state = how === "answered" ? "answered" : how === "settled" ? "settled" : "closed";
        removeCard?.();
        removeCard = null;
        if (question === q) question = null;
        if (node && outlining.lit() === node) light(null);
        if (how === "dismiss" || how === "changed" || (how === "drag" && was === "open")) forgetHeld(id);
        if (how === "changed") say("outline_changed", below(x + scrollX, y + scrollY));
      },
    };
    question = q;
    if (node) light(node, true);
    return q;
  };
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
    // A new drag of an agent: the last drop's question closes as Not now before the outline moves (TIN-786).
    newDrag();
    // The outline is what goes (TIN-619): the same element is read on the drop.
    light(scopeAt(e.clientX, e.clientY));
    // The browser sends dragover every few dozen milliseconds while the agent is over the page. A drag that ends
    // elsewhere (Esc, released outside the page) sends this page neither drop nor dragend: without a dragover for
    // OUTLINE_IDLE_MS, the outline goes, and what was found about the page's charts with it.
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (holding()) return;
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
      return answerDirectOnly(null, e.clientX, e.clientY);
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
    if (!drag?.hub || !drag.ticket) return say("no_ticket", below(e.pageX, e.pageY));
    if (!hubAllowed(drag.hub, __APC_DEV__)) return say("unknown_dock", below(e.pageX, e.pageY));
    // A frame with an opaque origin (sandboxed, data:): it has no address a reading could name, so nothing is read (TIN-752).
    if (location.origin === "null") return say("opaque_frame", below(e.pageX, e.pageY));
    // The page took away what was outlined: what is under the pointer now is not what the person saw outlined, so nothing goes.
    if (outlined && !outlined.isConnected) return say("outline_changed", below(e.pageX, e.pageY));
    // The control the drop points at, found once: the consent card's check reads the outline again with it (TIN-786).
    const pointed = pointedAt(e.clientX, e.clientY);
    const reading = readAt(e.clientX, e.clientY, outlined, pointed);
    const id = crypto.randomUUID();
    const target: Target = { anchor: outlined, x: e.pageX, y: e.pageY, hub: drag.hub, agent: drag.agent };
    pending.set(id, target);
    // From here the drop has its question, and its outline stays (as the extension's box) until the question ends.
    const q = openQuestion(id, outlined, pointed, reading, e.clientX, e.clientY);
    /**
     * The service worker's answer. A card answer opens the card only while this drop's question is still the open
     * one, and only when the outline still shows what was read; all of it in this one task, so no drag comes between.
     * Any other answer is this drop's outcome: it ends the question (its outline goes) and is drawn at its own place.
     */
    const answer = (r: Reply | null) => {
      const status = r?.status ?? "error";
      if (status === "consent" || status === "consent_sensitive" || status === "consent_update") {
        if (q.state !== "waiting") {
          // Closed by a new drag before the card came: nothing was sent, and nothing shows.
          pending.delete(id);
          if (q.state === "closed") forgetHeld(id);
          return;
        }
        if (q.node && !(shows(q.node) && sameOutline(q.node, q.pointed, q.reading))) {
          pending.delete(id);
          return q.end("changed");
        }
        return ask(q, status, r!, send);
      }
      q.end("settled");
      if (status !== "asking") pending.delete(id);
      sent(r ?? { status }, target, id);
    };
    // sendMessage is called in the same task as the click that answers the card: nothing can change the page between.
    const send = (consent?: Consent): void => {
      chrome.runtime
        .sendMessage<Reply>({ type: "drop", id, drag: { hub: drag.hub, agent: drag.agent, ticket: drag.ticket }, reading, ...(consent ? { consent } : {}) })
        .then(answer, () => answer({ status: "error" }));
    };
    send();
  };

  // dragenter and drop listen in the capture phase on window, which the content script fills before the
  // page's own scripts run (it runs at document_start), so no listener of the page comes before them.
  // In a tab the script was injected into later, a page's earlier capture listener could stop them:
  // for dragenter that costs little, since each dragover moves the dragover listener too.
  window.addEventListener(
    "dragenter",
    (e) => {
      if (!e.isTrusted || !carriesAgent(e)) return;
      // A new drag of an agent: the last drop's question closes as Not now (TIN-786); dragover does it too, should a page stop this.
      newDrag();
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
  const frameHint = async (frame: Element, at: { x: number; y: number }) => {
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
    const words = frameNote(typeof r.origin === "string" ? r.origin : null);
    // Where the agent went into the frame, as every note is at its drop (TIN-786).
    hintShown = notice({ lead: words.lead, text: words.text, failed: false }, "frame", 6000, at);
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
      // What was outlined when the agent was let go is what is read (TIN-619). The outline is taken off for the
      // reading, as it always was; a drop that gets a question puts it back as the extension's box (TIN-786).
      const outlined = outlining.lit();
      clearTimeout(idleTimer);
      light(null);
      forgetScopes();
      if (!e.isTrusted || !carriesAgent(e)) return;
      if (apcApp()) onAppDrop(e);
      else onPageDrop(e, outlined);
    },
    true,
  );
  window.addEventListener("dragleave", (e) => {
    // A drop's held outline goes only with its question (TIN-786).
    if (!e.relatedTarget && !holding()) light(null);
    if (!isTop || hinted() || !e.isTrusted || !carriesAgent(e)) return;
    const frame = frameInto(e);
    if (!frame) return;
    cancelFrameHint();
    const at = { x: e.pageX, y: e.pageY };
    hintTimer = window.setTimeout(() => void frameHint(frame, at), 400);
  });
  window.addEventListener("dragend", () => {
    if (holding()) return;
    light(null);
    forgetScopes();
  });
  // The service worker's later word, once the person answered in the dock.
  chrome.runtime.onMessage.addListener((m) => {
    const msg = m as Reply & { type?: string };
    // A frame of this tab has the agent's drag (TIN-752).
    if (msg.type === "frame_drag") return cancelFrameHint();
    if (msg.type !== "status" || !msg.status || !(msg.status in STATUS_TEXT)) return;
    // The drop this word is about, by its id: never whichever drop came last, and nothing for a drop this page does not know.
    const target = msg.id ? pending.get(msg.id) : undefined;
    if (!target) return;
    pending.delete(msg.id!);
    sent(msg, target, msg.id!);
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
  /** On a consent card: the numbers setting, for What's sent? (TIN-786). */
  mode?: SensitiveMode;
  /** When sent: the agent's name, as the service worker made it safe; absent when there is none. */
  agent?: string;
  /** When sent with an offer to include what was left out: until when that drop's reading is kept. */
  holdUntil?: number;
}

/** A drop's question (TIN-786): the drop's outline, reading and place, and how far it got. */
interface Question {
  id: string;
  /** The outlined element, or null when nothing was outlined (a selection, the page's margin): then nothing is checked. */
  node: Element | null;
  pointed: Element | null;
  reading: Reading;
  /** The drop point, in the viewport. */
  x: number;
  y: number;
  /** waiting: the service worker has not answered; open: its card shows; then answered, settled (the answer was no card) or closed. */
  state: "waiting" | "open" | "answered" | "settled" | "closed";
  /** The card shows: `remove` takes it away when the question ends. */
  shown(remove: () => void): void;
  /** Puts the outline where the element is now (it moved, or the page scrolled). */
  ring(): void;
  /** answered (a sending click), settled (the answer was no card), dismiss (×, Esc, Not now, 45 s), changed (the outline did), drag (a new drag). */
  end(how: "answered" | "settled" | "dismiss" | "changed" | "drag"): void;
}

/** Closes the open question as Not now: set by listen(), for a pin's drag. */
let closeQuestion: (() => void) | null = null;

/** The drop's reading the worker keeps for Include goes: its card closed, or its question did, with nothing sent. */
function forgetHeld(id: string): void {
  void chrome.runtime.sendMessage({ type: "forget", id }).catch(() => {});
}

/**
 * A drop's outcome, drawn at that drop (TIN-786): the pin and "Sent to *agent*" beside it, or the card that offers
 * what was left out (TIN-619), or the waiting card, or the failure. That drop's own waiting card makes way for it.
 */
function sent(r: Reply, target: Target, id: string | null): void {
  stopWait(id);
  const point = below(target.x, target.y);
  if (r.status === "asking") {
    if (id) waitingCard(id, target.hub, point);
    return;
  }
  if (r.status !== "sent") return say(r.status, point);
  const at = r.pin ? pin(target, r.pin) : null;
  // Just below the badge (it may sit in the paragraph's top right corner), never over it.
  const beside = at ? { x: at.x, y: at.y + 34 } : point;
  const name = agentName(r.agent);
  if (r.sensitive?.offer && r.id && typeof r.holdUntil === "number" && r.holdUntil > Date.now()) {
    const heldId = r.id;
    return offerInclude(r.sensitive.count, name, beside, heldId, r.holdUntil, () =>
      chrome.runtime
        .sendMessage<Reply>({ type: "include", id: heldId })
        .then((again) => sent(again ?? { status: "error" }, target, null), () => sent({ status: "error" }, target, null)),
    );
  }
  sentWord(name, beside, id);
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
 * is dragged). `boxed` draws that box for any element: the outline a drop keeps while its card asks (TIN-786),
 * which the page's own styles and re-renders cannot take away, and which leaves the page's style.outline as it was.
 */
function outliner(): { light: (el: Element | null, boxed?: boolean) => void; lit: () => Element | null } {
  let lit: Element | null = null;
  let litOutline = "";
  /** Whether the outline is on the element's own style.outline, to put back. */
  let inline = false;
  let litBoxed = false;
  let host: HTMLDivElement | null = null;
  let box: HTMLDivElement | null = null;
  const place = (el: Element) => {
    const r = el.getBoundingClientRect();
    box!.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #d4733a;border-radius:3px`;
  };
  const light = (el: Element | null, boxed = false) => {
    if (lit === el && litBoxed === boxed) {
      if (el && box) place(el);
      return;
    }
    if (inline && outlines(lit)) lit.style.outline = litOutline;
    inline = false;
    host?.remove();
    host = box = null;
    lit = el;
    litBoxed = boxed;
    if (!boxed && outlines(el)) {
      inline = true;
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
function readAt(x: number, y: number, scope: Element | null, pointed: Element | null = pointedAt(x, y)) {
  const selection = String(getSelection() ?? "").slice(0, TEXT_MAX);
  const outlined = readOutlined(scope, pointed);
  return {
    // In a frame (TIN-752), the frame's own address: where the text came from. A frame without one of its own
    // (about:blank, srcdoc) gives the origin it belongs to.
    url: /^https?:/.test(location.href) || location.origin === "null" ? location.href : `${location.origin}/`,
    title: document.title,
    element: outlined.element,
    selection: selection || null,
    selection_context: selection ? selectionContext(scope, selection) : null,
    form: outlined.form,
  };
}

/** A page reading, as readAt takes it. */
type Reading = ReturnType<typeof readAt>;

/**
 * The part of a reading that is the outlined element (TIN-786): its words and its form state, from the element
 * and the control the drop pointed at, and nothing about the pointer or the page around it. The drop's reading
 * is made of it, and the consent card's check (sameOutline) calls it again on the same element: one function,
 * so whatever the reading cuts or leaves out, the check cuts and leaves out the same way.
 */
function readOutlined(scope: Element | null, pointed: Element | null) {
  // A chart's mark (TIN-760, TIN-765): what the page writes for it, as a "chart point", "chart bar" or "chart mark" (a shape that
  // names itself), under the chart's heading. Should the chart no longer tell anything about it at the drop, no element goes
  // (the dock says the page), and nothing beyond the mark is read.
  const shape = scope instanceof SVGElement && scope.matches(SHAPES);
  const mark = shape ? readMark(scope) : null;
  const cell = scope?.closest<HTMLTableCellElement>("td,th");
  const table = cell?.closest("table");
  return {
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
    form: formIn(scope, pointed),
  };
}

/**
 * Whether the outlined element still shows what the drop read (TIN-786): the same words and the same form
 * state, by readOutlined itself, with what was found about the page's charts forgotten before and after, as
 * the drop forgot it. Nothing it reads is kept or sent.
 */
function sameOutline(scope: Element, pointed: Element | null, reading: Reading): boolean {
  charts.clear();
  const again = readOutlined(scope, pointed);
  charts.clear();
  return again.element?.text === reading.element?.text && JSON.stringify(again.form) === JSON.stringify(reading.form);
}

/** Whether an element still has a box the person can see. */
function shows(el: Element): boolean {
  if (!el.isConnected || !el.checkVisibility({ visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
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

/** The control a drop points at: the one under the pointer, or the one its label names. Found once, at the drop. */
function pointedAt(x: number, y: number): Element | null {
  const under = deepElementAt(x, y);
  const label = under?.closest("label");
  return under?.closest(CONTROLS) ?? label?.control ?? label?.querySelector(CONTROLS) ?? null;
}

/**
 * The form state inside the outline (TIN-619): every control in it, its open shadow roots too, the one
 * under the pointer (or the one its label names) marked; formState keeps those the person can see, inside
 * the outlined box and not cut off by a box around them.
 */
function formIn(scope: Element | null, pointed: Element | null) {
  if (!scope) return null;
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
  page: (e: Element) => pageLevel(e.tagName, e.getAttribute("role"), !!e.closest("article,section,aside,nav,[role=region],[role=dialog]")) || !parentOf(e),
};

/** The heading an element is under (titleOf), as the person sees it (readable, or a title control's chosen value), never innerText. */
function headingFor(el: Element): string | null {
  const found = titleOf<Element>(el, outline);
  if (!found) return null;
  if ("label" in found) return found.label;
  const words = titleWords(found.el) ?? readable(found.el, 200);
  return words.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/** A place on the page, in page coordinates: where a card or note goes. */
interface Point {
  x: number;
  y: number;
}

/** Where a card or note goes for a point the person dropped on: just below it, a little to its left. */
const below = (x: number, y: number): Point => ({ x: x - 16, y: y + 14 });

/** What the cards and notes look like: the extension's own, in closed shadow roots the page's styles cannot reach. */
const PANEL_CSS = `
.card, .note { box-sizing: border-box; z-index: 2147483647; background: #1f1f1f; color: #fff; font: 13px/1.45 system-ui, sans-serif; text-align: left; }
.card { position: absolute; width: 320px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; padding: 12px 30px 12px 14px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); }
.card.question { position: fixed; }
.note { position: absolute; pointer-events: none; max-width: min(300px, calc(100vw - 16px)); padding: 8px 12px; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.failed { border-left: 4px solid #e5484d; padding-left: 10px; }
p { margin: 0; }
p + p { margin-top: 2px; }
.lead { font-weight: 600; }
.row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.b { font: inherit; padding: 5px 10px; border-radius: 7px; cursor: pointer; border: 1px solid #555; background: transparent; color: #fff; }
.b.primary { border-color: #d4733a; background: #d4733a; }
.b:disabled { opacity: .5; cursor: default; }
.x { position: absolute; top: 6px; right: 8px; padding: 2px 4px; background: none; border: 0; color: #ccc; font: 16px/1 system-ui, sans-serif; cursor: pointer; }
.more { display: inline-block; margin-top: 8px; padding: 0; background: none; border: 0; color: #f2a46b; font: inherit; cursor: pointer; text-decoration: underline; }
dl { margin: 6px 0 0; }
dt { font-weight: 600; margin-top: 4px; }
dd { margin: 0; }
a { color: #f2a46b; font-weight: 600; }
.spin { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border: 2px solid #777; border-top-color: #f2a46b; border-radius: 50%; vertical-align: -2px; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

/** One card or note on screen (TIN-786), and what takes it away. An Include offer can also give way to its plain Sent word. */
interface Shown {
  id: string | null;
  kind: "waiting" | "include" | "answer" | "note";
  close(): void;
  demote?(): void;
}

/**
 * What the extension shows in this frame besides the consent card, in two layers that each hold at most one
 * thing: a card (the waiting card, the Include offer, the answer on an APC app) and a note (Sent, a failure, the
 * frame note). A newer one replaces the one in its layer; a note never takes a card's place.
 */
const shown: { card: Shown | null; note: Shown | null } = { card: null, note: null };
function put(layer: "card" | "note", s: Shown): void {
  shown[layer]?.close();
  shown[layer] = s;
}
function gone(layer: "card" | "note", s: Shown): void {
  if (shown[layer] === s) shown[layer] = null;
}

/** A newer question or card, for another drop: that drop's Include offer gives way to its plain Sent word. */
function demoteInclude(id: string | null): void {
  for (const layer of ["card", "note"] as const) {
    const s = shown[layer];
    if (s?.kind === "include" && s.id !== id) s.demote?.();
  }
}

/** A card or note: its host (one of the extension's cards, never what a drop or the outline lands on) and its box. */
function panel(className: string): { host: HTMLDivElement; box: HTMLDivElement } {
  const host = cardHost();
  host.style.cssText = "position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important";
  const root = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.className = className;
  root.append(Object.assign(document.createElement("style"), { textContent: PANEL_CSS }), box);
  return { host, box };
}

const line = (text: string, className = ""): HTMLParagraphElement => Object.assign(document.createElement("p"), { textContent: text, className });

function button(label: string, primary = false): HTMLButtonElement {
  return Object.assign(document.createElement("button"), { type: "button", textContent: label, className: primary ? "b primary" : "b" });
}

/** The × in a card's corner. */
function closeButton(label: string): HTMLButtonElement {
  const x = Object.assign(document.createElement("button"), { type: "button", textContent: "×", className: "x", title: label });
  x.setAttribute("aria-label", label);
  return x;
}

/** "Sent to *agent*": the name in a text node of its own, between bidi isolates, or "your agent". */
function sentLine(name: string | null): HTMLParagraphElement {
  const p = line("", "lead");
  p.append(document.createTextNode(SENT_TO), document.createTextNode(name ? isolate(name) : AGENT_FALLBACK));
  return p;
}

/** Puts a card or note at a place on the page, kept inside the part of the page in view. */
function placeAt(box: HTMLElement, at: Point): void {
  const m = 8;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const width = document.documentElement.clientWidth || innerWidth;
  const left = Math.max(scrollX + m, Math.min(at.x, scrollX + width - w - m));
  const top = Math.max(scrollY + m, Math.min(at.y, scrollY + innerHeight - h - m));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

/**
 * The consent card's place (TIN-786): below the outlined element's box, or above it when there is no room below;
 * over it only when there is room on neither side. With nothing outlined, at the drop point. In the viewport.
 */
function placeQuestion(box: HTMLElement, q: Question): void {
  const m = 8;
  const width = document.documentElement.clientWidth || innerWidth;
  const height = innerHeight;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.max(m, Math.min(q.x - w / 2, width - w - m));
  let top: number;
  if (q.node) {
    const r = q.node.getBoundingClientRect();
    if (height - r.bottom >= h + 2 * m) top = Math.max(m, r.bottom + m);
    else if (r.top >= h + 2 * m) top = Math.min(r.top - h - m, height - h - m);
    else top = height - h - m;
  } else {
    top = q.y + 14 + h + m <= height ? q.y + 14 : q.y - 14 - h;
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(m, Math.min(top, height - h - m)))}px`;
}

/**
 * The consent card (13.3, TIN-786): the question, a reason when there is one, the buttons, × and What's sent?, in a
 * closed shadow root, below the outline it asks about. Its buttons take trusted clicks only. A sensitive site gets
 * Send and Not now, never Always. A sending click checks first, in the same task as it sends, that the outline still
 * shows what the drop read; Never waits for the service worker's answer before the card goes. Not now, ×, Esc and
 * 45 s send nothing.
 */
function ask(q: Question, status: "consent" | "consent_sensitive" | "consent_update", r: Reply, send: (c: Consent) => void): void {
  demoteInclude(q.id);
  const { host, box } = panel("card question");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "APC");
  box.append(line(CONSENT_QUESTION, "lead"));
  const reason = consentReason(status, r.asks ?? null);
  if (reason) box.append(line(reason));
  // The outline's sensitive numbers, said only when they are about to go (the setting is Send).
  const numbers = r.sensitive?.count ? sensitiveNote(r.sensitive.count, r.sensitive.mode) : null;
  if (numbers) {
    const p = line(numbers);
    p.dataset.apcSensitive = String(r.sensitive!.count);
    box.append(p);
  }
  // In a frame (TIN-752) the answers are kept for the tab's site, not the frame's: the buttons say so by name.
  const tabSite = isTop ? null : tabHost();
  const choices: Array<[Consent | null, string]> =
    status === "consent_sensitive"
      ? [["once", CARD_LABELS.send], [null, CARD_LABELS.notNow]]
      : [["once", CARD_LABELS.once], ["always", tabSite ? CARD_LABELS.alwaysOn(tabSite) : CARD_LABELS.always], ["never", tabSite ? CARD_LABELS.neverOn(tabSite) : CARD_LABELS.never]];
  const row = Object.assign(document.createElement("div"), { className: "row" });
  const buttons: HTMLButtonElement[] = [];
  let disarmed = false;
  const answer = (consent: Consent | null) => (ev: MouseEvent) => {
    // A page can click a button by script; only the person's own click counts.
    if (!ev.isTrusted || disarmed) return;
    if (consent === null) return q.end("dismiss");
    if (consent === "never") {
      // Never sends nothing: the card waits for the service worker to say it kept the choice.
      disarmed = true;
      for (const b of buttons) b.disabled = true;
      send("never");
      return;
    }
    // The outline must still show what the drop read; then the drop's own reading goes, in this same task.
    if (q.node && !(shows(q.node) && sameOutline(q.node, q.pointed, q.reading))) return q.end("changed");
    q.end("answered");
    send(consent);
  };
  for (const [consent, label] of choices) {
    const b = button(label, consent === "once");
    b.dataset.apcConsent = consent ?? "dismiss";
    b.addEventListener("click", answer(consent));
    buttons.push(b);
    row.append(b);
  }
  const x = closeButton(CARD_LABELS.notNow);
  x.dataset.apcConsent = "dismiss";
  x.addEventListener("click", answer(null));
  buttons.push(x);
  // What's sent?, closed until clicked: what goes, what is held back by the numbers setting, and where it goes.
  const more = Object.assign(document.createElement("button"), { type: "button", className: "more", textContent: WHATS_SENT.label });
  more.setAttribute("aria-expanded", "false");
  const facts = document.createElement("dl");
  facts.hidden = true;
  for (const [term, text] of [
    [WHATS_SENT.labels.goes, WHATS_SENT.goes],
    [WHATS_SENT.labels.heldBack, WHATS_SENT.heldBack(sensitiveMode(r.mode))],
    [WHATS_SENT.labels.where, WHATS_SENT.where],
  ] as const) {
    facts.append(Object.assign(document.createElement("dt"), { textContent: term }), Object.assign(document.createElement("dd"), { textContent: text }));
  }
  const place = () => {
    q.ring();
    placeQuestion(box, q);
  };
  more.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    facts.hidden = !facts.hidden;
    more.setAttribute("aria-expanded", String(!facts.hidden));
    place();
  });
  box.append(row, more, facts, x);
  const onKey = (e: KeyboardEvent) => {
    if (e.isTrusted && e.key === "Escape") q.end("dismiss");
  };
  const timer = window.setTimeout(() => q.end("dismiss"), 45_000);
  // Every second, the cheap part: the outlined element is still there and still shows.
  const tick = window.setInterval(() => {
    if (q.node && !shows(q.node)) q.end("changed");
  }, 1000);
  const observer = q.node ? new ResizeObserver(place) : null;
  if (q.node) observer!.observe(q.node);
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  addEventListener("keydown", onKey, true);
  document.documentElement.append(host);
  q.shown(() => {
    clearTimeout(timer);
    clearInterval(tick);
    observer?.disconnect();
    removeEventListener("scroll", place, true);
    removeEventListener("resize", place);
    removeEventListener("keydown", onKey, true);
    host.remove();
  });
  placeQuestion(box, q);
}

/**
 * A note at a drop (TIN-786): what it says, which note it is, how long it stays, where. One at a time; a failure has
 * a marked edge. Returns what removes it.
 */
function notice(words: NoteText, kind: string, ms: number, at: Point, id: string | null = null): () => void {
  return note(kind, words.failed, ms, at, id, (box) => {
    if (words.lead) box.append(line(words.lead, "lead"));
    box.append(line(words.text));
  });
}

function note(kind: string, failed: boolean, ms: number, at: Point, id: string | null, fill: (box: HTMLDivElement) => void): () => void {
  const { host, box } = panel(failed ? "note failed" : "note");
  box.dataset.apcNote = kind;
  box.setAttribute("role", "status");
  fill(box);
  let timer = 0;
  const me: Shown = {
    id,
    kind: "note",
    close() {
      clearTimeout(timer);
      host.remove();
      gone("note", me);
    },
  };
  put("note", me);
  document.documentElement.append(host);
  placeAt(box, at);
  timer = window.setTimeout(() => me.close(), ms);
  return () => me.close();
}

/** An outcome's note at a place, when it has one: failures stay 8 s. */
function say(status: DropStatus, at: Point): void {
  const words = NOTE_TEXT[status];
  if (words) notice(words, status, words.failed ? 8000 : 3500, at);
}

/** "Sent to *agent*", beside the pin (or at the drop point), for 3.5 s. */
function sentWord(name: string | null, at: Point, id: string | null): void {
  note("sent", false, 3500, at, id, (box) => box.append(sentLine(name)));
}

/**
 * After a drop under Ask per drop that left sensitive numbers out (TIN-619): "Sent to *agent*", how many were left
 * out, and Include it, which sends that drop's reading, taken at the drop, with them. Only while the service worker
 * still keeps it (holdUntil), 30 s at most. A card, or a note when another drop's waiting card holds the card's
 * place. Its own × and its timeout let the reading go; a newer card for another drop leaves only the Sent word.
 */
function offerInclude(count: number, name: string | null, at: Point, id: string, holdUntil: number, include: () => void): void {
  const layer = shown.card?.kind === "waiting" && shown.card.id !== id ? "note" : "card";
  if (layer === "card") demoteInclude(id);
  const { host, box } = panel("card");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "APC");
  box.dataset.apcSent = "";
  const row = Object.assign(document.createElement("div"), { className: "row" });
  const yes = button(includeLabel(count), true);
  yes.dataset.apcInclude = "include";
  row.append(yes);
  const x = closeButton("Close");
  x.dataset.apcInclude = "dismiss";
  box.append(sentLine(name), line(sentWithout(count)), row, x);
  let timer = 0;
  const end = () => {
    clearTimeout(timer);
    host.remove();
    gone(layer, me);
  };
  const me: Shown = {
    id,
    kind: "include",
    close: end,
    demote() {
      end();
      sentWord(name, at, id);
    },
  };
  yes.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    // This offer's own timer only: it must not let the reading go after the click.
    clearTimeout(timer);
    end();
    include();
  });
  x.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    end();
    forgetHeld(id);
  });
  put(layer, me);
  document.documentElement.append(host);
  placeAt(box, at);
  timer = window.setTimeout(
    () => {
      end();
      forgetHeld(id);
    },
    Math.max(0, Math.min(30_000, holdUntil - Date.now())),
  );
}

/** Each waiting drop's deadline, by its id: it outlives the card when another drop's card takes its place, so the service worker still hears. */
const waits = new Map<string, number>();

/** A drop's outcome arrived: its wait is over, and its waiting card, when it still shows, makes way. */
function stopWait(id: string | null): void {
  if (!id) return;
  clearTimeout(waits.get(id));
  waits.delete(id);
  if (shown.card?.kind === "waiting" && shown.card.id === id) shown.card.close();
}

/**
 * The first drop of an agent in this browser (TIN-786): a card at the drop until the dock answers (the service
 * worker asks it for up to 60 s), with Open dock, which opens that drop's own dock. With no word by WAIT_LOST_MS, one
 * line says so, claiming neither that the reading went nor that it did not, and the service worker is told.
 */
function waitingCard(id: string, hub: string, at: Point): void {
  demoteInclude(id);
  const { host, box } = panel("card");
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", "APC");
  box.dataset.apcNote = "asking";
  const text = line("", "lead");
  text.append(Object.assign(document.createElement("span"), { className: "spin" }), WAITING_TEXT);
  const row = Object.assign(document.createElement("div"), { className: "row" });
  const open = button(CARD_LABELS.openDock, true);
  open.dataset.apcOpenDock = "";
  // The drop's own dock, checked when the agent was dropped: the service worker opens exactly that one.
  open.addEventListener("click", (ev) => {
    if (ev.isTrusted) void chrome.runtime.sendMessage({ type: "open_dock", hub }).catch(() => {});
  });
  row.append(open);
  box.append(text, row);
  const me: Shown = {
    id,
    kind: "waiting",
    close() {
      host.remove();
      gone("card", me);
    },
  };
  put("card", me);
  document.documentElement.append(host);
  placeAt(box, at);
  clearTimeout(waits.get(id));
  waits.set(
    id,
    window.setTimeout(() => {
      waits.delete(id);
      void chrome.runtime.sendMessage({ type: "wait_lost", id }).catch(() => {});
      const mine = shown.card === me;
      me.close();
      if (mine) notice({ lead: null, text: WAIT_LOST_TEXT, failed: true }, "wait_lost", 8000, at, id);
    }, WAIT_LOST_MS),
  );
}

/**
 * The answer to a dock agent dropped on a Direct-only APC app (APC 0.5), where it was dropped, in a closed shadow
 * root: the app's host first, as the dock names an app it does not know, that it connects agents itself, and a link
 * to its connect page (from its apc.json, on its own origin). With no app, the drop nothing on an APC app took
 * (TIN-703): one line. Nothing is sent anywhere. `x` and `y` are in the viewport.
 */
function answerDirectOnly(app: DirectOnly | null, x: number, y: number): void {
  demoteInclude(null);
  const { host, box } = panel("card");
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", "APC");
  box.dataset.apcAnswer = app ? "direct_only" : "not_taken";
  if (app) {
    box.append(line(app.host, "lead"), line(app.message));
    if (app.connect) {
      const link = Object.assign(document.createElement("a"), { href: app.connect, textContent: connectLabel(app.host) });
      box.append(link);
    }
  } else {
    box.append(line(NOT_TAKEN_TEXT));
  }
  const x0 = closeButton("Close");
  box.append(x0);
  let timer = 0;
  const me: Shown = {
    id: null,
    kind: "answer",
    close() {
      clearTimeout(timer);
      host.remove();
      gone("card", me);
    },
  };
  x0.addEventListener("click", (ev) => {
    if (ev.isTrusted) me.close();
  });
  put("card", me);
  document.documentElement.append(host);
  placeAt(box, below(x + scrollX, y + scrollY));
  timer = window.setTimeout(() => me.close(), 20_000);
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
function pin(target: Target, mark: PinMark): Point | null {
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
    pos = { x: Math.round(left), y: Math.round(top) };
  };
  /** Where the badge is, on the page: the Sent word goes beside it (TIN-786). */
  let pos: Point = { x: target.x - 14, y: target.y - 14 };
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
      say("outline_changed", below(x + scrollX, y + scrollY));
      return false;
    }
    const anchor = outlined;
    if (!anchor || anchor === target.anchor) return false;
    const reading = readAt(x, y, anchor);
    const id = crypto.randomUUID();
    const moved: Target = { anchor, x: x + scrollX, y: y + scrollY, hub: target.hub, agent: target.agent };
    void chrome.runtime
      .sendMessage<Reply>({ type: "move", id, hub: target.hub, agent: target.agent, reading })
      .then((r) => sent(r ?? { status: "error" }, moved, id), () => sent({ status: "error" }, moved, id));
    return true;
  });
  pins.set(key, remove);
  draw();
  timer = window.setTimeout(() => void poll(), 2000);
  return host.isConnected ? { ...pos } : null;
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
    // Moving a pin is a new gesture: the open question closes as Not now before this outline lights (TIN-786).
    closeQuestion?.();
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

