/** The standard agent bar (TIN-394, `<apc-agents>` from @apc/web) in React: icons are the agents' marks from the dock. */
import { defineAgentBar, type ApcAgentsElement, type BarAgent } from "@apc/web";
import { createElement, useEffect, useRef } from "react";

defineAgentBar();

export function AgentBar(props: { agents: BarAgent[]; onOpen: (id: string) => void; onUnpin: (id: string) => void }) {
  const ref = useRef<ApcAgentsElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const open = (e: Event) => latest.current.onOpen((e as CustomEvent<{ id: string }>).detail.id);
    const unpin = (e: Event) => latest.current.onUnpin((e as CustomEvent<{ id: string }>).detail.id);
    el.addEventListener("apc-open", open);
    el.addEventListener("apc-unpin", unpin);
    return () => {
      el.removeEventListener("apc-open", open);
      el.removeEventListener("apc-unpin", unpin);
    };
  }, []);
  useEffect(() => {
    if (ref.current) ref.current.agents = props.agents;
  }, [props.agents]);
  return createElement("apc-agents", { ref, class: "agent-bar" });
}
