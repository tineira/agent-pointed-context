/**
 * The agent dock with its attention hub (TIN-382). The person's agents connect once, to the dock's
 * MCP URL. Dragging one onto an APC app (Pulse) pairs them after a yes on the app's
 * page and a yes here; from then on the agent follows the person's pointer across every paired app.
 *
 * Each agent's drag carries its public handle, this hub's origin and a single-use ticket (60 s),
 * never a URL or a grant. The dock keeps a fresh ticket per agent so the drag can start at once.
 */
import { APC_AGENT_TYPE, agentDragPayload } from "@tineira/apc-web";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { askYourAgentPrompt } from "../../../demo/src/web/qr.tsx";
import { StartOver } from "../../../demo/src/web/start-over.tsx";
import { AgentPet } from "./apc-pet.tsx";
import { AgentPage, call, host, RemoveAgent, type DockAgent, type DockState } from "./agent-page.tsx";
import { READER_NOTICE } from "../worker/reading.ts";
import { cardOuterSize, FLOAT_START, fitsCard, floatSizeReducer } from "./float-size.ts";
import { PET, PET_AGENT, petApp, PetHint, PetView, PetWaiting } from "./pet.tsx";
import { ConnectAgent, DESKTOP_SHELL, DESKTOP_SHORTCUT, Install, Setup } from "./setup.tsx";
import { Downloads } from "./downloads.tsx";
import { DecisionNotice, NotVerified, UnverifiedRequest } from "./unverified.tsx";
import { buttonsOff, decisionNotice, inFlightOf, kindOf, landed, mayAnswer, sentOut, type InFlight, type Sent } from "./request-state.ts";

/** What the dock's Start over deletes (TIN-411). */
const DOCK_WIPES = ["your agents and their MCP URLs", "their pairings with apps (each app gets its grant back)", "where your agents point"];

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

/** The desktop dock's always-on-top strip (#84): only what Float shows. Its builds since the pets (TIN-479, pet.tsx) open no strip; older ones still do. */
const STRIP = new URLSearchParams(location.search).get("view") === "strip";
if (STRIP) document.body.classList.add("float-body");
/** A window of the desktop dock other than the dock itself: the strip, or a pet. It only resumes the dock, and has no one to read an error. */
const FLOATING = STRIP || PET;

/**
 * A fetch that never reached the server ("TypeError: Failed to fetch"): the network is not back yet,
 * as when the computer wakes from sleep with the dock open. The dock window then tries again too.
 */
const unreachable = (e: unknown) => e instanceof TypeError;

/** An agent's page (TIN-419): /dock/agents/<id>. */
const agentRoute = (path: string) => path.match(/^\/dock\/agents\/(ag_[0-9a-f]+)\/?$/)?.[1] ?? null;

