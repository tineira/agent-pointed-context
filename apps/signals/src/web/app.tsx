/**
 * Signals' page (TIN-384): the market feed of the visitor's demo world (the dock's seed, TIN-393). Every post, and each of
 * its parts (offer, audience, code, text), is a target. Agents arrive from the agent dock: the
 * first drop asks the person here, then in the dock; later drops pin at once.
 */
import { focusAttrs, type FocusRow, type FocusTarget } from "@apc/protocol";
import { createViewReporter, enablePinning, type AgentDrag } from "@apc/web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDataset, MONTHS } from "../../../demo/src/model/seed.ts";
import { buildMarket, type Post } from "../../../demo/src/model/market.ts";
import { Avatar, brandOf, compact, Icon, stats, Verified } from "./brands.tsx";
import { AgentBar } from "./agent-bar.tsx";
import { StartOver, startOverAsked } from "../../../demo/src/web/start-over.tsx";

interface GrantState {
  id: string;
  hub: string;
  agent: string;
  name: string;
  icon: string | null;
  connected: boolean;
  waiting: boolean;
  pin: FocusRow | null;
}
interface FeedState {
  seed: number;
  grants: GrantState[];
}
type Pending = { drag: AgentDrag & { hub: string; ticket: string }; target: FocusTarget };

const DOCK_URL = import.meta.env.DEV ? "http://localhost:5200/" : "https://v2.apc.tineira.com/";
const REGION_NAME: Record<string, string> = { latam: "Latin America", na: "North America", emea: "Europe" };
const PLAN_NAME: Record<string, string> = { starter: "Starter", team: "Team", business: "Business" };
const MONTH_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_NAME[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

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
          {startOverAsked() && <b>Nothing to start over here: this browser has no Signals feed. </b>}
          Signals shows the market of one demo world. Open it from your <a href={DOCK_URL}>agent dock</a>, with its <b>Signals</b> button: the dock opens every app on the same world.
        </p>
      </Shell>
    );
  if (error) return <Shell><p className="muted">Could not open Signals: {error}</p></Shell>;
  if (!sid) return <Shell><p className="muted">Opening Signals…</p></Shell>;
  return <Feed sid={sid} />;
}

