import { APC_JSON_PATH, directOnlyNote, parseApcManifest, parseFocusAttrs, urlOnOrigin, type ApcRole, type FocusTarget } from "@apc/protocol";

const profileLoads = new Map<string, Promise<ApcRole[] | null>>();

/**
 * The profiles the page's own app offers, from its apc.json (APC 0.5), for `enablePinning({ profiles })`:
 * read once per origin, without cookies. Null when there is no valid file (then read again next time).
 */
export function loadApcProfiles(origin: string = location.origin, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<ApcRole[] | null> {
  let load = profileLoads.get(origin);
  if (!load) {
    load = fetcher(`${origin}${APC_JSON_PATH}`, { credentials: "omit", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const parsed = parseApcManifest(body, origin);
        return parsed.ok ? parsed.manifest.profiles : null;
      })
      .catch(() => null);
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
   * APC 0.5: the profiles this app offers, as its apc.json says: a list, or a promise of one, such as
   * `loadApcProfiles()`, which reads the page's own apc.json. An app without "dock" still takes the drop
   * of an agent dragged from a dock, anywhere on the page and with or without acceptNativeDrops, and
   * answers it with `onDockUnsupported` instead of `onUnknownAgent`: never a drop that silently does
   * nothing. While the promise is pending, a dock agent's drop is taken and held until it settles, then
   * answered or paired as the profiles say. A promise that gives null (no file) counts as offering Dock.
   */
  profiles?: readonly ApcRole[] | PromiseLike<readonly ApcRole[] | null>;
  /** For that answer: the app's name and the page where the person connects an agent directly (apc.json's `direct.connect`). */
  direct?: { name: string; connect: string | null };
  /** A dock agent dropped on an app that does not offer Dock. Without it, `showDockUnsupported` tells the person in the page. */
  onDockUnsupported?: (answer: DockUnsupported) => void;
}

/** The answer to a dock agent dropped on a Direct-only app: who it was, what to tell the person, and where they connect instead. */
export interface DockUnsupported {
  drag: AgentDrag;
  /** The target under the drop, if any. */
  target: FocusTarget | null;
  name: string;
  connect: string | null;
  /** `directOnlyNote(name)`: the app's own words, on its own page. */
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
  Object.assign(box.style, { position: "fixed", zIndex: "2147483647", right: "16px", bottom: "16px", maxWidth: "340px", padding: "12px 14px", borderRadius: "10px", background: "#1f1f1f", color: "#fff", font: "13px/1.45 system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.25)" });
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
  let node: Element | null = document.elementFromPoint(x, y);
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
 * Drag an agent's mark onto anything that carries data-focus. While dragging,
 * the body has class apc-dragging (valid targets can outline themselves) and
 * the target under the pointer has class apc-target. Escape cancels.
 * Returns a function that removes the listeners.
 */
export function enablePinning(options: PinningOptions): () => void {
  const root = options.root ?? document;
  const markSelector = options.markSelector ?? "[data-apc-mark]";
  let drag: { grantId: string; ghost: HTMLElement; current: { element: Element; target: FocusTarget } | null } | null = null;

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
    document.body.classList.remove("apc-dragging");
    drag = null;
    if (commit && current) options.onPin(grantId, current.target, current.element);
  };

  const onDown = (event: Event) => {
    const pointer = event as PointerEvent;
    const mark = (pointer.target as Element | null)?.closest?.(markSelector);
    const grantId = mark?.getAttribute("data-grant");
    if (!mark || !grantId || pointer.button !== 0) return;
    pointer.preventDefault();
    const ghost = mark.cloneNode(true) as HTMLElement;
    ghost.classList.add("apc-ghost");
    Object.assign(ghost.style, { position: "fixed", pointerEvents: "none", left: `${pointer.clientX - 12}px`, top: `${pointer.clientY - 12}px`, zIndex: "1000" });
    document.body.appendChild(ghost);
    document.body.classList.add("apc-dragging");
    drag = { grantId, ghost, current: null };
  };

  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    drag.ghost.style.left = `${event.clientX - 12}px`;
    drag.ghost.style.top = `${event.clientY - 12}px`;
    const hit = targetAt(event.clientX, event.clientY);
    const allowed = hit && (options.canTarget ? options.canTarget(drag.grantId, hit.target) : true);
    setCurrent(allowed ? hit : null);
  };

  const onUp = () => end(true);

  // Native drops from another window (opt-in). During dragover only the types are readable, so the
  // target lights up for any APC agent; who it is and whether it may point there is checked on drop.
  let native: { current: { element: Element; target: FocusTarget } | null; depth: number } | null = null;
  // An app that does not offer Dock (APC 0.5) takes a dock agent's drop only to answer it. Its
  // profiles are known (a list), still loading (a pending promise: `loading`), or unknown (null).
  const given = options.profiles;
  const isPromise = (p: unknown): p is PromiseLike<readonly ApcRole[] | null> => !!p && typeof (p as PromiseLike<unknown>).then === "function";
  let profiles: readonly ApcRole[] | null = isPromise(given) ? null : (given ?? null);
  let loading = isPromise(given);
  const ready: Promise<void> = isPromise(given)
    ? Promise.resolve(given).then(
        (p) => {
          profiles = p ?? null;
          loading = false;
        },
        () => {
          loading = false;
        },
      )
    : Promise.resolve();
  const dockless = () => !!profiles && !profiles.includes("dock");
  const isAgentDrag = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes(APC_AGENT_TYPE) && (!!options.acceptNativeDrops || dockless() || loading);
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
    if (hit || dockless() || loading) {
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
    // A dock agent dropped before the app's profiles are known: held until they are (the ticket lives 60 s).
    if (drag?.hub && drag.ticket && loading) {
      void ready.then(() => deliver(drag, hit));
      return;
    }
    deliver(drag, hit);
  };
  const deliver = (drag: AgentDrag | null, hit: { element: Element; target: FocusTarget } | null) => {
    if (drag?.hub && drag.ticket && dockless()) {
      const name = options.direct?.name ?? "This app";
      const answer: DockUnsupported = { drag, target: hit?.target ?? null, name, connect: options.direct?.connect ?? null, message: directOnlyNote(name) };
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
    if (event.key === "Escape") end(false);
  };

  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
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
    window.removeEventListener("keydown", onKey);
  };
}
