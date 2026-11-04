import type { ApcProfile, FocusRow, FocusTarget, PresenceEvent } from "@tineira/apc-protocol";
import type { Region } from "../model/seed.ts";
import type { CompatRow } from "../worker/compat.ts";
import { HEARTBEAT_MS } from "../worker/page.ts";

export type { CompatRow };

export interface GrantState {
  id: string;
  secret: string;
  label: string;
  client_name: string | null;
  client_icon: string | null;
  client_ua: string | null;
  client_title: string | null;
  agent_name: string | null;
  owner_name: string | null;
  conflict: { client_name: string; client_version: string | null; user_agent: string; at: string } | null;
  regions: Region[] | null;
  created_at: string;
  last_active_at: string | null;
  pin: FocusRow | null;
}

export type TourStep = "off" | "connect" | "connected" | "point" | "pinned" | "read_once" | "read_twice";

export interface SandboxState {
  seed: number;
  settings: { share_view: boolean; show_activity: boolean };
  grants: GrantState[];
  tour: { step: TourStep; grant_id: string | null };
  /** Pulse's APC v2 deploy (TIN-382), and which dock agents are which grants. */
  v2?: boolean;
  hub_links?: Array<{ hub: string; agent: string; grant_id: string }>;
  /** On Pulse's v2 deploy, the docks it pairs with, by host (TIN-402). */
  hubs?: string[];
  /** The profiles Pulse offers (APC 0.4), and the agents linked across both: [direct grant, dock grant]. */
  profiles?: ApcProfile[];
  links?: Array<[string, string]>;
  expires_at: string;
}

export type ServerMessage =
  | { type: "presence"; event: PresenceEvent }
  | { type: "pin"; grant_id: string; pin: FocusRow | null }
  | { type: "grants" }
  | { type: "waiting"; grant_id: string; on: boolean }
  | { type: "activity" };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok && response.status !== 400) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export function createApi(sid: string) {
  const base = `/api/s/${sid}`;
  const post = <T>(path: string, body: unknown) => call<T>(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  return {
    state: () => call<SandboxState>(`${base}/state`),
    reportView: (view: unknown) => post<{ ok: boolean }>("/view", view),
    setting: (name: "share_view" | "show_activity", on: boolean) => post("/settings", { name, on }),
    pin: (grantId: string, target: FocusTarget) => post<{ ok: boolean; error?: string }>("/pin", { grant_id: grantId, target }),
    unpin: (grantId: string) => post("/unpin", { grant_id: grantId }),
    /** Revoke from the app (APC 0.2): the agent's grant goes at once, whichever way it came. */
    revoke: (grantId: string) => post<{ ok: boolean; error?: string }>(`/grants/${grantId}/revoke`, {}),
    /** apc_link (APC 0.4): show a linked agent as two again; both grants stay. */
    unlink: (grantId: string) => post<{ ok: boolean }>(`/grants/${grantId}/unlink`, {}),
    addRestricted: (region: Region) => post<GrantState & { ok?: boolean; error?: string }>("/grants/restricted", { region }),
    addAgent: () => post<GrantState & { ok?: boolean; error?: string }>("/grants/agent", {}),
    reset: () => post<{ ok: boolean }>("/reset", {}),
    resolveConflict: (grantId: string, action: "split" | "adopt") => post<{ ok: boolean; grant?: GrantState }>(`/grants/${grantId}/conflict`, { action }),
    /** A dock agent's drop (TIN-382). Without `consent` the server pairs only an agent it holds a grant for; otherwise it answers consent_required with the nonce the consent sends back (TIN-606). */
    hubPair: (body: { hub: string; agent: string; ticket: string; region: Region | null; target: FocusTarget; consent?: string }) => post<{ ok: boolean; error?: string; grant_id?: string; status?: string; consent?: string }>("/hub/pair", body),
    tour: (action: "ack" | "skip" | "done") => post<{ ok: boolean }>("/tour", { action }),
    rename: (grantId: string, name: string) => post<{ ok: boolean }>(`/grants/${grantId}/name`, { name }),
    compat: () => call<CompatRow[]>(`${base}/compat.json`),
    eventsUrl: `${base}/events.jsonl`,
    connect(onMessage: (message: ServerMessage) => void): () => void {
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      // Reconnect with backoff (2 s doubling to 60 s), so an expired sandbox is not hammered.
      let delay = 2000;
      const open = () => {
        socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
        socket.onopen = () => {
          delay = 2000;
          // The heartbeat: the sandbox counts this page as open only while its pings are answered.
          const ws = socket;
          ws?.send("ping");
          heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), HEARTBEAT_MS);
        };
        socket.onmessage = (event) => {
          if (event.data === "pong") return;
          onMessage(JSON.parse(String(event.data)) as ServerMessage);
        };
        socket.onclose = () => {
          clearInterval(heartbeat);
          if (closed) return;
          setTimeout(open, delay);
          delay = Math.min(60_000, delay * 2);
        };
      };
      open();
      return () => {
        closed = true;
        clearInterval(heartbeat);
        socket?.close();
      };
    },
  };
}
export type Api = ReturnType<typeof createApi>;

export { openSession } from "./session.ts";

export function mcpUrl(sid: string, grant: GrantState): string {
  return `${location.origin}/mcp/${sid}/${grant.secret}`;
}
