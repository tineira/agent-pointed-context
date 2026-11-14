/**
 * APC v2 (TIN-382): an agent dropped from a dock that Pulse does not know yet. Pulse asks the person
 * first, on its own page: may this agent read Pulse, and how much? On yes, Pulse makes a grant and
 * hands it to the dock's hub; the dock then asks too, and the agent reads Pulse only after both.
 *
 * The pairing code (APC 0.9, TIN-859): the dock's Allow needs a code. Since TIN-901 the consent does not show it: the
 * page holds it, and the Allow turns the consent into the handoff card (same place), with the code large, the time
 * left and Cancel. DockWaiting, the banner, is the same state after a reload. If the dock the person uses does not
 * ask for that code, the agent was someone else's: Cancel. Cancel ends the grant only while the dock has not
 * connected (APC 0.10); past the code's time the card stops showing the code.
 */
import type { AgentDrag } from "@tineira/apc-web";
import { formatPairingCode, type FocusTarget } from "@tineira/apc-protocol";
import { useEffect, useRef, useState } from "react";
import { REGIONS, type Region } from "../model/seed.ts";
import { ApcHandoff } from "./apc-handoff.tsx";
import type { Api, SandboxState } from "./api.ts";

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

/** A dock grant waiting on the dock, as Pulse's state has it (`hub_links`). */
export type HubLink = NonNullable<SandboxState["hub_links"]>[number];

type Phase =
  | { kind: "ask" }
  | { kind: "handoff"; grantId: string; held: { code: string; expires_at: string } }
  | { kind: "ended"; message: string };

/**
 * The consent, and after the Allow the same card in the same place as the handoff (TIN-901). Before Allow it shows no
 * code, only that the dock will ask for one: the page holds the code (`drop.pairing_code`) and reveals it on Allow.
 * The handoff card shows it large with a copy button and the time left, from Pulse's own state once that has the grant
 * (so it also hides the code when the dock took it), and goes when the dock connects or the grant goes. A refusal or an
 * expired code is said on the card, which asks the person to drag the agent again: a new code needs a new consent.
 */
export function HubConsent(props: {
  api: Api;
  drop: PendingDrop;
  /** Pulse's dock grants now: the card follows its grant's state. */
  links: readonly HubLink[];
  /** The Allow went through: the page refreshes, and notes a pin that failed (said on the waiting card). */
  onPaired: (grantId: string, pinError?: PinError) => void;
  /** The grant the card shows, so the page's banner does not show the same code twice; null once it goes. */
  onHandoff: (grantId: string | null) => void;
  /** Cancel on the card: takes the dock's access back (only in handoff). */
  onCancel: (grantId: string) => Promise<void>;
  /** A pin that failed where the agent was dropped, for this card's grant. */
  pinError?: string | undefined;
  onDone: (notice: string | null) => void;
}) {
  const [region, setRegion] = useState<Region | "">("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  // One Allow, one request: the ref holds before the re-render that turns the buttons off (a double click, Grok on #123).
  const sent = useRef(false);
  const seen = useRef(false);
  const host = new URL(props.drop.drag.hub).host;
  const { onHandoff, onDone } = props;
  const grantId = phase.kind === "handoff" ? phase.grantId : null;
  useEffect(() => {
    onHandoff(grantId);
    return () => onHandoff(null);
  }, [grantId, onHandoff]);
  const link = grantId ? props.links.find((l) => l.grant_id === grantId) : undefined;
  const inHandoff = link?.state === "handoff";
  // Once Pulse's state has had the grant in handoff and no longer does (or has it live), the dock connected or the grant went: the card is done.
  useEffect(() => {
    if (!grantId) return;
    if (inHandoff) seen.current = true;
    else if (seen.current || link?.state === "live") onDone(null);
  }, [grantId, inHandoff, link?.state, onDone]);
  const allow = async () => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    try {
      const r = await props.api.hubPair({ hub: props.drop.drag.hub, agent: props.drop.drag.agent, ticket: props.drop.drag.ticket, region: region || null, target: props.drop.target, consent: props.drop.consent });
      if (!r.ok || !r.grant_id) {
        setPhase({ kind: "ended", message: hubError(r.error) });
        return;
      }
      // Paired: the code the page held is shown now, with the expiry Pulse stored (APC 0.10 § 4).
      setPhase({ kind: "handoff", grantId: r.grant_id, held: { code: props.drop.pairing_code, expires_at: r.pairing?.expires_at ?? new Date(Date.now() + 120_000).toISOString() } });
      // A pin that failed while the pairing went through (pin_error) is said on the waiting card.
      props.onPaired(r.grant_id, r.pin_error ? { grantId: r.grant_id, error: r.pin_error } : undefined);
    } catch (error) {
      setPhase({ kind: "ended", message: String(error) });
    }
  };
  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="hub-consent-title">
      <div className="tour-modal">
        {phase.kind === "ask" ? (
          <>
            <h2 id="hub-consent-title">Let your agent from the dock at {host} read Pulse?</h2>
            <p>If you allow it, Pulse gives that dock its own access, the dock asks you once more, and from then on that agent reads Pulse when you point it here.</p>
            <p>After Allow, your dock will ask for a code.</p>
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
          </>
        ) : phase.kind === "ended" ? (
          <ApcHandoff host={host} pairing={null} message={phase.message} onCancel={() => props.onDone(null)} />
        ) : (
          <>
            <ApcHandoff host={host} pairing={link ? (link.pairing ?? null) : phase.held} onCancel={() => void props.onCancel(phase.grantId).then(() => props.onDone(null))} />
            {props.pinError && <p>Not pinned where you dropped it ({props.pinError}). Once your dock connects, drop the agent there again.</p>}
          </>
        )}
      </div>
    </div>
  );
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
