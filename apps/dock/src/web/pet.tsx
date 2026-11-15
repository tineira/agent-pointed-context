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
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { DockAgent } from "./agent-page.tsx";
import type { Marks } from "./float-marks.ts";
import { AgentPet } from "./apc-pet.tsx";
import { canDrag, dragTitle } from "./agent-drag.ts";
import { READER_NOTICE } from "../worker/reading.ts";
import type { UnverifiedAction } from "./unverified.tsx";
import type { InFlight } from "./request-state.ts";
import { PairingRequest } from "./pairing-request.tsx";
import { ConnectRequest, type ConnectAction, type ConnectCardItem, type DockConnect } from "./connect-request.tsx";
import { PET_BUBBLE_START, petBubbleReducer } from "./pet-bubble.ts";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
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
const tauri = typeof window !== "undefined" ? (window as { __TAURI_INTERNALS__?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> } }).__TAURI_INTERNALS__ : undefined;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => (tauri ? tauri.invoke<T>(cmd, args).catch(() => null) : Promise.resolve(null));
// A queued measurement must finish before Done closes the bubble, even if native commands are slow.
let bubbleCommand: Promise<Side | null> = Promise.resolve(null);
export const petApp = {
  /** The dock's agents: the app opens a pet for each and closes the others, and lists them by name in its tray's Float menu (TIN-698; an older app ignores the names). */
  agents: (ids: string[], names: string[]) => void invoke("pet_agents", { agents: ids, names }),
  /** The mouse is over the pet, or left it: the app lets the grip take clicks while it is. */
  grip: (shown: boolean) => void invoke("pet_grip", { shown }),
  /**
   * The grip is pressed: this window moves with the mouse until it is let go. Answers once the move has
   * settled, with which way the bubble opens now (the app may have turned it), or null.
   */
  move: () => invoke<Side>("pet_move"),
  /** The bubble's size, or null when it goes: the app sizes the window and says which way it opens. */
  bubble: (size: { width: number; height: number } | null) => (bubbleCommand = bubbleCommand.then(() => invoke<Side>("pet_bubble", { bubble: size && [size.width, size.height] }))),
  openDock: () => void invoke("pet_open_dock"),
  /**
   * What this app's pet windows can do (TIN-922). An app before it answers null: its pets keep code
   * entry in the dock, since the installed app loads these pages from production.
   */
  caps: () => invoke<string[]>("pet_caps"),
  /** A press on the bubble's code field: the app activates this pet's window, so typing reaches it. */
  focus: () => void invoke("pet_focus"),
};

/** The code is typed in the pet only on an app that can activate the pet for it (TIN-922). */
export function petCodeEntry(caps: string[] | null): "field" | "dock" {
  return caps?.includes("code_field") ? "field" : "dock";
}

/**
 * Float per agent in the app (TIN-698, float.rs), for the dock's own window: whether Float is on and
 * which agents it took out, and changes to them. Null from an app before TIN-698, or outside the app.
 */
export const floatApp = {
  state: () => invoke<Marks>("float_state"),
  set: (change: { on?: boolean; agent?: string; marked?: boolean }) => invoke<Marks>("float_set", change),
};

export interface PetRequest {
  id: string;
  kind: "app" | "reader";
  app: string;
  host: string;
  agent: string;
  /** An app outside APP_ORIGINS (TIN-581): what it calls itself, and whether this request shows the warning. */
  unverified?: { declared: string | null; warning: boolean };
  /** What is on its way: an Approve turns Approve off, a Deny turns both off (request-state.ts). */
  inFlight?: InFlight;
  /** The hub is still introducing itself to the app: Approve is off, Deny stays on. */
  approving?: boolean;
  /** The app sent a pairing code (APC 0.9): the bubble has Deny and sends the person to the dock to type it. */
  code?: boolean;
}

