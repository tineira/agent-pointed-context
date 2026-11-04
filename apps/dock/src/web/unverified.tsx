/**
 * Apps outside APP_ORIGINS in the dock (TIN-581, DESIGN.md section 18): the warning the person
 * approves before one pairs, and the "Not verified" badge it keeps everywhere the dock names it. The
 * warning lives here, in the dock, never in the app's page; its words come from trust.ts, so the tests
 * read what the person reads. Deny is first and has the focus: the safe answer is the default.
 */
import { useEffect, useState } from "react";
import { NOT_VERIFIED, splitHost, unverifiedWarning } from "../worker/trust.ts";

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
 * A pending pairing with an unverified app. The first time its domain asks in this dock (`warning`),
 * the full warning: the domain first and big, the name the app gives itself only as secondary text,
 * the risk, Deny and Approve. Once the person approved that domain here, the usual request, with the badge.
 * While an answer is on its way (`busy`, or a click here a moment ago), both buttons are off.
 */
export function UnverifiedRequest(props: {
  domain: string;
  declared: string | null;
  agent: string;
  warning: boolean;
  busy?: boolean;
  decide: (action: UnverifiedAction) => void;
  /** Float and the pets: smaller type, same words. */
  compact?: boolean;
}) {
  // Off at once on a click, before the page hears back: a second click cannot send a second answer.
  const [clicked, setClicked] = useState(false);
  // On again once the page has heard back (busy went true, then false), so a refused answer can be given again.
  useEffect(() => {
    if (!props.busy) setClicked(false);
  }, [props.busy]);
  const off = !!props.busy || clicked;
  const answer = (action: UnverifiedAction) => {
    if (off) return;
    setClicked(true);
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
        </p>
        <div className="row">
          <button type="button" disabled={off} onClick={() => answer("deny")}>
            Deny
          </button>
          <button type="button" disabled={off} onClick={() => answer("approve")}>
            Allow
          </button>
        </div>
      </>
    );
  return (
    <div className={`unverified-warning${props.compact ? " compact" : ""}`} role="alertdialog" aria-label={`${w.badge}: ${w.domain}`} aria-busy={off}>
      <p className="unverified-domain">
        <HostName host={w.domain} />
      </p>
      <p>
        <NotVerified />
      </p>
      {w.declared && <p className="muted unverified-declared">{w.declared}</p>}
      <p>{w.ask}</p>
      <p className="unverified-risk">{w.risk}</p>
      <div className="row">
        {w.actions.map((a) => (
          <button key={a.action} type="button" className={a.default ? "primary" : undefined} autoFocus={a.default} disabled={off} onClick={() => answer(a.action)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
