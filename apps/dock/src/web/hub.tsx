/**
 * The agent dock with its attention hub (TIN-382). The person's agents connect once, to the dock's
 * MCP URL. Dragging one onto an APC app (Pulse under APC v2) pairs them after a yes on the app's
 * page and a yes here; from then on the agent follows the person's pointer across every paired app.
 *
 * Each agent's drag carries its public handle, this hub's origin and a single-use ticket (60 s),
 * never a URL or a grant. The dock keeps a fresh ticket per agent so the drag can start at once.
 */
import { APC_AGENT_TYPE, agentDragPayload } from "@apc/web";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { askYourAgentPrompt } from "../../../demo/src/web/qr.tsx";
import { StartOver } from "../../../demo/src/web/start-over.tsx";
import { AgentPet } from "./apc-pet.tsx";
import { AgentPage, call, host, RemoveAgent, type DockAgent, type DockState } from "./agent-page.tsx";
import { cardOuterSize, FLOAT_START, fitsCard, floatSizeReducer } from "./float-size.ts";
import { PET, PET_AGENT, petApp, PetHint, PetView, PetWaiting } from "./pet.tsx";
import { APPS, appUrl, ConnectAgent, DESKTOP_SHELL, DESKTOP_SHORTCUT, DOCK_DESKTOP, Install, Setup } from "./setup.tsx";

