/**
 * Apps outside APP_ORIGINS in the dock (TIN-581, DESIGN.md section 18): the warning the person
 * approves before one pairs, and the "Not verified" badge it keeps everywhere the dock names it. The
 * warning lives here, in the dock, never in the app's page; its words come from trust.ts, so the tests
 * read what the person reads. Deny is first and has the focus: the safe answer is the default.
 */
import { useEffect, useState, type ReactNode } from "react";
import { NOT_VERIFIED, splitHost, unverifiedWarning } from "../worker/trust.ts";
import { buttonsOff, cardInFlight, kindOf, mayAnswer, type InFlight } from "./request-state.ts";

export type UnverifiedAction = "approve" | "approve_unverified" | "deny";

/**
 * A request whose app sent a pairing code (APC 0.9, TIN-859), as a surface takes it: the field to type it in, and
 * whether what is typed is a code yet (Approve waits for it); or, on Float, the strip and the pets, no field and no
 * Approve, but a note in its place that it is answered in the dock.
 */
export type CodeEntry = { kind: "field"; field: ReactNode; ready: boolean } | { kind: "dock"; note: ReactNode };

/** The badge on an unverified app's request, its line in an agent's apps, and where an agent points. */
export function NotVerified() {
  return (
    <span className="not-verified" title="This app is not one the dock knows. It is named by its domain, and what it says comes to your agent marked untrusted.">
      {NOT_VERIFIED}
    </span>
  );
}

/**
 * An app's host on one line that never wraps (Review round 1 on #120): the domain someone registered
 * (`site`) is always shown whole, and the labels before it are shortened from the left when they do not
 * fit, so `pulse.apc.tineira.com.evil.example` reads "…tineira.com.evil.example", never a trusted-looking
 * "pulse.apc.tineira.com" alone on a line. The full host is in the title.
 */
export function HostName(props: { host: string; className?: string }) {
  const { head, site } = splitHost(props.host);
  return (
    <span className={`host-name${props.className ? ` ${props.className}` : ""}`} title={props.host}>
      {head && <span className="host-head">{head}</span>}
      <span className="host-site">
        {head ? "." : ""}
        {site}
      </span>
    </span>
  );
}

/**
 * The hub's refusal of an answer, said on the surface where it was given (Fix check 4 on #120): "Approval was
 * withdrawn; ask again." and the like (decisionNotice), until the person closes it or answers again.
 */
export function DecisionNotice(props: { notice: string | null; dismiss: () => void }) {
  if (!props.notice) return null;
  return (
    <div className="decision-notice" role="alert">
      <p>{props.notice}</p>
      <button type="button" className="link" onClick={props.dismiss} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

/**
 * A pending pairing with an unverified app. The first time its domain asks in this dock (`warning`),
 * the full warning: the domain first and big, the name the app gives itself only as secondary text,
 * the risk, Deny and Approve. Once the person approved that domain here, the usual request, with the badge.
 * While an Approve is on its way, or the hub is still introducing itself after one (`approving`), Approve is
 * off and Deny stays on, here too: a misclick can be undone (Fix check 2 on #120). A Deny on its way turns
 * both off (request-state.ts).
 */
export function UnverifiedRequest(props: {
  domain: string;
  declared: string | null;
  agent: string;
  warning: boolean;
  /** What the page has on its way for this request. */
  inFlight?: InFlight;
  /** The hub is still introducing itself to the app after a yes: Approve is off, Deny stays on, so the person can always say no. */
  approving?: boolean;
  decide: (action: UnverifiedAction) => void;
  /** Float and the pets: smaller type, same words. */
  compact?: boolean;
  /** The request needs the pairing code its app showed (APC 0.9): where it is typed, or that it is typed in the dock. */
  code?: CodeEntry;
}) {
  // An Approve this card sent, at once on a click, before the page re-renders: never two yeses. A Deny is the
  // page's alone (its in-flight map), so a Deny that fails is on again as soon as the page clears it (Fix check 3 on #120).
  const [approveClicked, setApproveClicked] = useState(false);
  // Cleared once the page has heard back and the hub is not approving, so a refused Approve can be given again.
  useEffect(() => {
    if (!props.inFlight && !props.approving) setApproveClicked(false);
  }, [props.inFlight, props.approving]);
  const state = { inFlight: cardInFlight(props.inFlight, approveClicked), approving: props.approving };
  const off = buttonsOff(state);
  // With a code, Approve also waits for what is typed to be one; on a surface without the field there is no Approve.
  const approveOff = off.approve || (props.code?.kind === "field" && !props.code.ready);
  const answer = (action: UnverifiedAction) => {
    if (!mayAnswer(action, state)) return;
    if (kindOf(action) === "approve" && (props.code?.kind === "dock" || approveOff)) return;
    if (kindOf(action) === "approve") setApproveClicked(true);
    props.decide(action);
  };
  const w = unverifiedWarning(props.domain, props.declared, props.agent);
  if (!props.warning)
    return (
      <>
        <p>
          <b>
            <HostName host={w.domain} />
          </b>{" "}
          <NotVerified /> wants to be read by <b>{props.agent}</b>. You approved this domain before in this dock; its tools and data still come marked untrusted.
          {props.code?.kind === "field" ? <> Type the code shown in {w.domain}.</> : null}
        </p>
        {props.code?.kind === "field" ? props.code.field : null}
        <div className="row">
          <button type="button" disabled={off.deny} onClick={() => answer("deny")}>
            Deny
          </button>
          {props.code?.kind === "dock" ? (
            props.code.note
          ) : (
            <button type="button" disabled={approveOff} onClick={() => answer("approve")}>
              Allow
            </button>
          )}
        </div>
      </>
    );
  return (
    <div className={`unverified-warning${props.compact ? " compact" : ""}`} role="alertdialog" aria-label={`${w.badge}: ${w.domain}`} aria-busy={off.approve}>
      <p className="unverified-domain">
        <HostName host={w.domain} />
      </p>
      <p>
        <NotVerified />
      </p>
      {w.declared && <p className="muted unverified-declared">{w.declared}</p>}
      <p>{w.ask}</p>
      <p className="unverified-risk">{w.risk}</p>
      {props.code?.kind === "field" ? props.code.field : null}
      <div className="row">
        {w.actions.map((a) =>
          a.action !== "deny" && props.code?.kind === "dock" ? (
            <span key={a.action}>{props.code.note}</span>
          ) : (
            <button key={a.action} type="button" className={a.default ? "primary" : undefined} autoFocus={a.default} disabled={a.action === "deny" ? off.deny : approveOff} onClick={() => answer(a.action)}>
              {a.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
