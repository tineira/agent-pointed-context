import type { FocusRow, FocusTarget, PresenceEvent } from "@apc/protocol";
import type { Dataset, Region } from "../model/seed.ts";

export interface GrantState {
  id: string;
  secret: string;
  label: string;
  client_name: string | null;
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
  | { type: "grants" };

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
    data: () => call<Dataset>(`${base}/data`),
    reportView: (view: unknown) => post<{ ok: boolean }>("/view", view),
    setting: (name: "share_view" | "show_activity", on: boolean) => post("/settings", { name, on }),
    pin: (grantId: string, target: FocusTarget) => post<{ ok: boolean; error?: string }>("/pin", { grant_id: grantId, target }),
    unpin: (grantId: string) => post("/unpin", { grant_id: grantId }),
    addRestricted: (region: Region) => post<GrantState>("/grants/restricted", { region }),
    eventsUrl: `${base}/events.jsonl`,
    connect(onMessage: (message: ServerMessage) => void): () => void {
      let socket: WebSocket | null = null;
      let closed = false;
      const open = () => {
        socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
        socket.onmessage = (event) => onMessage(JSON.parse(String(event.data)) as ServerMessage);
        socket.onclose = () => {
          if (!closed) setTimeout(open, 2000);
        };
      };
      open();
      return () => {
        closed = true;
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
