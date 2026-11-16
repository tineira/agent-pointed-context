/** Dock drop refusals and the waiting card for grants made on /connect/dock. */
import { formatPairingCode } from "@tineira/apc-protocol";
import { useEffect, useState } from "react";

const ERRORS: Record<string, string> = {
  not_found: "Your dock did not accept the connection request and may be too old for Connect. Update your dock, then drop the agent again.",
  ticket_not_for_pairing: "Drop the agent again, then confirm in your dock.",
  ticket_origin_mismatch: "This link is for another app. Drop the agent again.",
  too_many_requests: "Your dock already has too many pending requests. Answer one, then drop the agent again.",
  ticket_expired: "The drag is too old. Drag the agent from the dock again.",
  consent_required: "This question is too old. Drag the agent from the dock again.",
  consent_expired: "This question is too old. Drag the agent from the dock again.",
  hub_not_allowed: "Pulse does not pair with that dock.",
  hub_unreachable: "The dock did not answer. Try again in a moment.",
  hub_refused: "The dock did not answer as a dock should, so Pulse didn't pair.",
  hub_ignores_pairing_code: "This dock can't check pairing codes, so Pulse didn't pair.",
  invalid_pairing_code: "The dock refused the pairing code. Drag the agent from the dock again.",
  pairing_code_required: "The dock wants a pairing code. Drag the agent from the dock again.",
  app_not_allowed: "The dock does not pair with this Pulse.",
  pairing_in_progress: "Pulse is still pairing this agent with the dock. Try again in a moment.",
  pairing_ended: "That pairing ended before the dock connected. Drag the agent from the dock again.",
  not_cancellable: "The dock has connected already. To take its access back, revoke the agent.",
  not_available: "This Pulse does not pair with docks.",
};

/** A refusal in words, for the page's notices. */
export function hubError(error: string | undefined): string {
  return ERRORS[error ?? ""] ?? error ?? "it did not go through";
}

/** A drop that paired but could not pin its target (the server's `pin_error`): the waiting card says so. */
export interface PinError {
  grantId: string;
  error: string;
}

/**
 * After the Allow (APC 0.9): Pulse waits for the person's dock to ask for the code. Shown from Pulse's own
 * state, so it comes back on a reload or a new drop, and goes once the dock connects or the grant goes.
 * Cancel takes the access back while the dock has not connected.
 */
export function DockWaiting(props: { hub: string; pairing: { code: string; expires_at: string } | null; onCancel: () => void; pinError?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Pulse's stored expiry is the truth (APC 0.10): the countdown stops at zero, and past it the code is no longer shown.
  const left = props.pairing ? Math.max(0, Math.ceil((Date.parse(props.pairing.expires_at) - now) / 1000)) : 0;
  const host = (() => {
    try {
      return new URL(props.hub).host;
    } catch {
      return props.hub;
    }
  })();
  return (
    <div className="mx-auto mt-3 w-full max-w-7xl px-5" role="status">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-filament/40 bg-filament-soft px-3 py-2 text-sm">
        {!props.pairing ? (
          <span>
            Your dock at <b>{host}</b> took the code and is connecting. If you didn't type a code there, the agent wasn't yours: Cancel.
          </span>
        ) : left > 0 ? (
          <span>
            Waiting for your dock at <b>{host}</b>: type <b className="pairing-code">{formatPairingCode(props.pairing.code)}</b> there ({left} s left). If your dock doesn't ask for this code, the agent wasn't yours: Cancel.
          </span>
        ) : (
          <span>
            Your dock at <b>{host}</b> didn't finish in time. Cancel, then drag the agent from the dock again.
          </span>
        )}
        <button type="button" className="tour-skip" onClick={props.onCancel}>
          Cancel
        </button>
        {props.pinError && <span className="basis-full text-muted">Not pinned where you dropped it ({props.pinError}). Once your dock connects, drop the agent there again.</span>}
      </div>
    </div>
  );
}
