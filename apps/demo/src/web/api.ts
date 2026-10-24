import type { FocusRow, FocusTarget, PresenceEvent } from "@apc/protocol";
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
  client_title: string | null;
  agent_name: string | null;
  owner_name: string | null;
  regions: Region[] | null;
  created_at: string;
  last_active_at: string | null;
  pin: FocusRow | null;
}

export interface SandboxState {
  seed: number;
  settings: { share_view: boolean; show_activity: boolean };
  grants: GrantState[];
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
    addRestricted: (region: Region) => post<GrantState>("/grants/restricted", { region }),
    addAgent: () => post<GrantState>("/grants/agent", {}),
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

/** Resume or open the visitor's sandbox. Opening one is retried: a new sandbox can fail to start once. */
export async function openSession(): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { sid } = await call<{ sid: string }>("/api/session", { method: "POST", body: "{}" });
      return sid;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

export function mcpUrl(sid: string, grant: GrantState): string {
  return `${location.origin}/mcp/${sid}/${grant.secret}`;
}
