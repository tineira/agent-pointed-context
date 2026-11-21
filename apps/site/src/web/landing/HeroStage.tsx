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
 */
import { focusAttrs } from "@tineira/apc-protocol";
import { enablePinning, initials, pinBadgeX, pinTouch, type AgentState, type BarAgent } from "@tineira/apc-web";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "../styles/hero.css";
import { AgentMark } from "../agent-mark.tsx";
import { answerParagraphs, answerText, heroAnswer, topTwo, type HeroAnswer } from "./hero/answer.ts";
import { CHART_TOP, loadHeroData, monthName, monthShort, type HeroData, type HeroFocus } from "./hero/data.ts";
import { HERO_AGENT, HeroAgentBar, HeroPin } from "./hero/elements.tsx";
import { FocusCard, inlineJson, Json } from "./hero/json.tsx";
import { carryMark, sendMessage } from "./hero/motion.ts";
import { answerShown, NO_PINS, offerOpened, pinMade, type PinBy } from "./hero/pins.ts";

/** Pulse's Agents page: where the visitor makes an agent and copies its MCP address. */
export const PULSE_AGENTS = "https://pulse.apc.tineira.com/agents";
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

type ChatItem =
  | { id: number; type: "question"; text: string }
  | { id: number; type: "tool"; name: string; args: string | null; result: string | null; done: boolean }
  | { id: number; type: "focus"; focus: HeroFocus }
  | { id: number; type: "answer"; answer: HeroAnswer }
  | { id: number; type: "turn" };
/** A chat item before it has its id. */
type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, "id"> : never) : never;

