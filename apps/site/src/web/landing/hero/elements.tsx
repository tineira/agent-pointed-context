/**
 * The standard APC elements from @tineira/apc-web on the hero's stage, as Pulse wraps them (apps/demo/src/web/agent-bar.tsx
 * and apc-pin.tsx): the agent bar, `<apc-agents>`, where the visitor's agent lives, and the pin badge, `<apc-pin>`, that the
 * pinned bar wears. Both draw the site's agent mark. Their drag, tap and keyboard pinning is enablePinning's (HeroStage).
 */
import { defineAgentBar, definePinBadge, type ApcAgentsElement, type ApcPinElement, type BarAgent } from "@tineira/apc-web";
import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { AgentMark } from "../../agent-mark.tsx";

defineAgentBar();
definePinBadge();

/** The one agent on the stage: the visitor's, simulated. */
export const HERO_AGENT = { id: "your-agent", name: "Your agent" } as const;

const roots = new WeakMap<HTMLElement, Root>();

/** The agent bar, with one agent. Its × (and the badge's) unpins. */
export function HeroAgentBar(props: { agent: BarAgent; onUnpin: () => void }) {
  const ref = useRef<ApcAgentsElement | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.renderIcon = (_agent, into) => {
      let root = roots.get(into);
      if (!root) {
        root = createRoot(into);
        roots.set(into, root);
      }
      root.render(<AgentMark size={into.classList.contains("apc-agents__mini-icon") ? 16 : 24} track />);
    };
    const unpin = () => latest.current.onUnpin();
    el.addEventListener("apc-unpin", unpin);
    return () => el.removeEventListener("apc-unpin", unpin);
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.agents = [props.agent];
  }, [props.agent]);

  // The bar's hint off before it connects: React sets a custom element's known property (dockHint) on creation, before
  // the element is in the page, so its first render never reads that hint's dismissal from this origin's localStorage,
  // which is the hub's key on apc.tineira.com.
  return createElement("apc-agents", { ref, class: "hero-agents", dockHint: null });
}

/** The pin badge on the pinned bar: a dashed, breathing ring until the agent reads the pin, then a check, and ×. */
export function HeroPin(props: { seen: boolean; at: { left: number; top: number }; onUnpin: () => void }) {
  const ref = useRef<ApcPinElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A function that draws nothing: the icon is the portal below, as in Pulse.
    el.renderIcon = () => {};
    setHost(el.iconHost);
    const unpin = () => latest.current.onUnpin();
    el.addEventListener("apc-unpin", unpin);
    return () => el.removeEventListener("apc-unpin", unpin);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.agent = { id: HERO_AGENT.id, name: HERO_AGENT.name, seen: props.seen };
    // Where it sits is set through the CSSOM: the site's policy allows no style attribute.
    el.style.setProperty("--hero-pin-x", `${props.at.left}px`);
    el.style.setProperty("--hero-pin-y", `${props.at.top}px`);
  });

  return (
    <>
      {createElement("apc-pin", { ref, class: "hero-pin" })}
      {host && createPortal(<AgentMark size={20} />, host)}
    </>
  );
}
