import { APC_JSON_MAX_BYTES, APC_JSON_PATH, couldNotCheckNote, directOnlyNote, parseApcManifest, parseFocusAttrs, urlOnOrigin, type ApcRole, type FocusTarget } from "@apc/protocol";

const profileLoads = new Map<string, Promise<ApcRole[] | null>>();

/** How long the page waits for its own apc.json: a held drop never waits longer. */
export const APC_JSON_LOAD_MS = 3000;

/** A body as text, at most `cap` bytes, or null past it; the rest is never read. */
async function readCapped(response: Response, cap: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * The profiles the page's own app offers, from its apc.json (APC 0.5), for `enablePinning({ profiles })`:
 * read without cookies, with no redirect followed, within APC_JSON_LOAD_MS for headers and body, and at
 * most APC_JSON_MAX_BYTES, as the hub and the extension read it. Kept per origin once read; null when
 * there is no valid file in time, and then read again on the next call.
 */
export function loadApcProfiles(origin: string = location.origin, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<ApcRole[] | null> {
  let load = profileLoads.get(origin);
  if (!load) {
    const signal = AbortSignal.timeout(APC_JSON_LOAD_MS);
    const ends = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
    const read = fetcher(`${origin}${APC_JSON_PATH}`, { credentials: "omit", redirect: "error", signal, headers: { accept: "application/json" } })
      .then((r) => (r.ok ? readCapped(r, APC_JSON_MAX_BYTES) : null))
      .then((text) => {
        if (text === null) return null;
        const parsed = parseApcManifest(JSON.parse(text), origin);
        return parsed.ok ? parsed.manifest.profiles : null;
      })
      .catch(() => null);
    // The time limit covers the body too: a file that never ends gives null on time.
    load = Promise.race([read, ends]);
    profileLoads.set(origin, load);
    void load.then((p) => p || profileLoads.delete(origin));
  }
  return load;
}

export interface PinningOptions {
  /** Where marks and targets live; defaults to document. */
  root?: Document | HTMLElement;
  /** Selector of the draggable agent marks; each carries data-grant. */
  markSelector?: string;
  /** Refuse a target for one agent (for example outside a restricted grant). */
  canTarget?: (grantId: string, target: FocusTarget) => boolean;
  onPin: (grantId: string, target: FocusTarget, element: Element) => void;
  /**
   * APC v2, opt-in (TIN-369): also accept a native HTML5 drop of an agent dragged from another
   * window (a dock), whose dataTransfer carries APC_AGENT_TYPE. Off by default: v1 apps do not turn it on.
   */
  acceptNativeDrops?: boolean;
  /**
   * The grant a dropped agent's public handle names in this app, or null when the app does not know
   * it (the drop is then ignored). Defaults to the handle itself, taken as a grant id.
   */
  resolveAgent?: (handle: string) => string | null;
  /**
   * APC v2, opt-in (TIN-382): a dropped agent this app does not know yet, whose drag names its hub
   * and carries a pairing ticket. The app asks the person, then pairs with the hub. Without it the drop is ignored.
   */
  onUnknownAgent?: (drag: AgentDrag & { hub: string; ticket: string }, target: FocusTarget, element: Element) => void;
  /**
   * APC 0.5: the profiles this app offers, as its apc.json says: a list; a promise of one; or a loader,
   * such as `loadApcProfiles` itself, called now and again on a later dock drop if it gave nothing. An app
   * without "dock" still takes the drop of an agent dragged from a dock, anywhere on the page and with or
   * without acceptNativeDrops, and answers it with `onDockUnsupported` instead of `onUnknownAgent`: never
   * a drop that silently does nothing. While the profiles load, a dock agent's drop is taken and held,
   * then answered or paired as they say. When they cannot be read (null, an error, the time limit), the
   * drop is never sent to pairing: it is answered as `unchecked` ("could not check this app").
   */
  profiles?: readonly ApcRole[] | PromiseLike<readonly ApcRole[] | null> | (() => PromiseLike<readonly ApcRole[] | null>);
  /** For that answer: the app's name and the page where the person connects an agent directly (apc.json's `direct.connect`). */
  direct?: { name: string; connect: string | null };
  /** A dock agent dropped on an app that does not offer Dock. Without it, `showDockUnsupported` tells the person in the page. */
  onDockUnsupported?: (answer: DockUnsupported) => void;
  /**
   * Which events may arm, tap, pin or drag (APC 0.6). By default only the person's own: `event.isTrusted`,
   * so a script in the page (`element.click()`, a dispatched PointerEvent) cannot point an agent at data.
   * A test that sends events of its own passes `() => true`; nothing in a page can reach this.
   */
  trusted?: (event: Event) => boolean;
}

/** The answer to a dock agent dropped on a Direct-only app: who it was, what to tell the person, and where they connect instead. */
export interface DockUnsupported {
  drag: AgentDrag;
  /** The target under the drop, if any. */
  target: FocusTarget | null;
  name: string;
  connect: string | null;
  /**
   * `direct_only`: the app's apc.json lists no "dock". `unchecked`: the page could not read its own
   * apc.json, so it cannot tell, and it pairs nothing it cannot check.
   */
  reason: "direct_only" | "unchecked";
  /** `directOnlyNote(name)`, or `couldNotCheckNote(name)`: the app's own words, on its own page. */
  message: string;
}

/**
 * The default answer to a dock agent dropped on a Direct-only app: a note at the bottom of the page
 * with the words, a link to the app's connect page, and ×. It stays 20 s, or until closed. A new drop
 * replaces it: never a stack of notes.
 */
let shownNote: { box: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
export function showDockUnsupported(answer: DockUnsupported): HTMLElement {
  if (shownNote) {
    clearTimeout(shownNote.timer);
    shownNote.box.remove();
    shownNote = null;
  }
  const box = document.createElement("div");
  box.setAttribute("role", "status");
  box.setAttribute("data-apc-dock-unsupported", "");
  Object.assign(box.style, { position: "fixed", zIndex: "2147483647", right: "16px", bottom: "calc(16px + max(var(--apc-bar-height, 0px), env(safe-area-inset-bottom, 0px)))", maxWidth: "340px", padding: "12px 14px", borderRadius: "10px", background: "#1f1f1f", color: "#fff", font: "13px/1.45 system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.25)" });
  const text = document.createElement("p");
  text.textContent = answer.message;
  Object.assign(text.style, { margin: "0 0 8px" });
  box.appendChild(text);
  // Only an http(s) page of this app: the same check apc.json's direct.connect passes (no blob:, javascript: or another site).
  const connect = typeof location === "undefined" ? null : urlOnOrigin(answer.connect, location.origin);
  if (connect) {
    const link = document.createElement("a");
    link.setAttribute("href", connect);
    link.textContent = `Connect an agent to ${answer.name}`;
    Object.assign(link.style, { color: "#f2a46b", fontWeight: "600" });
    box.appendChild(link);
  }
  const close = document.createElement("button");
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  Object.assign(close.style, { position: "absolute", top: "4px", right: "6px", background: "none", border: "0", color: "#ccc", font: "16px system-ui, sans-serif", cursor: "pointer" });
  const remove = () => {
    box.remove();
    if (shownNote?.box === box) {
      clearTimeout(shownNote.timer);
      shownNote = null;
    }
  };
  close.addEventListener("click", remove);
  box.appendChild(close);
  document.body.appendChild(box);
  shownNote = { box, timer: setTimeout(remove, 20_000) };
  return box;
}

/** What an agent's drag carries. hub and ticket come with pairing (TIN-382): the hub's origin and a single-use, short-lived ticket. */
export interface AgentDrag {
  v: 1;
  agent: string;
  hub?: string;
  ticket?: string;
}

/** The drag type a dock puts on an agent: its payload is agentDragPayload(handle), never a secret. */
export const APC_AGENT_TYPE = "application/x-apc-agent";

/**
 * Set on the page's root element while enablePinning takes native agent drops (APC 0.5): the page
 * answers every drop of a dock agent itself, so the browser extension stands back even on a
 * Direct-only app. A Direct-only app without it gets the extension's answer instead.
 */
export const APC_DROPS_ATTR = "data-apc-native-drops";

/**
 * What an agent's drag carries: a public handle and nothing else. Any page the agent is dropped on
 * can read it, so it must never hold a grant secret or an MCP URL.
 */
export function agentDragPayload(handle: string, pairing?: { hub: string; ticket: string }): string {
  return JSON.stringify(pairing ? { v: 1, agent: handle, hub: pairing.hub, ticket: pairing.ticket } : { v: 1, agent: handle });
}

/**
 * A drag payload, or null when it is not one (another app's data, a wrong version, junk). A hub
 * that is not a bare http(s) origin, or a ticket that is not a short token, is dropped, not the drag.
 */
export function parseAgentDrag(text: string): AgentDrag | null {
  try {
    const value = JSON.parse(text) as { v?: unknown; agent?: unknown; hub?: unknown; ticket?: unknown } | null;
    if (value?.v !== 1 || typeof value.agent !== "string" || !/^[\w.:-]{1,128}$/.test(value.agent)) return null;
    const drag: AgentDrag = { v: 1, agent: value.agent };
    const hubOk = typeof value.hub === "string" && value.hub.length <= 200 && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(value.hub);
    const ticketOk = typeof value.ticket === "string" && /^[\w.-]{16,200}$/.test(value.ticket);
    if (hubOk && ticketOk) Object.assign(drag, { hub: value.hub, ticket: value.ticket });
    return drag;
  } catch {
    return null;
  }
}

/** The handle in a drag payload, or null when it is not one. */
export function parseAgentDragPayload(text: string): string | null {
  return parseAgentDrag(text)?.agent ?? null;
}

/** The innermost pointable element at a point, with its parsed target. */
export function targetAt(x: number, y: number): { element: Element; target: FocusTarget } | null {
  return targetOf(document.elementFromPoint(x, y));
}

/** The innermost pointable element at or above a node, with its parsed target. */
export function targetOf(start: Element | null): { element: Element; target: FocusTarget } | null {
  let node: Element | null = start;
  while (node) {
    const host: Element | null = node.closest("[data-focus]");
    if (!host) return null;
    const target = parseFocusAttrs(host.getAttribute("data-focus"), host.getAttribute("data-focus-part"), host.getAttribute("data-focus-params"));
    if (target) return { element: host, target };
    node = host.parentElement;
  }
  return null;
}

/**
 * Tap to pin (APC 0.6, the touch way): the person taps an agent's mark (the agent is then "armed"),
 * then taps a target. Pure, so it is tested: it holds which agent is armed and what a tap on a target
 * does. A second tap on the armed mark, or cancel, lets go; a tap that is no target, or a target the
 * agent may not point at, keeps the agent armed.
 */
export type TapPinResult = "pinned" | "no_target" | "refused" | "idle";
export interface TapPin {
  /** The armed agent's grant id, or null. */
  readonly armed: string | null;
  /** Arm this agent; the armed one again lets go. Returns the armed agent after. */
  toggle(grantId: string): string | null;
  cancel(): void;
  /** A tap, with the target under it (or null). Pins the armed agent there. */
  tap(hit: { element: Element; target: FocusTarget } | null): TapPinResult;
}
export function createTapPin(options: { canTarget?: PinningOptions["canTarget"]; onPin: PinningOptions["onPin"]; onChange?: (armed: string | null) => void }): TapPin {
  let armed: string | null = null;
  const set = (next: string | null) => {
    if (next === armed) return;
    armed = next;
    options.onChange?.(armed);
  };
  return {
    get armed() {
      return armed;
    },
    toggle(grantId) {
      set(armed === grantId ? null : grantId);
      return armed;
    },
    cancel() {
      set(null);
    },
    tap(hit) {
      if (!armed) return "idle";
      if (!hit) return "no_target";
      if (options.canTarget && !options.canTarget(armed, hit.target)) return "refused";
      const grantId = armed;
      set(null);
      options.onPin(grantId, hit.target, hit.element);
      return "pinned";
    },
  };
}

/** The window event fired when an agent is armed or let go (detail.id: the grant id or null): the agent bar marks the armed mark. */
export const APC_ARMED_EVENT = "apc-armed";

/** Less than this many pixels between a touch's down and up is a tap, not a drag. */
export const TAP_SLOP_PX = 10;
const ARMED_STYLE_ID = "apc-pinning-style";
const ARMED_CSS = `
body.apc-armed [data-focus] { outline: 2px dashed var(--apc-accent, #b85209); outline-offset: 2px; cursor: pointer; }
[data-apc-mark][aria-pressed="true"] { outline: 3px solid var(--apc-accent, #b85209); outline-offset: 2px; }
`;

/** The note shown while an agent is armed: what to do, and a way out. Fixed above the agent bar (--apc-bar-height). */
function armedNote(name: string, onCancel: () => void): { box: HTMLElement; say: (text: string) => void } {
  const box = document.createElement("div");
  box.setAttribute("role", "status");
  box.setAttribute("data-apc-tap-pin", "");
  Object.assign(box.style, { position: "fixed", zIndex: "2147483646", left: "12px", right: "12px", bottom: "calc(max(var(--apc-bar-height, 0px), env(safe-area-inset-bottom, 0px)) + 12px)", display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "12px", background: "#1f1f1f", color: "#fff", font: "14px/1.35 system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.3)" });
  const text = document.createElement("span");
  text.style.flex = "1";
  const say = (t: string) => {
    text.textContent = t;
  };
  say(`Tap what to point ${name} at.`);
  const cancel = document.createElement("button");
  cancel.setAttribute("type", "button");
  cancel.setAttribute("data-apc-tap-cancel", "");
  cancel.textContent = "Cancel";
  Object.assign(cancel.style, { minHeight: "44px", minWidth: "64px", padding: "0 14px", borderRadius: "10px", border: "1px solid #666", background: "transparent", color: "#fff", font: "600 14px system-ui, sans-serif", cursor: "pointer" });
  cancel.addEventListener("click", onCancel);
  box.append(text, cancel);
  return { box, say };
}

/**
 * Drag an agent's mark onto anything that carries data-focus. While dragging,
 * the body has class apc-dragging (valid targets can outline themselves) and
 * the target under the pointer has class apc-target. Escape cancels.
 *
 * Touch (APC 0.6): a finger can drag a mark the same way (pointer events), and a plain tap on a mark
 * (a touch or pen press that moves under TAP_SLOP_PX, or a keyboard activation) arms the agent
 * instead: "tap to pin". The body gets class apc-armed (and apc-dragging), every target is outlined,
 * a note at the bottom of the page says what to do and has Cancel, and the next tap on a target pins
 * the agent there (the click that follows is swallowed, so the target's own action does not run).
 * Tapping the mark again, Cancel or Escape lets go. A mouse click on a mark does nothing, as before.
 * A pin badge (<apc-pin>) can be dragged by touch but does not arm: it is where an agent points,
 * not where agents are.
 * Returns a function that removes the listeners.
 */
export function enablePinning(options: PinningOptions): () => void {
  const root = options.root ?? document;
  const markSelector = options.markSelector ?? "[data-apc-mark]";
  let drag: { grantId: string; mark: Element; ghost: HTMLElement; current: { element: Element; target: FocusTarget } | null; x: number; y: number; moved: number; touch: boolean } | null = null;
  // Tap to pin: the agent armed by a tap on its mark, and the note that says so.
  let note: { box: HTMLElement; say: (text: string) => void } | null = null;
  // The one click that follows a pinning (or refused) tap or key: swallowed once, and only on the element that was pinned.
  let swallowClickUntil = 0;
  let swallowOn: Element | null = null;
  const trusted = options.trusted ?? ((e: Event) => e.isTrusted === true);
  // Armed from the keyboard: targets can be focused and pinned with Enter or Space. What was changed is put back on let go.
  let restore: Array<[Element, string | null]> = [];
  let watch: ReturnType<typeof setInterval> | null = null;
  const tapPin = createTapPin({
    canTarget: options.canTarget,
    onPin: options.onPin,
    onChange: (armed) => {
      note?.box.remove();
      note = null;
      for (const [el, prev] of restore) (prev === null ? el.removeAttribute("tabindex") : el.setAttribute("tabindex", prev));
      restore = [];
      if (watch) clearInterval(watch);
      watch = null;
      for (const m of document.querySelectorAll(markSelector)) m.removeAttribute("aria-pressed");
      if (!armed) {
        document.body.classList.remove("apc-armed", "apc-dragging");
        document.documentElement.removeAttribute("data-apc-armed");
      } else {
        if (!document.getElementById(ARMED_STYLE_ID)) {
          const style = document.createElement("style");
          style.id = ARMED_STYLE_ID;
          style.textContent = ARMED_CSS;
          document.head.append(style);
        }
        const mark = [...document.querySelectorAll(markSelector)].find((m) => m.getAttribute("data-grant") === armed && !m.closest("apc-pin"));
        const name = mark?.getAttribute("aria-label") || mark?.getAttribute("title") || "your agent";
        note = armedNote(name, () => tapPin.cancel());
        document.body.append(note.box);
        document.body.classList.add("apc-armed", "apc-dragging");
        document.documentElement.setAttribute("data-apc-armed", armed);
        mark?.setAttribute("aria-pressed", "true");
        // A route change (pushState too) or a hidden page lets go: the person is never left armed on another screen.
        const href = location.href;
        watch = setInterval(() => {
          if (location.href !== href || document.visibilityState === "hidden") tapPin.cancel();
        }, 250);
      }
      window.dispatchEvent(new CustomEvent(APC_ARMED_EVENT, { detail: { id: armed } }));
    },
  });
  /** A tap on a mark of the agent bar (not a pin badge) arms its agent. */
  const armFromMark = (mark: Element, grantId: string) => {
    if (!mark.closest("apc-pin")) tapPin.toggle(grantId);
  };
  /** From the keyboard: arm, make every target focusable, move focus to the first and say how to pin. */
  const armFromKey = (mark: Element, grantId: string) => {
    if (mark.closest("apc-pin")) return;
    if (tapPin.toggle(grantId) !== grantId) return;
    const targets = [...document.querySelectorAll("[data-focus]")].filter((el) => targetOf(el)?.element === el);
    for (const el of targets) {
      if (el.hasAttribute("tabindex")) continue;
      restore.push([el, null]);
      el.setAttribute("tabindex", "0");
    }
    note?.say("Pointing your agent: Tab to an outlined item, then press Enter or Space to pin it. Escape cancels.");
    (targets[0] as HTMLElement | undefined)?.focus();
  };

  const setCurrent = (next: { element: Element; target: FocusTarget } | null) => {
    if (!drag) return;
    drag.current?.element.classList.remove("apc-target");
    drag.current = next;
    next?.element.classList.add("apc-target");
  };

  const end = (commit: boolean) => {
    if (!drag) return;
    const { grantId, ghost, current } = drag;
    current?.element.classList.remove("apc-target");
    ghost.remove();
    // Armed (tap to pin), the page stays in its pinning state: only a drag's own class goes.
    if (!tapPin.armed) document.body.classList.remove("apc-dragging");
    drag = null;
    if (commit && current) options.onPin(grantId, current.target, current.element);
  };

  const onDown = (event: Event) => {
    if (!trusted(event)) return;
    const pointer = event as PointerEvent;
    const mark = (pointer.target as Element | null)?.closest?.(markSelector);
    const grantId = mark?.getAttribute("data-grant");
    if (!mark || !grantId || pointer.button !== 0) return;
    pointer.preventDefault();
    const ghost = mark.cloneNode(true) as HTMLElement;
    ghost.classList.add("apc-ghost");
    Object.assign(ghost.style, { outline: "none", position: "fixed", pointerEvents: "none", left: `${pointer.clientX - 12}px`, top: `${pointer.clientY - 12}px`, zIndex: "1000" });
    document.body.appendChild(ghost);
    document.body.classList.add("apc-dragging");
    drag = { grantId, mark, ghost, current: null, x: pointer.clientX, y: pointer.clientY, moved: 0, touch: pointer.pointerType === "touch" || pointer.pointerType === "pen" };
  };

  const onMove = (event: PointerEvent) => {
    if (!drag || !trusted(event)) return;
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
    drag.ghost.style.left = `${event.clientX - 12}px`;
    drag.ghost.style.top = `${event.clientY - 12}px`;
    const hit = targetAt(event.clientX, event.clientY);
    const allowed = hit && (options.canTarget ? options.canTarget(drag.grantId, hit.target) : true);
    setCurrent(allowed ? hit : null);
  };

  const onUp = (event: Event) => {
    if (!trusted(event)) return;
    // A touch or pen press on a mark that did not move is a tap: arm the agent (or let go of it).
    if (drag && drag.touch && drag.moved < TAP_SLOP_PX) {
      const { grantId, mark } = drag;
      end(false);
      armFromMark(mark, grantId);
      return;
    }
    end(true);
  };
  const onCancel = () => end(false);
  const letGo = () => tapPin.cancel();

  // Armed: a tap on a target pins the agent there. The press is watched on the window, so a scroll
  // (the browser cancels the pointer) or a move past the slop is not a tap.
  let press: { x: number; y: number; target: EventTarget | null } | null = null;
  const inUi = (node: EventTarget | null) => !!(node as Element | null)?.closest?.("[data-apc-tap-pin], [data-apc-mark], apc-agents");
  const onAnyDown = (event: Event) => {
    const p = event as PointerEvent;
    swallowClickUntil = 0; // a new press: only the click of the tap that pins is swallowed
    press = tapPin.armed && trusted(event) ? { x: p.clientX, y: p.clientY, target: p.target } : null;
  };
  const onAnyUp = (event: Event) => {
    const p = event as PointerEvent;
    const start = press;
    press = null;
    if (!tapPin.armed || !start || !trusted(event) || inUi(start.target) || inUi(p.target)) return;
    if (Math.hypot(p.clientX - start.x, p.clientY - start.y) >= TAP_SLOP_PX) return;
    const hit = targetAt(p.clientX, p.clientY);
    const result = tapPin.tap(hit);
    // A tap on something that is no target lets go and passes through: a link, tab or button works at once.
    if (result === "no_target") return tapPin.cancel();
    // The tap that pinned, or was refused, must not run the target's own action.
    swallowClickUntil = Date.now() + 500;
    swallowOn = hit?.element ?? null;
    if (result === "refused") note?.say("This agent cannot point at that. Tap another outlined target, or Cancel.");
  };
  // Only the click that follows a pinning (or refused) tap is swallowed; every other click goes through.
  const onClickCapture = (event: Event) => {
    if (Date.now() > swallowClickUntil || inUi(event.target)) return;
    if (swallowOn && !swallowOn.contains(event.target as Node)) return;
    swallowClickUntil = 0; // one-shot: the next click is the person's own
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // A keyboard (or assistive technology) activation of a mark arms it too: no pointer was involved.
  const onClick = (event: Event) => {
    if ((event as MouseEvent).detail !== 0 || !trusted(event)) return;
    const mark = (event.target as Element | null)?.closest?.(markSelector);
    const grantId = mark?.getAttribute("data-grant");
    if (mark && grantId) armFromKey(mark, grantId);
  };

  // Native drops from another window (opt-in). During dragover only the types are readable, so the
  // target lights up for any APC agent; who it is and whether it may point there is checked on drop.
  let native: { current: { element: Element; target: FocusTarget } | null; depth: number } | null = null;
  // An app that does not offer Dock (APC 0.5) takes a dock agent's drop only to answer it. Its
  // profiles are known (a list), still loading (`loading`), could not be read (`unread`), or not given
  // at all (undefined: the app takes dock agents as before 0.5).
  const given = options.profiles;
  const isPromise = (p: unknown): p is PromiseLike<readonly ApcRole[] | null> => !!p && typeof (p as PromiseLike<unknown>).then === "function";
  let profiles: readonly ApcRole[] | null | undefined = Array.isArray(given) ? given : undefined;
  let loading = false;
  let ready: Promise<void> = Promise.resolve();
  const load = (p: PromiseLike<readonly ApcRole[] | null>) => {
    loading = true;
    ready = Promise.resolve(p).then(
      (v) => {
        profiles = v ?? null;
        loading = false;
      },
      () => {
        profiles = null;
        loading = false;
      },
    );
  };
  if (typeof given === "function") load(given());
  else if (isPromise(given)) load(given);
  const unread = () => profiles === null && !loading;
  const dockless = () => !!profiles && !profiles.includes("dock");
  const isAgentDrag = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes(APC_AGENT_TYPE) && (!!options.acceptNativeDrops || dockless() || loading || unread());
  const nativeEnd = () => {
    native?.current?.element.classList.remove("apc-target");
    native = null;
    document.body.classList.remove("apc-dragging");
  };
  const onDragEnter = (event: DragEvent) => {
    if (!isAgentDrag(event)) return;
    if (!native) {
      native = { current: null, depth: 0 };
      document.body.classList.add("apc-dragging");
    }
    native.depth++;
  };
  const onDragOver = (event: DragEvent) => {
    if (!isAgentDrag(event) || !native) return;
    // A Direct-only app lights no target for a dragged agent: it cannot point a dock agent at anything.
    const hit = dockless() ? null : targetAt(event.clientX, event.clientY);
    if (hit?.element !== native.current?.element) {
      native.current?.element.classList.remove("apc-target");
      hit?.element.classList.add("apc-target");
      native.current = hit;
    }
    // On a Direct-only app the drop is taken anywhere, so the person always gets the answer; so it is
    // while the app's profiles are still loading, since the drop is answered once they are known.
    if (hit || dockless() || loading || unread()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
    }
  };
  const onDragLeave = (event: DragEvent) => {
    if (!native || !isAgentDrag(event)) return;
    if (--native.depth <= 0) nativeEnd();
  };
  const onDrop = (event: DragEvent) => {
    if (!isAgentDrag(event)) return;
    event.preventDefault();
    const drag = parseAgentDrag(event.dataTransfer!.getData(APC_AGENT_TYPE));
    const hit = targetAt(event.clientX, event.clientY);
    nativeEnd();
    const fromDock = !!(drag?.hub && drag.ticket);
    // Profiles that could not be read are asked again on this drop, when the app gave a loader.
    if (fromDock && unread() && typeof given === "function") load(given());
    // A dock agent dropped before the app's profiles are known: held until they are, within the
    // loader's own time limit (loadApcProfiles: 3 s; the ticket lives 60 s).
    if (fromDock && loading) {
      void ready.then(() => deliver(drag, hit));
      return;
    }
    deliver(drag, hit);
  };
  const deliver = (drag: AgentDrag | null, hit: { element: Element; target: FocusTarget } | null) => {
    // A dock agent on an app that does not offer Dock, or whose profiles could not be read: answered,
    // never sent to pairing (an app that cannot check its own file pairs nothing on a guess).
    if (drag?.hub && drag.ticket && (dockless() || unread())) {
      const name = options.direct?.name ?? "This app";
      const reason = dockless() ? "direct_only" : "unchecked";
      const answer: DockUnsupported = { drag, target: hit?.target ?? null, name, connect: options.direct?.connect ?? null, reason, message: reason === "direct_only" ? directOnlyNote(name) : couldNotCheckNote(name) };
      (options.onDockUnsupported ?? showDockUnsupported)(answer);
      return;
    }
    // A drop held while the profiles loaded, on an app that turns out to offer Dock but takes no native drops.
    if (!options.acceptNativeDrops) return;
    if (!drag || !hit) return;
    const grantId = options.resolveAgent ? options.resolveAgent(drag.agent) : drag.agent;
    if (!grantId) {
      if (drag.hub && drag.ticket) options.onUnknownAgent?.({ ...drag, hub: drag.hub, ticket: drag.ticket }, hit.target, hit.element);
      return;
    }
    if (options.canTarget && !options.canTarget(grantId, hit.target)) return;
    options.onPin(grantId, hit.target, hit.element);
  };
  const onKey = (event: KeyboardEvent) => {
    swallowClickUntil = 0; // a new key press: nothing from before is swallowed
    if (event.key === "Escape") {
      end(false);
      tapPin.cancel();
      return;
    }
    // Armed from the keyboard: Enter or Space on a focused target pins there.
    if ((event.key === "Enter" || event.key === " ") && tapPin.armed && trusted(event) && !inUi(event.target)) {
      const hit = targetOf(event.target as Element | null);
      if (!hit) return;
      event.preventDefault();
      // The click the browser makes from this key (Space: on keyup) must not run the target's own action either.
      swallowClickUntil = Date.now() + 500;
      swallowOn = hit.element;
      if (tapPin.tap(hit) === "refused") note?.say("This agent cannot point at that. Tab to another outlined item, or press Escape.");
    }
  };

  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("popstate", letGo);
  window.addEventListener("hashchange", letGo);
  window.addEventListener("pagehide", letGo);
  window.addEventListener("visibilitychange", letGo);
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onAnyDown, true);
  window.addEventListener("pointerup", onAnyUp, true);
  window.addEventListener("click", onClickCapture, true);
  root.addEventListener("click", onClick);
  const takesNative = !!(options.acceptNativeDrops || options.profiles);
  if (takesNative) {
    document.documentElement?.setAttribute(APC_DROPS_ATTR, "");
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
  }
  return () => {
    nativeEnd();
    if (takesNative) document.documentElement?.removeAttribute(APC_DROPS_ATTR);
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
    end(false);
    root.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("popstate", letGo);
    window.removeEventListener("hashchange", letGo);
    window.removeEventListener("pagehide", letGo);
    window.removeEventListener("visibilitychange", letGo);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onAnyDown, true);
    window.removeEventListener("pointerup", onAnyUp, true);
    window.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("click", onClick);
    tapPin.cancel();
  };
}
