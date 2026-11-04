/**
 * Which answers a pairing request takes while one is on its way (TIN-581, Fix check 2 on #120). Pure,
 * so the tests run it; the dock, an agent's page, Float, the strip and the pets all use it.
 *
 * An Approve on its way, or the hub still introducing itself to the app after one (`approving`), turns
 * Approve off and leaves Deny on, on the surface that sent it too: a misclick can always be undone, and
 * a Deny sent then reaches the hub, which lets it win. A Deny on its way turns both off.
 */
export type InFlight = "approve" | "deny";

/** The kind of answer an action is: Deny and Unpair say no, the rest say yes. */
export const kindOf = (action: string): InFlight => (action === "deny" || action === "unpair" ? "deny" : "approve");

/** What is on its way for one request, from the answers sent and not yet heard back: a Deny counts over an Approve. */
export function inFlightOf(sent: { approve?: boolean; deny?: boolean } | undefined): InFlight | undefined {
  return sent?.deny ? "deny" : sent?.approve ? "approve" : undefined;
}

/** Which buttons are off. */
export function buttonsOff(o: { inFlight?: InFlight; approving?: boolean }): { deny: boolean; approve: boolean } {
  return { deny: o.inFlight === "deny", approve: o.inFlight !== undefined || !!o.approving };
}

/** Whether an answer may be sent now: never twice the same kind, never a yes once anything is on its way. */
export function mayAnswer(action: string, o: { inFlight?: InFlight; approving?: boolean }): boolean {
  const off = buttonsOff(o);
  return kindOf(action) === "deny" ? !off.deny : !off.approve;
}

/** The answers on their way per request, as the page keeps them. */
export type Sent = ReadonlyMap<string, { approve?: boolean; deny?: boolean }>;

/** An answer of this kind leaves for this request. */
export function sentOut(m: Sent, id: string, kind: InFlight): Sent {
  return new Map(m).set(id, { ...m.get(id), [kind]: true });
}

/**
 * An answer of this kind came back, whatever it said, or failed on the way (Fix check 3 on #120): only that
 * kind clears, so a failed Deny can be sent again while an Approve is still on its way.
 */
export function landed(m: Sent, id: string, kind: InFlight): Sent {
  const next = new Map(m);
  const left = { ...next.get(id), [kind]: false };
  if (left.approve || left.deny) next.set(id, left);
  else next.delete(id);
  return next;
}

/**
 * What a card treats as on its way: the page's map, plus an Approve the card itself sent before the page
 * re-rendered. A Deny comes from the page's map alone, never from the card, so when one fails and the page
 * clears it the card's Deny is on again (Fix check 3 on #120).
 */
export function cardInFlight(page: InFlight | undefined, approveClicked: boolean): InFlight | undefined {
  return mergeInFlight(page, approveClicked ? "approve" : undefined);
}

/** Two views of what is on its way (the page's, and a card's own click before the page re-renders) as one. */
export function mergeInFlight(a: InFlight | undefined, b: InFlight | undefined): InFlight | undefined {
  return a === "deny" || b === "deny" ? "deny" : (a ?? b);
}
