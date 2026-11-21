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
 * - The links to Pulse live here, outside the frame: a link inside the sandboxed frame could not open.
 *
 * Plain createElement, not JSX, so apps/site/test/hero-live.test.ts renders it under node --test.
 */
import { createElement as h, Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PULSE_ORIGIN } from "../../../pulse-origin.ts";
import { clearPulseStatus, embedMessage, PULSE_AGENTS, PULSE_HERO, READY_TIMEOUT_MS, savePulseStatus } from "../../pulse-status.ts";
import { currentTheme, subscribeTheme, type Theme } from "../../theme.ts";

/** The frame's attributes, exactly (apps/site/test/landing.test.ts reads them). */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin";
export const FRAME_ALLOW = "clipboard-write";

export type FramePhase = "loading" | "ready" | "failed";

/** The stage: the simulated demo until the visitor asks for their own agent, then Pulse's live view. */
export function HeroSwitch(props: { live: boolean; demo: ReactNode; onBack: () => void }): ReactElement {
  return props.live ? h(PulseFrame, { onBack: props.onBack }) : h(Fragment, null, props.demo);
}

export function PulseFrame(props: { onBack: () => void }): ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<FramePhase>("loading");

  const postTheme = (scheme: Theme = currentTheme()) => frameRef.current?.contentWindow?.postMessage({ type: "apc:theme", scheme }, PULSE_ORIGIN);

  useEffect(() => {
    // No hint survives a new frame: /try waits for this frame's first apc:pulse-status.
    clearPulseStatus();
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
    };
  }, []);

  const newTab = (text: string) => h("a", { href: PULSE_AGENTS, target: "_blank", rel: "noopener" }, text, " ", h("span", { "aria-hidden": "true" }, "→"));

  return h(
    "figure",
    { className: "hero-stage hero-live", "data-phase": phase, "aria-label": "Pulse, live: connect your own agent and point it at a bar", "aria-busy": phase === "loading" },
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
