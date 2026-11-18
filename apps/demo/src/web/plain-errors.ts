/**
 * A refusal from the app or the dock, in plain words for the page's notices. The server answers with codes
 * (`unknown_grant`, `hub_refused`, ...); a person never reads one. Pulse and Signals share it, each passing its
 * own name, so the sentences say which app. A code this table does not know gets one generic sentence: never the code.
 */

/** Said when a code is missing or not in the table. */
export const GENERIC_ERROR = "That did not go through. Try again in a moment.";

/** The sentence for a refusal code, for the app named (`Pulse` or `Signals`). */
export function plainError(app: string, error: string | undefined | null): string {
  const table: Record<string, string> = {
    // The dock side of a drop (pairing).
    not_found: "Your dock did not accept the connection request and may be too old to connect to apps. Update your dock, then drop the agent again.",
    ticket_not_for_pairing: "Drop the agent again, then confirm in your dock.",
    ticket_origin_mismatch: `This link is for another app. Drop the agent again.`,
    too_many_requests: "Your dock already has too many pending requests. Answer one, then drop the agent again.",
    ticket_expired: "The drag is too old. Drag the agent from the dock again.",
    dock_expired: "The drag is too old. Drag the agent from the dock again.",
    consent_required: "This question is too old. Drag the agent from the dock again.",
    consent_expired: "This question is too old. Drag the agent from the dock again.",
    hub_not_allowed: `${app} does not pair with that dock.`,
    app_not_allowed: `The dock does not pair with this ${app}.`,
    hub_unreachable: "The dock did not answer. Try again in a moment.",
    hub_refused: `The dock did not answer as a dock should, so ${app} didn't pair.`,
    hub_ignores_pairing_code: `This dock can't check pairing codes, so ${app} didn't pair.`,
    invalid_pairing_code: "The dock refused the pairing code. Drag the agent from the dock again.",
    pairing_code_required: "The dock wants a pairing code. Drag the agent from the dock again.",
    pairing_in_progress: `${app} is still pairing this agent with the dock. Try again in a moment.`,
    pairing_ended: "That pairing ended before the dock connected. Drag the agent from the dock again.",
    not_cancellable: "The dock has connected already. To take its access back, revoke the agent.",
    not_available: `This ${app} does not pair with docks.`,
    // Pinning, revoking and adding agents.
    unknown_grant: "That agent is no longer connected here. Connect it again, then try once more.",
    invalid_target: "The agent can't be pointed at that. Drop it on a customer, a chart or a post instead.",
    out_of_grant: "That agent can't read that part of the data, so it can't be pointed there.",
    too_many: "There are too many agents here already. Revoke one, then add another.",
    dock_only: `${app} takes agents through your dock only.`,
    invalid: "That did not go through. Reload the page and try again.",
    rate_limited: "Too many requests. Wait a minute, then try again.",
    forbidden: "This browser can't change that. Reload the page and try again.",
    expired: "This demo has expired. Reload the page to start a new one.",
    sandbox_expired: "This demo has expired. Reload the page to start a new one.",
    unauthorized: "This browser can't change that. Reload the page and try again.",
  };
  return Object.hasOwn(table, error ?? "") ? table[error!]! : GENERIC_ERROR;
}

/** A pin that failed: the notice's second half, after "Not pinned". */
export function plainPinError(app: string, error: string | undefined | null): string {
  if (error === "not_found") return "That is no longer in the data. Drop the agent on something else.";
  return plainError(app, error);
}
