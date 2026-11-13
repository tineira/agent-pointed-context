/**
 * A pending pairing request, as every surface of the dock shows it (TIN-859): the dock's page, an agent's page,
 * Float (its Picture-in-Picture window and the APC dock for Windows' strip) and the pets. One component, so the
 * pairing code (APC 0.9) is asked the same way everywhere.
 *
 * A request whose app sent a code is approved only with it. `entry` says where it can be typed:
 *
 * - `"field"` (the dock's page and an agent's page): the request, one labelled field for the code, its hint and its
 *   error, then Deny and Allow, Deny first and neither the default. Allow is off until what is typed is a code;
 *   Enter in the field is Allow only then. Typing is forgiving (case, spaces, a dash; a pasted `k7m-4p2`).
 * - `"dock"` (Float, the strip, the pets): no field and no Allow, only Deny and "Allow it in your dock: it needs the
 *   code." Float shrinks as an answer leaves, so a wrong code and its retry would be hidden there; the pets add a
 *   button that opens the dock.
 *
 * A request without a code (a reader, an app from before 0.9) keeps its buttons on every surface. An unverified
 * app keeps its warning (unverified.tsx), with the same field or note.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { formatPairingCode } from "@tineira/apc-protocol";
import { buttonsOff, CODE_IN_DOCK, codeErrorText, typedCode, type CodeError, type InFlight } from "./request-state.ts";
import { UnverifiedRequest, type CodeEntry, type UnverifiedAction } from "./unverified.tsx";

export interface PairingRequestProps {
  /** Where the code is typed: "field" on the dock's page and an agent's page, "dock" on Float, the strip and the pets. */
  entry: "field" | "dock";
  kind: "app" | "reader";
  /** The app's name (a verified app) or its domain (an unverified one), for "Type the code shown in …". */
  app: string;
  /** The app's host, for an unverified app's warning. */
  host: string;
  agent: string;
  /** What the request says, in this surface's words. */
  says: ReactNode;
  unverified?: { declared: string | null; warning: boolean };
  /** The app sent a pairing code: the request needs it. */
  code?: boolean;
  inFlight?: InFlight;
  approving?: boolean;
  /** The person's answer; an approval of a request with a code carries the code, raw. */
  decide: (action: UnverifiedAction, code?: string) => void;
  /** The hub's last refusal of a code for this request, said on the card (only the ones a person can retry). */
  error?: CodeError | null;
  /** Float and the pets: smaller type. */
  compact?: boolean;
  /** The pets: a button that opens the dock, where the code is typed. */
  openDock?: () => void;
  /** Float's card opened by a click: focus goes to the field, never to Allow. */
  focusField?: boolean;
}

export function PairingRequest(props: PairingRequestProps) {
  const id = useId();
  const [value, setValue] = useState("");
  // A wrong code clears the field, so the next try starts empty.
  useEffect(() => {
    if (props.error?.error === "wrong_pairing_code") setValue("");
  }, [props.error]);
  const code = props.code && props.kind === "app" ? typedCode(value) : null;
  const off = buttonsOff({ inFlight: props.inFlight, approving: props.approving });
  const approve = (action: UnverifiedAction) => {
    if (!props.code) return props.decide(action);
    if (props.entry !== "field" || !code || off.approve) return;
    props.decide(action, code);
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const field = (
    <div className="code-entry">
      <label htmlFor={`${id}-code`}>Code from {props.app}</label>
      <input
        id={`${id}-code`}
        className="code-input"
        value={value}
        maxLength={9}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="characters"
        inputMode="text"
        placeholder="K7M-4P2"
        autoFocus={props.focusField}
        aria-describedby={`${hintId} ${errorId}`}
        aria-invalid={props.error ? true : undefined}
        onChange={(e) => setValue(e.currentTarget.value)}
        onPaste={(e) => {
          // A pasted code, however it was written, reads as the app shows it.
          const pasted = typedCode(e.clipboardData.getData("text"));
          if (!pasted) return;
          e.preventDefault();
          setValue(formatPairingCode(pasted));
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          approve(props.unverified?.warning ? "approve_unverified" : "approve");
        }}
      />
      <p id={hintId} className="muted code-hint">
        It is on {props.app.endsWith("s") ? `${props.app}'` : `${props.app}'s`} screen, where you allowed the agent. If you didn&apos;t just do that, Deny.
      </p>
      <p id={errorId} className="code-error" aria-live="polite">
        {props.error ? codeErrorText(props.error) : ""}
      </p>
    </div>
  );
  const note = (
    <span className="code-elsewhere">
      {CODE_IN_DOCK}
      {props.openDock && (
        <>
          {" "}
          <button type="button" className="link" onClick={props.openDock}>
            Open the dock
          </button>
        </>
      )}
    </span>
  );
  const entry: CodeEntry | undefined = props.code && props.kind === "app" ? (props.entry === "field" ? { kind: "field", field, ready: !!code } : { kind: "dock", note }) : undefined;

  if (props.unverified)
    return (
      <UnverifiedRequest
        domain={props.host}
        declared={props.unverified.declared}
        agent={props.agent}
        warning={props.unverified.warning}
        inFlight={props.inFlight}
        approving={props.approving}
        decide={(action) => (action === "deny" ? props.decide("deny") : approve(action))}
        {...(props.compact ? { compact: true } : {})}
        {...(entry ? { code: entry } : {})}
      />
    );

  // A request without a code: its buttons as before.
  if (!entry)
    return (
      <>
        <p>{props.says}</p>
        <div className="row">
          <button type="button" className="primary" disabled={off.approve} onClick={() => props.decide("approve")}>
            Allow
          </button>
          <button type="button" disabled={off.deny} onClick={() => props.decide("deny")}>
            Deny
          </button>
        </div>
      </>
    );

  return (
    <>
      <p>
        {props.says}
        {entry.kind === "field" ? <> Type the code shown in {props.app}.</> : null}
      </p>
      {entry.kind === "field" ? entry.field : null}
      <div className="row">
        <button type="button" disabled={off.deny} onClick={() => props.decide("deny")}>
          Deny
        </button>
        {entry.kind === "field" ? (
          <button type="button" disabled={off.approve || !entry.ready} onClick={() => approve("approve")}>
            Allow
          </button>
        ) : (
          entry.note
        )}
      </div>
    </>
  );
}
