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
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { askYourAgentPrompt } from "../../../demo/src/web/qr.tsx";
import { APPS, appUrl, ConnectAgent, Install, Setup } from "./setup.tsx";

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
  badge: string | null;
  mcp_url: string;
  last_active_at: string | null;
  waiting: boolean;
  focus: { app: AppRef; label: string; pinned_at: string; seen: boolean } | null;
  pairings: Array<{ id: string; app: AppRef; status: "pending" | "paired"; created_at: string; page_open: boolean | null; error: string | null }>;
  compat: { listed_after_pairing: boolean; listed_at: string | null; prefixed_calls: number; relay_calls: number; waits: number };
}
interface DockState {
  seed: number;
  setup_done: boolean;
  expires_at: string;
  agents: DockAgent[];
}

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

/**
 * Draw an agent's icon (an <svg> or an <img> from AgentIcon) as a 64 px PNG data URI: the agent's
 * mark that apps show on its pins (TIN-388). Full size on a transparent background, no frame
 * (TIN-389); a monochrome mark is inked mid grey, so it reads on light and dark pages.
 */
async function badgeOf(icon: Element): Promise<string | null> {
  let src: string;
  if (icon instanceof HTMLImageElement) src = icon.src;
  else if (icon instanceof SVGSVGElement) {
    const clone = icon.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "64");
    clone.setAttribute("height", "64");
    clone.removeAttribute("class");
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone).replaceAll("currentColor", "#8b95a1"))}`;
  } else return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    canvas.getContext("2d")!.drawImage(img, 0, 0, 64, 64);
    const png = canvas.toDataURL("image/png");
    return png.length <= 16_384 ? png : null;
  } catch {
    return null;
  }
}

export function HubDock() {
  const [did, setDid] = useState<string | null>(null);
  const [state, setState] = useState<DockState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  // The first run or Change world (TIN-403, TIN-406). It stays open until the person is done, though
  // the hub marks the first run over as soon as the world is chosen.
  const [wizard, setWizard] = useState<"first" | "world" | null>(null);
  const setupDone = state?.setup_done;
  useEffect(() => {
    if (setupDone === false) setWizard((w) => w ?? "first");
  }, [setupDone]);
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
  // The agent's mark for the apps (TIN-388): its logo as drawn here, as a 64 px PNG, given to the hub.
  const drawn = useRef(new Map<string, string>());
  const marks = state?.agents.map((a) => `${a.id}:${a.client_name ?? ""}:${a.client_ua ?? ""}:${a.client_icon?.length ?? 0}`).join("|") ?? "";
  useEffect(() => {
    if (!base || !state) return;
    for (const a of state.agents) {
      if (!a.client_name) continue;
      const icon = document.querySelector(`[data-badge-source="${a.id}"] > *`);
      if (!icon) continue;
      void badgeOf(icon).then((badge) => {
        if (!badge || badge === a.badge || drawn.current.get(a.id) === badge) return;
        drawn.current.set(a.id, badge);
        void call(`${base}/agents/${a.id}/badge`, { badge });
      });
    }
  }, [base, marks]);

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
  const dragProps = (a: DockAgent) => ({
    draggable: true,
    title: a.client_name ? `Drag ${a.name} onto anything in an APC app to point it there (or to pair it with that app)` : `Drag ${a.name} into your agent's chat: it pastes the prompt that connects it`,
    onDragStart: (e: React.DragEvent<HTMLElement>) => startDrag(e.nativeEvent, a.id),
    onDragEnd: () => endDrag(a.id),
  });
  function startDrag(e: DragEvent, agentId: string) {
    // Not connected yet (TIN-408): the drag is the connect prompt, to drop into the agent's chat. It
    // carries the agent's MCP URL, so only until the agent connects; then it is the APC payload,
    // which never carries a URL. (A demo choice: with OAuth the prompt would hold no secret.)
    const agent = state?.agents.find((a) => a.id === agentId);
    if (agent && !agent.client_name) {
      e.dataTransfer?.setData("text/plain", askYourAgentPrompt(agent.mcp_url, "APC"));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      setDragging(agentId);
      return;
    }
    const t = tickets.current.get(agentId);
    const fresh = t && t.expires_at - Date.now() > 3_000 ? { hub: location.origin, ticket: t.ticket } : undefined;
    e.dataTransfer?.setData(APC_AGENT_TYPE, agentDragPayload(agentId, fresh));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "link";
    const chip = (e.currentTarget as HTMLElement | null)?.querySelector(".chip");
    if (chip && e.dataTransfer) e.dataTransfer.setDragImage(chip, 32, 32);
    setDragging(agentId);
  }
  function endDrag(agentId: string) {
    setDragging(null);
    // A ticket is single use: the app may have spent it.
    tickets.current.delete(agentId);
    void fetchTicket(agentId);
  }

  const requests = pending.map(({ agent, pairing }) => (
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
    ));

  // The first run, or Change world (TIN-403): the dock shows only that, and any pairing request.
  if (wizard || !state.setup_done) {
    return (
      <main className="dock">
        <Header />
        <BadgeSources agents={state.agents} />
        {requests}
        <Setup
          agent={state.agents[0]}
          seed={state.seed}
          {...(wizard === "world" ? { only: "world" as const } : {})}
          onWorld={async (seed) => {
            await call(`${base}/world`, { seed });
            refresh();
          }}
          onDone={() => setWizard(null)}
        />
      </main>
    );
  }

  return (
    <main className="dock">
      <Header />
      <BadgeSources agents={state.agents} />
      {requests}
      <ul className="tiles">
        {state.agents.map((a) => {
          const connected = !!a.client_name;
          const paired = a.pairings.filter((p) => p.status === "paired");
          return (
            <li key={a.id} className={`tile${dragging === a.id ? " dragging" : ""}`}>
              <div className="tile-drag" {...dragProps(a)}>
                <span className="chip">
                  <AgentIcon clientName={a.client_name} clientUa={a.client_ua} clientIcon={a.client_icon} motion={!connected ? "off" : a.waiting ? "waiting" : "idle"} size={64} />
                </span>
                <span className="tile-name">{a.name}</span>
                <span className="tile-where">
                  {a.focus ? (
                    <>
                      → {a.focus.app.name}: {a.focus.label} · {a.focus.seen ? <span className="read">read ✓</span> : "not read yet"}
                    </>
                  ) : !connected ? (
                    "not connected yet: drag me into your agent's chat"
                  ) : a.waiting ? (
                    "waiting for you to point"
                  ) : paired.length ? (
                    "not pointed at anything"
                  ) : (
                    "drag me onto an app to pair"
                  )}
                </span>
              </div>
              <details className="tile-details" open={!connected || undefined}>
                <summary>{connected ? "Details" : "Connect this agent"}</summary>
                <ConnectAgent agent={a} />
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
                {a.focus && (
                  <div className="row small">
                    <button type="button" onClick={() => void call(`${base}/agents/${a.id}/clear`, {}).then(refresh)}>
                      Clear pointer
                    </button>
                  </div>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      <nav className="launch" aria-label="Apps">
        {APPS.map((app) => (
          <a
            key={app.name}
            className="launch-app"
            href={appUrl(app, state.seed)}
            target="_blank"
            rel="noreferrer"
            title={`Open ${app.name} on this dock's world`}
          >
            <span className="launch-icon" aria-hidden="true">
              {app.glyph}
            </span>
            {app.name}
          </a>
        ))}
      </nav>
      <div className="row small footer">
        <button type="button" onClick={() => void call(`${base}/agents`, {}).then(refresh)}>
          Add an agent
        </button>
        <Float agents={state.agents} dragProps={(a) => ({ startDrag: (e) => startDrag(e, a.id), endDrag: () => endDrag(a.id) })} />
        <button type="button" title={`World ${state.seed}: the seed every app opens on`} onClick={() => setWizard("world")}>
          Change world
        </button>
        <Install />
      </div>
    </main>
  );
}

/**
 * Float (TIN-392): an installed web app cannot stay on top of other windows; a Document
 * Picture-in-Picture window can. It holds only the agents' logos, each draggable like in the dock.
 * Shown where the browser has the API (Chrome and Edge on desktop).
 */
function Float(props: { agents: DockAgent[]; dragProps: (a: DockAgent) => { startDrag: (e: DragEvent) => void; endDrag: () => void } }) {
  const pip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
  const [win, setWin] = useState<Window | null>(null);
  const root = useRef<Root | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!win) return;
    root.current ??= createRoot(win.document.body);
    root.current.render(
      <div className="float">
        {props.agents.map((a) => {
          const d = latest.current.dragProps(a);
          return (
            <div key={a.id} className="float-agent" draggable title={`Drag ${a.name} onto an app`} onDragStart={(e) => d.startDrag(e.nativeEvent)} onDragEnd={d.endDrag}>
              <span className="chip">
                <AgentIcon clientName={a.client_name} clientUa={a.client_ua} clientIcon={a.client_icon} motion={!a.client_name ? "off" : a.waiting ? "waiting" : "idle"} size={48} />
              </span>
            </div>
          );
        })}
      </div>,
    );
  }, [win, props.agents]);
  if (!pip) return null;
  return (
    <button
      type="button"
      title="Keep your agents on top of every window, ready to drag"
      onClick={async () => {
        if (win) return win.focus();
        const w = await pip.requestWindow({ width: 96 * Math.max(1, Math.min(3, props.agents.length)), height: 110 });
        for (const sheet of [...document.styleSheets]) {
          try {
            const style = w.document.createElement("style");
            style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
            w.document.head.append(style);
          } catch {
            // a sheet from another origin: skipped
          }
        }
        w.addEventListener("pagehide", () => {
          root.current?.unmount();
          root.current = null;
          setWin(null);
        });
        setWin(w);
      }}
    >
      {win ? "Floating" : "Float"}
    </button>
  );
}

/**
 * Each connected agent's icon, hidden: what the dock draws the agent's mark from (TIN-388), whatever
 * it shows. The first run shows no tiles, and an app paired during it needs the mark too (TIN-409).
 */
function BadgeSources(props: { agents: DockAgent[] }) {
  return (
    <div hidden aria-hidden="true">
      {props.agents
        .filter((a) => a.client_name)
        .map((a) => (
          <span key={a.id} data-badge-source={a.id}>
            <AgentIcon clientName={a.client_name} clientUa={a.client_ua} clientIcon={a.client_icon} size={64} />
          </span>
        ))}
    </div>
  );
}

function Header() {
  return (
    <header className="dock-head">
      <h1>Agent dock</h1>
      <span className="kicker">APC v2</span>
    </header>
  );
}
