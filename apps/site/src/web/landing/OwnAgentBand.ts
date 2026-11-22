/**
 * The band under the hero (TIN-1104): "Now use your own agent", for anyone not yet connected, whether or not they saw
 * the stage's own panel. Its button scrolls back to the stage and opens the real Pulse there (`openRealHero`, the same
 * one frame the panel and the title bar mount, so nothing loads from Pulse before the click). Once the site knows the
 * visitor's agent is connected (usePulseView, live while the hero's frame reports), it is a quiet line instead.
 *
 * The section's class never changes with the state: the scroll reveal (reveal.ts) keeps its own classes on it.
 * Plain createElement, not JSX, so apps/site/test/landing.test.ts renders it under node --test.
 */
import { createElement as h, type ReactElement } from "react";
import { usePulseView, type PulseView } from "../pulse-status.ts";
import { openRealHero } from "./hero/live.ts";

/** The stage the button scrolls back to (HeroSection's). */
export const HERO_STAGE_SELECTOR = ".landing-hero-stage";

export function OwnAgentBand(): ReactElement {
  return h(OwnAgentBandView, { view: usePulseView(), onUseOwnAgent: scrollUpAndOpen });
}

/** The band for a given connection: the offer, or the quiet connected line. */
export function OwnAgentBandView(props: { view: PulseView; onUseOwnAgent: () => void }): ReactElement {
  const { connected, agentName, openHref } = props.view;
  const arrow = (glyph: string) => h("span", { "aria-hidden": "true" }, glyph);
  return h(
    "section",
    { className: "wrap landing-own rv", "aria-labelledby": "landing-own-title" },
    connected
      ? h(
          "div",
          { className: "landing-own-quiet" },
          h("h2", { id: "landing-own-title" }, agentName ? `${agentName} connected` : "Your agent connected"),
          h("span", { "aria-hidden": "true" }, "·"),
          h("a", { href: openHref, target: "_blank", rel: "noopener" }, "Open Pulse ", arrow("↗")),
        )
      : h(
          "div",
          { className: "landing-own-card" },
          h(
            "div",
            { className: "landing-own-copy" },
            h("h2", { id: "landing-own-title" }, "Now use your own agent"),
            h("p", null, "Claude, ChatGPT, Grok… point it at the real Pulse, right in the demo above."),
          ),
          h(
            "div",
            { className: "landing-own-actions" },
            h("button", { type: "button", className: "btn primary", onClick: () => props.onUseOwnAgent() }, "Use your own agent ", arrow("↑")),
            h("a", { className: "landing-own-open", href: openHref, target: "_blank", rel: "noopener" }, "or open Pulse ", arrow("↗")),
          ),
        ),
  );
}

/**
 * Scrolls up to the stage (smoothly, or a plain jump under reduced motion), then asks the hero to open the real Pulse.
 * The hero takes the request whenever it can: at once if it is mounted, else as soon as it mounts.
 */
export function scrollUpAndOpen(doc: Pick<Document, "querySelector"> = document, reduce: boolean = prefersReducedMotion()): void {
  doc.querySelector(HERO_STAGE_SELECTOR)?.scrollIntoView({ behavior: reduce ? "instant" : "smooth", block: "start" });
  openRealHero();
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
