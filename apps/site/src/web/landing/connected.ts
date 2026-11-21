/**
 * What the landing's "Try it" card says once the visitor's agent is connected in the hero (TIN-1089): a check beside
 * Pulse and a line under the chips, "<agent> connected" (or "Connected") with a link that follows the same target as
 * every "Open Pulse" on the site (pulse-status.ts, TIN-1087). Signals is left as it is.
 *
 * Plain createElement, not JSX, so apps/site/test/connected.test.ts renders it under node --test. The name is a React
 * text node, and the check is drawn in CSS, so the card needs no markup the CSP could object to.
 */
import { createElement as h, type ReactElement } from "react";
import type { PulseView } from "../pulse-status.ts";

/** The check beside Pulse's chip: decorative, the line under the chips says it in words. */
export function ConnectedTick(): ReactElement {
  return h("i", { className: "landing-tick", "aria-hidden": "true" });
}

/** The card's connection line. A live region, always in the card, so a connection made in the hero is announced. */
export function ConnectedRow(props: { view: PulseView }): ReactElement {
  const { connected, agentName, openHref } = props.view;
  return h(
    "div",
    { className: "landing-conn-row", role: "status" },
    connected &&
      h(
        "span",
        { className: "landing-conn" },
        h(ConnectedTick),
        agentName ? `${agentName} connected` : "Connected",
      ),
    connected && h("a", { className: "landing-conn-open", href: openHref }, "Open Pulse ", h("span", { "aria-hidden": "true" }, "↗")),
  );
}
