/**
 * Signals' page (TIN-384): the market feed of the visitor's Pulse sandbox. Every post, and each of
 * its parts (offer, audience, code, text), is a target. Agents arrive from the agent dock: the
 * first drop asks the person here, then in the dock; later drops pin at once.
 */
import { focusAttrs, type FocusRow, type FocusTarget } from "@apc/protocol";
import { createViewReporter, enablePinning, type AgentDrag } from "@apc/web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDataset, MONTHS } from "../../../demo/src/model/seed.ts";
import { buildMarket, type Post } from "../../../demo/src/model/market.ts";

interface GrantState {
  id: string;
  hub: string;
  agent: string;
  name: string;
  connected: boolean;
  pin: FocusRow | null;
}
interface FeedState {
  seed: number;
  grants: GrantState[];
}
type Pending = { drag: AgentDrag & { hub: string; ticket: string }; target: FocusTarget };

const DOCK_URL = import.meta.env.DEV ? "http://localhost:5200/" : "https://v2.apc.tineira.com/";
const PULSE_URL = import.meta.env.DEV ? "http://localhost:5199/overview" : "https://pulse.v2.apc.tineira.com/overview";
const REGION_NAME: Record<string, string> = { latam: "LATAM", na: "North America", emea: "Europe" };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok && response.status !== 400) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export function App() {
  const [sid, setSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const seed = Number(new URLSearchParams(location.search).get("seed"));
    call<{ sid?: string; error?: string }>("/api/session", Number.isInteger(seed) && seed > 0 ? { seed } : {}).then(
      (r) => (r.sid ? setSid(r.sid) : setError(r.error ?? "error")),
      (e: unknown) => setError(String(e)),
    );
  }, []);
  if (error === "no_seed")
    return (
      <Shell>
        <p className="muted">
          Signals shows the market around one Pulse sandbox. Open it from <a href={PULSE_URL}>Pulse (APC v2)</a>, with the <b>Signals</b> link in its top bar.
        </p>
      </Shell>
    );
  if (error) return <Shell><p className="muted">Could not open Signals: {error}</p></Shell>;
  if (!sid) return <Shell><p className="muted">Opening Signals…</p></Shell>;
  return <Feed sid={sid} />;
}

function Shell(props: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="page">
      <header>
        <div className="brand">
          <span className="logo" aria-hidden="true">◎</span> Signals <span className="kicker">APC v2 · market feed</span>
        </div>
        {props.right}
      </header>
      <main>{props.children}</main>
    </div>
  );
}

