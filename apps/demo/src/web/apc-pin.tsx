/**
 * The standard pin badge (TIN-482, `<apc-pin>` from @apc/web) in React, with Pulse's own logos: the
 * element calls renderIcon with an element it keeps, and Pulse draws AgentIcon there. Where the
 * badge goes (className, style) stays Pulse's: pin-badges.tsx floats it over its target.
 */
import { definePinBadge, type ApcPinElement } from "@apc/web";
import { createElement, useEffect, useRef, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "./agent-icon.tsx";
import type { AgentMotion } from "./agent-brands.ts";

definePinBadge();

const roots = new WeakMap<HTMLElement, Root>();

export function ApcPin(props: {
  id: string;
  name: string;
  seen: boolean;
  clientName: string | null;
  clientUa?: string | null;
  clientIcon?: string | null;
  motion: AgentMotion;
  onUnpin: (grantId: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<ApcPinElement | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.renderIcon = (_agent, into) => {
      const p = latest.current;
      let root = roots.get(into);
      if (!root) {
        root = createRoot(into);
        roots.set(into, root);
      }
      root.render(<AgentIcon clientName={p.clientName} clientUa={p.clientUa} clientIcon={p.clientIcon} motion={p.motion} size={18} />);
    };
    const unpin = (e: Event) => latest.current.onUnpin((e as CustomEvent<{ id: string }>).detail.id);
    el.addEventListener("apc-unpin", unpin);
    return () => {
      el.removeEventListener("apc-unpin", unpin);
      // The icon's root goes with the badge (not during React's own commit).
      const icon = el.mark?.firstElementChild as HTMLElement | null;
      const root = icon && roots.get(icon);
      if (icon && root) queueMicrotask(() => (root.unmount(), roots.delete(icon)));
    };
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.agent = { id: props.id, name: props.name, seen: props.seen };
  });

  return createElement("apc-pin", { ref, class: props.className, style: props.style });
}
