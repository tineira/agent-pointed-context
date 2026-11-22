/**
 * The landing's hero (TIN-1066): a mock Pulse window, "Active customers per month", beside a "your agent" window,
 * simulated with Pulse's real answers (hero-data.json). Pinning is the standard one Pulse uses, from @tineira/apc-web:
 * the agent lives in the agent bar (<apc-agents>), the visitor drags it onto a bar, or taps it and then a bar, or uses
 * the keyboard (enablePinning); it goes back to the bar, and the bar wears the pin badge (<apc-pin>), a dashed breathing
 * ring until read, then a check, with ×; dragging the badge moves the pin; what the agent reads lights up.
 *
 * After a pin, the focus message travels to the agent window and fades to black as it crosses (in reality it goes
 * underneath, unseen); the agent window shows the exchange and the answer, which says what the chart does not show.
 * The stage plays one pin by itself on load (not under reduced motion), which does not count; after the visitor's second
 * own pin and its answer, "Now use your own agent" opens inside the stage.
 *
 * "Use your own agent" (the panel's action, and the title bar's shortcut) puts Pulse's real hero view in place of the
 * stage (hero/live.ts, TIN-1071): only then does the page frame Pulse, and Pulse set its sandbox cookie, as the copy
 * beside each says. "Back to the demo" brings the simulated stage back. The panel and the title bar ask for it with
 * `openRealHero` (hero/live.ts), which the band under the hero calls too (OwnAgentBand, TIN-1104).
 *
 * The hero's arrow (hero/try-me.ts, TIN-1103, TIN-1106): "Try me" at the agent 5 s after the stage starts (at once under
 * reduced motion); after the visitor's first press on the agent, tap, keyboard arming or pin, "Try me" at "Use your own
 * agent", once their pin is over (or a few seconds after a press that pinned nothing); after "Use your own agent" (which
 * try-me.ts hears itself), "Do this" at Pulse's Connect box, which the live frame reports through `events`.
 */
import { focusAttrs } from "@tineira/apc-protocol";
import { enablePinning, initials, pinBadgeX, pinTouch, type AgentState, type BarAgent } from "@tineira/apc-web";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../styles/hero.css";
import { AgentMark } from "../agent-mark.tsx";
import { answerParagraphs } from "./hero/answer.ts";
import { createClock } from "./hero/clock.ts";
import { CHART_TOP, loadHeroData, monthName, monthShort, type HeroData } from "./hero/data.ts";
import { HERO_AGENT, HeroAgentBar, HeroPin } from "./hero/elements.tsx";
import { FocusCard, Json } from "./hero/json.tsx";
import { HeroStageHost } from "./hero/live.ts";
import { carryMark, sendMessage } from "./hero/motion.ts";
import { createHeroSequence, type ChatItem } from "./hero/sequence.ts";
import { TRY_ME_DELAY_MS, TRY_ME_OWN_DELAY_MS, tryMe } from "./hero/try-me.ts";
import { usePulseView } from "../pulse-status.ts";

/** What "Use your own agent" does, said beside it (invariant 5 of TIN-1063: no request to Pulse before the click). */
const COOKIE_NOTE = "“Use your own agent” connects to Pulse (pulse.apc.tineira.com) in this page, and Pulse sets its one sandbox cookie.";
/** The bar the stage pins by itself: March, whose focus the build page shows. */
const SELF_PLAY_MONTH = "2026-03";
/** How long what the agent read stays lit (the package's FLASH_MS). */
const LIT_MS = 4000;

/** Whether the visitor asks for less motion, kept current. */
function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setReduce(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return reduce;
}

