/**
 * The landing's hero, for real (TIN-1070): Pulse's chart of active customers and its agent bar, in a frame on
 * apc.tineira.com, beside a "your agent" window. The visitor asked for it with one click on the landing ("Use your own
 * agent", Tomas's decision of 2026-11-21), so the view opens the visitor's sandbox and makes its own agent when it
 * mounts, and shows the agent's MCP address at once. Then the visitor's agent connects, appears in the bar with its
 * name and logo, and pins for real: drag it onto a bar, tap it then a bar, or use the keyboard (enablePinning, as in
 * Pulse); its badge is a dashed, breathing ring until the agent reads, then a check; × unpins; dragging the badge moves
 * the pin. The agent's calls on this sandbox show as they arrive.
 *
 * What the view never does: show another grant's secret, revoke, allow, start over, wake, change settings, or link
 * anywhere (the frame is sandboxed: the landing owns "Open Pulse"). See the design, TIN-1063.
 */
import { canonicalTarget, type FocusTarget } from "@tineira/apc-protocol";
import { connectPrompt, dropExpiredWaits, enablePinning, foldWaitEvent, NO_OPEN_WAITS, nextWaitExpiry, waitOpen, type OpenWaits } from "@tineira/apc-web";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { demoDataset } from "../../model/demo-world.ts";
import { displayNames, motionFor, type AgentMotion } from "../agent-brands.ts";
import { PinBadges, isSeen, pinLabel } from "../pin-badges.tsx";
import { openSession } from "../session.ts";
import { EmbedAgentBar, type EmbedBarAgent } from "./agent-bar.tsx";
import { createEmbedApi, EMBED_VIEW, type EmbedApi, type GrantState, type SandboxState } from "./api.ts";
import { HeroChart, heroSeries, monthName, monthShort } from "./chart.tsx";
import { activeConflict, ensureEmbedGrant, qualifyingGrant, type EmbedGrantError } from "./grant.ts";
import { latestOnly } from "./latest.ts";
import { agentConnected, NOT_CONNECTED, pulseStatus, type createPoster } from "./messages.ts";

type Poster = ReturnType<typeof createPoster>;

/** How long what the agent read stays lit, and how long "is reading" stays after its last call. */
const LIT_MS = 4000;
const READING_MS = 6000;
/** The calls the agent window lists, newest last. */
const CALLS_SHOWN = 6;

/** The first wait before reading the state again after a failed read, and the longest. */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30_000;

const ERRORS: Record<EmbedGrantError | "session" | "rate_limited_session" | "expired" | "revoked" | "read" | "read_limited", string> = {
  rate_limited: "Pulse is making too many new agents right now. Try again in a minute.",
  rate_limited_session: "Too many new demos from your network in the last minute. Try again in a minute.",
  too_many: "This demo sandbox already has the most agents it can hold (20). Open Pulse to use one of them.",
  failed: "Pulse could not make your agent's address. Reload to try again, or open Pulse.",
  session: "Pulse could not open your demo sandbox. Reload to try again, or open Pulse.",
  expired: "This demo sandbox ended (they last 6 hours idle). Reload to start a new one.",
  read: "Pulse did not answer. Trying again…",
  read_limited: "Pulse is busy right now. Trying again in a moment…",
  revoked: "This agent's address was revoked in Pulse. Reload to get a new one.",
};

export function EmbedHero(props: { poster: Poster }) {
  const [opened, setOpened] = useState<{ sid: string; grantId: string } | { error: string } | null>(null);
  // Mounted: the landing shows the frame now (it keeps it hidden until this message).
  useEffect(() => props.poster.ready(), [props.poster]);
  useEffect(() => {
    let live = true;
    void (async () => {
      let sid: string;
      try {
        sid = await openSession();
      } catch (error) {
        if (live) setOpened({ error: /429/.test(String(error)) ? ERRORS.rate_limited_session : ERRORS.session });
        return;
      }
      const api = createEmbedApi(sid);
      // The sandbox makes the hero's one grant, or returns the one it made (idempotent: a reload never makes another).
      const result = await ensureEmbedGrant(sid, api.embedAgent);
      if (!live) return;
      if (!result.ok) return setOpened({ error: ERRORS[result.error] });
      // A new agent's view (the overview, § 4) is set by the sandbox when it makes the grant, so a lost answer keeps it.
      setOpened({ sid, grantId: result.grantId });
    })();
    return () => {
      live = false;
    };
  }, []);

  if (opened && "sid" in opened) return <Live sid={opened.sid} grantId={opened.grantId} poster={props.poster} />;
  return <Frame agent={<p className={opened ? "note note-error" : "note"} role="status">{opened ? opened.error : "Opening your Pulse demo…"}</p>} />;
}

