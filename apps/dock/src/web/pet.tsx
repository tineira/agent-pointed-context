/**
 * Float as desktop pets in the APC dock for Windows (TIN-479): each agent in a small frameless window
 * of its own, on top of every window (apps/dock-desktop/src/pets.rs opens /dock?view=pet&agent=<id>).
 * Dragging a pet is the dock's own drag: dropped on an APC app that takes it, it points the agent; a
 * drop nothing took moves the pet there instead (the app does that, from the cursor). A pairing
 * request shows as a bubble beside the pet, and the app grows the window for it.
 *
 * A pet draws the APC character (apc-pet.tsx, TIN-483): the same one as Float and the dock's tiles.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { DockAgent } from "./agent-page.tsx";
import { AgentPet } from "./apc-pet.tsx";
import { grabPoint, movesPet } from "./pet-state.ts";

const params = new URLSearchParams(location.search);
/** This page is a pet: ?view=pet&agent=<id>, or with no agent the empty dock's hint. */
export const PET = params.get("view") === "pet";
export const PET_AGENT = PET ? params.get("agent") : null;
if (PET) document.body.classList.add("pet-body");

/** Which way the bubble opens from the logo: the app chooses, by where the pet is on the screen. */
interface Side {
  left: boolean;
  up: boolean;
}

/** The app's commands for its pets (pets.rs); outside the app they do nothing. */
const tauri = (window as { __TAURI_INTERNALS__?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> } }).__TAURI_INTERNALS__;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => (tauri ? tauri.invoke<T>(cmd, args).catch(() => null) : Promise.resolve(null));
export const petApp = {
  /** The dock's agents: the app opens a pet for each and closes the others. */
  agents: (ids: string[]) => void invoke("pet_agents", { agents: ids }),
  /** A drag nothing took: the app moves the pet to the cursor, `grab` under it. */
  dropped: (grab: [number, number]) => void invoke("pet_dropped", { grab }),
  /** The bubble's size, or null when it goes: the app sizes the window and says which way it opens. */
  bubble: (size: { width: number; height: number } | null) => invoke<Side>("pet_bubble", { bubble: size && [size.width, size.height] }),
  openDock: () => void invoke("pet_open_dock"),
};

export interface PetRequest {
  id: string;
  kind: "app" | "reader";
  app: string;
  host: string;
  agent: string;
}

/** One agent's pet, and the bubble of its pairing requests while any waits. */
export function PetView(props: {
  agent: DockAgent;
  requests: PetRequest[];
  decide: (id: string, action: "approve" | "deny") => void;
  startDrag: (e: DragEvent) => void;
  endDrag: () => void;
}) {
  const logo = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const grab = useRef<[number, number]>([52, 52]);
  const [dragging, setDragging] = useState(false);
  // null while the app sizes the window for a bubble: it is laid out hidden, to be measured.
  const [side, setSide] = useState<Side | null>(null);
  const asking = props.requests.map((r) => r.id).join(",");
  useLayoutEffect(() => {
    let live = true;
    setSide(null);
    const el = bubble.current;
    void petApp.bubble(asking && el ? { width: el.offsetWidth, height: el.offsetHeight } : null).then((s) => live && setSide(s ?? { left: false, up: true }));
    return () => {
      live = false;
    };
  }, [asking]);
  const a = props.agent;
  const where = side ? `${side.left ? "pet-left" : "pet-right"} ${side.up ? "pet-up" : "pet-down"}` : "pet-measuring";
  return (
    <div className={`pet ${where}`}>
      <div
        ref={logo}
        className="pet-logo"
        draggable
        title={a.client_name ? `Drag ${a.name} onto an app to point it, or anywhere else to move it` : `Drag ${a.name} into your agent's chat to connect it, or anywhere else to move it`}
        onDragStart={(e) => {
          if (logo.current) grab.current = grabPoint({ x: e.clientX, y: e.clientY }, logo.current.getBoundingClientRect());
          setDragging(true);
          props.startDrag(e.nativeEvent);
        }}
        onDragEnd={(e) => {
          setDragging(false);
          props.endDrag();
          if (movesPet(e.dataTransfer?.dropEffect)) petApp.dropped(grab.current);
        }}
      >
        <AgentPet agent={a} size={96} dragging={dragging} />
      </div>
      {asking && (
        <div ref={bubble} className="pet-bubble" role="status" aria-live="polite">
          {props.requests.map((r) => (
            <div key={r.id} className="pet-request">
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
      )}
    </div>
  );
}

/** The empty dock's one pet: a click opens the dock, where agents are added. */
export function PetHint() {
  return (
    <div className="pet pet-right pet-up">
      <button type="button" className="pet-logo pet-hint" title="No agents yet: open your dock to add one" aria-label="Open your dock to add an agent" onClick={petApp.openDock}>
        <span className="chip">+</span>
      </button>
    </div>
  );
}

/** A pet while its page opens the dock, or tries again. */
export function PetWaiting(props: { note: string }) {
  return (
    <div className="pet pet-right pet-up">
      <div className="pet-logo" title={props.note}>
        <span className="chip pet-waiting" />
      </div>
    </div>
  );
}
