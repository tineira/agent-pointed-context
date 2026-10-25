import { parseFocusAttrs, type FocusTarget } from "@apc/protocol";

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
  const isAgentDrag = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes(APC_AGENT_TYPE);
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
    const hit = targetAt(event.clientX, event.clientY);
    if (hit?.element !== native.current?.element) {
      native.current?.element.classList.remove("apc-target");
      hit?.element.classList.add("apc-target");
      native.current = hit;
    }
    if (hit) {
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
  if (options.acceptNativeDrops) {
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
  }
  return () => {
    nativeEnd();
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