function Shell(props: { children: React.ReactNode; nav?: React.ReactNode; side?: React.ReactNode; top?: React.ReactNode; mobile?: React.ReactNode }) {
  return (
    <div className="layout">
      <nav className="left">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
            <circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="14" cy="14" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="14" cy="14" r="2" fill="currentColor" />
          </svg>
          <span>Signals</span>
        </div>
        {props.nav}
        <p className="disclaimer">A fictional market feed, generated for your dock's demo world. APC v2 demo.</p>
      </nav>
      <main className="timeline">
        <div className="mobile-bar">
          <span className="brand">Signals</span>
          {props.mobile}
        </div>
        {props.top}
        {props.children}
      </main>
      <aside className="right">{props.side}</aside>
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
        // Every drop goes through the server, which checks with the dock that a pairing still stands (TIN-389).
        resolveAgent: () => null,
        onUnknownAgent: async (drag, target) => {
          const paired = stateRef.current?.grants.some((g) => g.hub === drag.hub && g.agent === drag.agent);
          if (!paired) return setPending({ drag, target });
          const r = await call<{ ok: boolean; error?: string; grant_id?: string }>(`${base}/hub/pair`, { hub: drag.hub, agent: drag.agent, ticket: drag.ticket, target });
          if (r.ok) say(`Pinned ${stateRef.current?.grants.find((g) => g.id === r.grant_id)?.name ?? "your agent"}. Ask it about "this".`);
          else if (r.error === "not_paired") setPending({ drag, target });
          else say(`Not pinned: ${r.error}`);
          refresh();
        },
        onPin: async (grantId, target) => {
          const r = await call<{ ok: boolean; error?: string }>(`${base}/pin`, { grant_id: grantId, target });
          say(r.ok ? `Pinned ${stateRef.current?.grants.find((g) => g.id === grantId)?.name ?? "your agent"}. Ask it about "this".` : `Not pinned: ${r.error}`);
        },
      }),
    [base],
  );

  if (!state) return <Shell><p className="muted">Loading…</p></Shell>;
  const pinsOn = (postId: string, part: string | null) => state.grants.filter((g) => g.pin?.id === postId && (g.pin.part ?? null) === part);

  const tabs: Array<["" | Post["kind"], string]> = [["", "For you"], ["competitor_offer", "Competitors"], ["our_ad", "Our ads"]];
  const advertisers = [...new Set(posts.map((p) => p.author))].map((a) => ({ author: a, n: posts.filter((p) => p.author === a).length }));
  const unpin = (id: string) => void call(`${base}/unpin`, { grant_id: id }).then(refresh);
  // The standard agent bar (TIN-394): the agents paired here, their state, and where each points.
  const onScreen = (postId: string) => shown.some((p) => p.id === postId);
  const barAgents = state.grants.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    state: (!g.connected ? "off" : g.waiting ? "waiting" : "idle") as "off" | "waiting" | "idle",
    pin: g.pin?.id ? { label: `${g.pin.id}${g.pin.part ? ` ${g.pin.part}` : ""}`, seen: !!g.pin.seen_at && g.pin.seen_at >= g.pin.pinned_at, here: onScreen(g.pin.id) } : null,
  }));
  const openPin = (id: string) => {
    const postId = state.grants.find((g) => g.id === id)?.pin?.id;
    if (!postId) return;
    setKind("");
    setMonth("");
    setTimeout(() => document.querySelector(`[data-focus="post:${postId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  const bar = <AgentBar agents={barAgents} onOpen={openPin} onUnpin={unpin} />;
  return (
    <Shell
      mobile={
        <div className="mobile-actions">
          {bar}
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            <option value="">All months</option>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </div>
      }
      nav={
        <>
          <ul className="nav">
            {tabs.map(([k, label]) => (
              <li key={k}>
                <button type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </>
      }
      top={
        <>
          <div className="tabs" role="tablist">
            {tabs.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                <span>{label}</span>
              </button>
            ))}
          </div>
          {notice && <div className="notice">{notice}</div>}
        </>
      }
      side={
        <>
          <div className="bar-row">{bar}</div>
          <section className="panel">
            <h2>Filter by month</h2>
            <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
              <option value="">All months</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
          </section>
          <section className="panel">
            <h2>Who's advertising</h2>
            <ul className="advertisers">
              {advertisers.map((a) => (
                <li key={a.author}>
                  <Avatar author={a.author} size={36} />
                  <span>
                    <b>{a.author}</b>
                    <span className="muted">@{brandOf(a.author).handle}</span>
                  </span>
                  <span className="muted">{a.n} ads</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel muted small">Drag an agent from the dock onto a post, or onto its offer, targeting, code or text. Your agent reads it with this feed's own tools.</section>
          <section className="panel muted small">
            <StartOver site="Signals" wipes={["the agents your dock paired here, and their pins", "your view of this feed"]} reset={() => call(`${base}/reset`, {})} />
          </section>
        </>
      }
    >
      {shown.length === 0 && <p className="empty muted">No posts in {monthLabel(month)}.</p>}
      {[...shown].reverse().map((p) => {
        const b = brandOf(p.author);
        const st = stats(p, state.seed);
        const parts = p.kind === "our_ad" ? p.text.split(p.code) : [p.text];
        return (
          <article key={p.id} className={`post ${p.kind}`} {...focusAttrs({ kind: "post", id: p.id })}>
            <Avatar author={p.author} />
            <div className="post-body">
              <div className="post-head">
                <b>{p.author}</b>
                <Verified />
                <span className="muted">
                  @{b.handle} · {MONTH_NAME[Number(p.month.slice(5)) - 1]} {st.day}
                </span>
                <Pins grants={pinsOn(p.id, null)} onUnpin={unpin} />
              </div>
              <p className="post-text" {...focusAttrs({ kind: "post", id: p.id, part: "text" })}>
                {parts[0]}
                {p.kind === "our_ad" && (
                  <span className="code" {...focusAttrs({ kind: "post", id: p.id, part: "code" })}>
                    {p.code}
                    <Pins grants={pinsOn(p.id, "code")} onUnpin={unpin} />
                  </span>
                )}
                {parts[1]}
                <Pins grants={pinsOn(p.id, "text")} onUnpin={unpin} />
              </p>
              <a className="creative" href={`https://${b.domain}`} onClick={(e) => e.preventDefault()} {...focusAttrs({ kind: "post", id: p.id, part: "offer" })}>
                <div className="creative-art" style={{ background: `linear-gradient(135deg, ${b.color}, ${b.color}cc 55%, #0b0e13)` }}>
                  <span className="creative-kicker">{p.kind === "competitor_offer" ? `Switch to ${p.author}` : "Pulse"}</span>
                  <span className="creative-headline">{p.offer}</span>
                  <span className="creative-cta">{b.cta}</span>
                  <Pins grants={pinsOn(p.id, "offer")} onUnpin={unpin} />
                </div>
                <div className="creative-meta">
                  <span className="muted">{b.domain}</span>
                  <span>{p.kind === "competitor_offer" ? `${p.author}: ${p.offer}` : `Pulse: ${p.offer}`}</span>
                </div>
              </a>
              <div className="targeting" {...focusAttrs({ kind: "post", id: p.id, part: "audience" })}>
                <span className="promoted">Promoted</span>
                {p.kind === "competitor_offer" ? (
                  <span>
                    Targeting {PLAN_NAME[p.audience.plan]} teams in {REGION_NAME[p.audience.region]} · runs {monthLabel(p.month)} to {monthLabel(p.ends_month)}
                  </span>
                ) : (
                  <span>
                    Targeting {p.audience.region ? `teams in ${REGION_NAME[p.audience.region]}` : "everyone"} · {p.channel} · {monthLabel(p.month)}
                  </span>
                )}
                <Pins grants={pinsOn(p.id, "audience")} onUnpin={unpin} />
              </div>
              <div className="engagement" aria-label="Engagement">
                <span title="Replies">
                  <Icon name="reply" /> {compact(st.replies)}
                </span>
                <span title="Reposts">
                  <Icon name="repost" /> {compact(st.reposts)}
                </span>
                <span title="Likes">
                  <Icon name="like" /> {compact(st.likes)}
                </span>
                <span title="Views">
                  <Icon name="views" /> {compact(st.views)}
                </span>
              </div>
            </div>
          </article>
        );
      })}
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

/**
 * Agents pinned here, drawn by their mark (TIN-388): the agent's icon, a dashed ring until it reads
 * the pin and a check once it has, as in Pulse. The name is the tooltip, not the label.
 */
function Pins(props: { grants: GrantState[]; onUnpin: (grantId: string) => void }) {
  if (!props.grants.length) return null;
  return (
    <span className="pins">
      {props.grants.map((g) => {
        const seen = !!g.pin?.seen_at && g.pin.seen_at >= g.pin.pinned_at;
        return (
          <span key={g.id} className={`pin ${seen ? "seen" : "waiting"}`} title={`${g.name}: ${seen ? "read this pin" : "has not read this pin yet"}`}>
            {g.icon ? (
              <img src={g.icon} width={22} height={22} alt={g.name} />
            ) : (
              <svg className="pin-fallback" width="20" height="20" viewBox="0 0 24 24" role="img" aria-label={g.name}>
                <path fill="currentColor" d="M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
              </svg>
            )}
            {seen && (
              <span className="pin-check" aria-hidden="true">
                ✓
              </span>
            )}
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
