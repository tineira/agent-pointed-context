import { normalizePairingCode } from "@tineira/apc-protocol";

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

/**
 * What the dock tells the person when the hub refuses an answer (Fix check 4 on #120): a 400 with
 * { ok: false, error } is shown, never dropped.
 */
export function decisionNotice(error: unknown): string {
  switch (error) {
    case "approval_withdrawn":
      return "Approval was withdrawn; ask again. This app's domain was denied, unpaired or removed elsewhere in your dock while it was being approved, so it was not paired. Drop your agent on the app again to see the warning.";
    case "unknown_pairing":
      return "That request is no longer waiting: it was answered elsewhere, removed, or it expired. Drop your agent on the app again to ask again.";
    case "warning_required":
      return "This app is not verified, so it needs its warning: its request now shows it. Read it, then approve or deny.";
    case "app_blocked":
      return "The dock does not pair with this app right now, so it was not paired.";
    case "revoked":
      return "The app took the access back while it was being approved, so it was not paired.";
    case "invalid_action":
      return "That answer no longer applies to this request.";
    // The pairing code (APC 0.9, TIN-859). The three a person can try again after are said on the request's own card
    // (codeErrorText); these are for any surface that shows them as a notice.
    case "pairing_code_refused":
      return "Too many wrong codes, so the request was removed. Drop the agent on the app again.";
    case "wrong_pairing_code":
      return "Wrong code. Type the code the app shows, where you allowed the agent.";
    case "invalid_pairing_code":
      return "That is not a pairing code: it is 6 letters and digits, like K7M-4P2, shown by the app.";
    // Only a request without a code lands here (a coded one says it on its card): an app from before 0.9 (TIN-885).
    case "pairing_code_required":
      return "This app uses an older APC version that has no pairing code, so it was not paired. Ask its maker to update it, and Deny this request.";
    default:
      return `That did not go through (${typeof error === "string" ? error.slice(0, 40) : "error"}). Try again.`;
  }
}

/** Two views of what is on its way (the page's, and a card's own click before the page re-renders) as one. */
export function mergeInFlight(a: InFlight | undefined, b: InFlight | undefined): InFlight | undefined {
  return a === "deny" || b === "deny" ? "deny" : (a ?? b);
}

/**
 * The pairing code (APC 0.9, TIN-859). A request whose app sent a code is approved only with it: Allow is on once
 * what was typed is a code (6 characters, after case, spaces and dashes are ignored), and what goes to the hub is
 * that code, raw. Null while it is not one.
 */
export function typedCode(value: string): string | null {
  return normalizePairingCode(value);
}

/** The refusals a person can try again after on the same card; every other refusal goes to the dock's notice. */
export const CODE_RETRY_ERRORS = ["wrong_pairing_code", "invalid_pairing_code", "pairing_code_required"] as const;
export type CodeRetryError = (typeof CODE_RETRY_ERRORS)[number];
export const isCodeRetryError = (error: unknown): error is CodeRetryError => (CODE_RETRY_ERRORS as readonly unknown[]).includes(error);

/** A card's own error: which, the tries left after a wrong code, and when (so the same error twice is seen twice). */
export interface CodeError {
  error: CodeRetryError;
  attempts_left?: number;
  at: number;
}

/** What a card says under its code field. */
export function codeErrorText(e: Pick<CodeError, "error" | "attempts_left">): string {
  switch (e.error) {
    case "wrong_pairing_code": {
      const n = e.attempts_left;
      return typeof n === "number" ? `Wrong code. ${n} ${n === 1 ? "try" : "tries"} left.` : "Wrong code.";
    }
    case "invalid_pairing_code":
      return "That is not a pairing code: it is 6 letters and digits, like K7M-4P2.";
    case "pairing_code_required":
      return "Type the code the app shows.";
  }
}

/** What Float, the strip and the pets show in Allow's place for a request with a code: it is typed in the dock. */
export const CODE_IN_DOCK = "Allow it in your dock: it needs the code.";