/** The two windows: Pulse (the chart and the agent bar) and "your agent". */
function Frame(props: { chart?: ReactNode; bar?: ReactNode; agent: ReactNode }) {
  const series = useMemo(() => heroSeries(demoDataset()), []);
  return (
    <main className="stage">
      <section className="win app" aria-label="Pulse">
        <div className="win-bar">
          <i />
          <i />
          <i />
          <span>pulse · overview</span>
          <span className="live">live</span>
        </div>
        <div className="app-body">
          <h1 className="chart-title">
            Active customers <small>per month</small>
          </h1>
          {props.chart ?? <HeroChart series={series} pinned={null} lit={null} />}
          <div className="agentbar">{props.bar ?? <span className="agentbar-hint">Your agent appears here</span>}</div>
        </div>
      </section>
      <section className="win agent" aria-label="Your agent">
        <div className="win-bar">
          <i />
          <i />
          <i />
          <span>your agent</span>
        </div>
        <div className="agent-body">{props.agent}</div>
      </section>
    </main>
  );
}

interface Call {
  id: number;
  tool: string;
}

function Live(props: { sid: string; grantId: string; poster: Poster }) {
  const { sid, grantId, poster } = props;
  const api: EmbedApi = useMemo(() => createEmbedApi(sid), [sid]);
  const data = useMemo(demoDataset, []);
  const series = useMemo(() => heroSeries(data), [data]);
  const [state, setState] = useState<SandboxState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [busyAt, setBusyAt] = useState<number | null>(null);
  const [seenAt, setSeenAt] = useState<number | undefined>(undefined);
  const [openWaits, setOpenWaits] = useState<OpenWaits>(NO_OPEN_WAITS);
  const [onScreen, setOnScreen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);
  const nextCall = useRef(0);
  const stateRef = useRef<SandboxState | null>(null);
  stateRef.current = state;
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The state is the truth (B-3 of PR #245's review): read on mount, on every socket open and close (what changed while
  // it was down is not replayed), and on any message the view does not fold in itself. The sandbox gone (404) or no
  // longer this browser's (403) ends the view; any other failure (a 429, the network, a 5xx) shows inline and reads
  // again with backoff, so the view never stays on "Opening…".
  const [ended, setEnded] = useState(false);
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; delay: number }>({ timer: null, delay: RETRY_FIRST_MS });
  const alive = useRef(true);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);
  // Only the newest read counts (fix round 2, B-3): one a later read superseded is dropped, error and retry included.
  const readState = useMemo(() => latestOnly(() => api.state()), [api]);
  refreshRef.current = async () => {
    const outcome = await readState();
    if (!alive.current || !outcome.current) return;
    if (outcome.ok) {
      const next = outcome.value;
      if (retry.current.timer) clearTimeout(retry.current.timer);
      retry.current = { timer: null, delay: RETRY_FIRST_MS };
      setFailure(null);
      setState(next);
    } else {
      const status = (outcome.error as { status?: number })?.status;
      if (status === 404 || status === 403) {
        setEnded(true);
        setState(null);
        return;
      }
      setFailure(status === 429 ? ERRORS.read_limited : ERRORS.read);
      if (!retry.current.timer) {
        const delay = retry.current.delay;
        retry.current = { delay: Math.min(RETRY_MAX_MS, delay * 2), timer: setTimeout(() => {
          retry.current.timer = null;
          void refreshRef.current();
        }, delay) };
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      if (retry.current.timer) clearTimeout(retry.current.timer);
      retry.current = { timer: null, delay: RETRY_FIRST_MS };
    };
  }, [refresh]);

  // Only the grant the sandbox gave the hero, and only while it qualifies (revoked, it is gone).
  const grant: GrantState | null = state ? qualifyingGrant(state, grantId) : null;
  const name = grant ? (displayNames([grant]).get(grant.id) ?? grant.label) : "Your agent";
  const connected = agentConnected(grant);
  const pinnedMonth = typeof grant?.pin?.params?.month === "string" ? grant.pin.params.month : null;
  const pinnedMonthRef = useRef(pinnedMonth);
  pinnedMonthRef.current = pinnedMonth;

  // The landing learns only whether the agent is connected, and its cleaned name (§ 5): not connected once the sandbox
  // ended or the grant is gone, whatever it said before.
  useEffect(() => {
    if (ended) poster.status(NOT_CONNECTED);
    else if (state) poster.status(pulseStatus(grant, grant ? name : null));
  }, [ended, state, grant, name, poster]);

  // The sandbox's messages: this agent's calls, waits and pin; anything else refreshes the state.
  // Not once the sandbox ended: nothing is left to listen to.
  useEffect(
    () =>
      ended ? undefined : api.connect((message) => {
        if (message.type === "activity") return;
        if (message.type === "presence") {
          const event = message.event;
          if (event.grant_id !== grantId) return;
          if (event.kind === "wait") return setOpenWaits((w) => foldWaitEvent(w, event));
          const now = Date.now();
          setCalls((c) => [...c, { id: ++nextCall.current, tool: event.tool }].slice(-CALLS_SHOWN));
          setReadAt(now);
          setBusyAt(now);
          const month = pinnedMonthRef.current;
          if (month) {
            setLit(month);
            if (litTimer.current) clearTimeout(litTimer.current);
            litTimer.current = setTimeout(() => setLit(null), LIT_MS);
          }
          setTimeout(() => tick((n) => n + 1), READING_MS + 50);
          return;
        }
        if (message.type === "pin") {
          if (message.grant_id !== grantId) return;
          const pin = message.pin;
          if (pin?.seen_at && pin.seen_at >= pin.pinned_at) {
            setSeenAt(Date.now());
            setTimeout(() => tick((n) => n + 1), 1300);
          }
          setState((s) => (s ? { ...s, grants: s.grants.map((g) => (g.id === grantId ? { ...g, pin } : g)) } : s));
          return;
        }
        void refresh();
      }, () => void refresh()),
    [api, grantId, refresh, ended],
  );
  useEffect(() => () => {
    if (litTimer.current) clearTimeout(litTimer.current);
  }, []);
  // A wait whose closed was lost runs out at the ceiling plus the margin (APC 0.11).
  useEffect(() => {
    const at = nextWaitExpiry(openWaits);
    if (at === null) return;
    const id = setTimeout(() => setOpenWaits((w) => dropExpiredWaits(w)), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [openWaits]);

  // Pinning, as Pulse's: drag, tap then a bar, or the keyboard. Only this view's own agent, only what this view shows,
  // and no drop from another window (acceptNativeDrops off; no dock pairing, no Direct-only note linking elsewhere).
  useEffect(
    () =>
      enablePinning({
        acceptNativeDrops: false,
        canTarget: (id) => id === grantId,
        onPin: async (id, target: FocusTarget) => {
          if (id !== grantId) return;
          const current = stateRef.current?.grants.find((g) => g.id === id)?.pin;
          if (current && canonicalTarget(current) === canonicalTarget(target)) return;
          const result = await api.pin(id, target).catch(() => null);
          if (!result || result.status !== 200 || !result.json?.ok) {
            setNotice("Not pinned. Pulse did not answer; try again.");
            setTimeout(() => setNotice(null), 5000);
            return;
          }
          void api.reportView(EMBED_VIEW).catch(() => undefined);
        },
      }),
    [api, grantId],
  );

  const unpin = useCallback((id: string) => {
    if (id === grantId) void api.unpin(id).catch(() => undefined);
  }, [api, grantId]);

  const motionOf = (id: string): AgentMotion =>
    motionFor({
      connected: connected && id === grantId,
      waiting: waitOpen(openWaits, id, { path: "direct" }),
      busy: busyAt !== null && Date.now() - busyAt < 1500,
      seenAt,
      now: Date.now(),
    });

  if (ended) return <Frame agent={<p className="note note-error" role="status">{ERRORS.expired}</p>} />;
  if (!state) {
    return (
      <Frame
        agent={
          failure ? (
            <div className="note note-error" role="status">
              <p>{failure}</p>
              <button type="button" className="btn" onClick={() => void refresh()}>
                Try again now
              </button>
            </div>
          ) : (
            <p className="note" role="status">Opening your Pulse demo…</p>
          )
        }
      />
    );
  }
  if (!grant) return <Frame agent={<p className="note note-error" role="status">{ERRORS.revoked}</p>} />;

  const url = `${location.origin}/mcp/${sid}/${grant.secret}`;
  const seen = grant.pin ? isSeen(grant.pin) : false;
  const barAgent: EmbedBarAgent = {
    id: grant.id,
    name,
    client_name: grant.client_name,
    client_ua: grant.client_ua,
    client_icon: grant.client_icon,
    icon: grant.client_icon,
    state: motionOf(grant.id),
    pin: grant.pin ? { label: pinLabel(grant.pin), seen, here: onScreen.has(grant.id) } : null,
    restricted: false,
    paths: ["direct"],
  };
  const conflict = activeConflict(grant);
  const reading = readAt !== null && Date.now() - readAt < READING_MS;

  return (
    <>
      <Frame
        chart={<HeroChart series={series} pinned={pinnedMonth} lit={lit} />}
        bar={
          <>
            <EmbedAgentBar agents={[barAgent]} onUnpin={unpin} />
            <span className="agentbar-hint">{barHint(pinnedMonth, seen)}</span>
          </>
        }
        agent={
          <>
            {conflict && (
              <p className="note note-error" role="alert">
                Another app is using this address. Give each app its own: open Pulse, beside this demo, to make another.
              </p>
            )}
            {failure && (
              <p className="note note-error" role="status">
                {failure}
              </p>
            )}
            {notice && (
              <p className="note note-error" role="status">
                {notice}
              </p>
            )}
            {connected ? (
              <Connected name={name} pinnedMonth={pinnedMonth} seen={seen} reading={reading} calls={calls} url={url} />
            ) : (
              <ConnectPanel url={url} />
            )}
          </>
        }
      />
      <PinBadges grants={[grant]} motionOf={motionOf} onUnpin={unpin} onPlaced={setOnScreen} />
    </>
  );
}

/** What the agent bar says beside the agent. */
function barHint(month: string | null, seen: boolean): ReactNode {
  if (!month) {
    return (
      <>
        <span className="hint-pointer">Drag your agent onto a bar</span>
        <span className="hint-touch">Tap your agent, then a bar</span>
      </>
    );
  }
  return seen ? `Read: ${monthShort(month)} ✓` : `Pinned on ${monthShort(month)}`;
}

/** Before the agent connects: its MCP address, Copy, and Copy a prompt (as Pulse's Agents page). */
function ConnectPanel(props: { url: string }) {
  return (
    <div className="connect">
      <h2>Connect your agent</h2>
      <p>Paste it into your agent (Claude, ChatGPT, Cursor, Grok…) as a remote MCP server</p>
      <CopyRow text={props.url} label="MCP address" button="Copy" field />
      <CopyRow text={connectPrompt(props.url, "Pulse")} label="Or ask your agent to add it" button="Copy a prompt" />
      <p className="fine">The address is your agent's key to this demo sandbox: made-up data, gone after 6 hours idle. Share it with nothing else.</p>
      <p className="waiting" role="status">
        <span className="dot" aria-hidden="true" /> Waiting for your agent to connect…
      </p>
    </div>
  );
}

function CopyRow(props: { text: string; label: string; button: string; field?: boolean }) {
  const [said, setSaid] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string) => {
    setSaid(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 2500);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    // A click inside the frame is the gesture the clipboard needs (the landing allows clipboard-write).
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return say(props.field ? "Copy is blocked here: select the address and copy it." : "Copy is blocked here.");
    clipboard.writeText(props.text).then(
      () => say("Copied"),
      () => say(props.field ? "Copy is blocked here: select the address and copy it." : "Copy is blocked here."),
    );
  };
  return (
    <div className="copy-row">
      {props.field && (
        <label className="copy-field">
          <span className="sr-only">{props.label}</span>
          <input readOnly value={props.text} spellCheck={false} onFocus={(e) => e.currentTarget.select()} aria-label={props.label} />
        </label>
      )}
      {!props.field && <span className="copy-label">{props.label}</span>}
      <button type="button" className={props.field ? "btn primary" : "btn"} onClick={copy}>
        {props.button}
      </button>
      <span className="copied" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

/** After the agent connects: what to do next, who is reading what, and its calls on this sandbox. */
function Connected(props: { name: string; pinnedMonth: string | null; seen: boolean; reading: boolean; calls: Call[]; url: string }) {
  const { name, pinnedMonth, seen } = props;
  return (
    <div className="connected">
      <p className="ok-line">
        <span className="ok-dot" aria-hidden="true" /> <b>{name}</b> is connected to this Pulse.
      </p>
      <p className="next">
        {!pinnedMonth ? (
          <>
            Now drop <b>{name}</b> on a bar and ask it: <q>what is this?</q>
          </>
        ) : seen ? (
          <>
            <b>{name}</b> read {monthName(pinnedMonth)}. Its answer is in your chat. Move the pin and ask again.
          </>
        ) : (
          <>
            Pinned on {monthName(pinnedMonth)}. Now ask <b>{name}</b> in your own chat: <q>what is this?</q>
          </>
        )}
      </p>
      <p className="presence" role="status" aria-live="polite">
        {props.reading ? (
          <>
            <span className="spin" aria-hidden="true" /> {name} is reading {pinnedMonth ? monthName(pinnedMonth).split(" ")[0] : "Pulse"}
          </>
        ) : null}
      </p>
      {props.calls.length > 0 && (
        <ol className="calls" aria-label={`${name}'s calls on this demo`}>
          {props.calls.map((c) => (
            <li key={c.id}>
              <span className="call-dot" aria-hidden="true" />
              <code>{c.tool}</code>
            </li>
          ))}
        </ol>
      )}
      <details className="again">
        <summary>The MCP address again</summary>
        <CopyRow text={props.url} label="MCP address" button="Copy" field />
      </details>
    </div>
  );
}
