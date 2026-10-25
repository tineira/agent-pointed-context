/**
 * The agent dock with its attention hub (TIN-382). The person's agents connect once, to the dock's
 * MCP URL. Dragging one onto an APC app (Pulse under APC v2) pairs them after a yes on the app's
 * page and a yes here; from then on the agent follows the person's pointer across every paired app.
 *
 * Each agent's drag carries its public handle, this hub's origin and a single-use ticket (60 s),
 * never a URL or a grant. The dock keeps a fresh ticket per agent so the drag can start at once.
 */
import { APC_AGENT_TYPE, agentDragPayload } from "@apc/web";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";

interface AppRef {
  id: string;
  name: string;
  origin: string;
}
interface DockAgent {
  id: string;
  label: string;
  name: string;
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
  mcp_url: string;
  last_active_at: string | null;
  waiting: boolean;
  focus: { app: AppRef; label: string; pinned_at: string; seen: boolean } | null;
  pairings: Array<{ id: string; app: AppRef; status: "pending" | "paired"; created_at: string; page_open: boolean | null; error: string | null }>;
  compat: { listed_after_pairing: boolean; listed_at: string | null; prefixed_calls: number; relay_calls: number; waits: number };
}
interface DockState {
  expires_at: string;
  agents: DockAgent[];
}

