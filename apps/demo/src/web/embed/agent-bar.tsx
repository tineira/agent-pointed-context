/**
 * The hero's agent bar: the standard `<apc-agents>` from @tineira/apc-web, drawing Pulse's own logos (AgentIcon), as
 * Pulse's bar does (../agent-bar.tsx). Only Unpin is wired: the hero has no Revoke (its ⊘ is hidden, embed.css, and
 * its event does nothing), no Unlink, no warning link, and no dock hint (a link the sandboxed frame could not open).
 */
import { defineAgentBar, type ApcAgentsElement, type BarAgent } from "@tineira/apc-web";
import { createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "../agent-icon.tsx";

defineAgentBar();

export interface EmbedBarAgent extends BarAgent {
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
}

const roots = new WeakMap<HTMLElement, Root>();

export function EmbedAgentBar(props: { agents: EmbedBarAgent[]; onUnpin: (id: string) => void }) {
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
      root.render(<AgentIcon clientName={a?.client_name ?? null} clientUa={a?.client_ua} clientIcon={a?.client_icon} motion="idle" size={into.classList.contains("apc-agents__mini-icon") ? 16 : 22} />);
    };
    const unpin = (e: Event) => latest.current.onUnpin((e as CustomEvent<{ id: string }>).detail.id);
    el.addEventListener("apc-unpin", unpin);
    return () => el.removeEventListener("apc-unpin", unpin);
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.agents = props.agents;
  }, [props.agents]);

  // dockHint null at creation, as the landing's hero does: no "get the dock" link inside the frame.
  return createElement("apc-agents", { ref, class: "embed-agents", dockHint: null });
}