export function HeroStage() {
  const [data, setData] = useState<HeroData | null>(null);
  // The simulated demo first, always: HeroStageHost mounts the frame on the click only, whatever the stored hint says.
  useEffect(() => {
    let live = true;
    void loadHeroData().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, []);
  return (
    <HeroStageHost
      events={LIVE_EVENTS}
      demo={(useOwnAgent) =>
        data ? <Stage data={data} onUseOwnAgent={useOwnAgent} /> : <figure className="hero-stage hero-stage-loading" aria-busy="true" aria-label="A demo of pointing an agent at a chart, loading" />
      }
    />
  );
}

/** The live frame's news for the arrow: its status, its Connect box, and "Back to the demo". */
const LIVE_EVENTS = { status: tryMe.connection, connectBox: tryMe.setConnectBox, back: tryMe.back };

function Stage(props: { data: HeroData; onUseOwnAgent: () => void }) {
  const { months } = props.data;
  const reduce = useReducedMotion();
  // "or open Pulse" follows the connection (TIN-1087): Overview once the hero's frame says it is connected.
  const { openHref } = usePulseView();
  const stageRef = useRef<HTMLElement | null>(null);
  const agentWinRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const offerRef = useRef<HTMLHeadingElement | null>(null);

  const [pinned, setPinned] = useState<number | null>(null);
  const [seen, setSeen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lit, setLit] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [offer, setOffer] = useState(false);
  const [said, setSaid] = useState("");
  const [badgeAt, setBadgeAt] = useState<{ left: number; top: number } | null>(null);

  const clock = useMemo(() => createClock(), []);
  const selfPlay = useRef<AbortController | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);
  // The second arrow's reveal: the visitor's latest pin (only its end counts), and the wait after a press that pinned nothing.
  const pinRun = useRef(0);
  const ownWait = useRef<AbortController | null>(null);
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  // The sequence (hero/sequence.ts) drives the stage through this view.
  const sequence = useMemo(() => {
    const clearLit = () => {
      if (litTimer.current) clearTimeout(litTimer.current);
      litTimer.current = null;
    };
    return createHeroSequence({
      months,
      clock,
      reduce: () => reduceRef.current,
      view: {
        pinned: (index) => {
          clearLit();
          setPinned(index);
          setSeen(false);
          setBusy(false);
          setLit(null);
          setChat([]);
        },
        read: (index) => {
          setSeen(true);
          setLit(index);
          clearLit();
          litTimer.current = setTimeout(() => setLit(null), LIT_MS);
        },
        busy: setBusy,
        add: (item) => {
          const id = ++nextId.current;
          setChat((c) => [...c, { ...item, id } as ChatItem]);
          return id;
        },
        finish: (id, result) => setChat((c) => c.map((i) => (i.id === id && i.type === "tool" ? { ...i, done: true, result } : i))),
        say: setSaid,
        offer: () => setOffer(true),
        travel: (index, signal) => {
          const stage = stageRef.current;
          const bar = barRefs.current[index];
          const agent = agentWinRef.current;
          if (!stage || !bar || !agent) return Promise.resolve();
          const sent = sendMessage({ stage, bar, agent, month: months[index]!.month, reduce: reduceRef.current, wait: clock.wait });
          signal.addEventListener("abort", sent.cancel, { once: true });
          return sent.done;
        },
      },
    });
  }, [months, clock]);

  /** The stage's own drag stops for good as soon as the visitor does anything. */
  const stopSelfPlay = useCallback(() => {
    selfPlay.current?.abort();
    selfPlay.current = null;
  }, []);

  const unpin = useCallback(() => sequence.unpin(), [sequence]);

  /**
   * The visitor touched the agent: the first arrow goes, and the second shows a few seconds later unless a pin takes
   * over (then it shows when that pin is over).
   */
  const interacted = useCallback(() => {
    tryMe.interacted();
    if (ownWait.current) return;
    const wait = new AbortController();
    ownWait.current = wait;
    const run = pinRun.current;
    void clock.wait(TRY_ME_OWN_DELAY_MS, wait.signal).then(() => {
      if (ownWait.current === wait) ownWait.current = null;
      if (!wait.signal.aborted && pinRun.current === run) tryMe.ready("own");
    });
  }, [clock]);

  // Standard pinning on the stage: drag the agent (or its badge) onto a bar, tap it and then a bar, or the keyboard.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    return enablePinning({
      root: stage,
      onPin: (_grant, target) => {
        const index = months.findIndex((m) => m.month === target.params?.month);
        if (index < 0) return;
        stopSelfPlay();
        tryMe.interacted();
        ownWait.current?.abort();
        ownWait.current = null;
        const run = ++pinRun.current;
        void sequence.pin(index, "visitor").then(() => {
          if (pinRun.current === run) tryMe.ready("own");
        });
      },
    });
  }, [months, sequence, stopSelfPlay]);

  // Any press or key on the stage, or an agent armed for a tap, ends the stage's own drag.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener("pointerdown", stopSelfPlay, true);
    stage.addEventListener("keydown", stopSelfPlay, true);
    window.addEventListener("apc-armed", stopSelfPlay);
    return () => {
      stage.removeEventListener("pointerdown", stopSelfPlay, true);
      stage.removeEventListener("keydown", stopSelfPlay, true);
      window.removeEventListener("apc-armed", stopSelfPlay);
    };
  }, [stopSelfPlay]);

  // The first interaction with the agent: a press on it (a drag starts there), or the agent armed by a tap or a key.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pressed = (e: PointerEvent) => e.target instanceof Element && e.target.closest("[data-apc-mark]") && interacted();
    const armed = (e: Event) => (e as CustomEvent<{ id: string | null } | null>).detail?.id && interacted();
    stage.addEventListener("pointerdown", pressed, true);
    window.addEventListener("apc-armed", armed);
    return () => {
      stage.removeEventListener("pointerdown", pressed, true);
      window.removeEventListener("apc-armed", armed);
      ownWait.current?.abort();
      ownWait.current = null;
    };
  }, [interacted]);

  // The first arrow: 5 s after the stage starts (TIN-1106), on the stage's clock; at once under reduced motion.
  useEffect(() => {
    if (reduceRef.current) return tryMe.ready("agent");
    const due = new AbortController();
    void clock.wait(TRY_ME_DELAY_MS, due.signal).then(() => {
      if (!due.signal.aborted) tryMe.ready("agent");
    });
    return () => due.abort();
  }, [clock]);

  // A hidden tab holds the demo where it is (every wait goes through the clock); leaving the page clears every timer.
  useEffect(() => {
    const follow = () => (document.visibilityState === "hidden" ? clock.pause() : clock.resume());
    follow();
    document.addEventListener("visibilitychange", follow);
    return () => {
      document.removeEventListener("visibilitychange", follow);
      sequence.dispose();
      clock.dispose();
      if (litTimer.current) clearTimeout(litTimer.current);
    };
  }, [clock, sequence]);

  // Self-play on load: one pin, then the visitor's turn. None under reduced motion.
  useEffect(() => {
    if (reduceRef.current) return;
    const index = months.findIndex((m) => m.month === SELF_PLAY_MONTH);
    const play = new AbortController();
    selfPlay.current = play;
    void (async () => {
      await clock.wait(1100, play.signal);
      const stage = stageRef.current;
      const bar = barRefs.current[index];
      const mark = stage?.querySelector<HTMLElement>(".apc-agents__mark");
      if (play.signal.aborted || !stage || !bar || !mark || reduceRef.current) return;
      const carried = carryMark({ stage, mark, bar, wait: clock.wait });
      play.signal.addEventListener("abort", carried.cancel, { once: true });
      bar.classList.add("apc-target");
      const arrived = await carried.done;
      bar.classList.remove("apc-target");
      if (!arrived || play.signal.aborted) return;
      selfPlay.current = null;
      await sequence.pin(index, "self");
    })();
    return () => play.abort();
  }, [months, clock, sequence]);

  // The badge sits astride the pinned bar's right edge, just below its top, as Pulse places it.
  const place = useCallback(() => {
    const stage = stageRef.current;
    const bar = pinned === null ? null : barRefs.current[pinned];
    if (!stage || !bar) return setBadgeAt(null);
    const s = stage.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const half = 14;
    const left = pinBadgeX({ targetRight: r.right - s.left - half + 22, viewportWidth: stage.clientWidth, index: 0, touch: pinTouch() }) + half;
    const top = r.top - s.top + 16;
    setBadgeAt((prev) => (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5 ? prev : { left, top }));
  }, [pinned]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const watch = new ResizeObserver(() => place());
    watch.observe(stage);
    return () => watch.disconnect();
  }, [place]);

  // The agent window follows the exchange.
  useLayoutEffect(() => {
    const body = chatRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [chat]);

  const useOwnAgent = () => {
    stopSelfPlay();
    props.onUseOwnAgent();
  };
  useEffect(() => {
    if (offer) offerRef.current?.focus({ preventScroll: true });
  }, [offer]);

  const pinnedMonth = pinned === null ? null : months[pinned];
  const state: AgentState = pinnedMonth ? (seen ? "seen" : busy ? "busy" : "waiting") : "idle";
  const agent = useMemo<BarAgent>(
    () => ({ id: HERO_AGENT.id, name: HERO_AGENT.name, state, pin: pinnedMonth ? { label: `active_customers ${pinnedMonth.month}`, seen, here: true } : null }),
    [state, pinnedMonth, seen],
  );

  return (
    <figure ref={stageRef} className="hero-stage" aria-label="A demo of pointing your agent at a chart, simulated with Pulse's demo data">
      <div className="hero-grid">
        <div className="hero-win hero-app">
          <div className="hero-win-bar">
            <i />
            <i />
            <i />
            <span>pulse · overview</span>
          </div>
          <div className="hero-app-body">
            <h3 className="hero-chart-title">
              Active customers <small>per month</small>
            </h3>
            <div className="hero-chart">
              <span className="hero-grid-line hero-grid-100" aria-hidden="true">
                <b>100</b>
              </span>
              <span className="hero-grid-line hero-grid-50" aria-hidden="true">
                <b>50</b>
              </span>
              {months.map((m, i) => (
                <div
                  key={m.month}
                  ref={(el) => {
                    barRefs.current[i] = el;
                    el?.style.setProperty("--hero-bar", `${((m.get_figure.values.active / CHART_TOP) * 100).toFixed(2)}%`);
                  }}
                  className={`hero-bar${pinned === i ? " is-pinned" : ""}`}
                  role="img"
                  aria-label={`${monthName(m.month)}: ${m.get_figure.values.active} active customers`}
                  data-apc-presence={lit === i ? "read" : undefined}
                  data-apc-agent={lit === i ? initials(HERO_AGENT.name) : undefined}
                  {...focusAttrs({ kind: m.focus.kind, id: null, params: m.focus.params })}
                />
              ))}
            </div>
            <div className="hero-months" aria-hidden="true">
              {months.map((m, i) => (
                <span key={m.month} className={pinned === i ? "is-on" : undefined}>
                  {monthShort(m.month)}
                </span>
              ))}
            </div>
            <div className="hero-agentbar">
              <HeroAgentBar agent={agent} onUnpin={unpin} />
              <span className="hero-agentbar-hint">{hint(pinnedMonth?.month ?? null, seen)}</span>
            </div>
          </div>
        </div>
        <div ref={agentWinRef} className="hero-win hero-agent">
          <div className="hero-win-bar">
            <i />
            <i />
            <i />
            <span>your agent</span>
            <button type="button" className="hero-own" onClick={useOwnAgent} aria-describedby="hero-cookie">
              Use your own agent
            </button>
          </div>
          <div ref={chatRef} className="hero-chat">
            {chat.length === 0 && pinned === null ? <p className="hero-chat-empty">Drag your agent onto a bar. It is told what you pointed at, not what your screen looks like.</p> : chat.map(renderItem)}
          </div>
          <div className="hero-chat-foot" aria-hidden="true">
            <span>Ask about “this”</span>
            <kbd>↵</kbd>
          </div>
        </div>
      </div>
      {pinnedMonth && badgeAt && <HeroPin seen={seen} at={badgeAt} onUnpin={unpin} />}
      {offer && (
        <div className="hero-offer" role="region" aria-labelledby="hero-offer-title" onKeyDown={(e) => e.key === "Escape" && setOffer(false)}>
          <div className="hero-offer-card">
            <span className="hero-offer-eyebrow">Your turn</span>
            <h3 id="hero-offer-title" ref={offerRef} tabIndex={-1}>
              Now use <em>your own agent</em>
            </h3>
            <p>
              This agent was simulated. Pulse is a real demo app, and it opens right here: <b>copy its MCP address into your agent, then drop your agent on a bar.</b> It reads the same data you saw here.
            </p>
            <div className="hero-offer-actions">
              <button type="button" className="btn primary" onClick={useOwnAgent} aria-describedby="hero-offer-cookie">
                Use your own agent <span aria-hidden="true">→</span>
              </button>
              <a className="hero-offer-open" href={openHref} target="_blank" rel="noopener">
                or open Pulse <span aria-hidden="true">↗</span>
              </a>
              <button type="button" className="hero-offer-back" onClick={() => setOffer(false)}>
                Back to the demo
              </button>
            </div>
            <p id="hero-offer-cookie" className="hero-offer-cookie">
              {COOKIE_NOTE}
            </p>
          </div>
        </div>
      )}
      <p className="hero-said" role="status">
        {said}
      </p>
      <figcaption className="hero-note">
        Simulated with Pulse's demo data, one made-up world. Nothing leaves this page. <span id="hero-cookie">{COOKIE_NOTE}</span>
      </figcaption>
    </figure>
  );
}