/** One agent's pet, and the bubble of its pairing and connect requests while any waits. */
export function PetView(props: {
  agent: DockAgent;
  requests: PetRequest[];
  connects?: ConnectCardItem[];
  decide: (id: string, action: UnverifiedAction) => void;
  decideConnect?: (connect: DockConnect, action: ConnectAction) => void;
  dismissBlockedConnect?: (id: string) => void;
  /** Whether the drag went ahead (an agent not connected yet does not drag, TIN-908). */
  startDrag: (e: DragEvent) => boolean;
  endDrag: () => void;
  /** The hub's refusal of the last answer (Fix check 4 on #120): the bubble shows it, with or without a request left. */
  refusal?: ReactNode;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // null while the app sizes the window for a bubble: it is laid out hidden, to be measured.
  const [side, setSide] = useState<Side | null>(null);
  const [review, updateReview] = useReducer(petBubbleReducer, PET_BUBBLE_START);
  const [codeEntry, setCodeEntry] = useState<"field" | "dock">("dock");
  useEffect(() => {
    let live = true;
    void petApp.caps().then((caps) => live && setCodeEntry(petCodeEntry(caps)));
    return () => {
      live = false;
    };
  }, []);
  const connects = props.connects ?? [];
  const asking = [...connects.map((c) => `${c.connect.id}:${c.blockedUrl ? "open" : "ask"}`), ...props.requests.map((r) => r.id), ...(props.refusal ? ["refusal"] : [])].join(",");
  const shown = !!asking || review.shown;
  useLayoutEffect(() => {
    if (asking) updateReview({ type: "show" });
  }, [asking]);
  // Content can grow without a new request id (a warning, a refusal or a blocked browser). Measure
  // those changes too, and retain the largest size through expiry and answers on another surface.
  useLayoutEffect(() => {
    if (!shown) return;
    const el = bubble.current;
    if (!el) return;
    const measure = () => updateReview({ type: "measure", width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  // A fresh view knows no bubble: clear any size a previous mount left in the window (a reload, or
  // a refresh error that swapped this view for PetWaiting). Queued, so a bubble measured now follows it.
  useLayoutEffect(() => {
    void petApp.bubble(null);
  }, []);
  useLayoutEffect(() => {
    if (!review.size) return;
    let live = true;
    void petApp.bubble(review.size).then((s) => live && setSide(s ?? { left: false, up: true }));
    return () => {
      live = false;
    };
  }, [review.size]);
  const done = () => {
    // No timer, state broadcast or request disappearance sends the native shrink command.
    updateReview({ type: "done" });
    setSide(null);
    void petApp.bubble(null);
  };
  const a = props.agent;
  const where = side ? `${side.left ? "pet-left" : "pet-right"} ${side.up ? "pet-up" : "pet-down"}` : "pet-measuring";
  const requests = shown ? (
    <div ref={bubble} className="pet-bubble" style={{ minHeight: review.size?.height }} role="status" aria-live="polite">
      {props.refusal}
      {connects.map((c) => (
        <div key={c.connect.id} className={`pet-request${!c.connect.verified ? " unverified" : ""}`}>
          <ConnectRequest
            connect={c.connect}
            agentName={c.agentName}
            inFlight={c.inFlight}
            blockedUrl={c.blockedUrl}
            decide={(action) => props.decideConnect?.(c.connect, action)}
            onOpenLink={() => setTimeout(() => props.dismissBlockedConnect?.(c.connect.id), 0)}
            onDismiss={() => props.dismissBlockedConnect?.(c.connect.id)}
            compact
          />
        </div>
      ))}
      {props.requests.map((r) => (
        // An app outside APP_ORIGINS (TIN-581): the same warning as in the dock, Deny focused. A request with a pairing
        // code (APC 0.9): Deny, and the code is typed in the dock, which the bubble opens; its content is fixed per request.
        <div
          key={r.id}
          className={`pet-request${r.unverified ? " unverified" : ""}`}
          // The pet is shown without activation (SW_SHOWNOACTIVATE): a press on the code field asks the
          // app to activate it, so the keyboard reaches the field (TIN-922).
          onPointerDownCapture={(e) => {
            if (codeEntry === "field" && (e.target as HTMLElement).closest("input")) petApp.focus();
          }}
        >
          <PairingRequest
            // Typed here on an app that can activate the pet (pet_caps); otherwise in the dock.
            entry={codeEntry}
            kind={r.kind}
            app={r.app}
            host={r.host}
            agent={r.agent}
            says={
              r.kind === "reader" ? (
                <>
                  <b>{r.app}</b> wants to send <b>{r.agent}</b> page readings. {READER_NOTICE}
                </>
              ) : (
                <>
                  <b>{r.app}</b> <span className="muted">({r.host})</span> wants to be read by <b>{r.agent}</b>.
                </>
              )
            }
            {...(r.unverified ? { unverified: r.unverified } : {})}
            code={!!r.code}
            inFlight={r.inFlight}
            approving={!!r.approving}
            decide={(action) => props.decide(r.id, action)}
            openDock={petApp.openDock}
            compact
          />
        </div>
      ))}
      {!asking && (
        <div className="pet-request">
          <p>No requests waiting.</p>
          <button type="button" onClick={done}>Done</button>
        </div>
      )}
    </div>
  ) : null;
  return (
    <PetFrame where={where} name={a.name} beside={requests} moved={(s) => setSide(s)}>
      <div
        className="pet-logo"
        draggable={canDrag(a)}
        title={canDrag(a) ? dragTitle(a, "an app") : `Connect ${a.name} first: click to open your dock`}
        // Not connected yet (TIN-908): it does not drag, and a click opens the dock, where it connects.
        onClick={canDrag(a) ? undefined : petApp.openDock}
        onDragStart={(e) => {
          if (props.startDrag(e.nativeEvent)) setDragging(true);
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
function PetFrame(props: { where: string; name?: string; children: ReactNode; beside?: ReactNode; moved?: (side: Side) => void }) {
  const [hover, setHover] = useState(false);
  const shown = useRef(false);
  const over = (on: boolean) => {
    if (shown.current === on) return;
    shown.current = on;
    setHover(on);
    petApp.grip(on);
  };
  // The app's idea of the hover starts and ends with this frame (a reload, or the hint giving way to an
  // agent).
  useEffect(() => {
    petApp.grip(false);
    return () => petApp.grip(false);
  }, []);
  // The grip shows on a move over the pet, not on pointerenter: when a body drag ends, WebView2 sends
  // the page a pointerenter at the point the drag started, wherever the cursor is. A body drag hides
  // the grip; the next move over the pet shows it again. A pointerenter only forgets what the page last
  // told the app, so the first move after it always tells the app again: the app may have dropped the
  // hover meanwhile (it does when the pets are hidden, and a hidden page gets no pointerleave).
  return (
    <div
      className={`pet ${props.where}${hover ? " pet-hover" : ""}`}
      onPointerEnter={() => (shown.current = false)}
      onPointerMove={() => over(true)}
      onPointerLeave={() => over(false)}
      onDragStart={() => over(false)}
    >
      <div className="pet-block">
        <div
          className="pet-grip"
          role="button"
          aria-label={props.name ? `Move ${props.name}` : "Move"}
          title={props.name ? `Drag to move ${props.name}` : "Drag to move"}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void petApp.move().then((side) => side && props.moved?.(side));
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
export function PetHint(props: { note?: string }) {
  useLayoutEffect(() => {
    void petApp.bubble(null);
  }, []);
  return (
    <PetFrame where="pet-right pet-up">
      <button type="button" className="pet-logo pet-hint" title={props.note ?? "No agents yet: open your dock to add one"} aria-label={props.note ?? "Open your dock to add an agent"} onClick={petApp.openDock}>
        <span className="chip">+</span>
      </button>
    </PetFrame>
  );
}

/** A pet while its page opens the dock, or tries again. */
export function PetWaiting(props: { note: string }) {
  useLayoutEffect(() => {
    void petApp.bubble(null);
  }, []);
  return (
    <PetFrame where="pet-right pet-up">
      <div className="pet-logo" title={props.note}>
        <span className="chip pet-waiting" />
      </div>
    </PetFrame>
  );
}
