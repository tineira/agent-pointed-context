/**
 * An agent's own page in the dock (TIN-419), at /dock/agents/<id>: who it is, what it did through
 * the dock, the apps it reads, how to connect it (folded), and Remove. Also the dock's shared types
 * and calls, and the Remove confirm (TIN-418).
 */
import { useEffect, useRef, useState } from "react";
import type { Onboarding } from "../onboarding.ts";
import { askToDisconnectPrompt } from "../../../demo/src/web/qr.tsx";
import { AgentPet } from "./apc-pet.tsx";
import { ConnectAgent, CopyRow } from "./setup.tsx";
import { agoLabel, READER_NOTICE, READING_TTL_MS, sizeLabel, type ReadingRow } from "../worker/reading.ts";
import { NotVerified, UnverifiedRequest } from "./unverified.tsx";
import { buttonsOff, type InFlight } from "./request-state.ts";

export interface AppRef {
  id: string;
  name: string;
  origin: string;
  /** An app outside APP_ORIGINS (TIN-580): name is its host; declared_name is what it calls itself. */
  unverified?: true;
  declared_name?: string | null;
}
export interface DockAgent {
  id: string;
  label: string;
  name: string;
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
  client_version: string | null;
  created_at: string;
  badge: string | null;
  mcp_url: string;
  last_active_at: string | null;
  waiting: boolean;
  /** A call other than wait_for_focus is in flight (TIN-483): the pet's "calling tools". */
  busy: boolean;
  /** How many calls the dock logged for this agent (TIN-419): a change refreshes its page. */
  calls: number;
  /** The page readings sent to this agent (TIN-422): site, time and size, newest first. */
  readings: ReadingRow[];
  focus: { app: AppRef; label: string; pinned_at: string; seen: boolean } | null;
  /** Apps, and browsers sending page readings (kind "reader", TIN-421). */
  /** revoked: the app revoked the grant itself (APC 0.2); revoked_by is the app's host. */
  /** warning: a pending unverified app whose domain the person has not approved in this dock asks with the warning (TIN-581). */
  /** blocked_by: our blocklist, or the kill switch that closes the dock to unverified apps. */
  pairings: Array<{ id: string; kind: "app" | "reader"; app: AppRef; status: "pending" | "paired" | "revoked" | "blocked"; created_at: string; page_open: boolean | null; error: string | null; revoked_by?: string; revoked_at?: string | null; warning?: boolean; approving?: boolean; blocked_by?: "blocklist" | "closed" }>;
  compat: { listed_after_pairing: boolean; listed_at: string | null; prefixed_calls: number; relay_calls: number; waits: number };
}
export interface DockState {
  seed: number;
  setup_done: boolean;
  onboarding: Onboarding;
  expires_at: string;
  agents: DockAgent[];
}

export const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok && response.status !== 400) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}


/**
 * Remove an agent (TIN-418), behind a confirm that says what goes. A connected agent keeps the dock's
 * server in its own settings, so the confirm gives the prompt that asks it to drop "APC".
 */
