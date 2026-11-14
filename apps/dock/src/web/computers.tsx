/**
 * Your dock on more than one computer (TIN-838): Link another computer (a code, its QR and link), Join a
 * dock you already have (the code typed, or from the link), the yes a linked computer gives, and the list
 * of computers on the dock with Remove. One dock means one connection for each agent: a drop on any of
 * these computers reaches the same agent.
 */
import { useEffect, useRef, useState } from "react";
import { Qr } from "../../../demo/src/web/qr.tsx";
import { formatJoinCode, joinLink, normalizeJoinCode } from "../worker/devices.ts";
import { call, type DockDevice, type DockJoin, type DockState } from "./agent-page.tsx";
import { CopyRow } from "./setup.tsx";
import { agoLabel } from "../worker/reading.ts";

/** Now, again every second while `on`: for the countdowns. */
function useNow(on = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The computers waiting for a yes, live: a request whose time ran out goes from the page before the hub says so. */
export function pendingJoins(state: DockState, now: number): DockJoin[] {
  return (state.joins ?? []).filter((j) => j.status === "pending" && (j.answer_by ?? 0) > now);
}

/**
 * "A new computer wants to join this dock": on every linked computer's dock, above the agents, as a
 * pairing request is. Allow gives it the dock: every agent, where they point, pairing them with apps.
 */
export function JoinRequests(props: { state: DockState; base: string; refresh: () => void }) {
  const now = useNow((props.state.joins ?? []).some((j) => j.status === "pending"));
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = (id: string, action: "approve" | "deny") => {
    setSending(id);
    setError(null);
    void call<{ ok?: boolean }>(`${props.base}/joins/${id}`, { action })
      .then((r) => r?.ok === false && setError("That request is no longer waiting: its time ran out, or another computer answered it."))
      .catch(() => setError("Could not reach your dock. Try again."))
      .finally(() => {
        setSending(null);
        props.refresh();
      });
  };
  const joins = pendingJoins(props.state, now);
  if (!joins.length && !error) return null;
  return (
    <>
      {error && (
        <div className="decision-notice" role="status">
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>
            OK
          </button>
        </div>
      )}
      {joins.map((j) => (
        <section key={j.id} className="request join-request" role="alertdialog" aria-labelledby={`join-${j.id}`}>
          <h2 id={`join-${j.id}`} className="join-title">
            A new computer wants to join this dock
          </h2>
          <dl className="join-facts">
            <dt>Computer</dt>
            <dd>
              <b>{j.label}</b>
            </dd>
            <dt>Asked</dt>
            <dd>{j.asked_at ? agoLabel(j.asked_at, now) : "just now"}</dd>
            <dt>Answer within</dt>
            <dd>{clock((j.answer_by ?? now) - now)}</dd>
          </dl>
          <p>
            It will use <b>every agent here</b>, point them and see where they point, and pair them with apps. Allow it only if you just entered this dock's code on a computer of yours.
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={sending === j.id} onClick={() => decide(j.id, "approve")}>
              Allow
            </button>
            <button type="button" disabled={sending === j.id} onClick={() => decide(j.id, "deny")}>
              Deny
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

/** A panel of the dock (Link, Computers): its own title and a way back to the agents. */
function Panel(props: { title: string; back: () => void; children: React.ReactNode }) {
  return (
    <section className="dock-panel" aria-labelledby="dock-panel-title">
      <div className="dock-panel-head">
        <button type="button" className="icon-button" aria-label="Back to the dock" title="Back to the dock" onClick={props.back}>
          ←
        </button>
        <h2 id="dock-panel-title">{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}

/**
 * Link another computer: a code that works once and for two minutes, as text, QR and link. The code is
 * made when the panel opens (one at a time: a new one ends the last), and goes on Cancel.
 */
export function LinkPanel(props: { state: DockState; base: string; back: () => void; refresh: () => void }) {
  const [made, setMade] = useState<{ code: string; expires_at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const devicesAtStart = useRef((props.state.devices ?? []).length);
  const now = useNow();
  // One request at a time (Review round 1 on #158): a newer code ends the last, so two in flight could leave
  // the one on screen dead. And a code that arrives after the panel closed is cancelled at once.
  const [making, setMaking] = useState(false);
  const left = useRef(false);
  const cancelCode = (code: string) => void call(`${props.base}/link/cancel`, { code }).catch(() => undefined);
  const make = () => {
    if (making) return;
    setMaking(true);
    setError(null);
    void call<{ ok?: boolean; code?: string; expires_at?: number; error?: string }>(`${props.base}/link`, {})
      .then(
        (r) => {
          if (left.current) return r.ok && r.code ? cancelCode(r.code) : undefined;
          if (r.ok && r.code && r.expires_at) setMade({ code: r.code, expires_at: r.expires_at });
          else setError(r.error === "too_many_devices" ? "This dock has as many computers as it can hold. Remove one first." : "Could not make a code. Try again.");
          props.refresh();
        },
        () => !left.current && setError("Could not reach your dock. Try again."),
      )
      .finally(() => setMaking(false));
  };
  useEffect(make, []);
  const cancel = () => {
    left.current = true;
    if (made && made.expires_at > Date.now()) cancelCode(made.code);
    props.back();
  };
  const devices = props.state.devices ?? [];
  const joined = devices.length > devicesAtStart.current ? devices[devices.length - 1] : null;
  const waiting = pendingJoins(props.state, now);
  // The code is open until claimed. Once the hub showed it open, a code it no longer shows is spent: claimed
  // and waiting (the request above), or used, denied, cancelled elsewhere (Review round 1 on #158: a denied
  // code stayed on screen as if it still worked).
  const shownOpen = useRef<string | null>(null);
  if (made && props.state.link?.code === made.code) shownOpen.current = made.code;
  const spent = !!made && shownOpen.current === made.code && props.state.link?.code !== made.code;
  const claimed = spent && (waiting.length > 0 || (props.state.joins ?? []).some((j) => j.status === "approved"));
  const expired = !!made && !claimed && (made.expires_at <= now || spent);

  if (joined)
    return (
      <Panel title="Link another computer" back={props.back}>
        <div className="join-done" role="status">
          <b>{joined.label} joined your dock.</b>
          <p>It has the same agents and the same connection: your agent needs nothing new.</p>
        </div>
        <button type="button" className="primary" onClick={props.back}>
          Done
        </button>
      </Panel>
    );
  return (
    <Panel title="Link another computer" back={cancel}>
      <p>
        On the other computer, open <b>{location.host}/dock</b> (or Dock for Windows), choose <b>⋯ › Join a dock on another computer</b>, and enter this code. Or scan the QR, or open the link there.
      </p>
      {error && <p className="warn">{error}</p>}
      {made && !expired && !claimed && (
        <>
          <div className="join-code-block">
            <Qr text={joinLink(location.origin, made.code)} label="QR code of the link that joins this dock" />
            <span className="muted">Code</span>
            <span className="join-code">{formatJoinCode(made.code)}</span>
          </div>
          <CopyRow text={joinLink(location.origin, made.code)} label="Copy link" />
          <p className="muted">
            Works once. Expires in <b>{clock(made.expires_at - now)}</b>.
          </p>
        </>
      )}
      {claimed && <p className="join-note">A computer entered the code. Answer its request above: nothing joins without your yes.</p>}
      {expired && (
        <div className="row">
          <p>{spent ? "This code no longer works: it was used, or the request was denied." : "This code expired."}</p>
          <button type="button" className="primary" onClick={make} disabled={making}>
            New code
          </button>
        </div>
      )}
      <p className="join-note">This dock asks you before the other computer joins. Once linked, it uses the same agents and the same connection: your agent needs nothing new.</p>
      <div className="row">
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </Panel>
  );
}

/** What the person reads for each reason a join did not go through. */
const JOIN_ERRORS: Record<string, string> = {
  bad_code: "That is not a dock code: it has 9 letters and digits, like KQ7-M4P-2XD.",
  unknown_code: "No dock has that code. It works once and for 2 minutes: make a new one on the other computer.",
  busy: "Too many tries just now. Wait a minute, then try again.",
  dock_expired: "That dock no longer exists.",
  too_many_devices: "That dock has as many computers as it can hold. Remove one there first.",
  forbidden: "Open this from your dock's own page.",
  denied: "The other computer said no. Nothing joined.",
  expired: "Nobody answered on the other computer in time. Make a new code there and try again.",
  full: "That dock has as many computers as it can hold. Remove one there first.",
  unreachable: "Could not reach the dock. Try again.",
};

/**
 * Join a dock you already have: the code from the other computer (its link fills it in). Joined, the page
 * opens that dock; the dock this computer had is left (deleted if nothing was in it).
 */
export function JoinPanel(props: { initialCode: string; desktop: boolean; leaving: { agents: number } | "unknown" | null; cancel: () => void }) {
  const [code, setCode] = useState(props.initialCode);
  const [phase, setPhase] = useState<{ kind: "idle" } | { kind: "asking" } | { kind: "waiting"; claim: string; label: string } | { kind: "failed"; reason: string }>({ kind: "idle" });
  const [hasDock, setHasDock] = useState<boolean | null>(props.leaving === "unknown" ? null : !!props.leaving);
  useEffect(() => {
    if (props.leaving !== "unknown") return;
    void call<{ has_dock: boolean }>("/api/dock/mine").then((r) => setHasDock(r.has_dock), () => setHasDock(null));
  }, [props.leaving]);

  const join = () => {
    if (!normalizeJoinCode(code)) return setPhase({ kind: "failed", reason: "bad_code" });
    setPhase({ kind: "asking" });
    void call<{ ok?: boolean; claim?: string; label?: string; error?: string }>("/api/dock/join", { code, desktop: props.desktop }).then(
      (r) => setPhase(r.ok && r.claim ? { kind: "waiting", claim: r.claim, label: r.label ?? "this computer" } : { kind: "failed", reason: r.error ?? "unknown_code" }),
      (e: unknown) => setPhase({ kind: "failed", reason: /: 429$/.test(String(e)) ? "busy" : /: 403$/.test(String(e)) ? "forbidden" : "unreachable" }),
    );
  };
  // Waiting: ask for the answer every 1.5 s until it comes.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let stop = false;
    const ask = () =>
      call<{ status: string }>("/api/dock/join/status", { claim: phase.claim }).then(
        (r) => {
          if (stop) return;
          // A full load opens the joined dock from scratch: its state, its socket, and the desktop app's pets.
          if (r.status === "joined") location.replace("/dock");
          else if (r.status === "pending") timer = window.setTimeout(ask, 1500);
          else setPhase({ kind: "failed", reason: r.status });
        },
        () => !stop && (timer = window.setTimeout(ask, 3000)),
      );
    let timer = window.setTimeout(ask, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phase]);

  const leaving = props.leaving && props.leaving !== "unknown" ? props.leaving : hasDock ? { agents: -1 } : null;
  return (
    <section className="dock-panel" aria-labelledby="join-panel-title">
      <div className="dock-panel-head">
        <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={props.cancel}>
          ←
        </button>
        <h2 id="join-panel-title">Join a dock you already have</h2>
      </div>
      {phase.kind === "waiting" ? (
        <div className="join-waiting" role="status">
          <b>Waiting for a yes on your other computer…</b>
          <p>
            It shows there as <b>{phase.label}</b>. Answer within 2 minutes, and keep this page open until then.
          </p>
          {/* Stop waiting (Review round 1 on #158): the request on the other computer ends by itself. */}
          <div className="row">
            <button type="button" onClick={() => setPhase({ kind: "idle" })}>
              Stop waiting
            </button>
          </div>
        </div>
      ) : (
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <p>Your agents and their connection come with it. On your other computer: <b>⋯ › Link another computer</b>.</p>
          <label htmlFor="join-code">Code from your other computer</label>
          <input id="join-code" className="join-code-input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="KQ7-M4P-2XD" autoFocus />
          {phase.kind === "failed" && <p className="warn">{JOIN_ERRORS[phase.reason] ?? JOIN_ERRORS.unknown_code}</p>}
          {leaving && (
            <p className="join-note">
              This computer leaves the dock it has now{leaving.agents > 0 ? ` (${leaving.agents} connected agent${leaving.agents === 1 ? "" : "s"})` : ""}. That dock is not deleted when something is in it: other computers linked to it keep it, and with none it ends 7 days after its last use.
            </p>
          )}
          <p className="join-note">Only use a code from a computer of yours: whoever holds the dock sees where you point its agents.</p>
          <div className="row">
            <button type="submit" className="primary" disabled={phase.kind === "asking"}>
              Join
            </button>
            <button type="button" onClick={props.cancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The computers on this dock, with Remove for every one but this. */
export function ComputersPanel(props: { state: DockState; base: string; back: () => void; link: () => void; refresh: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const remove = (d: DockDevice) => {
    if (!confirm(`Remove ${d.label} from this dock? It stops opening this dock. Your agents, their apps and the other computers stay, but each agent gets a new connection URL, since that computer saw the old ones: reconnect your agents from the dock afterwards. Every browser extension sending page readings is unpaired too, so each asks once again on its next drop.`)) return;
    setError(null);
    void call<{ ok?: boolean }>(`${props.base}/devices/${d.id}/remove`, {})
      .then((r) => r?.ok === false && setError("Could not remove it: it may be gone already."))
      .catch(() => setError("Could not reach your dock. Try again."))
      .finally(props.refresh);
  };
  const devices = props.state.devices ?? [];
  return (
    <Panel title="Computers on this dock" back={props.back}>
      {error && <p className="warn">{error}</p>}
      <ul className="computers">
        {devices.map((d) => (
          <li key={d.id}>
            <div className="computer-who">
              <b>{d.label}</b>
              <span className="muted">
                Linked {agoLabel(d.created_at, Date.now())}
                {d.last_used_at && !d.current ? ` · used ${agoLabel(d.last_used_at, Date.now())}` : ""}
              </span>
            </div>
            {d.current ? (
              <span className="computer-this">This computer</span>
            ) : (
              <button type="button" onClick={() => remove(d)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="primary" onClick={props.link}>
        Link another computer
      </button>
      <div className="join-note">
        <p>
          <b>Remove</b> signs that computer out of this dock. Your agents, their apps and the other computers stay; each agent gets a new connection URL, which the dock shows for you to reconnect it.
        </p>
        <p>
          <b>Start over</b> (in ⋯) erases the dock on every computer.
        </p>
        <p>The dock lasts 7 days after its last use on any of them.</p>
      </div>
    </Panel>
  );
}