function Feed({ sid }: { sid: string }) {
  const base = `/api/s/${sid}`;
  const [state, setState] = useState<FeedState | null>(null);
  const [kind, setKind] = useState<"" | Post["kind"]>("");
  const [month, setMonth] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stateRef = useRef<FeedState | null>(null);
  stateRef.current = state;

  const refresh = useCallback(() => void call<FeedState>(`${base}/state`).then(setState), [base]);
  useEffect(() => {
    refresh();
    let ws: WebSocket | null = null;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
      ws.onopen = () => ws?.send("ping");
      ws.onmessage = (e) => e.data !== "pong" && refresh();
      ws.onclose = () => !closed && setTimeout(open, 2000);
    };
    open();
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, [base, refresh]);

  const posts = useMemo(() => (state ? buildMarket(generateDataset(state.seed)).posts : []), [state?.seed]);
  const shown = posts.filter((p) => (!kind || p.kind === kind) && (!month || p.month === month));

  const say = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 8000);
  };

  // The view, as identifiers.
  const report = useMemo(() => createViewReporter((view) => void call(`${base}/view`, view)), [base]);
  useEffect(() => report({ screen: "feed", params: { ...(kind ? { kind } : {}), ...(month ? { month } : {}) }, selection: null }), [report, kind, month]);

  // Agents come only from the dock: a known one pins, an unknown one asks first.
  useEffect(
    () =>
      enablePinning({
        acceptNativeDrops: true,
        resolveAgent: (handle) => stateRef.current?.grants.find((g) => g.agent === handle)?.id ?? null,
        onUnknownAgent: (drag, target) => setPending({ drag, target }),
        onPin: async (grantId, target) => {
          const r = await call<{ ok: boolean; error?: string }>(`${base}/pin`, { grant_id: grantId, target });
          say(r.ok ? `Pinned ${stateRef.current?.grants.find((g) => g.id === grantId)?.name ?? "your agent"}. Ask it about "this".` : `Not pinned: ${r.error}`);
        },
      }),
    [base],
  );

  if (!state) return <Shell><p className="muted">Loading…</p></Shell>;
  const pinsOn = (postId: string, part: string | null) => state.grants.filter((g) => g.pin?.id === postId && (g.pin.part ?? null) === part);

  return (
    <Shell
      right={
        <div className="actions">
          <a href={PULSE_URL} target="_blank" rel="noreferrer">
            Pulse
          </a>
          <button type="button" onClick={() => window.open(DOCK_URL, "apc-dock", "popup,width=360,height=600")} title="Open your agent dock, and drag an agent from it onto a post">
            Dock
          </button>
        </div>
      }
    >
      {notice && <div className="notice">{notice}</div>}
      <div className="filters">
        {(["", "competitor_offer", "our_ad"] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {k === "" ? "All" : k === "competitor_offer" ? "Competitors" : "Our ads"}
          </button>
        ))}
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          <option value="">All months</option>
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">The market around your Pulse sandbox. Drag an agent from the dock onto a post, or onto its offer, audience or code.</p>
      <ul className="feed">
        {[...shown].reverse().map((p) => (
          <li key={p.id} className={`post ${p.kind}`} {...focusAttrs({ kind: "post", id: p.id })}>
            <Pins grants={pinsOn(p.id, null)} onUnpin={(id) => void call(`${base}/unpin`, { grant_id: id }).then(refresh)} />
            <div className="post-head">
              <b>{p.author}</b>
              <span className="muted">
                {p.kind === "competitor_offer" ? `competitor · ${p.month} to ${p.ends_month}` : `our ad · ${p.channel} · ${p.month}`}
              </span>
            </div>
            <p className="post-text" {...focusAttrs({ kind: "post", id: p.id, part: "text" })}>
              {p.text}
              <Pins grants={pinsOn(p.id, "text")} onUnpin={(id) => void call(`${base}/unpin`, { grant_id: id }).then(refresh)} />
            </p>
            <div className="chips">
              <span className="chip" {...focusAttrs({ kind: "post", id: p.id, part: "offer" })}>
                {p.offer}
                <Pins grants={pinsOn(p.id, "offer")} onUnpin={(id) => void call(`${base}/unpin`, { grant_id: id }).then(refresh)} />
              </span>
              <span className="chip" {...focusAttrs({ kind: "post", id: p.id, part: "audience" })}>
                {p.kind === "competitor_offer" ? `${REGION_NAME[p.audience.region]} · ${p.audience.plan}` : p.audience.region ? REGION_NAME[p.audience.region] : "everyone"}
                <Pins grants={pinsOn(p.id, "audience")} onUnpin={(id) => void call(`${base}/unpin`, { grant_id: id }).then(refresh)} />
              </span>
              {p.kind === "our_ad" && (
                <span className="chip code" {...focusAttrs({ kind: "post", id: p.id, part: "code" })}>
                  {p.code}
                  <Pins grants={pinsOn(p.id, "code")} onUnpin={(id) => void call(`${base}/unpin`, { grant_id: id }).then(refresh)} />
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <Consent
          pending={pending}
          onDone={async (allow) => {
            setPending(null);
            if (!allow) return;
            const r = await call<{ ok: boolean; error?: string }>(`${base}/hub/pair`, { hub: pending.drag.hub, agent: pending.drag.agent, ticket: pending.drag.ticket, target: pending.target });
            say(r.ok ? `Paired with the dock at ${new URL(pending.drag.hub).host}. Allow it there too, then ask your agent about "this".` : `Not paired: ${r.error === "ticket_expired" ? "the drag is too old (60 s); drag the agent from the dock again" : r.error}`);
            refresh();
          }}
        />
      )}
    </Shell>
  );
}

function Pins(props: { grants: GrantState[]; onUnpin: (grantId: string) => void }) {
  if (!props.grants.length) return null;
  return (
    <span className="pins">
      {props.grants.map((g) => {
        const seen = !!g.pin?.seen_at && g.pin.seen_at >= g.pin.pinned_at;
        return (
          <span key={g.id} className={`pin ${seen ? "seen" : "waiting"}`} title={`${g.name}: ${seen ? "read this pin" : "has not read this pin yet"}`}>
            {g.name}
            {seen ? " ✓" : ""}
            <button type="button" aria-label={`Remove ${g.name}'s pin`} onClick={() => props.onUnpin(g.id)}>
              ×
            </button>
          </span>
        );
      })}
    </span>
  );
}

function Consent(props: { pending: Pending; onDone: (allow: boolean) => void }) {
  const host = new URL(props.pending.drag.hub).host;
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="modal">
        <h2 id="consent-title">Let an agent from your dock read Signals?</h2>
        <p>
          You dropped an agent from the dock at <b>{host}</b>. If you allow it, Signals gives that dock its own access to this feed, the dock asks you once more, and from then on that agent reads Signals when you point it here.
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => props.onDone(true)}>
            Allow
          </button>
          <button type="button" onClick={() => props.onDone(false)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