/** What the agent bar says next to the agent. */
function hint(month: string | null, seen: boolean): ReactNode {
  if (!month) {
    return (
      <>
        <span className="hero-hint-pointer">Drag your agent onto a bar</span>
        <span className="hero-hint-touch">Tap your agent, then a bar</span>
      </>
    );
  }
  return seen ? `Read: ${monthShort(month)} ✓` : `Pinned on ${monthShort(month)}`;
}

function renderItem(item: ChatItem): ReactNode {
  switch (item.type) {
    case "question":
      return (
        <p key={item.id} className="hero-q">
          {item.text}
        </p>
      );
    case "tool":
      return (
        <div key={item.id} className={`hero-tool${item.done ? " is-done" : ""}`}>
          <span className="hero-tool-dot" aria-hidden="true" />
          <span>
            <b>{item.name}</b>
            {item.args && (
              <>
                {" "}
                <Json text={item.args} />
              </>
            )}
            {item.result && (
              <span className="hero-tool-result">
                → <Json text={item.result} />
              </span>
            )}
          </span>
        </div>
      );
    case "focus":
      return <FocusCard key={item.id} focus={item.focus} />;
    case "answer":
      return (
        <div key={item.id} className="hero-answer">
          <AgentMark size={22} />
          <div>
            {answerParagraphs(item.answer).map((p, i) => (
              <p key={i}>{p.map((s, j) => (typeof s === "string" ? s : <b key={j}>{s.strong}</b>))}</p>
            ))}
            <small>read with get_figure and get_customer · not drawn on the chart</small>
          </div>
        </div>
      );
    case "turn":
      return (
        <p key={item.id} className="hero-turn">
          <b>Your turn.</b> Drag your agent from the bar onto another month, or move the pin.
        </p>
      );
  }
}
