/**
 * APC v2 dock prototype (TIN-370): Pulse tells a dock window which agents it has, so the dock can
 * show them and drag them back onto Pulse (a native drop, TIN-369). The dock is another origin
 * (v2.apc.tineira.com) opened from Pulse; they talk with postMessage only, and nothing secret
 * crosses: an agent's handle is its grant id, which the drop needs and any page may read.
 */
import { useEffect, useRef } from "react";
import { dockOriginAllowed, type DockAgent, type DockMessage } from "./dock-protocol.ts";

export const DOCK_URL = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? "http://localhost:5200/" : "https://v2.apc.tineira.com/";

/**
 * Pulse's side: every dock that says hello gets the agents, then each change. A dock says hello
 * again now and then, so one that outlives a reload of Pulse finds it again. Off unless enabled.
 */
export function useDockBridge(enabled: boolean, agents: DockAgent[] | null): void {
  // Each dock window, with the origin it said hello from: messages go only to that origin.
  const docks = useRef(new Map<MessageEventSource, string>());
  const latest = useRef<DockMessage | null>(null);
  latest.current = agents ? { type: "apc-dock:agents", v: 1, app: { name: "Pulse", origin: location.origin }, agents } : null;
  const send = (to: MessageEventSource, origin: string) => {
    if (!latest.current) return;
    try {
      (to as Window).postMessage(latest.current, origin);
    } catch {
      docks.current.delete(to);
    }
  };
  useEffect(() => {
    if (!enabled) return;
    const onMessage = (event: MessageEvent) => {
      if (!dockOriginAllowed(event.origin) || !event.source) return;
      const m = event.data as { type?: unknown; v?: unknown } | null;
      if (m?.type !== "apc-dock:hello" || m.v !== 1) return;
      docks.current.set(event.source, event.origin);
      send(event.source, event.origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled]);
  const key = JSON.stringify(agents);
  useEffect(() => {
    if (!enabled) return;
    for (const [dock, origin] of docks.current) {
      if ((dock as Window).closed) docks.current.delete(dock);
      else send(dock, origin);
    }
  }, [enabled, key]);
}

/** Open the dock as a small window of its own, or bring it back if it is open. */
export function openDock(): void {
  window.open(DOCK_URL, "apc-dock", "popup,width=320,height=560");
}
