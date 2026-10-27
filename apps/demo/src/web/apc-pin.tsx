/**
 * The standard pin badge (TIN-482, `<apc-pin>` from @apc/web) in React, with Pulse's own logos:
 * AgentIcon is portalled into the badge's icon host. Where the badge goes (className, style) stays
 * Pulse's: pin-badges.tsx floats it over its target.
 */
import { definePinBadge, type ApcPinElement } from "@apc/web";
import { createElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AgentIcon } from "./agent-icon.tsx";
import type { AgentMotion } from "./agent-brands.ts";

definePinBadge();

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
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A function that draws nothing: the icon is the portal below, not the element's own.
    el.renderIcon = () => {};
    setHost(el.iconHost);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unpin = (e: Event) => latest.current.onUnpin((e as CustomEvent<{ id: string }>).detail.id);
    el.addEventListener("apc-unpin", unpin);
    return () => el.removeEventListener("apc-unpin", unpin);
  }, []);

  useLayoutEffect(() => {
    if (ref.current) ref.current.agent = { id: props.id, name: props.name, seen: props.seen };
  });

  return (
    <>
      {createElement("apc-pin", { ref, class: props.className, style: props.style })}
      {host && createPortal(<AgentIcon clientName={props.clientName} clientUa={props.clientUa} clientIcon={props.clientIcon} motion={props.motion} size={18} />, host)}
    </>
  );
}
