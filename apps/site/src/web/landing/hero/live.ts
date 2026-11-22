/**
 * The real hero (TIN-1071, design TIN-1063 §§ 2, 5): after "Use your own agent", Pulse's own hero view
 * (pulse.apc.tineira.com/embed/hero) in place of the simulated stage. Nothing of it exists before that click: no
 * frame in the page or in React's tree, no request to Pulse, no Pulse cookie (invariants 4 and 5).
 *
 * - The frame is sandboxed to scripts and its own origin (no navigation, no popups, no forms, no dialogs), may write
 *   the clipboard, and stays hidden behind "Opening Pulse…" until the view says `apc:embed-ready` from Pulse's
 *   origin and the frame's own window. Without that in 5 s it goes, and a link opens Pulse in a new tab instead.
 * - Its height follows `apc:embed-resize`, clamped to [280, 720]; its theme follows the site's (`apc:theme`, on load,
 *   on ready, and on every change of the toggle or the system's).
 * - `apc:pulse-status` keeps or drops the hint /try reads (pulse-status.ts); the hint is cleared when the frame mounts.
 * - What the hero's arrow needs (TIN-1106) goes to `events`, given by HeroStage: the status, where the view shows its
 *   Connect box (`apc:embed-anchor`, null again when the frame goes), and "Back to the demo". live.ts does not import
 *   the arrow (try-me.ts imports live.ts).
 * - The links to Pulse live here, outside the frame: a link inside the sandboxed frame could not open. They go to
 *   Overview once the frame says the agent is connected, to Agents until then (usePulseView, TIN-1087).
 *
 * Plain createElement, not JSX, so apps/site/test/pulse-status.test.ts renders it under node --test.
 */
import { createElement as h, Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PULSE_ORIGIN } from "../../../pulse-origin.ts";
import { clearPulseStatus, embedMessage, PULSE_HERO, READY_TIMEOUT_MS, savePulseStatus, usePulseView } from "../../pulse-status.ts";
import { currentTheme, subscribeTheme, type Theme } from "../../theme.ts";

/** The frame's attributes, exactly (apps/site/test/landing.test.ts reads them). */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin";
export const FRAME_ALLOW = "clipboard-write";

export type FramePhase = "loading" | "ready" | "failed";

/**
 * "Use your own agent", from anywhere on the page (TIN-1104): the stage's panel and title bar, and the band under the
 * hero. In-page module state only, no global and no message: a request is kept until the hero takes it, so one made
 * before the hero has mounted is not lost, and the hero takes it once (`takeRealHeroOpen`). A request when the frame
 * is already live changes nothing: there is only ever the one frame HeroStageHost mounts.
 */
let openRequested = false;
const openListeners = new Set<() => void>();

/** Asks the hero to put Pulse's real view in place of the simulated stage. Every subscriber hears it. */
export function openRealHero(): void {
  openRequested = true;
  for (const listener of [...openListeners]) listener();
}

/** Calls `listener` on every request to open the real hero, whoever made it (the hero's arrow moves to the Connect box on it, TIN-1106). */
export function subscribeRealHeroOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => void openListeners.delete(listener);
}

/** Whether a request is waiting, clearing it: only the hero takes requests. */
export function takeRealHeroOpen(): boolean {
  const requested = openRequested;
  openRequested = false;
  return requested;
}

/** The hero's side: takes a request already waiting, then each new one, and calls `open` for it. Returns the unsubscribe. */
export function listenForRealHeroOpen(open: () => void): () => void {
  const take = () => {
    if (takeRealHeroOpen()) open();
  };
  const unsubscribe = subscribeRealHeroOpen(take);
  take();
  return unsubscribe;
}

/** What the live frame tells the page around it (the hero's arrow, TIN-1106). */
export interface LiveEvents {
  status?: (connected: boolean) => void;
  connectBox?: (box: { x: number; y: number; width: number; height: number } | null) => void;
  back?: () => void;
}

/**
 * The component that can mount the frame: it starts on the simulated demo, whatever hint is stored, and switches on
 * "Use your own agent" (`openRealHero`, from the demo or the band; the Back button returns). HeroStage renders it;
 * pulse-status.test.ts renders it too.
 */
