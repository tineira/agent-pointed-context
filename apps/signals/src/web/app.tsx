/**
 * Signals' page (TIN-384): the market feed of the visitor's demo world (the dock's seed, TIN-393, or one
 * of its own). Every post, and each of its parts (offer, audience, code, text), is a target. Agents
 * come both ways (TIN-578): from the agent dock (the first drop asks the person here, then in the dock;
 * later drops pin at once), or connected directly, each with its own URL, from the Connect panel (the
 * Direct profile's list from @tineira/apc-web). The same agent both ways shows as one.
 */
import { canonicalTarget, focusAttrs, type ApcProfile, type FocusRow, type FocusTarget } from "@tineira/apc-protocol";
import { createViewReporter, enablePinning, loadApcProfiles, mergePins, type AgentDrag, type BarAgent } from "@tineira/apc-web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDataset, MONTHS } from "../../../demo/src/model/seed.ts";
import { buildMarket, type Post } from "../../../demo/src/model/market.ts";
import { Avatar, brandOf, compact, Icon, stats, Verified } from "./brands.tsx";
import { AgentBar } from "./agent-bar.tsx";
import { ApcPin } from "./apc-pin.tsx";
import { openSession } from "./session.ts";
import { StartOver } from "../../../demo/src/web/start-over.tsx";
import { DirectAgents } from "../../../demo/src/web/direct-agents.tsx";

interface GrantState {
  id: string;
  path: ApcProfile;
  hub: string | null;
  agent: string | null;
  name: string;
  /** A Direct agent's secret, for its MCP URL; null for a dock's grant. */
  secret: string | null;
  client: string | null;
  icon: string | null;
  connected: boolean;
  waiting: boolean;
  pin: FocusRow | null;
  linked_with: string | null;
}
interface FeedState {
  seed: number;
  profiles: ApcProfile[];
  grants: GrantState[];
}
/** A dock agent to ask about; `consent` is the nonce the server asked with, sent back with the Allow (TIN-606). */
type Pending = { drag: AgentDrag & { hub: string; ticket: string }; target: FocusTarget; consent: string };

