/**
 * The hero view's own API (TIN-1070): only what the hero may do with its sandbox. It reads the state, makes its one
 * agent (POST /grants/agent), pins and unpins that agent, says what it shows (POST /view), and listens on the
 * sandbox's WebSocket. Nothing else of Pulse's API is in this bundle (the build checks it: capability.ts), so a frame
 * on another site cannot reach Revoke, Start over, Allow, Wake or Settings through it.
 */
import type { FocusTarget } from "@tineira/apc-protocol";
import { HEARTBEAT_MS } from "../../worker/page.ts";
import type { GrantState, SandboxState, ServerMessage } from "../api.ts";

export type { GrantState, SandboxState, ServerMessage };

/** An answer as the hero reads it: the HTTP status and the JSON body, if any. */
export interface Answer<T> {
  status: number;
  json: T | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const json = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, json };
}

export function createEmbedApi(sid: string) {
  const base = `/api/s/${sid}`;
  const post = <T>(path: string, body: unknown) => call<T>(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  return {
    async state(): Promise<SandboxState> {
      const answer = await call<SandboxState>(`${base}/state`);
      if (answer.status !== 200 || !answer.json) throw Object.assign(new Error(`state: ${answer.status}`), { status: answer.status });
      return answer.json;
    },
    /**
     * The hero's agent (its own grant), idempotent: the sandbox makes it on the first call and returns it on every later
     * one. 200 with the grant and `made`, 400 `too_many` at the cap, 429 rate limited.
     */
    embedAgent: () => post<GrantState & { made?: boolean; ok?: boolean; error?: string }>("/grants/embed", {}),
    reportView: (view: unknown) => post<{ ok: boolean }>("/view", view),
    pin: (grantId: string, target: FocusTarget) => post<{ ok: boolean; error?: string }>("/pin", { grant_id: grantId, target }),
    unpin: (grantId: string) => post<{ ok: boolean }>("/unpin", { grant_id: grantId }),
    /**
     * The sandbox's messages (presence, pins, grants), with the page's heartbeat; reconnects with backoff, as Pulse does.
     * `onLink` runs on every open (the first and each reconnect) and on every close: what changed while the socket was
     * down (a revoke, the agent's initialize, the sandbox ending) is not replayed, so the page reads the state again.
     */
    connect(onMessage: (message: ServerMessage) => void, onLink?: () => void): () => void {
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let delay = 2000;
      const open = () => {
        socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
        socket.onopen = () => {
          delay = 2000;
          const ws = socket;
          ws?.send("ping");
          heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), HEARTBEAT_MS);
          onLink?.();
        };
        socket.onmessage = (event) => {
          if (event.data === "pong") return;
          try {
            onMessage(JSON.parse(String(event.data)) as ServerMessage);
          } catch {
            // a message the hero cannot read is skipped
          }
        };
        socket.onclose = () => {
          clearInterval(heartbeat);
          if (closed) return;
          // Closed: the sandbox may have ended (its handshake then fails too), so the page reads the state again.
          onLink?.();
          retry = setTimeout(open, delay);
          delay = Math.min(60_000, delay * 2);
        };
      };
      open();
      return () => {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(retry);
        socket?.close();
      };
    },
  };
}
export type EmbedApi = ReturnType<typeof createEmbedApi>;

/** The view the hero reports on a pin (the sandbox sets the same when it makes the hero's agent), so get_current_view names a screen. */
export const EMBED_VIEW = { screen: "overview", params: {}, selection: null } as const;