export function HeroStageHost(props: { demo: (useOwnAgent: () => void) => ReactNode; events?: LiveEvents }): ReactElement {
  const [live, setLive] = useState(false);
  useEffect(() => listenForRealHeroOpen(() => setLive(true)), []);
  const onBack = () => {
    setLive(false);
    props.events?.back?.();
  };
  return h(HeroSwitch, { live, demo: props.demo(openRealHero), onBack, events: props.events });
}

/** The stage: the simulated demo until the visitor asks for their own agent, then Pulse's live view. */
export function HeroSwitch(props: { live: boolean; demo: ReactNode; onBack: () => void; events?: LiveEvents }): ReactElement {
  return props.live ? h(PulseFrame, { onBack: props.onBack, events: props.events }) : h(Fragment, null, props.demo);
}

export function PulseFrame(props: { onBack: () => void; events?: LiveEvents }): ReactElement {
  const figureRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<FramePhase>("loading");
  const { openHref } = usePulseView();

  const events = useRef(props.events);
  events.current = props.events;
  const postTheme = (scheme: Theme = currentTheme()) => frameRef.current?.contentWindow?.postMessage({ type: "apc:theme", scheme }, PULSE_ORIGIN);

  useEffect(() => {
    // No hint survives a new frame: /try waits for this frame's first apc:pulse-status.
    clearPulseStatus();
    // The button that opened it is gone (the stage's) or far below (the band's): focus goes to the live stage.
    figureRef.current?.focus({ preventScroll: true });
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) setPhase("failed");
    }, READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      const message = embedMessage(event, frameRef.current?.contentWindow ?? null);
      if (!message) return;
      if (message.type === "apc:embed-ready") {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        setPhase("ready");
        postTheme();
      } else if (message.type === "apc:pulse-status") {
        savePulseStatus(message);
        events.current?.status?.(message.connected);
      } else if (message.type === "apc:embed-anchor") {
        events.current?.connectBox?.(message.connect);
      } else {
        bodyRef.current?.style.setProperty("--hero-live-h", `${message.height}px`);
      }
    };
    window.addEventListener("message", onMessage);
    // The toggle (subscribeTheme) and the system's scheme while no theme is chosen.
    const unsubscribe = subscribeTheme((theme) => postTheme(theme));
    const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
    const onScheme = () => postTheme();
    scheme?.addEventListener("change", onScheme);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      unsubscribe();
      scheme?.removeEventListener("change", onScheme);
      events.current?.connectBox?.(null);
    };
  }, []);

  const newTab = (text: string) => h("a", { href: openHref, target: "_blank", rel: "noopener" }, text, " ", h("span", { "aria-hidden": "true" }, "→"));

  return h(
    "figure",
    { ref: figureRef, tabIndex: -1, className: "hero-stage hero-live", "data-phase": phase, "aria-label": "Pulse, live: connect your own agent and point it at a bar", "aria-busy": phase === "loading" },
    h(
      "div",
      { className: "hero-live-bar" },
      h("i"),
      h("i"),
      h("i"),
      h("span", null, "pulse · live"),
      h("button", { type: "button", className: "hero-own", onClick: props.onBack }, "Back to the demo"),
    ),
    h(
      "div",
      { ref: bodyRef, className: "hero-live-body" },
      phase !== "failed" &&
        h("iframe", {
          ref: frameRef,
          className: "hero-live-frame",
          title: "Pulse, live: your own agent",
          src: PULSE_HERO,
          sandbox: FRAME_SANDBOX,
          allow: FRAME_ALLOW,
          onLoad: () => postTheme(),
        }),
      phase === "loading" && h("p", { className: "hero-live-wait", role: "status" }, "Opening Pulse…"),
      phase === "failed" && h("div", { className: "hero-live-fail", role: "status" }, h("p", null, "Pulse did not open here."), newTab("Open Pulse in a new tab")),
    ),
    h("p", { className: "hero-note" }, `This is Pulse itself (${new URL(PULSE_ORIGIN).host}), a demo app with made-up data. `, newTab("or open Pulse")),
  );
}
