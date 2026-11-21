/**
 * The hero's stage sequence (hero/sequence.ts), driven with the stage's own clock on fake timers (TIN-1066 review round 1):
 * - "Now use your own agent" opens after the visitor's second own pin and its answer, even when a pin or an unpin cut
 *   the wait before it short: it counts as offered only once it opens;
 * - the badge dropped back on its own bar changes nothing, as in Pulse: no new read, no count, the chat kept;
 * - a hidden tab holds the demo, and every timer is cleared when a wait is cut short or the stage goes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClock, type Clock } from "../src/web/landing/hero/clock.ts";
import type { HeroData } from "../src/web/landing/hero/data.ts";
import { createHeroSequence, type ChatItem, type HeroSequence } from "../src/web/landing/hero/sequence.ts";

const data = JSON.parse(readFileSync(new URL("../src/web/hero-data.json", import.meta.url), "utf8")) as HeroData;
const at = (month: string) => data.months.findIndex((m) => m.month === month);
const MESSAGE_MS = 2100;

/** Timers that run only when the test advances them. */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        due.set(++next, { at: now + ms, fn });
        return next;
      },
      clear: (id: unknown) => void due.delete(id as number),
      now: () => now,
    },
    get pending() {
      return due.size;
    },
    /** Runs every timer due within `ms`, in order, letting the awaiting code run between them. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        const first = [...due.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!first || first[1].at > end) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = end;
      await flush();
    },
  };
}

/** A stage: the sequence, its clock on fake timers, and what the view was told. */
function stage() {
  const time = fakeTimers();
  const clock: Clock = createClock(time.timers);
  const s = { pinned: null as number | null, seen: false, chat: [] as ChatItem[], offers: 0, pinnedCalls: 0, travels: 0 };
  let id = 0;
  const sequence: HeroSequence = createHeroSequence({
    months: data.months,
    clock,
    reduce: () => false,
    view: {
      pinned: (index) => {
        s.pinnedCalls++;
        s.pinned = index;
        s.seen = false;
        s.chat = [];
      },
      read: () => {
        s.seen = true;
      },
      busy: () => {},
      add: (item) => {
        s.chat.push({ ...item, id: ++id } as ChatItem);
        return id;
      },
      finish: () => {},
      say: () => {},
      offer: () => {
        s.offers++;
      },
      travel: (_index, signal) => {
        s.travels++;
        return clock.wait(MESSAGE_MS, signal);
      },
    },
  });
  const answered = () => s.chat.some((i) => i.type === "answer");
  /** Advances until the running pin's answer is on screen. */
  const untilAnswer = async () => {
    for (let t = 0; t < 20_000 && !answered(); t += 50) await time.advance(50);
    assert.ok(answered(), "the answer came");
  };
  return { time, clock, sequence, s, untilAnswer };
}

test("a third pin during the wait before the panel opens: the panel opens after its answer", async () => {
  const { time, sequence, s, untilAnswer } = stage();
  void sequence.pin(at("2026-03"), "self");
  await untilAnswer();
  await time.advance(1000);
  void sequence.pin(at("2026-02"), "visitor");
  await untilAnswer();
  await time.advance(1000);
  assert.equal(s.offers, 0, "one pin of the visitor's: no panel yet");
  void sequence.pin(at("2026-01"), "visitor");
  await untilAnswer();
  await time.advance(300); // inside the 700 ms before the panel
  assert.equal(s.offers, 0);
  void sequence.pin(at("2026-05"), "visitor");
  await untilAnswer();
  assert.match(JSON.stringify(s.chat.find((i) => i.type === "answer")), /"active":132/);
  await time.advance(1000);
  assert.equal(s.offers, 1, "the panel opens after May's answer");
  assert.equal(sequence.count.offered, true);
  // It opens by itself once.
  void sequence.pin(at("2025-10"), "visitor");
  await untilAnswer();
  await time.advance(2000);
  assert.equal(s.offers, 1);
});

test("an unpin during the wait before the panel opens: the panel opens after the next answer", async () => {
  const { time, sequence, s, untilAnswer } = stage();
  void sequence.pin(at("2026-02"), "visitor");
  await untilAnswer();
  void sequence.pin(at("2026-01"), "visitor");
  await untilAnswer();
  await time.advance(300);
  sequence.unpin();
  await time.advance(5000);
  assert.equal(s.offers, 0, "cut short: not opened");
  assert.equal(sequence.count.offered, false, "and not counted as offered");
  void sequence.pin(at("2026-04"), "visitor");
  await untilAnswer();
  await time.advance(1000);
  assert.equal(s.offers, 1);
});

test("the badge dropped back on its own bar changes nothing: no new read, no count, the chat kept", async () => {
  const { time, sequence, s, untilAnswer } = stage();
  void sequence.pin(at("2026-03"), "self");
  await untilAnswer();
  await time.advance(1000);
  const chat = s.chat.slice();
  assert.equal(s.seen, true);
  void sequence.pin(at("2026-03"), "visitor");
  await time.advance(10_000);
  assert.deepEqual(s.chat, chat, "the chat is kept");
  assert.equal(s.seen, true, "the pin stays read");
  assert.equal(s.pinnedCalls, 1);
  assert.equal(s.travels, 1, "no message sent again");
  assert.equal(sequence.count.own, 0, "not a pin of the visitor's");
  // So one real pin elsewhere is still only the first.
  void sequence.pin(at("2026-02"), "visitor");
  await untilAnswer();
  await time.advance(2000);
  assert.equal(s.offers, 0);
  assert.equal(sequence.count.own, 1);
});

test("a hidden tab holds the demo where it is, and it goes on when the tab shows again", async () => {
  const { time, clock, sequence, s, untilAnswer } = stage();
  void sequence.pin(at("2026-03"), "visitor");
  await time.advance(420 + MESSAGE_MS + 100);
  const before = s.chat.length;
  assert.ok(before >= 1, "the question is asked");
  clock.pause();
  assert.equal(time.pending, 0, "no timer runs while hidden");
  await time.advance(60_000);
  assert.equal(s.chat.length, before, "nothing moved while hidden");
  clock.resume();
  await untilAnswer();
});

test("every timer is cleared when a wait is cut short, when a pin replaces another, and when the stage goes", async () => {
  const { time, clock, sequence } = stage();
  const cut = new AbortController();
  const waited = clock.wait(5000, cut.signal);
  assert.equal(time.pending, 1);
  cut.abort();
  await waited;
  assert.equal(time.pending, 0, "an aborted wait clears its timer");
  void sequence.pin(at("2026-03"), "visitor");
  await time.advance(100);
  void sequence.pin(at("2026-04"), "visitor");
  await time.advance(0);
  assert.equal(time.pending, 1, "only the new pin's wait is left");
  sequence.dispose();
  clock.dispose();
  assert.equal(time.pending, 0, "leaving the page clears them all");
});
