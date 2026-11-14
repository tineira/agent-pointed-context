/**
 * Which mark is armed, on the mark itself (TIN-903). enablePinning keeps the armed agent's grant on the
 * document element (`data-apc-armed`); every mark of that agent, a pet, a pin badge or a mark in the agent
 * bar, wears `data-armed="true"` and `aria-pressed="true"` while it is armed, so an app needs no code of
 * its own to show it. A mark drawn after the agent was armed reads the same attribute when it is drawn.
 */
export const ARMED_ATTR = "data-apc-armed";

/** Puts (or takes off) the armed attributes on one mark, from the grant that is armed now. */
export function markArmed(mark: Element, grantId: string | null, armed: string | null = document.documentElement.getAttribute(ARMED_ATTR)): void {
  if (grantId !== null && armed === grantId) {
    mark.setAttribute("data-armed", "true");
    mark.setAttribute("aria-pressed", "true");
  } else {
    mark.removeAttribute("data-armed");
    mark.removeAttribute("aria-pressed");
  }
}

/** Every mark under the document, in step with the armed agent. */
export function syncArmedMarks(markSelector: string): void {
  const armed = document.documentElement.getAttribute(ARMED_ATTR);
  for (const m of document.querySelectorAll(markSelector)) markArmed(m, m.getAttribute("data-grant"), armed);
}