const PULSE_URL = import.meta.env.DEV ? "http://localhost:5199/overview" : "https://pulse.v2.apc.tineira.com/overview";
const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok && response.status !== 400) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export function HubDock() {
  const [did, setDid] = useState<string | null>(null);
  const [state, setState] = useState<DockState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const tickets = useRef(new Map<string, { ticket: string; expires_at: number }>());

  useEffect(() => {
    call<{ did: string }>("/api/dock", {}).then((r) => setDid(r.did), (e: unknown) => setError(String(e)));
  }, []);
  const base = did ? `/api/d/${did}` : null;
  const refresh = useCallback(() => {
    if (base) call<DockState>(`${base}/state`).then(setState, (e: unknown) => setError(String(e)));
  }, [base]);

  // Live: the hub says "state" on every change; the page pings so the hub knows the dock is open.
  useEffect(() => {
    if (!base) return;
    refresh();
    let ws: WebSocket | null = null;
    let closed = false;
    let ping = 0;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
      ws.onmessage = (e) => e.data !== "pong" && refresh();
      ws.onclose = () => !closed && setTimeout(open, 2000);
    };
    open();
    ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, [base, refresh]);

  // A fresh ticket per agent, so a drag can start at once (dragstart cannot wait for the network).
  const fetchTicket = useCallback(
    async (agentId: string) => {
      if (!base) return;
      try {
        const t = await call<{ ticket: string; expires_at: number }>(`${base}/agents/${agentId}/ticket`, {});
        if (t.ticket) tickets.current.set(agentId, t);
      } catch {
        tickets.current.delete(agentId);
      }
    },
    [base],
  );
  const ids = state?.agents.map((a) => a.id).join(",") ?? "";
  useEffect(() => {
    if (!ids) return;
    const top = () => {
      for (const id of ids.split(",")) {
        const t = tickets.current.get(id);
        if (!t || t.expires_at - Date.now() < 20_000) void fetchTicket(id);
      }
    };
    top();
    const id = setInterval(top, 10_000);
    return () => clearInterval(id);
  }, [ids, fetchTicket]);

  if (error) return <main><Header /><p>Could not open your dock: {error}</p></main>;
  if (!state || !base) return <main><Header /><p>Opening your dock…</p></main>;

  const pending = state.agents.flatMap((a) => a.pairings.filter((p) => p.status === "pending").map((p) => ({ agent: a, pairing: p })));
  const decide = (pid: string, action: "approve" | "deny" | "unpair") => void call(`${base}/pairings/${pid}`, { action }).then(refresh);

  return (
    <main>
      <Header />
      {pending.map(({ agent, pairing }) => (
        <section key={pairing.id} className="request">
          <p>
            <b>{pairing.app.name}</b> at <b>{host(pairing.app.origin)}</b> wants to be read by <b>{agent.name}</b>. Its tools and data come from {pairing.app.origin}.
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => decide(pairing.id, "approve")}>
              Allow
            </button>
            <button type="button" onClick={() => decide(pairing.id, "deny")}>
              Deny
            </button>
          </div>
        </section>
      ))}
      <ul className="agents">
        {state.agents.map((a) => {
          const connected = !!a.client_name;
          const paired = a.pairings.filter((p) => p.status === "paired");
          return (
            <li key={a.id} className="agent-block">
              <div
                className={`agent${dragging === a.id ? " dragging" : ""}`}
                draggable
                title={`Drag ${a.name} onto anything in an APC app to point it there (or to pair it with that app)`}
                onDragStart={(e) => {
                  const t = tickets.current.get(a.id);
                  const fresh = t && t.expires_at - Date.now() > 3_000 ? { hub: location.origin, ticket: t.ticket } : undefined;
                  e.dataTransfer.setData(APC_AGENT_TYPE, agentDragPayload(a.id, fresh));
                  e.dataTransfer.effectAllowed = "link";
                  const chip = e.currentTarget.querySelector(".chip");
                  if (chip) e.dataTransfer.setDragImage(chip, 20, 20);
                  setDragging(a.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  // A ticket is single use: the app may have spent it.
                  tickets.current.delete(a.id);
                  void fetchTicket(a.id);
                }}
              >
                <span className="chip">
                  <AgentIcon clientName={a.client_name} clientUa={a.client_ua} clientIcon={a.client_icon} motion={!connected ? "off" : a.waiting ? "waiting" : "idle"} size={24} />
                </span>
                <span className="who">
                  <div className="name">{a.name}</div>
                  <div className="where">
                    {a.focus ? (
                      <>
                        → {a.focus.app.name}: {a.focus.label} · {a.focus.seen ? <span className="read">read ✓</span> : "not read yet"}
                      </>
                    ) : !connected ? (
                      "not connected yet"
                    ) : paired.length ? (
                      "not pointed at anything"
                    ) : (
                      "drag it onto an app to pair"
                    )}
                  </div>
                </span>
              </div>
              {(!connected || shown.has(a.id)) && (
                <div className="connect">
                  <p>Add this URL to your agent as a remote MCP server. It is this agent's key: keep it to yourself.</p>
                  <div className="row">
                    <code className="url">{a.mcp_url}</code>
                    <button type="button" onClick={() => void navigator.clipboard?.writeText(a.mcp_url)}>
                      Copy
                    </button>
                  </div>
                </div>
              )}
              {paired.length > 0 && (
                <ul className="apps">
                  {paired.map((p) => (
                    <li key={p.id}>
                      <span>
                        {p.app.name} <span className="muted">· {host(p.app.origin)}</span>
                        {p.error && <span className="warn"> · not answering</span>}
                      </span>
                      <button type="button" onClick={() => decide(p.id, "unpair")}>
                        Unpair
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {connected && paired.length > 0 && (
                <p className="compat" title="What this agent's client does with the dock, for the compatibility matrix (TIN-384)">
                  Tools re-listed after pairing: {a.compat.listed_after_pairing ? "yes" : "not yet"} · prefixed calls {a.compat.prefixed_calls} · call_app_tool {a.compat.relay_calls} · waits {a.compat.waits}
                </p>
              )}
              <div className="row small">
                {a.focus && (
                  <button type="button" onClick={() => void call(`${base}/agents/${a.id}/clear`, {}).then(refresh)}>
                    Clear pointer
                  </button>
                )}
                {connected && (
                  <button type="button" onClick={() => setShown((s) => new Set(s.has(a.id) ? [...s].filter((x) => x !== a.id) : [...s, a.id]))}>
                    {shown.has(a.id) ? "Hide connection" : "Show connection"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <button type="button" onClick={() => void call(`${base}/agents`, {}).then(refresh)}>
          Add an agent
        </button>
      </div>
      <p className="status">
        Drag an agent onto a bar, a row or a card in <a href={PULSE_URL} target="_blank" rel="noreferrer">Pulse (APC v2)</a>. The first time, Pulse asks you, then this dock does. Your agent connects only here.
      </p>
    </main>
  );
}

function Header() {
  return (
    <div>
      <div className="kicker">APC v2 · prototype</div>
      <h1>Agent dock</h1>
    </div>
  );
}
