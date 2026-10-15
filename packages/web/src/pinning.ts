import { parseFocusAttrs, type FocusTarget } from "@apc/protocol";

export interface PinningOptions {
  /** Where marks and targets live; defaults to document. */
  root?: Document | HTMLElement;
  /** Selector of the draggable agent marks; each carries data-grant. */
  markSelector?: string;
  /** Refuse a target for one agent (for example outside a restricted grant). */
  canTarget?: (grantId: string, target: FocusTarget) => boolean;
  onPin: (grantId: string, target: FocusTarget, element: Element) => void;
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
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") end(false);
  };

  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
  return () => {
    end(false);
    root.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
  };
}
