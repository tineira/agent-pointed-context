/**
 * The hero's sequence (TIN-1066), apart from React so it is tested: what a pin does, step by step, through a view the
 * stage gives it and the stage's clock. A pin on bar i: the bar is pinned (unread, the chat cleared), the focus message
 * travels, the agent asks, calls get_current_view, gets the focus, calls get_figure (then the pin is read and the bar
 * lights up), calls get_customer for the two customers with the most seats, and answers. After the visitor's second
 * own pin and its answer, "Now use your own agent" opens.
 *
 * - A new pin or an unpin cuts the running one short: its waits end at once and it does nothing more.
 * - The badge dropped back on its own bar changes nothing, as in Pulse: no new read, no count, the chat kept.
 * - The panel counts as offered only once it opens, so a pin or an unpin in the wait before it leaves it for the next answer.
 */
import { answerText, heroAnswer, topTwo, type HeroAnswer } from "./answer.ts";
import type { Clock } from "./clock.ts";
import { monthName, type HeroFocus, type HeroMonth } from "./data.ts";
import { inlineJson } from "./format.ts";
import { NO_PINS, offerDue, offerOpened, pinMade, type PinBy, type PinCount } from "./pins.ts";

export type ChatItem =
  | { id: number; type: "question"; text: string }
  | { id: number; type: "tool"; name: string; args: string | null; result: string | null; done: boolean }
  | { id: number; type: "focus"; focus: HeroFocus }
  | { id: number; type: "answer"; answer: HeroAnswer }
  | { id: number; type: "turn" };
/** A chat item before it has its id. */
export type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, "id"> : never) : never;

/** What the sequence asks of the stage. */
export interface StageView {
  /** Bar `index` is pinned, unread, with an empty chat; null: nothing is pinned. */
  pinned: (index: number | null) => void;
  /** The agent read the pin on bar `index`: the badge's check, and the bar lit. */
  read: (index: number) => void;
  /** The agent is working. */
  busy: (on: boolean) => void;
  /** A chat item; returns its id. */
  add: (item: NewItem) => number;
  /** A tool call is done, with what it returned. */
  finish: (id: number, result: string | null) => void;
  /** What a screen reader is told. */
  say: (text: string) => void;
  /** "Now use your own agent" opens. */
  offer: () => void;
  /** The focus message travels from bar `index` to the agent; resolves when it is gone, or at once on abort. */
  travel: (index: number, signal: AbortSignal) => Promise<void>;
}

/** The waits between the steps, in ms (reduced motion caps each at REDUCED_MS). */
export const STEP_MS = { lift: 420, ask: 550, view: 650, focus: 1000, figure: 750, customerCall: 420, customerRead: 480, answer: 400, turn: 900, offer: 700 } as const;
export const REDUCED_MS = 250;

export interface HeroSequence {
  pin: (index: number, by: PinBy) => Promise<void>;
  unpin: () => void;
  /** The title bar's shortcut. */
  openOffer: () => void;
  dispose: () => void;
  readonly pinnedIndex: number | null;
  readonly count: PinCount;
}

export function createHeroSequence(o: { months: readonly HeroMonth[]; view: StageView; clock: Clock; reduce: () => boolean }): HeroSequence {
  const { view } = o;
  let count = NO_PINS;
  let pinned: number | null = null;
  let current: AbortController | null = null;
  /** Ends the running pin (its waits end at once) and starts another. */
  const restart = () => {
    current?.abort();
    current = new AbortController();
    return current.signal;
  };

  async function pin(index: number, by: PinBy): Promise<void> {
    const m = o.months[index];
    if (!m) return;
    // The badge dropped back on its own bar: nothing changes (Pulse: apps/demo/src/web/App.tsx, onPin).
    if (index === pinned) return;
    const signal = restart();
    const live = () => !signal.aborted;
    const pause = (ms: number) => o.clock.wait(o.reduce() ? Math.min(ms, REDUCED_MS) : ms, signal);
    count = pinMade(count, by);
    pinned = index;
    view.pinned(index);
    view.say(`Your agent is pinned on ${monthName(m.month)}.`);

    await pause(STEP_MS.lift);
    if (!live()) return;
    await view.travel(index, signal);
    if (!live()) return;
    view.add({ type: "question", text: "What's behind this bar?" });
    view.busy(true);
    await pause(STEP_MS.ask);
    if (!live()) return;
    const call = view.add({ type: "tool", name: "get_current_view", args: null, result: null, done: false });
    await pause(STEP_MS.view);
    if (!live()) return;
    view.finish(call, null);
    view.add({ type: "focus", focus: m.focus });
    await pause(STEP_MS.focus);
    if (!live()) return;
    const figure = m.get_figure;
    const read = view.add({ type: "tool", name: "get_figure", args: inlineJson(m.focus.next_args), result: null, done: false });
    await pause(STEP_MS.figure);
    if (!live()) return;
    view.finish(read, `{ "values": ${inlineJson(figure.values)}, "breakdown": { "customers": [${figure.breakdown.customers.length} customers] }, … }`);
    view.read(index);
    view.say(`Your agent read ${monthName(m.month)}.`);
    for (const fact of topTwo(figure.breakdown.customers)) {
      await pause(STEP_MS.customerCall);
      if (!live()) return;
      const id = view.add({ type: "tool", name: "get_customer", args: inlineJson({ id: fact.customer_id }), result: null, done: false });
      await pause(STEP_MS.customerRead);
      if (!live()) return;
      const c = m.get_customer.find((x) => x.customer.id === fact.customer_id)?.customer;
      view.finish(id, c ? `{ "customer": { "name": ${JSON.stringify(c.name)}, "plan": ${JSON.stringify(c.plan)}, "region": ${JSON.stringify(c.region)}, … }, … }` : null);
    }
    await pause(STEP_MS.answer);
    if (!live()) return;
    const answer = heroAnswer(m);
    view.add({ type: "answer", answer });
    view.busy(false);
    view.say(answerText(answer));
    if (by === "self") {
      await pause(STEP_MS.turn);
      if (!live()) return;
      view.add({ type: "turn" });
      return;
    }
    if (!offerDue(count, by)) return;
    await pause(STEP_MS.offer);
    // Cut short: not offered yet, so the next answer opens it.
    if (!live()) return;
    count = offerOpened(count);
    view.offer();
    view.say("Now use your own agent.");
  }

  return {
    pin,
    unpin() {
      restart();
      pinned = null;
      view.pinned(null);
      view.say("Unpinned.");
    },
    openOffer() {
      count = offerOpened(count);
      view.offer();
    },
    dispose() {
      current?.abort();
    },
    get pinnedIndex() {
      return pinned;
    },
    get count() {
      return count;
    },
  };
}
