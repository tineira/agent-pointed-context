/**
 * Float as desktop pets in the APC dock for Windows (TIN-479): each agent in a small frameless window
 * of its own, on top of every window (apps/dock-desktop/src/pets.rs opens /dock?view=pet&agent=<id>).
 * Dragging a pet is the dock's own drag: dropped on an APC app that takes it, it points the agent; a
 * drop nothing took (or Esc) leaves the pet where it is. Only the grip moves it (TIN-484): a pill above
 * its head, shown while the mouse is over the pet, that moves the window natively (the app saves where
 * it is let go). A pairing request shows as a bubble beside the pet, and the app grows the window for it.
 *
 * A pet draws the APC character (apc-pet.tsx, TIN-483): the same one as Float and the dock's tiles.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DockAgent } from "./agent-page.tsx";
import { AgentPet } from "./apc-pet.tsx";

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
const tauri = (
  window as {
    __TAURI_INTERNALS__?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>; metadata?: { currentWindow?: { label?: string } } };
  }
).__TAURI_INTERNALS__;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => (tauri ? tauri.invoke<T>(cmd, args).catch(() => null) : Promise.resolve(null));
export const petApp = {
  /** The dock's agents: the app opens a pet for each and closes the others. */
  agents: (ids: string[]) => void invoke("pet_agents", { agents: ids }),
  /** The mouse is over the pet, or left it: the app lets the grip take clicks while it is. */
  grip: (shown: boolean) => void invoke("pet_grip", { shown }),
  /** The grip is pressed: the window moves with the mouse until it is let go (Tauri's own command). */
  move: () => void invoke("plugin:window|start_dragging", { label: tauri?.metadata?.currentWindow?.label }),
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
  const bubble = useRef<HTMLDivElement>(null);
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
  const requests = asking ? (
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
  ) : null;
  return (
    <PetFrame where={where} name={a.name} beside={requests}>
      <div
        className="pet-logo"
        draggable
        title={a.client_name ? `Drag ${a.name} onto an app to point it` : `Drag ${a.name} into your agent's chat to connect it`}
        onDragStart={(e) => {
          setDragging(true);
          props.startDrag(e.nativeEvent);
        }}
        onDragEnd={() => {
          setDragging(false);
          props.endDrag();
        }}
      >
        <AgentPet agent={a} size={96} dragging={dragging} />
      </div>
    </PetFrame>
  );
}

/**
 * A pet's window: the pet (the grip's band, and the logo below it), and beside it whatever else the
 * window holds. The grip shows while the mouse is over the window, which is only ever over the pet or
 * its bubble (the app's region is those); it hides when the mouse leaves. Pressing it moves the window.
 */
function PetFrame(props: { where: string; name?: string; children: ReactNode; beside?: ReactNode }) {
  const [hover, setHover] = useState(false);
  const shown = useRef(false);
  const over = (on: boolean) => {
    if (shown.current === on) return;
    shown.current = on;
    setHover(on);
    petApp.grip(on);
  };
  // The grip shows on a move over the pet, not on pointerenter: when a body drag ends, WebView2 sends
  // the page a pointerenter at the point the drag started, wherever the cursor is. A body drag hides
  // the grip; the next move over the pet shows it again.
  return (
    <div
      className={`pet ${props.where}${hover ? " pet-hover" : ""}`}
      onPointerMove={() => over(true)}
      onPointerLeave={() => over(false)}
      onDragStart={() => over(false)}
    >
      <div className="pet-block">
        <div
          className="pet-grip"
          title={props.name ? `Drag to move ${props.name}` : "Drag to move"}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            petApp.move();
          }}
        >
          <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
            {[1.5, 6.5].flatMap((x) => [1.5, 5, 8.5].map((y) => <circle key={`${x},${y}`} cx={x} cy={y} r={1.2} fill="currentColor" />))}
          </svg>
        </div>
        {props.children}
      </div>
      {props.beside}
    </div>
  );
}

/** The empty dock's one pet: a click opens the dock, where agents are added. */
export function PetHint() {
  return (
    <PetFrame where="pet-right pet-up">
      <button type="button" className="pet-logo pet-hint" title="No agents yet: open your dock to add one" aria-label="Open your dock to add an agent" onClick={petApp.openDock}>
        <span className="chip">+</span>
      </button>
    </PetFrame>
  );
}

/** A pet while its page opens the dock, or tries again. */
export function PetWaiting(props: { note: string }) {
  return (
    <PetFrame where="pet-right pet-up">
      <div className="pet-logo" title={props.note}>
        <span className="chip pet-waiting" />
      </div>
    </PetFrame>
  );
}
