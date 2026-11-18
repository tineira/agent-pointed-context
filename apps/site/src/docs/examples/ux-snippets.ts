/**
 * The snippets of the UX guide at apc.tineira.com/docs/ux, kept here so the type checker reads them: a name
 * that drifts from @tineira/apc-web breaks the build, not the page. They show a pattern; none is an app.
 */
// #region imports
import { agentBadge, defineHandoff, definePinBadge, enablePinning, type ApcHandoffElement, type ApcPinElement } from "@tineira/apc-web";
import type { FocusTarget } from "@tineira/apc-protocol";

declare function post(path: string, body?: unknown): Promise<unknown>;
// #endregion

// #region pin
/** A pin badge on a row: the agent's logo, × to unpin. */
export function wearPin(row: HTMLElement, grantId: string, unpin: (grantId: string) => void): void {
  definePinBadge();
  const pin = document.createElement("apc-pin") as ApcPinElement;
  pin.agent = { id: grantId, name: "Claude", seen: false, badge: agentBadge({ clientName: "Claude", key: grantId }) };
  pin.addEventListener("apc-unpin", () => unpin(grantId));
  row.append(pin);
}
// #endregion

// #region tap
/** Pinning on a phone: tap the mark, then the target. Say what to do while an agent is armed, and give a way out. */
export function pinningWords(): () => void {
  return enablePinning({
    onPin: (grantId: string, target: FocusTarget) => void post(`/api/agents/${grantId}/pin`, { target }),
    strings: { tapPrompt: (name) => `Tap what you want ${name} to look at.`, cancel: "Cancel" },
  });
}
// #endregion

// #region handoff
/** The handoff card in the consent's place, from the Allow until the dock has the code. */
export function showHandoff(consentSlot: HTMLElement, hub: string, code: string, storedExpiry: string, grantId: string): void {
  defineHandoff();
  const card = document.createElement("apc-handoff") as ApcHandoffElement;
  card.host = new URL(hub).host;
  card.pairing = { code, expires_at: storedExpiry }; // the app's stored expiry, never a guess
  card.addEventListener("apc-cancel", () => void post("/api/cancel", { grant_id: grantId }));
  consentSlot.replaceChildren(card);
}
// #endregion
