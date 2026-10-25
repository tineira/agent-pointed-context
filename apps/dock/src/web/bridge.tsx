/**
 * The agent dock, APC v2 prototype (TIN-370). A window of its own, opened from Pulse (?apc=v2,
 * "Dock"), that lists Pulse's agents. Drag one onto anything in Pulse, in another window, and Pulse
 * pins it there (a native drop, TIN-369), as if the top-bar mark had been dragged.
 *
 * The agents come from Pulse over postMessage (apps/demo/src/web/dock-bridge.ts). The drag carries
 * only the agent's public handle. The log below the agents is the measurement the issue asks for:
 * whether each drag landed, and where the agent points afterwards.
 */
import { APC_AGENT_TYPE, agentDragPayload } from "@apc/web";
import { useEffect, useRef, useState } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { appOriginAllowed, parseAgents, type DockAgent } from "../../../demo/src/web/dock-protocol.ts";

type App = { name: string; origin: string };
interface Drag {
  at: number;
  name: string;
  ms: number;
  /** The drop effect the browser reports at dragend: "link" when an app took the agent, "none" otherwise. */
  effect: string;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Dock() {
  const [app, setApp] = useState<App | null>(null);
  const [agents, setAgents] = useState<DockAgent[]>([]);
  const [heardAt, setHeardAt] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [log, setLog] = useState<Drag[]>([]);
  const [, tick] = useState(0);
  const dragStart = useRef(0);
  const opener = window.opener as Window | null;

  // Hello to the window that opened us, now and then: Pulse answers with its agents, and a Pulse
  // that reloaded finds this dock again.
  useEffect(() => {
    if (!opener) return;
    const hello = () => {
      try {
        opener.postMessage({ type: "apc-dock:hello", v: 1 }, "*");
      } catch {
        // the opener is gone
      }
    };
    hello();
    const id = setInterval(() => {
      hello();
      tick((n) => n + 1);
    }, heardAt ? 10_000 : 2_000);
    return () => clearInterval(id);
  }, [opener, heardAt === 0]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener || !appOriginAllowed(event.origin)) return;
      const message = parseAgents(event.data);
      if (!message) return;
      setApp({ name: message.app.name, origin: event.origin });
      setAgents(message.agents);
      setHeardAt(Date.now());
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [opener]);

  if (!opener) {
    return (
      <main>
        <Header />
        <p>
          The dock opens from an app. Open <a href="https://apc.tineira.com/overview?apc=v2">Pulse with APC v2 on</a>, then click <b>Dock</b> in its top bar.
        </p>
      </main>
    );
  }

  const quiet = heardAt > 0 && Date.now() - heardAt > 25_000;
  return (
    <main>
      <Header />
      <div className="status">
        {!app ? "Waiting for the app that opened this window…" : quiet ? `${app.name} is not answering: closed, or reloaded without APC v2?` : (
          <>
            Agents of <b>{app.name}</b> ({new URL(app.origin).host})
          </>
        )}
      </div>
      {app && agents.length === 0 && <p>{app.name} has no agents yet.</p>}
      <ul className="agents">
        {agents.map((a) => (
          <li
            key={a.handle}
            className={`agent${dragging === a.handle ? " dragging" : ""}`}
            draggable
            title={`Drag ${a.name} onto anything in ${app?.name ?? "the app"} to point it there`}
            onDragStart={(e) => {
              e.dataTransfer.setData(APC_AGENT_TYPE, agentDragPayload(a.handle));
              e.dataTransfer.effectAllowed = "link";
              const chip = e.currentTarget.querySelector(".chip");
              if (chip) e.dataTransfer.setDragImage(chip, 20, 20);
              dragStart.current = Date.now();
              setDragging(a.handle);
            }}
            onDragEnd={(e) => {
              const now = Date.now();
              setDragging(null);
              setLog((l) => [{ at: now, name: a.name, ms: now - dragStart.current, effect: e.dataTransfer.dropEffect }, ...l].slice(0, 8));
            }}
          >
            <span className="chip">
              <AgentIcon clientName={a.client_name} clientUa={a.client_ua} clientIcon={a.client_icon} motion={a.motion} size={24} />
            </span>
            <span className="who">
              <div className="name">{a.name}</div>
              <div className="where">
                {a.pin ? (
                  <>
                    → {a.pin.label} · {a.pin.seen ? <span className="read">read ✓</span> : "not read yet"}
                  </>
                ) : a.motion === "off" ? (
                  "not connected yet"
                ) : (
                  "not pointed at anything"
                )}
              </div>
            </span>
          </li>
        ))}
      </ul>
      {log.length > 0 && (
        <>
          <h2>Drags</h2>
          <ul className="log">
            {log.map((d) => (
              <li key={d.at}>
                {time(d.at)} {d.name}:{" "}
                {d.effect === "none" ? "not dropped on a target" : <span className="ok">dropped ({d.effect})</span>} · {(d.ms / 1000).toFixed(1)} s
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="status">Drag an agent onto a bar, a row or a card in {app?.name ?? "the app"}. Keep this window beside it, or over another app.</p>
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