/** What the dock's Start over deletes (TIN-411). */
const DOCK_WIPES = ["your agents and their MCP URLs", "their pairings with apps (each app gets its grant back)", "your world and where your agents point"];

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

  // Bumped when the desktop app's dock is gone (Start over, or 6 h idle), to open the dock again.
  const [reopen, setReopen] = useState(0);
  useEffect(() => {
    // The strip and the pets only resume the dock its window opened, and wait for it on a first run (#84).
    let retry = 0;
    const open = () =>
      call<{ did: string }>("/api/dock", FLOATING ? { resume: true } : {}).then(
        (r) => setDid(r.did),
        (e: unknown) => (FLOATING ? (retry = window.setTimeout(open, 2000)) : setError(String(e))),
      );
    void open();
    return () => clearTimeout(retry);
  }, [reopen]);
  const base = did ? `/api/d/${did}` : null;
  const refresh = useCallback(() => {
    if (!base) return;
    call<DockState>(`${base}/state`).then(setState, (e: unknown) => {
      // The desktop app stays open for days, so its windows open the dock again when it is gone (403
      // without the cookie, 404 once expired): the strip and the pets wait for the dock window's new one.
      if ((FLOATING || DESKTOP_SHELL) && /: 40[34]$/.test(String(e))) {
        setDid(null);
        setState(null);
        setReopen((n) => n + 1);
      } else setError(String(e));
    });
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

  // The strip and the pets have no one to read an error: they say so (in a line, in a title) and try again.
  useEffect(() => {
    if (!FLOATING || !error) return;
    const id = setTimeout(() => {
      setError(null);
      refresh();
    }, 3000);
    return () => clearTimeout(id);
  }, [error, refresh]);

  if (error) return PET ? <PetWaiting note="Could not reach your dock. Trying again…" /> : STRIP ? <div className="float float-empty">Could not reach your dock. Trying again…</div> : <main><Header /><p>Could not open your dock: {error}</p></main>;
  if (!state || !base) return PET ? <PetWaiting note="Opening your dock…" /> : STRIP ? <div className="float float-empty">Opening your dock…</div> : <main><Header /><p>Opening your dock…</p></main>;

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

  const requests = pending.map(({ agent, pairing }) => (
    <section key={pairing.id} className="request">
      <p>
        {pairing.kind === "reader" ? (
          <>
            <b>{pairing.app.name}</b> wants to send <b>{agent.name}</b> page readings: the text you drop it on, on sites you allow in the APC extension. That text passes through this dock and is kept 10 minutes.
          </>
        ) : (
          <>
            <b>{pairing.app.name}</b> at <b>{host(pairing.app.origin)}</b> wants to be read by <b>{agent.name}</b>. Its tools and data come from {pairing.app.origin}.
          </>
        )}
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

  const floatRequests = pending.map(({ agent, pairing }) => ({ id: pairing.id, kind: pairing.kind, app: pairing.app.name, host: host(pairing.app.origin), agent: agent.name, agentId: agent.id }));
  const floatDrag = (a: DockAgent) => ({ startDrag: (e: DragEvent) => startDrag(e, a.id), endDrag: () => endDrag(a.id) });

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
      />
    );
  }

  // The APC dock for Windows' always-on-top strip (#84), in its builds before the pets: only what Float shows.
  if (STRIP) return <FloatAgents agents={state.agents} requests={floatRequests} decide={(id, action) => decide(id, action)} dragProps={floatDrag} />;

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
        <div className="row small footer">
          <StartOver site="Agent dock" className="" wipes={DOCK_WIPES} reset={() => call(`${base}/reset`, {})} />
        </div>
      </main>
    );
  }

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
          requests={agent.pairings.filter((p) => p.status === "pending").map((p) => ({ id: p.id, kind: p.kind, app: p.app }))}
          decide={decide}
          refresh={refresh}
          back={back}
          dragProps={dragProps(agent)}
          dragging={dragging === agent.id}
        />
      </>
    );
  }

  return (
    <main className="dock">
      <Header />
      <BadgeSources agents={state.agents} />
      {requests}
      {state.agents.length === 0 && <p className="empty">No agents. Add one with <b>Add an agent</b> below, then connect it.</p>}
      <ul className="tiles">
        {state.agents.map((a) => {
          const connected = !!a.client_name;
          const paired = a.pairings.filter((p) => p.status === "paired");
          return (
            <li key={a.id} className={`tile${dragging === a.id ? " dragging" : ""}`}>
              <div className="tile-drag" {...dragProps(a)}>
                <AgentPet agent={a} size={104} dragging={dragging === a.id} decorative />
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
                  {a.calls ? ` · ${a.calls} call${a.calls === 1 ? "" : "s"}` : ""} →
                </a>
              ) : (
                // Not connected yet: how to connect it stays under its tile, as in the first run.
                <details className="tile-details" open>
                  <summary>Connect this agent</summary>
                  <ConnectAgent agent={a} />
                  <RemoveAgent agent={a} apps={[]} remove={() => call(`${base}/agents/${a.id}/remove`, {}).then(refresh)} />
                </details>
              )}
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
        {DESKTOP_SHELL ? (
          <span className="muted" title="The APC dock for Windows keeps your agents on top of every window">
            {DESKTOP_SHORTCUT} floats your agents
          </span>
        ) : (
          <Float agents={state.agents} requests={floatRequests} decide={(id, action) => decide(id, action)} dragProps={floatDrag} />
        )}
        <button type="button" title={`World ${state.seed}: the seed every app opens on`} onClick={() => setWizard("world")}>
          Change world
        </button>
        {!DESKTOP_SHELL && <Install />}
        {DOCK_DESKTOP.offered && (
          <a href={DOCK_DESKTOP.url} title={`Get the APC dock for Windows: your agents on top of every window. ${DOCK_DESKTOP.note}`}>
            Dock for Windows
          </a>
        )}
        <StartOver site="Agent dock" className="" wipes={DOCK_WIPES} reset={() => call(`${base}/reset`, {})} />
      </div>
    </main>
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
}

function Float(props: {
  agents: DockAgent[];
  /** Pairing requests waiting in the dock (TIN-413): the dock's window is usually hidden while Float is on. */
  requests: FloatRequest[];
  decide: (id: string, action: "approve" | "deny") => void;
  dragProps: (a: DockAgent) => { startDrag: (e: DragEvent) => void; endDrag: () => void };
}) {
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
  }, [win, props.agents, props.requests, showCard, size.opened]);
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
  }
  if (!pip) return prompt || null;
  return (
    <>
      <button type="button" title="Keep your agents on top of every window, ready to drag" onClick={() => void openFloat()}>
        {win ? "Floating" : "Float"}
      </button>
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
  decide: (id: string, action: "approve" | "deny") => void;
  dragProps: (a: DockAgent) => { startDrag: (e: DragEvent) => void; endDrag: () => void };
  /** Float's Picture-in-Picture window only (TIN-480): until `open`, a compact notice stands for the requests. The strip passes none and shows the card. */
  notice?: { open: boolean; /** The card was opened by a click: focus the card (not Allow, so a held Enter cannot approve it). */ focus: boolean; onOpen: () => void };
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
        {props.requests.map((r) => (
          <div key={r.id} className="float-request" tabIndex={-1} autoFocus={props.notice?.focus && r === props.requests[0]}>
            <p>
              {r.kind === "reader" ? (
                <>
                  <b>{r.app}</b> wants to send <b>{r.agent}</b> page readings.
                </>
              ) : (
                <>
                  <b>{r.app}</b> <span className="muted">({r.host})</span> wants to be read by <b>{r.agent}</b>.
                </>
              )}
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => props.decide(r.id, "approve")}>
                Allow
              </button>
              <button type="button" onClick={() => props.decide(r.id, "deny")}>
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  if (props.agents.length === 0) return <div className="float float-empty">Add an agent in your dock.</div>;
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
      <span className="kicker">APC v2</span>
    </header>
  );
}
