/**
 * APC v2 (TIN-382): an agent dropped from a dock that Pulse does not know yet. Pulse asks the person
 * first, on its own page: may this agent read Pulse, and how much? On yes, Pulse makes a grant and
 * hands it to the dock's hub; the dock then asks too, and the agent reads Pulse only after both.
 *
 * The pairing code (APC 0.9, TIN-859): the consent shows a code, and the dock's Allow needs it. After the
 * Allow, Pulse waits for the person's dock (DockWaiting): the code again, the time left, and Cancel. If the
 * dock the person uses does not ask for that code, the agent was someone else's: Cancel.
 */
import type { AgentDrag } from "@tineira/apc-web";
import { formatPairingCode, type FocusTarget } from "@tineira/apc-protocol";
import { useEffect, useRef, useState } from "react";
import { REGIONS, type Region } from "../model/seed.ts";
import type { Api } from "./api.ts";

export interface PendingDrop {
  drag: AgentDrag & { hub: string; ticket: string };
  target: FocusTarget;
  at: number;
  /** The nonce Pulse's server asked this consent with (TIN-606): the Allow sends it back, or no grant is made. */
  consent: string;
  /** The pairing code this consent shows (APC 0.9), raw: the person types it in their dock after the Allow. */
  pairing_code: string;
}

const ERRORS: Record<string, string> = {
  ticket_expired: "The drag is too old. Drag the agent from the dock again.",
  consent_required: "This question is too old. Drag the agent from the dock again.",
  hub_not_allowed: "Pulse does not pair with that dock.",
  hub_unreachable: "The dock did not answer. Try again in a moment.",
  hub_refused: "The dock did not answer as a dock should, so Pulse didn't pair.",
  hub_ignores_pairing_code: "This dock can't check pairing codes, so Pulse didn't pair.",
  invalid_pairing_code: "The dock refused the pairing code. Drag the agent from the dock again.",
  pairing_code_required: "The dock wants a pairing code. Drag the agent from the dock again.",
  app_not_allowed: "The dock does not pair with this Pulse.",
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

export function HubConsent(props: { api: Api; drop: PendingDrop; onDone: (notice: string | null, pinError?: PinError) => void }) {
  const [region, setRegion] = useState<Region | "">("");
  const [busy, setBusy] = useState(false);
  // One Allow, one request: the ref holds before the re-render that turns the buttons off (a double click, Grok on #123).
  const sent = useRef(false);
  const host = new URL(props.drop.drag.hub).host;
  const allow = async () => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    try {
      const r = await props.api.hubPair({ hub: props.drop.drag.hub, agent: props.drop.drag.agent, ticket: props.drop.drag.ticket, region: region || null, target: props.drop.target, consent: props.drop.consent });
      // Paired: the waiting card takes over, with the code (it comes from Pulse's state).
      // A pin that failed while the pairing went through (pin_error) is said on the waiting card.
      props.onDone(r.ok ? null : `Not paired: ${hubError(r.error)}`, r.ok && r.grant_id && r.pin_error ? { grantId: r.grant_id, error: r.pin_error } : undefined);
    } catch (error) {
      props.onDone(`Not paired: ${String(error)}`);
    }
  };
  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="hub-consent-title">
      <div className="tour-modal">
        <h2 id="hub-consent-title">Let your agent from the dock at {host} read Pulse?</h2>
        <p>
          If you allow it, Pulse gives that dock its own access, the dock asks you once more, and from then on that agent reads Pulse when you point it here.
        </p>
        <p>
          After Allow, your dock asks for this code: <b className="pairing-code">{formatPairingCode(props.drop.pairing_code)}</b>. Type it only in your own dock; never give it to anyone. Whoever types it gets this access.
        </p>
        <label className="flex items-center gap-2 text-sm">
          Access
          <select className="rounded-md border border-line bg-background px-2 py-1" value={region} onChange={(e) => setRegion(e.target.value as Region | "")}>
            <option value="">All of Pulse</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r.toUpperCase()} only
              </option>
            ))}
          </select>
        </label>
        <div className="tour-actions">
          <button type="button" className="tour-primary" disabled={busy} onClick={() => void allow()}>
            {busy ? "Pairing…" : "Allow"}
          </button>
          <button type="button" className="tour-skip" disabled={busy} onClick={() => props.onDone(null)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * After the Allow (APC 0.9): Pulse waits for the person's dock to ask for the code. Shown from Pulse's own
 * state, so it comes back on a reload or a new drop, and goes once the dock connects or the grant goes.
 * Cancel takes the access back while the dock has not connected.
 */
export function DockWaiting(props: { hub: string; pairing: { code: string; expires_at: string }; onCancel: () => void; pinError?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(props.pairing.expires_at) - now) / 1000));
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
        {left > 0 ? (
          <span>
            Waiting for your dock at <b>{host}</b>: type <b className="pairing-code">{formatPairingCode(props.pairing.code)}</b> there ({left} s left). If your dock doesn't ask for this code, the agent wasn't yours: Cancel.
          </span>
        ) : (
          <span>
            Your dock didn't finish in time. If it never asked for <b className="pairing-code">{formatPairingCode(props.pairing.code)}</b>, Cancel.
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