export function HubDock() {
  // The dock's own address: the list at /dock, an agent's page at /dock/agents/<id>; Back works.
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  // Whether this page pushed the agent's page, so ← Dock can be the browser's Back.
  const pushed = useRef(false);
  const go = useCallback((to: string, replace = false) => {
    if (location.pathname !== to) {
      if (replace) history.replaceState(null, "", to);
      else history.pushState(null, "", to);
    }
    pushed.current = !replace && to !== "/dock";
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  const [did, setDid] = useState<string | null>(null);
  const [state, setState] = useState<DockState | null>(null);
  // A new object on each failure, so a failed retry sets up the next one.
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Answers on their way per request (Review round 1 and Fix check 2 on #120): which buttons are off until they land, on every surface. */
  const [deciding, setDeciding] = useState<Sent>(new Map());
  /** What the hub said when it refused the last answer (Fix check 4 on #120), shown on every surface of this page. */
  const [notice, setNotice] = useState<string | null>(null);
  // It stays a while, then goes by itself; the person can close it sooner.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 15_000);
    return () => clearTimeout(id);
  }, [notice]);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const tickets = useRef(new Map<string, { ticket: string; expires_at: number }>());

  // Bumped when the desktop app's dock is gone (Start over, or 6 h idle), to open the dock again.
  const [reopen, setReopen] = useState(0);
  useEffect(() => {
    // The strip and the pets only resume the dock its window opened, and wait for it on a first run (#84).
    let retry = 0;
    const open = () =>
      call<{ did: string }>("/api/dock", FLOATING ? { resume: true } : {}).then(
        (r) => setDid(r.did),
        (e: unknown) => (FLOATING ? (retry = window.setTimeout(open, 2000)) : setError({ message: String(e), retry: unreachable(e) })),
      );
    void open();
    return () => clearTimeout(retry);
  }, [reopen]);
  const base = did ? `/api/d/${did}` : null;
  const refresh = useCallback(() => {
    if (!base) return;
    call<DockState>(`${base}/state`).then((s) => {
      setState(s);
      setError(null);
    }, (e: unknown) => {
      // The desktop app stays open for days, so its windows open the dock again when it is gone (403
      // without the cookie, 404 once expired): the strip and the pets wait for the dock window's new one.
      if ((FLOATING || DESKTOP_SHELL) && /: 40[34]$/.test(String(e))) {
        setDid(null);
        setState(null);
        setReopen((n) => n + 1);
      } else setError({ message: String(e), retry: FLOATING || unreachable(e) });
    });
  }, [base]);
  const keptAtHand = useCallback(() => {
    if (base) void call(`${base}/kept`, {}).then(refresh).catch(() => undefined);
  }, [base, refresh]);
  useEffect(() => {
    if (!base || state?.onboarding.kept) return;
    const installed = () => keptAtHand();
    if (DESKTOP_SHELL || window.matchMedia("(display-mode: standalone)").matches) installed();
    window.addEventListener("appinstalled", installed);
    return () => window.removeEventListener("appinstalled", installed);
  }, [base, state?.onboarding.kept, keptAtHand]);

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
      // The hub closes the socket when the dock goes (Start over, expiry): reading the state again then
      // shows it, which the desktop app's windows need to open the dock again.
      ws.onclose = () => {
        if (closed) return;
        refresh();
        setTimeout(open, 2000);
      };
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
  // A pet drags only its own agent, so it keeps only that agent's ticket.
  const ticketed = PET ? ids.split(",").filter((id) => id === PET_AGENT).join(",") : ids;
  useEffect(() => {
    if (!ticketed) return;
    const top = () => {
      for (const id of ticketed.split(",")) {
        const t = tickets.current.get(id);
        if (!t || t.expires_at - Date.now() < 20_000) void fetchTicket(id);
      }
    };
    top();
    const id = setInterval(top, 10_000);
    return () => clearInterval(id);
  }, [ticketed, fetchTicket]);

  // The pets tell the app the dock's agents on every change, so a pet comes and goes with each (TIN-479).
  const agentList = state ? ids : null;
  useEffect(() => {
    if (PET && agentList !== null) petApp.agents(agentList ? agentList.split(",") : []);
  }, [agentList]);

  // The strip and the pets have no one to read an error, and no window can reach the dock while the
  // network is down: they say so (in a line, in a title) and try again, at once when the network is
  // back. The error stays until a try succeeds.
  useEffect(() => {
    if (!error?.retry) return;
    const again = () => (base ? refresh() : setReopen((n) => n + 1));
    const id = setTimeout(again, 3000);
    window.addEventListener("online", again);
    return () => {
      clearTimeout(id);
      window.removeEventListener("online", again);
    };
  }, [error, base, refresh]);

  const unreached = "Could not reach your dock. Trying again…";
  if (error) return PET ? <PetWaiting note={unreached} /> : STRIP ? <div className="float float-empty">{unreached}</div> : <main><Header /><p>{error.retry ? unreached : `Could not open your dock: ${error.message}`}</p></main>;
  if (!state || !base) return PET ? <PetWaiting note="Opening your dock…" /> : STRIP ? <div className="float float-empty">Opening your dock…</div> : <main><Header /><p>Opening your dock…</p></main>;

  const pending = state.agents.flatMap((a) => a.pairings.filter((p) => p.status === "pending").map((p) => ({ agent: a, pairing: p })));
  const decide = (pid: string, action: Decision) => {
    // Never the same kind twice, and no yes once anything is on its way; a Deny still goes while an Approve is
    // on its way, from this surface too, so a misclick can be undone (Fix check 2 on #120). The hub lets it win.
    const kind = kindOf(action);
    const approving = pending.some((x) => x.pairing.id === pid && x.pairing.approving);
    if (!mayAnswer(action, { inFlight: inFlightOf(deciding.get(pid)), approving })) return;
    setDeciding((m) => sentOut(m, pid, kind));
    setNotice(null);
    void call<{ ok?: boolean; error?: unknown }>(`${base}/pairings/${pid}`, { action })
      // A refusal (400 with { ok: false, error }) is said, never dropped (Fix check 4 on #120); so is a call that failed.
      .then((r) => {
        if (r?.ok === false) setNotice(decisionNotice(r.error));
      })
      .catch(() => setNotice(decisionNotice("unreachable")))
      .finally(() => {
        // Answered or failed: that kind clears, and only it (a failed Deny can be sent again).
        setDeciding((m) => landed(m, pid, kind));
        refresh();
      });
  };
  /** What is on its way for a request: Approve off while a yes is, both off while a Deny is (request-state.ts). */
  const inFlight = (p: { id: string }) => inFlightOf(deciding.get(p.id));
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
    // The drag image is the character itself (not the whole tile), held where the person grabbed it.
    const pet = (e.currentTarget as HTMLElement | null)?.querySelector(".apc-pet");
    if (pet && e.dataTransfer) {
      const r = pet.getBoundingClientRect();
      e.dataTransfer.setDragImage(pet, Math.min(Math.max(e.clientX - r.left, 0), r.width), Math.min(Math.max(e.clientY - r.top, 0), r.height));
    }
    setDragging(agentId);
  }
  function endDrag(agentId: string) {
    setDragging(null);
    // A ticket is single use: the app may have spent it.
    tickets.current.delete(agentId);
    void fetchTicket(agentId);
  }

  const requests = pending.map(({ agent, pairing }) =>
    pairing.app.unverified ? (
      // An app outside APP_ORIGINS (TIN-581): the warning, in the dock, the first time its domain asks here.
      <section key={pairing.id} className="request unverified">
        <UnverifiedRequest domain={host(pairing.app.origin)} declared={pairing.app.declared_name ?? null} agent={agent.name} warning={!!pairing.warning} inFlight={inFlight(pairing)} approving={!!pairing.approving} decide={(action) => decide(pairing.id, action)} />
      </section>
    ) : (
    <section key={pairing.id} className="request">
      <p>
        {pairing.kind === "reader" ? (
          <>
            <b>{pairing.app.name}</b> wants to send <b>{agent.name}</b> page readings from the sites you allow in the <a href="/extension" target="_blank" rel="noreferrer">APC extension</a>. {READER_NOTICE}
          </>
        ) : (
          <>
            <b>{pairing.app.name}</b> at <b>{host(pairing.app.origin)}</b> wants to be read by <b>{agent.name}</b>. Its tools and data come from {pairing.app.origin}.
          </>
        )}
      </p>
      <div className="row">
        <button type="button" className="primary" disabled={buttonsOff({ inFlight: inFlight(pairing), approving: pairing.approving }).approve} onClick={() => decide(pairing.id, "approve")}>
          Allow
        </button>
        <button type="button" disabled={buttonsOff({ inFlight: inFlight(pairing) }).deny} onClick={() => decide(pairing.id, "deny")}>
          Deny
        </button>
      </div>
    </section>
    ),
  );

  const floatRequests: FloatRequest[] = pending.map(({ agent, pairing }) => ({
    id: pairing.id,
    kind: pairing.kind,
    app: pairing.app.name,
    host: host(pairing.app.origin),
    agent: agent.name,
    agentId: agent.id,
    inFlight: inFlight(pairing),
    approving: !!pairing.approving,
    ...(pairing.app.unverified ? { unverified: { declared: pairing.app.declared_name ?? null, warning: !!pairing.warning } } : {}),
  }));
  const floatDrag = (a: DockAgent) => ({ startDrag: (e: DragEvent) => startDrag(e, a.id), endDrag: () => endDrag(a.id) });
  // The hub's refusal of the last answer, on whichever surface this page is (Fix check 4 on #120).
  const noticeEl = notice ? <DecisionNotice notice={notice} dismiss={() => setNotice(null)} /> : null;

  // The APC dock for Windows' pets (TIN-479): one agent, and its pairing requests; with no agent, the hint.
  if (PET) {
    if (!PET_AGENT) return state.agents.length ? null : <PetHint />;
    const agent = state.agents.find((a) => a.id === PET_AGENT);
    // An agent gone from the dock: the app closes its pet.
    if (!agent) return null;
    return (
      <PetView
        agent={agent}
        requests={floatRequests.filter((r) => r.agentId === agent.id)}
        decide={(id, action) => decide(id, action)}
        startDrag={(e) => startDrag(e, agent.id)}
        endDrag={() => endDrag(agent.id)}
        refusal={noticeEl}
      />
    );
  }

  // The APC dock for Windows' always-on-top strip (#84), in its builds before the pets: only what Float shows.
  if (STRIP) return <FloatAgents agents={state.agents} requests={floatRequests} decide={(id, action) => decide(id, action)} dragProps={floatDrag} refusal={noticeEl} />;

  const pageOf = agentRoute(path);
  if (pageOf) {
    const agent = state.agents.find((a) => a.id === pageOf);
    const back = () => (pushed.current ? history.back() : go("/dock", true));
    if (!agent)
      return (
        <main className="dock">
          <Header />
          <p>This agent is no longer in your dock.</p>
          <div className="row">
            <button type="button" onClick={() => go("/dock", true)}>
              ← Dock
            </button>
          </div>
        </main>
      );
    return (
      <>
        <BadgeSources agents={state.agents} />
        <AgentPage
          agent={agent}
          base={base}
          requests={agent.pairings.filter((p) => p.status === "pending").map((p) => ({ id: p.id, kind: p.kind, app: p.app, warning: p.warning, inFlight: inFlight(p), approving: !!p.approving }))}
          decide={decide}
          refresh={refresh}
          back={back}
          dragProps={dragProps(agent)}
          dragging={dragging === agent.id}
          refusal={noticeEl}
        />
      </>
    );
  }

  const renderDock = (controls: ReactNode) => (
    <main className="dock">
      <Header />
      <BadgeSources agents={state.agents} />
      {noticeEl}
      {requests}
      {state.agents.length === 0 && <p className="empty">No agents. Add one with <b>Add an agent</b> below, then connect it.</p>}
      <ul className="tiles">
        {state.agents.map((a) => {
          const connected = !!a.client_name;
          const paired = a.pairings.filter((p) => p.status === "paired");
          // Apps that revoked this agent themselves (APC 0.2), by host.
          const revokedBy = a.pairings.filter((p) => p.status === "revoked").map((p) => p.revoked_by ?? host(p.app.origin));
          return (
            <li key={a.id} className={`tile${dragging === a.id ? " dragging" : ""}`}>
              <div className="tile-drag" {...dragProps(a)}>
                {connected ? <AgentPet agent={a} size={104} dragging={dragging === a.id} decorative /> : <AgentIcon clientName={null} motion="idle" size={64} />}
                <span className="tile-name">{a.name}</span>
                <span className="tile-where">
                  {a.focus ? (
                    <>
                      → {a.focus.app.name}
                      {a.focus.app.unverified && (
                        <>
                          {" "}
                          <NotVerified />
                        </>
                      )}
                      : {a.focus.label} · {a.focus.seen ? <span className="read">read ✓</span> : "not read yet"}
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
              {connected ? (
                <a
                  className="tile-more"
                  href={`/dock/agents/${a.id}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    go(`/dock/agents/${a.id}`);
                  }}
                >
                  Details{paired.length ? ` · ${paired.length} app${paired.length === 1 ? "" : "s"}` : ""}
                  {a.calls ? ` · ${a.calls} call${a.calls === 1 ? "" : "s"}` : ""}
                  {revokedBy.length ? ` · revoked by ${revokedBy.join(", ")}` : ""} →
                </a>
              ) : (
                // Not connected yet: how to connect it stays under its tile, as in the first run.
                <details className="tile-details">
                  <summary>Connect this agent</summary>
                  <ConnectAgent agent={a} />
                  <RemoveAgent agent={a} apps={[]} remove={() => call(`${base}/agents/${a.id}/remove`, {}).then(refresh)} />
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <Setup agents={state.agents} progress={state.onboarding} keepAtHand={<div className="row">{controls}</div>} />
      <div className="row small footer">
        <button type="button" onClick={() => void call(`${base}/agents`, {}).then(refresh)}>
          Add an agent
        </button>
        {controls}
        <details className="dock-menu">
          <summary>Menu</summary>
          <StartOver site="Agent dock" className="" wipes={DOCK_WIPES} reset={() => call(`${base}/reset`, {})} />
        </details>
      </div>
      <Downloads />
    </main>
  );
  return (
    <KeepAtHand agents={state.agents} requests={floatRequests} decide={(id, action) => decide(id, action)} dragProps={floatDrag} onUsed={keptAtHand} refusal={noticeEl}>
      {renderDock}
    </KeepAtHand>
  );
}

/**
 * Float (TIN-392): an installed web app cannot stay on top of other windows; a Document
 * Picture-in-Picture window can. It holds only the agents' logos, each draggable like in the dock.
 * Shown where the browser has the API (Chrome and Edge on desktop). Opened with ?float=1 (the APC
 * extension's Float, TIN-473), the dock asks to float at once: Chrome opens the window only from a
 * click in this page, so a prompt takes that one click.
 */
interface FloatRequest {
  id: string;
  kind: "app" | "reader";
  app: string;
  host: string;
  agent: string;
  agentId: string;
  /** An app outside APP_ORIGINS (TIN-581): what it calls itself, and whether this request shows the warning. */
  unverified?: { declared: string | null; warning: boolean };
  /** What is on its way: an Approve turns Approve off, a Deny turns both off (request-state.ts). */
  inFlight?: InFlight;
  /** The hub is still introducing itself to the app: Approve is off, Deny stays on (Fix check 1 on #120). */
  approving?: boolean;
}

/** What the person answers a request with; "approve_unverified" is only the warning's Approve (TIN-581). */
type Decision = "approve" | "approve_unverified" | "deny" | "unpair";

interface FloatProps {
  agents: DockAgent[];
  onUsed: () => void;
  /** Pairing requests waiting in the dock (TIN-413): the dock's window is usually hidden while Float is on. */
  requests: FloatRequest[];
  decide: (id: string, action: Decision) => void;
  dragProps: (a: DockAgent) => { startDrag: (e: DragEvent) => void; endDrag: () => void };
  children: (button: ReactNode) => ReactNode;
  /** The hub's refusal of the last answer (Fix check 4 on #120). */
  refusal?: ReactNode;
}

/** One Float window and install event, with controls in both the checklist and permanent footer. */
function KeepAtHand(props: FloatProps) {
  if (DESKTOP_SHELL) return props.children(<span className="muted" title="The APC dock for Windows keeps your agents on top of every window">{DESKTOP_SHORTCUT} floats your agents</span>);
  return <Float {...props}>{(float) => <Install>{(install) => props.children(<>{float}{install}</>)}</Install>}</Float>;
}

function Float(props: FloatProps) {
  const pip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number; preferInitialWindowPlacement?: boolean }): Promise<Window> } }).documentPictureInPicture;
  const [win, setWin] = useState<Window | null>(null);
  const [asked, setAsked] = useState(() => new URLSearchParams(location.search).has("float"));
  const root = useRef<Root | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Chrome resizes a Picture-in-Picture window only during a user activation (TIN-480): a request
  // shows a compact notice, and the click on it (the activation) grows the window to the card.
  // float-size.ts keeps the bookkeeping: the size to give back, and the request the card was opened for.
  const [size, dispatch] = useReducer(floatSizeReducer, FLOAT_START);
  const sized = useRef(size);
  sized.current = size;
  const [inner, setInner] = useState({ width: 0, height: 0 });
  const asking = props.requests.length > 0;
  const showCard = (asking && size.opened === props.requests[0]!.id) || (!!win && fitsCard(inner));
  const outerOf = (w: Window) => ({ width: w.outerWidth, height: w.outerHeight });
  /** Try the card size; false when the browser threw (a refusal without a throw shows in the resize event). */
  function grow(): boolean {
    if (!win) return false;
    try {
      const t = cardOuterSize({ width: win.innerWidth, height: win.innerHeight }, outerOf(win));
      win.resizeTo(t.width, t.height);
      return true;
    } catch {
      return false;
    }
  }
  /** Give back the earlier size. Kept until a resize confirms it: without a click the browser refuses. */
  function shrink(): void {
    const b = sized.current.before;
    if (!win || !b) return;
    // Already there: no resize event will come to confirm it.
    if (Math.abs(win.outerWidth - b.width) <= 2 && Math.abs(win.outerHeight - b.height) <= 2) return dispatch({ type: "resize", outer: outerOf(win) });
    try {
      win.resizeTo(b.width, b.height);
    } catch {
      // resize refused
    }
  }
  useEffect(() => {
    if (!win) return;
    const measure = () => {
      setInner({ width: win.innerWidth, height: win.innerHeight });
      dispatch({ type: "resize", outer: outerOf(win) });
    };
    measure();
    win.addEventListener("resize", measure);
    return () => win.removeEventListener("resize", measure);
  }, [win]);
  // A shrink that was refused (no click) is retried on the next click or key press in the window; not on pointerdown, which would shrink it under a drag of a logo.
  useEffect(() => {
    if (!win || !size.wantShrink) return;
    const retry = () => shrink();
    win.document.addEventListener("click", retry);
    win.document.addEventListener("keyup", retry);
    return () => {
      win.document.removeEventListener("click", retry);
      win.document.removeEventListener("keyup", retry);
    };
  }, [win, size.wantShrink]);
  useEffect(() => {
    if (!win) return;
    root.current ??= createRoot(win.document.body);
    root.current.render(
      <FloatAgents
        agents={props.agents}
        requests={props.requests}
        refusal={props.refusal}
        decide={(id, action) => {
          // The click is a user activation: the last decision gives the logos' size back at once.
          const last = latest.current.requests.length <= 1;
          dispatch({ type: "decide", last });
          if (last) shrink();
          latest.current.decide(id, action);
        }}
        dragProps={(a) => latest.current.dragProps(a)}
        notice={{
          open: showCard,
          focus: size.opened !== null,
          onOpen: () => {
            const first = latest.current.requests[0];
            if (first) dispatch({ type: "open", id: first.id, outer: outerOf(win), ok: grow() });
          },
        }}
      />,
    );
  }, [win, props.agents, props.requests, props.refusal, showCard, size.opened]);
  // Where a browser allows a resize without a click, the card shows at once (the window then fits);
  // otherwise the notice stays until the click. With no request left, back to the logos' size.
  useEffect(() => {
    if (!win) return;
    if (asking) {
      dispatch({ type: "grow", outer: outerOf(win) });
      grow();
    } else {
      dispatch({ type: "idle" });
      shrink();
    }
  }, [win, asking]);
  const dismiss = () => {
    setAsked(false);
    const url = new URL(location.href);
    url.searchParams.delete("float");
    history.replaceState(null, "", url);
  };
  useEffect(() => {
    if (!asked) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [asked]);
  const prompt = asked && !win && (
    <div className="float-ask" role="dialog" aria-label="Float your agents">
      <div className="float-ask-card">
        <button type="button" className="float-ask-close" aria-label="Not now" onClick={dismiss}>
          ✕
        </button>
        {pip ? (
          <>
            <p>Keep your agents on top of every window, ready to drag onto any page or app.</p>
            <button type="button" className="primary float-ask-go" data-float-ask onClick={() => void openFloat().then(dismiss)}>
              Float your agents
            </button>
          </>
        ) : (
          <p>Float needs Chrome or Edge on a computer. Drag your agents from this dock instead.</p>
        )}
      </div>
    </div>
  );
  async function openFloat(): Promise<void> {
    if (!pip) return;
    if (win) return win.focus();
    const w = await pip.requestWindow({ width: 100 * Math.max(1, Math.min(3, props.agents.length)), height: 110, preferInitialWindowPlacement: true });
    for (const sheet of [...document.styleSheets]) {
      try {
        const style = w.document.createElement("style");
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
        w.document.head.append(style);
      } catch {
        // a sheet from another origin: skipped
      }
    }
    w.document.body.className = "float-body";
    w.addEventListener("pagehide", () => {
      root.current?.unmount();
      root.current = null;
      dispatch({ type: "reset" });
      setInner({ width: 0, height: 0 });
      setWin(null);
    });
    setWin(w);
    props.onUsed();
  }
  return (
    <>
      {props.children(pip ? <button type="button" title="Keep your agents on top of every window, ready to drag" onClick={() => void openFloat()}>
        {win ? "Floating" : "Float"}
      </button> : null)}
      {prompt}
    </>
  );
}

/**
 * What Float shows (TIN-392), in its Picture-in-Picture window or in the APC dock for Windows' strip
 * (#84, ?view=strip): the agents' logos, each draggable, or the pairing requests while any waits.
 */
function FloatAgents(props: {
  agents: DockAgent[];
  requests: FloatRequest[];
  decide: (id: string, action: Decision) => void;
  dragProps: (a: DockAgent) => { startDrag: (e: DragEvent) => void; endDrag: () => void };
  /** Float's Picture-in-Picture window only (TIN-480): until `open`, a compact notice stands for the requests. The strip passes none and shows the card. */
  notice?: { open: boolean; /** The card was opened by a click: focus the card (not Allow, so a held Enter cannot approve it). */ focus: boolean; onOpen: () => void };
  /** The hub's refusal of the last answer (Fix check 4 on #120): shown above the requests or the logos. */
  refusal?: ReactNode;
}) {
  // Which agent the person is dragging here: its pet stretches while held (TIN-483).
  const [dragging, setDragging] = useState<string | null>(null);
  if (props.requests.length > 0 && props.notice && !props.notice.open) {
    const first = props.agents.find((a) => a.id === props.requests[0]!.agentId) ?? props.agents[0];
    const n = props.requests.length;
    return (
      <div className="float float-notice-wrap" role="status" aria-live="polite">
        <button type="button" className="float-notice" onClick={props.notice.onOpen} title="Open the request">
          <span className="chip">
            {first && <AgentPet agent={first} size={40} decorative />}
            <span className="float-notice-badge" aria-hidden="true">
              {n}
            </span>
          </span>
          <span>
            {n} {n === 1 ? "request" : "requests"}
          </span>
          <b>Review</b>
        </button>
      </div>
    );
  }
  if (props.requests.length > 0)
    return (
      <div className="float float-requests">
        {props.refusal}
        {props.requests.map((r) =>
          r.unverified ? (
            // An app outside APP_ORIGINS (TIN-581): the same warning as in the dock, Deny focused.
            <div key={r.id} className="float-request unverified" tabIndex={-1}>
              <UnverifiedRequest domain={r.host} declared={r.unverified.declared} agent={r.agent} warning={r.unverified.warning} inFlight={r.inFlight} approving={!!r.approving} decide={(action) => props.decide(r.id, action)} compact />
            </div>
          ) : (
          <div key={r.id} className="float-request" tabIndex={-1} autoFocus={props.notice?.focus && r === props.requests[0]}>
            <p>
              {r.kind === "reader" ? (
                <>
                  <b>{r.app}</b> wants to send <b>{r.agent}</b> page readings. {READER_NOTICE}
                </>
              ) : (
                <>
                  <b>{r.app}</b> <span className="muted">({r.host})</span> wants to be read by <b>{r.agent}</b>.
                </>
              )}
            </p>
            <div className="row">
              <button type="button" className="primary" disabled={buttonsOff(r).approve} onClick={() => props.decide(r.id, "approve")}>
                Allow
              </button>
              <button type="button" disabled={buttonsOff(r).deny} onClick={() => props.decide(r.id, "deny")}>
                Deny
              </button>
            </div>
          </div>
          ),
        )}
      </div>
    );
  if (props.agents.length === 0) return <div className="float float-empty">Add an agent in your dock.</div>;
  // A refusal with no request left: said in place of the logos until it is closed.
  if (props.refusal) return <div className="float float-requests">{props.refusal}</div>;
  return (
    <div className="float">
      {props.agents.map((a) => {
        const d = props.dragProps(a);
        return (
          <div
            key={a.id}
            className="float-agent"
            draggable
            title={`Drag ${a.name} onto an app`}
            onDragStart={(e) => {
              setDragging(a.id);
              d.startDrag(e.nativeEvent);
            }}
            onDragEnd={() => {
              setDragging(null);
              d.endDrag();
            }}
          >
            <AgentPet agent={a} size={80} dragging={dragging === a.id} />
          </div>
        );
      })}
    </div>
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
      <span className="kicker">Agent Pointed Context</span>
    </header>
  );
}