export function HeroStage() {
  const [data, setData] = useState<HeroData | null>(null);
  useEffect(() => {
    let live = true;
    void loadHeroData().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, []);
  if (!data) return <figure className="hero-stage hero-stage-loading" aria-busy="true" aria-label="A demo of pointing an agent at a chart, loading" />;
  return <Stage data={data} />;
}

function Stage(props: { data: HeroData }) {
  const { months } = props.data;
  const reduce = useReducedMotion();
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

  const run = useRef(0);
  const count = useRef(NO_PINS);
  const nextId = useRef(0);
  const message = useRef<{ cancel: () => void } | null>(null);
  const selfPlay = useRef<{ cancel: () => void } | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  const add = (item: NewItem): number => {
    const id = ++nextId.current;
    setChat((c) => [...c, { ...item, id } as ChatItem]);
    return id;
  };
  const finishTool = (id: number, result: string | null) => setChat((c) => c.map((i) => (i.id === id && i.type === "tool" ? { ...i, done: true, result } : i)));

  /** The stage's own drag stops for good as soon as the visitor does anything. */
  const stopSelfPlay = useCallback(() => {
    selfPlay.current?.cancel();
    selfPlay.current = null;
  }, []);

  const unpin = useCallback(() => {
    run.current++;
    message.current?.cancel();
    message.current = null;
    if (litTimer.current) clearTimeout(litTimer.current);
    setPinned(null);
    setSeen(false);
    setBusy(false);
    setLit(null);
    setChat([]);
    setSaid("Unpinned.");
  }, []);

  /** A pin on bar `index`: the message travels, the agent reads, and it answers. */
  const pin = useCallback(
    async (index: number, by: PinBy) => {
      const m = months[index];
      const stage = stageRef.current;
      const bar = barRefs.current[index];
      if (!m || !stage || !bar || !agentWinRef.current) return;
      const me = ++run.current;
      const live = () => run.current === me;
      const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, reduceRef.current ? Math.min(ms, 250) : ms));
      count.current = pinMade(count.current, by);
      message.current?.cancel();
      if (litTimer.current) clearTimeout(litTimer.current);
      setPinned(index);
      setSeen(false);
      setBusy(false);
      setLit(null);
      setChat([]);
      setSaid(`Your agent is pinned on ${monthName(m.month)}.`);

      await pause(420);
      if (!live()) return;
      const sent = sendMessage({ stage, bar, agent: agentWinRef.current, month: m.month, reduce: reduceRef.current });
      message.current = sent;
      await sent.done;
      if (!live()) return;
      message.current = null;

      add({ type: "question", text: "What's behind this bar?" });
      setBusy(true);
      await pause(550);
      if (!live()) return;
      const view = add({ type: "tool", name: "get_current_view", args: null, result: null, done: false });
      await pause(650);
      if (!live()) return;
      finishTool(view, null);
      add({ type: "focus", focus: m.focus });
      await pause(1000);
      if (!live()) return;
      const figure = m.get_figure;
      const read = add({ type: "tool", name: "get_figure", args: inlineJson(m.focus.next_args), result: null, done: false });
      await pause(750);
      if (!live()) return;
      finishTool(read, `{ "values": ${inlineJson(figure.values)}, "breakdown": { "customers": [${figure.breakdown.customers.length} customers] }, … }`);
      // The agent read the pin: the badge's ring becomes a check, and what it read lights up.
      setSeen(true);
      setLit(index);
      litTimer.current = setTimeout(() => setLit(null), LIT_MS);
      setSaid(`Your agent read ${monthName(m.month)}.`);
      for (const fact of topTwo(figure.breakdown.customers)) {
        await pause(420);
        if (!live()) return;
        const call = add({ type: "tool", name: "get_customer", args: inlineJson({ id: fact.customer_id }), result: null, done: false });
        await pause(480);
        if (!live()) return;
        const c = m.get_customer.find((x) => x.customer.id === fact.customer_id)?.customer;
        finishTool(call, c ? `{ "customer": { "name": ${JSON.stringify(c.name)}, "plan": ${JSON.stringify(c.plan)}, "region": ${JSON.stringify(c.region)}, … }, … }` : null);
      }
      await pause(400);
      if (!live()) return;
      const answer = heroAnswer(m);
      add({ type: "answer", answer });
      setBusy(false);
      setSaid(answerText(answer));
      if (by === "self") {
        await pause(900);
        if (!live()) return;
        add({ type: "turn" });
        return;
      }
      const shown = answerShown(count.current, by);
      count.current = shown.count;
      if (shown.offer) {
        await pause(700);
        if (!live()) return;
        setOffer(true);
        setSaid("Now use your own agent.");
      }
    },
    [months],
  );

  const pinRef = useRef(pin);
  pinRef.current = pin;

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
        void pinRef.current(index, "visitor");
      },
    });
  }, [months, stopSelfPlay]);

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

  // Self-play on load: one pin, then the visitor's turn. None under reduced motion.
  useEffect(() => {
    if (reduceRef.current) return;
    const index = months.findIndex((m) => m.month === SELF_PLAY_MONTH);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let carry: { cancel: () => void } | null = null;
    let over = false;
    const cancel = () => {
      over = true;
      if (timer) clearTimeout(timer);
      carry?.cancel();
      barRefs.current[index]?.classList.remove("apc-target");
      document.removeEventListener("visibilitychange", start);
    };
    selfPlay.current = { cancel };
    function start() {
      if (over || document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", start);
      timer = setTimeout(() => {
        const stage = stageRef.current;
        const bar = barRefs.current[index];
        const mark = stage?.querySelector<HTMLElement>(".apc-agents__mark");
        if (over || !stage || !bar || !mark || reduceRef.current) return;
        const carried = carryMark({ stage, mark, bar });
        carry = carried;
        bar.classList.add("apc-target");
        void carried.done.then((arrived) => {
          bar.classList.remove("apc-target");
          if (!arrived || over) return;
          selfPlay.current = null;
          void pinRef.current(index, "self");
        });
      }, 1100);
    }
    if (document.visibilityState === "visible") start();
    else document.addEventListener("visibilitychange", start);
    return cancel;
  }, [months]);

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

  // Nothing keeps running once the stage is gone.
  useEffect(
    () => () => {
      run.current++;
      message.current?.cancel();
      if (litTimer.current) clearTimeout(litTimer.current);
    },
    [],
  );

  const openOffer = () => {
    stopSelfPlay();
    count.current = offerOpened(count.current);
    setOffer(true);
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
            <button type="button" className="hero-own" onClick={openOffer}>
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
              This agent was simulated. Pulse is a real demo app: <b>make an agent there, copy its MCP address into your agent, then drop your agent on a bar in Pulse.</b> It reads the same data you saw here.
            </p>
            <div className="hero-offer-actions">
              <a className="btn primary" href={PULSE_AGENTS}>
                Open Pulse's Agents page <span aria-hidden="true">→</span>
              </a>
              <button type="button" className="hero-offer-back" onClick={() => setOffer(false)}>
                Back to the demo
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="hero-said" role="status">
        {said}
      </p>
      <figcaption className="hero-note">Simulated with Pulse's demo data, one made-up world. Nothing leaves this page.</figcaption>
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
