/**
 * The standard agent bar (TIN-394, `<apc-agents>` from @apc/web) in React: icons are the agents' marks.
 * Each shows the path it came by (APC 0.4); a linked one has Unlink.
 */
import { defineAgentBar, type ApcAgentsElement, type BarAgent } from "@apc/web";
import { createElement, useEffect, useRef } from "react";

defineAgentBar();

export function AgentBar(props: { agents: BarAgent[]; onOpen: (id: string) => void; onUnpin: (id: string) => void; onRevoke: (id: string) => void; onUnlink: (id: string) => void }) {
  const ref = useRef<ApcAgentsElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (type: string, fn: (id: string) => void) => {
      const handler = (e: Event) => fn((e as CustomEvent<{ id: string }>).detail.id);
      el.addEventListener(type, handler);
      return () => el.removeEventListener(type, handler);
    };
    const offs = [
      on("apc-open", (id) => latest.current.onOpen(id)),
      on("apc-unpin", (id) => latest.current.onUnpin(id)),
      on("apc-revoke", (id) => latest.current.onRevoke(id)),
      on("apc-unlink", (id) => latest.current.onUnlink(id)),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => {
    if (ref.current) ref.current.agents = props.agents;
  }, [props.agents]);
  return createElement("apc-agents", { ref, class: "agent-bar" });
}
