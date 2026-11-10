/**
 * The Direct profile's agent list (`<apc-direct-agents>` from @tineira/apc-web, TIN-578) in React: where the
 * person makes and names the agents that connect to this app directly, each with its own MCP URL and
 * the prompt to paste to it. Shared by Pulse and Signals.
 */
import { defineDirectAgents, type ApcDirectAgentsElement, type DirectAgent, type DirectStrings } from "@tineira/apc-web";
import { createElement, useEffect, useRef } from "react";
import { forwardStrings, usePulseStrings } from "./apc-strings.ts";

defineDirectAgents();

export function DirectAgents(props: { appName: string; agents: DirectAgent[]; onAdd: () => void; onRename: (id: string, name: string) => void; strings?: Partial<DirectStrings> }) {
  const fromContext = usePulseStrings()?.direct;
  const strings = props.strings ?? fromContext;
  const ref = useRef<ApcDirectAgentsElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const add = () => latest.current.onAdd();
    const rename = (e: Event) => {
      const { id, name } = (e as CustomEvent<{ id: string; name: string }>).detail;
      latest.current.onRename(id, name);
    };
    el.addEventListener("apc-add", add);
    el.addEventListener("apc-rename", rename);
    return () => {
      el.removeEventListener("apc-add", add);
      el.removeEventListener("apc-rename", rename);
    };
  }, []);
  useEffect(() => {
    if (ref.current) forwardStrings(ref.current, strings);
  }, [strings]);
  // Only when something shown changed: the element redraws its rows on every set.
  const key = JSON.stringify([props.appName, props.agents]);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.appName = latest.current.appName;
    ref.current.agents = latest.current.agents;
  }, [key]);
  return createElement("apc-direct-agents", { ref });
}
