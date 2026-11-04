/**
 * Apps outside APP_ORIGINS in the dock (TIN-581, DESIGN.md section 18): the warning the person
 * approves before one pairs, and the "Not verified" badge it keeps everywhere the dock names it. The
 * warning lives here, in the dock, never in the app's page; its words come from trust.ts, so the tests
 * read what the person reads. Deny is first and has the focus: the safe answer is the default.
 */
import { NOT_VERIFIED, unverifiedWarning } from "../worker/trust.ts";

export type UnverifiedAction = "approve" | "approve_unverified" | "deny";

/** The badge on an unverified app's request, its line in an agent's apps, and where an agent points. */
export function NotVerified() {
  return (
    <span className="not-verified" title="This app is not one the dock knows. It is named by its domain, and what it says comes to your agent marked untrusted.">
      {NOT_VERIFIED}
    </span>
  );
}

/**
 * A pending pairing with an unverified app. The first time its domain asks in this dock (`warning`),
 * the full warning: the domain first and big, the name the app gives itself only as secondary text,
 * the risk, Deny and Approve. Once the person approved that domain here, the usual request, with the badge.
 */
export function UnverifiedRequest(props: {
  domain: string;
  declared: string | null;
  agent: string;
  warning: boolean;
  decide: (action: UnverifiedAction) => void;
  /** Float and the pets: smaller type, same words. */
  compact?: boolean;
}) {
  const w = unverifiedWarning(props.domain, props.declared, props.agent);
  if (!props.warning)
    return (
      <>
        <p>
          <b>{w.domain}</b> <NotVerified /> wants to be read by <b>{props.agent}</b>. You approved this domain before in this dock; its tools and data still come marked untrusted.
        </p>
        <div className="row">
          <button type="button" onClick={() => props.decide("deny")}>
            Deny
          </button>
          <button type="button" onClick={() => props.decide("approve")}>
            Allow
          </button>
        </div>
      </>
    );
  return (
    <div className={`unverified-warning${props.compact ? " compact" : ""}`} role="alertdialog" aria-label={`${w.badge}: ${w.domain}`}>
      <p className="unverified-domain">{w.domain}</p>
      <p>
        <NotVerified />
      </p>
      {w.declared && <p className="muted unverified-declared">{w.declared}</p>}
      <p>{w.ask}</p>
      <p className="unverified-risk">{w.risk}</p>
      <div className="row">
        {w.actions.map((a) => (
          <button key={a.action} type="button" className={a.default ? "primary" : undefined} autoFocus={a.default} onClick={() => props.decide(a.action)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
