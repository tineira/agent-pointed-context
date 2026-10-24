/**
 * A pinned agent's icon sits on what it was pinned to, the way the landing shows it: a dashed,
 * breathing ring while the agent has not read the pin, a check once it has.
 * The badges float above the page (fixed, under the sticky header) and follow their targets on
 * scroll, resize and re-render. Only the icon and the unpin button take the pointer: the icon is a
 * mark like the top bar's (data-apc-mark), so dragging it to another target moves the pin (TIN-354).
 */
import { canonicalTarget, parseFocusAttrs, type FocusRow } from "@apc/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentMotion } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import type { GrantState } from "./api.ts";

export const isSeen = (pin: FocusRow) => !!pin.seen_at && pin.seen_at >= pin.pinned_at;

/** A pin in words, for titles: "active_customers 2026-03" or "cus_0042 seats". */
export function pinLabel(pin: FocusRow): string {
  if (pin.kind === "customer") return [pin.id, pin.part].filter(Boolean).join(" ");
  const p = pin.params ?? {};
  return [p.key, p.month, p.plan, p.region, pin.part].filter((v) => v !== undefined && v !== null && v !== "").join(" ");
}

interface Placed {
  grantId: string;
  left: number;
  top: number;
}

/** Where each pinned agent's badge goes: the first element on the page that carries its target. */
function place(grants: GrantState[]): Placed[] {
  const elements = [...document.querySelectorAll("[data-focus]")];
  const keys = elements.map((el) => {
    const t = parseFocusAttrs(el.getAttribute("data-focus"), el.getAttribute("data-focus-part"), el.getAttribute("data-focus-params"));
    return t ? canonicalTarget(t) : null;
  });
  const stacked = new Map<Element, number>();
  const out: Placed[] = [];
  for (const g of grants) {
    if (!g.pin) continue;
    const el = elements[keys.indexOf(canonicalTarget(g.pin))];
    if (!el) continue;
    // A chart column (an SVG group) has a hit area taller than its bar: sit on the bar. A card that holds a chart is not a column.
    const r = ((el instanceof SVGElement ? el.querySelector(".bar") : null) ?? el).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Two agents on one element sit side by side.
    const n = stacked.get(el) ?? 0;
    stacked.set(el, n + 1);
    // A bar or a cell: astride its right edge, just below its top, clear of the value printed above it.
    // A row or a card: just inside its top right corner.
    const narrow = r.width < 140;
    out.push({ grantId: g.id, left: (narrow ? r.right : r.right - 24) - n * 32, top: r.top + (narrow ? 16 : Math.min(22, r.height / 2)) });
  }
  return out;
}

const same = (a: Placed[], b: Placed[]) =>
  a.length === b.length && a.every((p, i) => p.grantId === b[i]!.grantId && Math.abs(p.left - b[i]!.left) < 0.5 && Math.abs(p.top - b[i]!.top) < 0.5);

export function PinBadges(props: {
  grants: GrantState[];
  motionOf: (grantId: string) => AgentMotion;
  onUnpin: (grantId: string) => void;
  /** The agents whose pin has a badge on this page; the top bar points elsewhere for the rest. */
  onPlaced: (grantIds: Set<string>) => void;
}) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  // The badge being dragged dims until the drop or Esc (the drag itself is enablePinning's).
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && stop();
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging]);
  const grantsRef = useRef(props.grants);
  grantsRef.current = props.grants;
  const onPlacedRef = useRef(props.onPlaced);
  onPlacedRef.current = props.onPlaced;

  const measure = () => {
    const next = place(grantsRef.current);
    setPlaced((prev) => (same(prev, next) ? prev : next));
  };
  // After every render (a new pin, a new screen, new filters)…
  useLayoutEffect(measure);
  // …and when the page scrolls, resizes or changes under us.
  useEffect(() => {
    let frame = 0;
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", soon, true);
    window.addEventListener("resize", soon);
    const resized = new ResizeObserver(soon);
    resized.observe(document.body);
    const mutated = new MutationObserver(soon);
    mutated.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-focus", "data-focus-params"] });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", soon, true);
      window.removeEventListener("resize", soon);
      resized.disconnect();
      mutated.disconnect();
    };
  }, []);
  const ids = placed.map((p) => p.grantId).join(",");
  useEffect(() => onPlacedRef.current(new Set(ids ? ids.split(",") : [])), [ids]);

  return createPortal(
    <>
      {placed.map((p) => {
        const g = props.grants.find((x) => x.id === p.grantId);
        if (!g?.pin) return null;
        const seen = isSeen(g.pin);
        return (
          <div
            key={g.id}
            className={`pin-badge ${seen ? "pin-badge-seen" : "pin-badge-waiting"}${dragging === g.id ? " pin-badge-dragging" : ""}`}
            style={{ left: p.left, top: p.top }}
            title={`${g.label}${g.client_name ? ` (${g.client_name})` : ""}: ${seen ? "read this pin" : "has not read this pin yet"}. Drag to point it at something else.`}
          >
            <span className="pin-badge-mark" data-apc-mark data-grant={g.id} onPointerDown={(e) => e.button === 0 && setDragging(g.id)}>
              <AgentIcon clientName={g.client_name} clientIcon={g.client_icon} seed={g.id} motion={props.motionOf(g.id)} size={18} />
            </span>
            {seen && (
              <span className="pin-badge-check" aria-hidden="true">
                ✓
              </span>
            )}
            <button type="button" className="pin-badge-unpin" onClick={() => props.onUnpin(g.id)} aria-label={`Remove ${g.label}'s pin`}>
              ×
            </button>
          </div>
        );
      })}
    </>,
    document.body,
  );
}
