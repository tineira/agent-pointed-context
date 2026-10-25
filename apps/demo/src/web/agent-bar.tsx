/**
 * The standard agent bar (TIN-394, `<apc-agents>` from @apc/web) in React, with Pulse's own logos:
 * the bar calls renderIcon with an element it keeps per agent, and Pulse draws AgentIcon there.
 * Used on Pulse's v2 deploy; apc.tineira.com keeps its own top-bar marks.
 */
import { defineAgentBar, type ApcAgentsElement, type BarAgent } from "@apc/web";
import { createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "./agent-icon.tsx";

defineAgentBar();

export interface PulseBarAgent extends BarAgent {
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
}

const roots = new WeakMap<HTMLElement, Root>();

export function AgentBar(props: { agents: PulseBarAgent[]; onOpen: (id: string) => void; onUnpin: (id: string) => void; onWarning: (id: string) => void }) {
  const ref = useRef<ApcAgentsElement | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.renderIcon = (agent, into) => {
      const a = latest.current.agents.find((x) => x.id === agent.id);
      let root = roots.get(into);
      if (!root) {
        root = createRoot(into);
        roots.set(into, root);
      }
      root.render(<AgentIcon clientName={a?.client_name ?? null} clientUa={a?.client_ua} clientIcon={a?.client_icon} motion="idle" size={22} />);
    };
    const on = (type: string, fn: (id: string) => void) => {
      const handler = (e: Event) => fn((e as CustomEvent<{ id: string }>).detail.id);
      el.addEventListener(type, handler);
      return () => el.removeEventListener(type, handler);
    };
    const offs = [on("apc-open", (id) => latest.current.onOpen(id)), on("apc-unpin", (id) => latest.current.onUnpin(id)), on("apc-warning", (id) => latest.current.onWarning(id))];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.agents = props.agents;
  }, [props.agents]);

  return createElement("apc-agents", { ref, class: "agent-bar" });
}