const DOCK_URL = import.meta.env.DEV ? "http://localhost:5200/dock" : "https://apc.tineira.com/dock";
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
    // The open is shared (TIN-490); an App that unmounted before it settled ignores the result.
    let live = true;
    openSession().then(
      (id) => live && setSid(id),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
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
        <p className="disclaimer">A fictional market feed, generated for your dock's demo world.</p>
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
  // The Connect panel (Direct): open when the visitor came to connect (?connect, from the dock's landing page).
  const [connectOpen, setConnectOpen] = useState(() => new URLSearchParams(location.search).has("connect") || location.hash === "#connect");
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
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        // Presence (APC 0.2) is published for the page; this page does not draw it, so it needs no new state.
        if (String(e.data).includes('"type":"presence"')) return;
        refresh();
      };
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
        // APC 0.5: a Signals that offers only Direct answers a dock agent's drop with how to connect directly,
        // and opens its Connect panel. Its profiles come from its own apc.json, so a drop before the page's
        // state has loaded is answered right too (held until the file is read).
        profiles: () => loadApcProfiles(),
        direct: { name: "Signals", connect: `${location.origin}/?connect` },
        onDockUnsupported: (answer) => {
          setConnectOpen(true);
          say(answer.message);
        },
        // Every dock drop goes to the server, which decides (TIN-606): an agent with no grant here comes back
        // consent_required with a nonce, and the person is asked, never on this page's last-loaded state.
        onUnknownAgent: async (drag, target) => {
          const r = await call<{ ok: boolean; error?: string; grant_id?: string; consent?: string }>(`${base}/hub/pair`, { hub: drag.hub, agent: drag.agent, ticket: drag.ticket, target });
          if (r.error === "consent_required" && r.consent) setPending({ drag, target, consent: r.consent });
          else if (r.ok) say(`Pinned ${stateRef.current?.grants.find((g) => g.id === r.grant_id)?.name ?? "your agent"}. Ask it about "this".`);
          else say(`Not pinned: ${r.error}`);
          refresh();
        },
        onPin: async (grantId, target) => {
          // A badge dropped back on its own target (a click) changes nothing: the pin keeps its read state.
          const current = stateRef.current?.grants.find((g) => g.id === grantId)?.pin;
          if (current && canonicalTarget(current) === canonicalTarget(target)) return;
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
  // An in-feed badge's × unpins only its own grant; the bar's merged entry for a linked agent is both
  // its grants, so its × takes the pin off both.
  const unpinGrant = (id: string) => void call(`${base}/unpin`, { grant_id: id }).then(refresh);
  const unpinEntry = (id: string) => {
    const partner = state.grants.find((g) => g.id === id)?.linked_with;
    void Promise.all([id, ...(partner ? [partner] : [])].map((gid) => call(`${base}/unpin`, { grant_id: gid }))).then(refresh);
  };
  // The standard agent bar (TIN-394): the agents here, the path each came by, their state, and where
  // each points. An agent linked across both paths (apc_link) is one entry, under its Direct grant.
  const onScreen = (postId: string) => shown.some((p) => p.id === postId);
  const barAgents: BarAgent[] = state.grants
    .filter((g) => !(g.path === "dock" && g.linked_with))
    .map((g) => {
      const other = g.linked_with ? state.grants.find((x) => x.id === g.linked_with) : undefined;
      const connected = g.connected || !!other?.connected;
      return {
        id: g.id,
        name: g.name,
        icon: g.icon ?? other?.icon ?? null,
        state: !connected ? "off" : g.waiting || other?.waiting ? "waiting" : "idle",
        // A linked agent holds two grants, so up to two pins: the bar shows both (TIN-607).
        pin: mergePins([g, other].map((x) => (x?.pin?.id ? { label: `${x.pin.id}${x.pin.part ? ` ${x.pin.part}` : ""}`, seen: !!x.pin.seen_at && x.pin.seen_at >= x.pin.pinned_at, here: onScreen(x.pin.id) } : null))),
        paths: other ? ["direct", "dock"] : [g.path],
      };
    });
  const offersDirect = state.profiles.includes("direct");
  const directAgents = state.grants
    .filter((g) => g.path === "direct" && g.secret)
    .map((g) => ({ id: g.id, name: g.name, url: `${location.origin}/mcp/${sid}/${g.secret}`, connected: g.connected, client: g.client, linked: !!g.linked_with }));
  const connectPanel = offersDirect && connectOpen && (
    <section className="panel connect" id="connect" aria-label="Connect an agent directly">
      <div className="connect-head">
        <h2>Connect an agent directly</h2>
        <button type="button" className="link" aria-label="Close" onClick={() => setConnectOpen(false)}>
          ×
        </button>
      </div>
      <p className="muted small">
        Your agent reads Signals on its own URL, and the feed goes straight to it. Once it is connected, drag its mark from the top onto any post. To use one agent across apps instead, connect it once to your <a href={DOCK_URL}>agent dock</a>.
      </p>
      <DirectAgents
        appName="Signals"
        agents={directAgents}
        onAdd={() =>
          void call<{ ok: boolean; error?: string }>(`${base}/grants/agent`, {}).then((r) => {
            if (!r.ok) say(`No new agent: ${r.error}`);
            refresh();
          })
        }
        onRename={(id, name) => void call(`${base}/grants/${id}/name`, { name }).then(refresh)}
      />
    </section>
  );
  const connectButton = offersDirect && !connectOpen && (
    <button type="button" className="connect-open" title="Connect an agent to Signals directly, on its own URL" onClick={() => setConnectOpen(true)}>
      Connect an agent
    </button>
  );
  const unlink = (id: string) => void call(`${base}/grants/${id}/unlink`, {}).then(refresh);
  const openPin = (id: string) => {
    // A linked agent has two grants and maybe two pins: open the one not on this page, else the first.
    const mine = state.grants.find((g) => g.id === id);
    const held = [mine, state.grants.find((g) => g.id === mine?.linked_with)].filter((g) => g?.pin?.id);
    const postId = (held.find((g) => !onScreen(g!.pin!.id!)) ?? held[0])?.pin?.id;
    if (!postId) return;
    setKind("");
    setMonth("");
    setTimeout(() => document.querySelector(`[data-focus="post:${postId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  // Revoke from the app (APC 0.2): at once, here; the dock learns it on its next call.
  const revoke = (id: string) => {
    const name = state.grants.find((g) => g.id === id)?.name ?? "Your agent";
    void call<{ ok: boolean; error?: string }>(`${base}/grants/${id}/revoke`, {})
      .then(
        (r) => (r.ok ? `Revoked ${name}: it can no longer read Signals. To let it back, connect it again here, or drop it here again from your dock.` : `Not revoked: ${r.error}`),
        (e: unknown) => `Not revoked: ${e instanceof Error ? e.message : String(e)}`,
      )
      .then((message) => {
        say(message);
        refresh();
      });
  };
  const bar = <AgentBar agents={barAgents} onOpen={openPin} onUnpin={unpinEntry} onRevoke={revoke} onUnlink={unlink} />;
  return (
    <Shell
      mobile={
        <div className="mobile-actions">
          {bar}
          {connectButton}
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
          {connectPanel}
        </>
      }
      side={
        <>
          <div className="bar-row">{bar}</div>
          {connectButton}
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
          <section className="panel muted small">Drag an agent onto a post, or onto its offer, targeting, code or text: from the dock, or its mark at the top. Your agent reads it with this feed's own tools.</section>
          <section className="panel muted small">
            <StartOver site="Signals" wipes={["the agents you connected here or your dock paired here, and their pins", "your view of this feed"]} reset={() => call(`${base}/reset`, {})} />
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
                <Pins grants={pinsOn(p.id, null)} onUnpin={unpinGrant} />
              </div>
              <p className="post-text" {...focusAttrs({ kind: "post", id: p.id, part: "text" })}>
                {parts[0]}
                {p.kind === "our_ad" && (
                  <span className="code" {...focusAttrs({ kind: "post", id: p.id, part: "code" })}>
                    {p.code}
                    <Pins grants={pinsOn(p.id, "code")} onUnpin={unpinGrant} />
                  </span>
                )}
                {parts[1]}
                <Pins grants={pinsOn(p.id, "text")} onUnpin={unpinGrant} />
              </p>
              <a className="creative" href={`https://${b.domain}`} onClick={(e) => e.preventDefault()} {...focusAttrs({ kind: "post", id: p.id, part: "offer" })}>
                <div className="creative-art" style={{ background: `linear-gradient(135deg, ${b.color}, ${b.color}cc 55%, #0b0e13)` }}>
                  <span className="creative-kicker">{p.kind === "competitor_offer" ? `Switch to ${p.author}` : "Pulse"}</span>
                  <span className="creative-headline">{p.offer}</span>
                  <span className="creative-cta">{b.cta}</span>
                  <Pins grants={pinsOn(p.id, "offer")} onUnpin={unpinGrant} />
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
                <Pins grants={pinsOn(p.id, "audience")} onUnpin={unpinGrant} />
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
          key={pending.consent}
          pending={pending}
          onDone={async (allow) => {
            if (!allow) return setPending(null);
            // The dialog stays, its buttons off, until the pairing answers (Grok on #123): one Allow, one request.
            const r = await call<{ ok: boolean; error?: string }>(`${base}/hub/pair`, { hub: pending.drag.hub, agent: pending.drag.agent, ticket: pending.drag.ticket, target: pending.target, consent: pending.consent }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
            // A newer drop's consent, shown meanwhile, stays.
            setPending((p) => (p === pending ? null : p));
            say(r.ok ? `Paired with the dock at ${new URL(pending.drag.hub).host}. Allow it there too, then ask your agent about "this".` : `Not paired: ${r.error === "ticket_expired" || r.error === "consent_required" ? "the drag is too old; drag the agent from the dock again" : r.error}`);
            refresh();
          }}
        />
      )}
    </Shell>
  );
}

/**
 * Agents pinned here, drawn by their mark (TIN-388): the standard pin badge, `<apc-pin>` from @tineira/apc-web
 * (TIN-482). It is a mark, so dragging it onto another part of a post moves the pin through the
 * same enablePinning as the agent bar's marks. Where it sits is Signals': inline next to a post part.
 */
function Pins(props: { grants: GrantState[]; onUnpin: (grantId: string) => void }) {
  if (!props.grants.length) return null;
  return (
    <span className="pins">
      {props.grants.map((g) => (
        <ApcPin key={g.id} id={g.id} name={g.name} icon={g.icon} seen={!!g.pin?.seen_at && g.pin.seen_at >= g.pin.pinned_at} onUnpin={props.onUnpin} />
      ))}
    </span>
  );
}

function Consent(props: { pending: Pending; onDone: (allow: boolean) => Promise<void> | void }) {
  const host = new URL(props.pending.drag.hub).host;
  // One answer per consent: the ref holds before the re-render that turns the buttons off (a double click).
  const answered = useRef(false);
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    if (answered.current) return;
    answered.current = true;
    setBusy(true);
    void props.onDone(allow);
  };
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="modal">
        <h2 id="consent-title">Let an agent from your dock read Signals?</h2>
        <p>
          You dropped an agent from the dock at <b>{host}</b>. If you allow it, Signals gives that dock its own access to this feed, the dock asks you once more, and from then on that agent reads Signals when you point it here.
        </p>
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => answer(true)}>
            {busy ? "Pairing…" : "Allow"}
          </button>
          <button type="button" disabled={busy} onClick={() => answer(false)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