export function RemoveAgent(props: { agent: DockAgent; apps: string[]; remove: () => Promise<unknown> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const connected = !!props.agent.client_name;
  return (
    <div className="row small">
      <button type="button" className="danger-link" onClick={() => dialog.current?.showModal()}>
        Remove this agent
      </button>
      <dialog ref={dialog} className="confirm" onClick={(e) => e.target === dialog.current && !busy && dialog.current?.close()}>
        <h2>Remove {props.agent.name}?</h2>
        <p>
          Its MCP URL stops working{props.apps.length ? `, and ${props.apps.join(" and ")} lose${props.apps.length === 1 ? "s" : ""} it` : ""}. You can add a new agent any time.
        </p>
        {connected && (
          <>
            <p>Then remove the "APC" server from your agent. Paste this to it:</p>
            <CopyRow text={askToDisconnectPrompt("APC", location.host)} label="Copy prompt" block />
          </>
        )}
        <div className="row">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await props.remove().catch(() => undefined);
              dialog.current?.close();
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

/** One logged call (worker/logic.ts CallEntry). */
interface CallEntry {
  at: string;
  app: string | null;
  tool: string;
  via: "dock" | "prefixed" | "relay";
  pin: string | null;
  error: string | null;
}

const when = (iso: string | null) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** The tool as the agent called it: the dock's own, <app>__<tool>, or call_app_tool → app.tool. */
const toolName = (c: CallEntry) => (c.via === "dock" ? c.tool : c.via === "prefixed" ? `${c.app}__${c.tool}` : `call_app_tool → ${c.app}.${c.tool}`);

/** Each page reading sent to this agent (TIN-422, DESIGN.md 13.3), with Clear. The times move on by themselves. */
function Readings(props: { agent: DockAgent; clear: () => void }) {
  const rows = props.agent.readings;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="agent-section">
      <h2>Page readings</h2>
      {rows.length === 0 ? (
        <p className="muted">Each page you send {props.agent.name} shows here: the site, the time and the size. Drop it on a page with the <a href="/extension" target="_blank" rel="noreferrer">APC extension</a>.</p>
      ) : (
        <>
          <ol className="calls readings">
            {rows.map((r) => {
              const kept = r.kept && Date.parse(r.at) + READING_TTL_MS > now;
              return (
                <li key={r.at} className={kept ? undefined : "gone"}>
                  <span className="call-app">{r.site}</span>
                  <time dateTime={r.at} title={new Date(r.at).toLocaleString()}>{agoLabel(r.at, now)}</time>
                  <span>{sizeLabel(r.bytes)}</span>
                  <span className="reading-state">{kept ? "still at the dock" : "gone"}</span>
                </li>
              );
            })}
          </ol>
          <div className="row small">
            <button type="button" onClick={props.clear}>
              Clear
            </button>
            <span className="muted">Removes this list and any reading still at the dock. What the agent already read stays with it.</span>
          </div>
        </>
      )}
    </section>
  );
}

export function AgentPage(props: {
  agent: DockAgent;
  base: string;
  /** inFlight: what is on its way (an Approve turns Approve off, a Deny both); approving: the hub is introducing itself to the app (Approve off, Deny on). */
  requests: Array<{ id: string; kind: "app" | "reader"; app: AppRef; warning?: boolean; inFlight?: InFlight; approving?: boolean }>;
  decide: (pairingId: string, action: "approve" | "approve_unverified" | "deny" | "unpair") => void;
  refresh: () => void;
  back: () => void;
  dragProps: Record<string, unknown>;
  /** The person is dragging this agent (its pet stretches). */
  dragging?: boolean;
}) {
  const { agent: a, base } = props;
  const [calls, setCalls] = useState<CallEntry[] | null>(null);
  const connected = !!a.client_name;
  const paired = a.pairings.filter((p) => p.status === "paired");
  const revoked = a.pairings.filter((p) => p.status === "revoked");
  // On the blocklist the dock operates (TIN-580): never called, nothing relayed.
  const blocked = a.pairings.filter((p) => p.status === "blocked");
  const names = new Map(a.pairings.map((p) => [p.app.id, p.app.name]));
  useEffect(() => {
    call<{ calls: CallEntry[] }>(`${base}/agents/${a.id}/calls`).then((r) => setCalls(r.calls ?? []), () => setCalls([]));
  }, [base, a.id, a.calls]);
  // The calls per app and tool, for the summary line.
  const byApp = new Map<string, number>();
  for (const c of calls ?? []) byApp.set(c.app ? (names.get(c.app) ?? c.app) : "Dock", (byApp.get(c.app ? (names.get(c.app) ?? c.app) : "Dock") ?? 0) + 1);
  return (
    <main className="dock agent-page">
      <nav className="row">
        <button type="button" className="back" onClick={props.back}>
          ← Dock
        </button>
      </nav>

      <section className="agent-hero">
        <span className="agent-hero-pet" {...props.dragProps}>
          <AgentPet agent={a} size={88} dragging={props.dragging} />
        </span>
        <div className="who">
          <h1>{a.name}</h1>
          <p className="muted">
            {connected ? (
              <>
                {a.client_name}
                {a.client_version ? ` ${a.client_version}` : ""}
              </>
            ) : (
              "not connected yet"
            )}
          </p>
        </div>
      </section>
      <dl className="facts">
        <dt>Added</dt>
        <dd>{when(a.created_at)}</dd>
        <dt>Last used</dt>
        <dd>{when(a.last_active_at)}</dd>
        <dt>Points at</dt>
        <dd>
          {a.focus ? (
            <>
              {a.focus.app.name}
              {a.focus.app.unverified && (
                <>
                  {" "}
                  <NotVerified />
                </>
              )}
              : {a.focus.label} · {a.focus.seen ? <span className="read">read ✓</span> : "not read yet"}{" "}
              <button type="button" className="link" onClick={() => void call(`${base}/agents/${a.id}/clear`, {}).then(props.refresh)}>
                Clear pointer
              </button>
            </>
          ) : a.waiting ? (
            "nothing yet: waiting for you to point"
          ) : (
            "nothing"
          )}
        </dd>
      </dl>

      <section className="agent-section">
        <h2>What it did</h2>
        {connected && (
          <p className="compat" title="What this agent's client does with the dock, for the compatibility matrix (TIN-384)">
            Tools re-listed after pairing: {a.compat.listed_after_pairing ? "yes" : "not yet"} · prefixed calls {a.compat.prefixed_calls} · call_app_tool {a.compat.relay_calls} · waits {a.compat.waits}
          </p>
        )}
        {calls === null ? (
          <p className="muted">Loading…</p>
        ) : calls.length === 0 ? (
          <p className="muted">No calls yet. Once your agent reads something through the dock, each call shows here: the tool and the app, never what it read.</p>
        ) : (
          <>
            <p className="muted">
              {calls.length} call{calls.length === 1 ? "" : "s"}: {[...byApp].map(([app, n]) => `${app} ${n}`).join(" · ")}
            </p>
            <ol className="calls">
              {calls.map((c, i) => (
                <li key={i} className={c.error ? "failed" : undefined}>
                  <time dateTime={c.at}>{when(c.at)}</time>
                  <span className="call-app">{c.app ? (names.get(c.app) ?? c.app) : "Dock"}</span>
                  <code>{toolName(c)}</code>
                  {c.pin && <span className="pin" title="It read where you pointed it">read the pin: {c.pin}</span>}
                  {c.error && <span className="warn">failed: {c.error}</span>}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <Readings agent={a} clear={() => void call(`${base}/agents/${a.id}/readings/clear`, {}).then(props.refresh)} />

      <section className="agent-section">
        <h2>Its apps</h2>
        {props.requests.map((r) =>
          r.app.unverified ? (
            <div key={r.id} className="request unverified">
              <UnverifiedRequest domain={host(r.app.origin)} declared={r.app.declared_name ?? null} agent={a.name} warning={!!r.warning} inFlight={r.inFlight} approving={!!r.approving} decide={(action) => props.decide(r.id, action)} />
            </div>
          ) : (
          <div key={r.id} className="request">
            <p>
              {r.kind === "reader" ? (
                <>
                  <b>{r.app.name}</b> wants to send <b>{a.name}</b> page readings: the text you drop it on, on sites you allow in the <a href="/extension" target="_blank" rel="noreferrer">APC extension</a>. {READER_NOTICE}
                </>
              ) : (
                <>
                  <b>{r.app.name}</b> at <b>{host(r.app.origin)}</b> wants to be read by <b>{a.name}</b>.
                </>
              )}
            </p>
            <div className="row">
              <button type="button" className="primary" disabled={buttonsOff(r).approve} onClick={() => props.decide(r.id, "approve")}>
                Allow
              </button>
              <button type="button" disabled={buttonsOff(r).deny} onClick={() => props.decide(r.id, "deny")}>
                Deny
              </button>
            </div>
          </div>
          ),
        )}
        {paired.length === 0 && revoked.length === 0 && blocked.length === 0 && props.requests.length === 0 ? (
          <p className="muted">None yet. Drag {a.name} onto an app to pair it.</p>
        ) : (
          <ul className="apps">
            {paired.map((p) => (
              <li key={p.id}>
                <span>
                  {p.app.unverified ? (
                    // An unverified app (TIN-581): named by its domain, badged, and what it calls itself only as its own word.
                    <>
                      {p.app.name} <NotVerified />
                      <span className="muted">
                        {p.app.declared_name ? ` · calls itself “${p.app.declared_name}”` : ""} · since {when(p.created_at)}
                      </span>
                    </>
                  ) : (
                    <>
                      {p.app.name} <span className="muted">· {p.kind === "reader" ? "page readings" : host(p.app.origin)} · since {when(p.created_at)}</span>
                    </>
                  )}
                  {p.error ? <span className="warn"> · not answering</span> : p.page_open ? <span className="read"> · open now</span> : null}
                </span>
                <button type="button" onClick={() => props.decide(p.id, "unpair")}>
                  Unpair
                </button>
              </li>
            ))}
            {/* Revoked in the app itself (APC 0.2): the dock no longer reads it, and pairing again takes a new drop there. */}
            {revoked.map((p) => (
              <li key={p.id} className="revoked">
                <span>
                  {p.app.name} <span className="warn">· Revoked by {p.revoked_by ?? host(p.app.origin)}</span>
                  {p.revoked_at ? <span className="muted"> · {when(p.revoked_at)}</span> : null}
                  <span className="muted"> · drop {a.name} on it again to ask for access</span>
                </span>
                <button type="button" onClick={() => props.decide(p.id, "unpair")} title="Remove this line from the dock">
                  Remove
                </button>
              </li>
            ))}
            {blocked.map((p) => (
              <li key={p.id} className="revoked">
                <span>
                  {p.app.name} {p.app.unverified && <NotVerified />}{" "}
                  <span className="warn">
                    {p.blocked_by === "closed" ? `· Paused: the dock is not reading unverified apps right now` : `· Blocked: the dock no longer reads ${host(p.app.origin)}`}
                  </span>
                </span>
                <button type="button" onClick={() => props.decide(p.id, "unpair")} title="Remove this line from the dock">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="agent-section tile-details">
        <summary>Connection</summary>
        <ConnectAgent agent={a} />
      </details>

      <RemoveAgent agent={a} apps={paired.map((p) => p.app.name)} remove={() => call(`${base}/agents/${a.id}/remove`, {}).then(props.back)} />
    </main>
  );
}
