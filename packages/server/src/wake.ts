/**
 * @experimental Not part of the APC standard: these exports may change or go without a major version.
 *
 * Wake on pin (TIN-962, TIN-967, TIN-973; experimental, not part of the APC standard): a server POSTs to a Grok Bot
 * webhook trigger when the person points an agent that is not calling, so the bot starts a run and reads the pin with
 * get_current_view. The agent dock's hub does it for its agents (apps/dock); an app does it for the agents that reach
 * it directly (the Direct profile; Pulse first). DESIGN.md § 30.
 *
 * The pure parts (limits, checks, copy) and `WakeEngine`, the state machine both run: one per Durable Object, over a
 * synchronous `WakeStore` (the hub's own tables, or `kvWakeStore` over an `ApcKv`) and a `WakeHost` that answers what
 * only the server knows (is the agent's source still live, was the pin handed over, is a call in flight). Every method
 * checks and writes before its first await; the one await is the POST, and what it writes afterwards is written only
 * on the webhook it was sent for (its `gen`), read again, never from a snapshot taken before the await.
 */
import { z } from "zod";
import { toolResult, type ToolResult } from "./envelope.ts";
import type { ApcKv } from "./kv.ts";
import { WAKE_DAY_MAX, WAKE_DOCK_PLACE, WAKE_GAP_MS, wakeAppPlace, wakeRoutinePrompt, type WakePlace } from "./wake-shared.ts";

export { WAKE_DAY_MAX, WAKE_DOCK_PLACE, WAKE_GAP_MS, wakeAppPlace, wakeRoutinePrompt, type WakePlace };

/** The only webhook shape ever called: Grok Bot's automation trigger. */
export const WAKE_URL = /^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[A-Za-z0-9_-]{8,128}$/;
/** The trigger's key: printable ASCII, no spaces. */
export const WAKE_KEY = /^[\x21-\x7e]{16,512}$/;
/** After a pin, the wake waits this long: a call already under way may take the pin. */
export const WAKE_SETTLE_MS = 2_000;
/** While a call or a wait of the agent is in flight, the wake is put off this long, again and again... */
export const WAKE_DEFER_MS = 3_000;
/** ...for at most this long after the pin: then it goes anyway. */
export const WAKE_DEFER_MAX_MS = 60_000;
/** One test per agent in this window. */
export const WAKE_TEST_GAP_MS = 10_000;
/** The webhook's deadline, headers included. */
export const WAKE_DEADLINE_MS = 10_000;
/** How often the offer in a result may come back (no MCP session to count one by). */
export const WAKE_HINT_EVERY_MS = 24 * 3_600_000;

export type WakeKind = "pin" | "page_reading";
export type WakeStatus = "ok" | "broken" | "error" | "paused" | "limit";

/** The person's webhook, checked: the trigger URL and key exactly as Grok Bot shows them, trimmed. */
export function parseWake(body: unknown): { url: string; key: string } | null {
  const b = body && typeof body === "object" ? (body as { url?: unknown; key?: unknown }) : {};
  if (typeof b.url !== "string" || typeof b.key !== "string") return null;
  const url = b.url.trim();
  const key = b.key.trim().replace(/^Bearer\s+/i, "");
  return WAKE_URL.test(url) && WAKE_KEY.test(key) ? { url, key } : null;
}

/** What a webhook's answer means: 2xx taken; a refused key or a deleted trigger is broken until set again; anything else an error. */
export function wakeOutcome(response: { status: number; type?: string } | null): "ok" | "broken" | "error" {
  if (!response || response.type === "opaqueredirect") return "error";
  if (response.status >= 200 && response.status < 300) return "ok";
  return [401, 403, 404, 410].includes(response.status) ? "broken" : "error";
}

/** The UTC day of a time, for the daily budget. */
export const wakeDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- the copy, by place: "the dock" only on the dock ----

const it = (p: WakePlace) => (p.dock ? "the dock" : p.name);
const page = (p: WakePlace) => (p.dock ? "the dock page" : `the ${p.name} page`);

/** wake_on_pin's input, as the description of its one field says it. */
const declinedText = (p: WakePlace) => `true when the person said they do not want Wake on pin: ${it(p)} stops suggesting it.`;

/** The tool's name, title and annotations, the same on every place. */
export const WAKE_TOOL_NAME = "wake_on_pin";
export const WAKE_TOOL_TITLE = "Set up Wake on pin (Grok Bot)";
// It writes one preference (declined), nothing else: not read-only, never destructive, the same answer twice, no other system.
export const WAKE_TOOL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The tool's description for a place. */
export function wakeToolDescription(p: WakePlace): string {
  return `For Grok Bot: lets ${it(p)} start a run of yours when the person points you while you are not working, so you answer without being asked. Returns whether it is on; while it is off, the routine to create (a routine with a webhook trigger, whose instructions it gives) and paste_at: ${page(p)} where the person pastes that routine's webhook URL and key; while it is on, last_delivery: when ${it(p)} last called the webhook and what it answered. If the person does not want it, call it with declined: true and ${it(p)} stops suggesting it. Never ask the person for the URL or the key in chat: they paste them into ${it(p)} themselves.`;
}

/**
 * The tool for a low-level MCP `Server` (the hub): its JSON Schema input. Its one input, `declined`, records the
 * person's no; it never returns or asks for the webhook's URL or key, which only the person sees in Grok Bot.
 */
export function wakeTool(p: WakePlace) {
  return {
    name: WAKE_TOOL_NAME,
    title: WAKE_TOOL_TITLE,
    description: wakeToolDescription(p),
    inputSchema: { type: "object", properties: { declined: { type: "boolean", description: declinedText(p) } } },
    annotations: WAKE_TOOL_ANNOTATIONS,
  } as const;
}

/** The same input as a zod shape, for an app's `McpServer.registerTool`. */
export function wakeToolShape(p: WakePlace) {
  return { declined: z.boolean().optional().describe(declinedText(p)) };
}

/** What a Grok bot agent's get_current_view and wait_for_focus results carry while Wake on pin is off and not declined. */
export function wakeResultHint(p: WakePlace): { state: "off"; hint: string } {
  return { state: "off", hint: `Offer the person Wake on pin, so ${it(p)} can start a run of yours when they point you while you are not working: call wake_on_pin. If they say no, call wake_on_pin with declined: true.` };
}

/** The line added to the server's instructions for a Grok bot agent while no webhook is set and the person has not declined. */
export function wakeHint(p: WakePlace): string {
  return `You are Grok Bot: ${p.dock ? "this dock" : p.name} can wake you when the person points you while you are not working. Offer it to the person once; if they agree, call wake_on_pin and follow what it returns. Never ask for the webhook's URL or key in chat.`;
}

/** The last call to the webhook (a test or a wake), as wake_on_pin reports it; never the URL or the key. */
export interface WakeDelivery {
  at: string;
  event: "test" | "pin";
  outcome: "ok" | "broken" | "error";
  /** The webhook's HTTP status, or null when no answer came (network, deadline). */
  http_status: number | null;
}

/** What wake_on_pin answers: on (with the last delivery), or off with the routine to create; never the URL or the key. */
export function wakeSetup(p: WakePlace, on: boolean, status: string | null, pasteAt: string, last: WakeDelivery | null = null): Record<string, unknown> {
  if (on) {
    return {
      wake: "on",
      status,
      last_delivery: last,
      paste_at: pasteAt,
      note:
        status === "limit"
          ? "Wake on pin is on, but today's wakes are used up: it starts again tomorrow (UTC)."
          : status === "paused"
            ? `Wake on pin is set, but paused: this agent no longer reports as Grok bot to ${it(p)}.`
            : last
        ? last.outcome === "ok"
          ? "Wake on pin is on, and the webhook took the last call. Nothing to set up. To change or turn it off, the person opens paste_at."
          : "Wake on pin is on, but the webhook did not take the last call (last_delivery says how). Ask the person to check the routine in Grok Bot and paste its URL and key again at paste_at, then press Send a test."
        : `Wake on pin is on; ${it(p)} has not called the webhook yet. Ask the person to press Send a test at paste_at.`,
    };
  }
  return {
    wake: "off",
    routine: { name: p.routineName, trigger: "webhook", instructions: wakeRoutinePrompt(p) },
    paste_at: pasteAt,
    steps: [
      `Create a routine named "${p.routineName}" with a webhook trigger (not a schedule) and routine.instructions as its instructions. If a routine with this name already exists, update its instructions and resume it instead of creating a new one.`,
      "Tell the person where in Grok Bot they find that routine's webhook URL and key.",
      "Ask them to open paste_at, paste the URL and the key under Wake on pin, Save, and press Send a test.",
    ],
    note: `You never see the webhook's key, and must not ask for it: the person copies it from Grok Bot into ${page(p)}.`,
  };
}

/** A result with one more top-level key, in its structured content and in its JSON text, as the other keys are. */
export function withKey<T extends { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }>(result: T, key: string, value: unknown): T {
  const structured = result.structuredContent ? { ...result.structuredContent, [key]: value } : undefined;
  let mirrored = false;
  const content = result.content.map((block, index) => {
    if (index !== 0 || block.type !== "text" || typeof block.text !== "string") return block;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mirrored = true;
        return { type: "text", text: JSON.stringify({ ...(parsed as object), [key]: value }) };
      }
    } catch {
      // not JSON: a block of its own below
    }
    return block;
  });
  if (!mirrored) content.push({ type: "text", text: JSON.stringify({ [key]: value }) });
  return { ...result, content, ...(structured ? { structuredContent: structured } : {}) };
}

// ---- the store ----

/** An agent's webhook: `gen` changes on every set, so a POST's outcome lands only on the webhook it was sent for. */
export interface WakeRow {
  gen: string;
  url: string;
  key: string;
  created_at: string;
  sent_at: number | null;
  status: WakeStatus | null;
  status_at: string | null;
  pending_at: number | null;
  pending_kind: string | null;
  /** The source (a pairing, a browser's reader, an app's grant) whose pin made the wake due: checked again before the POST. */
  pending_source: string | null;
  due: number | null;
  /** The last POST to this webhook (TIN-967): when, a test or a wake, how it went, and the HTTP status (null: no answer). */
  delivered_at: number | null;
  delivered_event: string | null;
  delivered_outcome: string | null;
  delivered_code: number | null;
}

/** A day's count of POSTs, per agent or per shared scope. */
export interface WakeBudget {
  day: string;
  count: number;
}

/** Where the engine keeps its state: synchronous, so every check and write happens with nothing running in between. */
export interface WakeStore {
  get(id: string): WakeRow | null;
  put(id: string, row: WakeRow): void;
  /** The webhook goes (Turn off); the budget, the hint and the decline stay. */
  remove(id: string): void;
  /** Every webhook goes (Start over, no computer left). */
  removeAll(): void;
  budget(scope: string): WakeBudget | null;
  setBudget(scope: string, budget: WakeBudget): void;
  /** When the offer last went out in a result, and when the person declined (ms), or null. */
  hint(id: string): number | null;
  setHint(id: string, at: number): void;
  declined(id: string): number | null;
  setDeclined(id: string, at: number): void;
  /** The ids with a pending wake and their due time. */
  pending(): Array<{ id: string; due: number }>;
  /**
   * The agent or grant ended: its webhook, hint and decline go. Whether its own budget goes too is the store's choice:
   * the hub's deletes it (as removing an agent always did); `kvWakeStore` keeps it (an app's shared scope bounds it).
   */
  purge(id: string): void;
}

const ROW = "wake:";
const BUDGET = "wake_budget:";
const HINT = "wake_hint:";
const DECLINED = "wake_declined:";

/** A `WakeStore` in an app's `ApcKv` (`wake:`, `wake_budget:`, `wake_hint:`, `wake_declined:`): beside apc_link's keys, never on them. */
export function kvWakeStore(kv: ApcKv): WakeStore {
  const json = <T>(key: string): T | null => {
    const raw = kv.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const num = (key: string): number | null => {
    const raw = kv.get(key);
    return raw === null || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  return {
    get: (id) => json<WakeRow>(ROW + id),
    put: (id, row) => kv.put(ROW + id, JSON.stringify(row)),
    remove: (id) => kv.delete(ROW + id),
    removeAll: () => {
      for (const [key] of kv.list(ROW)) kv.delete(key);
    },
    budget: (scope) => json<WakeBudget>(BUDGET + scope),
    setBudget: (scope, b) => kv.put(BUDGET + scope, JSON.stringify(b)),
    hint: (id) => num(HINT + id),
    setHint: (id, at) => kv.put(HINT + id, String(at)),
    declined: (id) => num(DECLINED + id),
    setDeclined: (id, at) => kv.put(DECLINED + id, String(at)),
    pending: () => {
      const out: Array<{ id: string; due: number }> = [];
      for (const [key, value] of kv.list(ROW)) {
        try {
          const row = JSON.parse(value) as WakeRow;
          if (row.pending_at !== null && row.due !== null) out.push({ id: key.slice(ROW.length), due: row.due });
        } catch {
          // not a row
        }
      }
      return out;
    },
    purge: (id) => {
      kv.delete(ROW + id);
      kv.delete(HINT + id);
      kv.delete(DECLINED + id);
    },
  };
}

// ---- the engine ----

/** What only the server knows. Every method is synchronous. */
export interface WakeHost {
  /** The server still holds this agent (the dock or the sandbox has not expired, the agent or grant exists). */
  alive(id: string): boolean;
  /** The pin's source is still live: the pairing paired, the browser's reading there, the grant Direct and not revoked. */
  live(id: string, source: string, kind: WakeKind): boolean;
  /**
   * Nothing to wake for: the agent was handed a pin of that source strictly after `pendingAt`, or there is no current
   * pin from that source any more (unpinned, cleared, replaced by another source's), when the server holds the pin.
   */
  covered(id: string, source: string, pendingAt: number, kind: WakeKind): boolean;
  /** The agent's client still declares Grok bot (a hint, never authentication). */
  offered(id: string): boolean;
  /** A call or a wait of the agent is in flight: it will deliver the pin itself. */
  deferred(id: string): boolean;
  /** Set the object's alarm again (it includes `nextDue()`). */
  arm(): Promise<void>;
  /** The page's state changed. */
  changed(): void;
  /** Work that runs on after the request that started it (waitUntil). */
  later?(work: Promise<unknown>): void;
}

export interface WakeEngineOptions {
  place: WakePlace;
  /** A budget every id also counts in (an app's sandbox), 200 a day like each id's own. */
  sharedScope?: string;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The wake state machine, one per Durable Object. Memory holds only what dies with the object: the POST in flight
 * per id (one at a time), the timers, the last test's time, and whether Start over is under way. The alarm is the
 * backstop for a timer an evicted object lost: `deliverDue()` from the alarm, `nextDue()` in the alarm's time.
 */
export class WakeEngine {
  private store: WakeStore;
  private readonly host: WakeHost;
  readonly place: WakePlace;
  private readonly sharedScope: string | null;
  private readonly aborts = new Map<string, AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tests = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  private resetting = false;

  constructor(store: WakeStore, host: WakeHost, options: WakeEngineOptions) {
    this.store = store;
    this.host = host;
    this.place = options.place;
    this.sharedScope = options.sharedScope ?? null;
  }

  /** The storage was wiped and made again: the same engine (its POSTs in flight can still be cut) over the new store. */
  useStore(store: WakeStore): void {
    this.store = store;
  }

  private later(work: Promise<unknown>): void {
    const running: Promise<void> = work.then(
      () => void this.running.delete(running),
      () => void this.running.delete(running),
    );
    this.running.add(running);
    this.host.later?.(running);
  }
  /** Resolves once the work started here has ended, including work it started meanwhile (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** What the page shows of an agent's webhook: never the key, and of the URL only the end of the trigger's id. */
  view(id: string): { url_tail: string; status: WakeStatus | null; status_at: string | null; sent_at: string | null } | null {
    const w = this.store.get(id);
    return w ? { url_tail: w.url.slice(-6), status: w.status, status_at: w.status_at, sent_at: w.sent_at ? new Date(w.sent_at).toISOString() : null } : null;
  }

  /** Whether a webhook is set for the agent. */
  isOn(id: string): boolean {
    return this.store.get(id) !== null;
  }

  /** Whether the server's instructions still offer it: no webhook set and the person has not declined. */
  offerInInstructions(id: string): boolean {
    return this.store.get(id) === null && this.store.declined(id) === null;
  }

  /** The earliest pending wake's due time, or null: what the object's alarm includes. */
  nextDue(): number | null {
    let next: number | null = null;
    for (const { due } of this.store.pending()) if (next === null || due < next) next = due;
    return next;
  }

  /**
   * A pin happened that the agent may not hear of: if it has a webhook, a wake is due WAKE_SETTLE_MS from now, or when
   * WAKE_GAP_MS since the last one has passed. A due already set stays (a second pin does not push the wake out); the
   * newest pin is the one to cover. Synchronous.
   */
  demand(id: string, kind: WakeKind, source: string): void {
    if (this.resetting) return;
    const w = this.store.get(id);
    if (!w) return;
    const now = Date.now();
    // Deliberate (TIN-964, kept): the first due stands (no starvation by pins), while pending_at, and with it the 60 s defer cap, restarts with each pin.
    const due = w.due ?? Math.max(now + WAKE_SETTLE_MS, (w.sent_at ?? 0) + WAKE_GAP_MS);
    this.store.put(id, { ...w, pending_at: now, pending_kind: kind, pending_source: source, due });
    this.schedule(id);
  }

  /** A timer for the agent's pending wake, and the alarm as its backstop. */
  private schedule(id: string): void {
    const w = this.store.get(id);
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    this.timers.delete(id);
    if (!w || w.pending_at === null || w.due === null) return;
    const timer = setTimeout(() => {
      if (this.timers.get(id) === timer) this.timers.delete(id);
      this.later(this.deliver(id));
    }, Math.max(0, w.due - Date.now()));
    this.timers.set(id, timer);
    this.later(this.host.arm());
  }

  /** Drop the agent's pending wake. */
  private drop(id: string): void {
    const w = this.store.get(id);
    if (w) this.store.put(id, { ...w, pending_at: null, pending_kind: null, pending_source: null, due: null });
  }

  /** The status, only on the webhook `gen` names; the page hears of it either way. */
  private setStatus(id: string, gen: string, status: WakeStatus): void {
    const w = this.store.get(id);
    if (w && w.gen === gen) this.store.put(id, { ...w, status, status_at: new Date().toISOString() });
    this.host.changed();
  }

  /** One more POST for the agent today, if the day's budgets allow it (counted before it is sent). */
  private spend(id: string, now: number): boolean {
    const day = wakeDay(now);
    const scopes = this.sharedScope ? [id, this.sharedScope] : [id];
    const counts = scopes.map((scope) => {
      const b = this.store.budget(scope);
      return b && b.day === day ? b.count : 0;
    });
    if (counts.some((count) => count >= WAKE_DAY_MAX)) return false;
    scopes.forEach((scope, i) => this.store.setBudget(scope, { day, count: counts[i]! + 1 }));
    return true;
  }

  /**
   * The agent's pending wake, when due: dropped if the server is gone, the source is no longer live, the pin was
   * handed over or is gone, or the webhook is broken; paused if the client no longer declares Grok bot; put off while a
   * POST of the agent's is in flight, or (up to WAKE_DEFER_MAX_MS) a call or wait of it; refused over the budget;
   * otherwise one POST. Every check and write happens before the POST.
   */
  async deliver(id: string): Promise<void> {
    if (this.resetting) return;
    const w = this.store.get(id);
    if (!w || w.pending_at === null || w.due === null) return;
    const now = Date.now();
    if (w.due > now) return this.schedule(id);
    if (!this.host.alive(id)) return this.drop(id);
    const kind: WakeKind = w.pending_kind === "page_reading" ? "page_reading" : "pin";
    const source = w.pending_source ?? "";
    if (!this.host.live(id, source, kind) || this.host.covered(id, source, w.pending_at, kind) || w.status === "broken") return this.drop(id);
    if (!this.host.offered(id)) {
      this.drop(id);
      this.setStatus(id, w.gen, "paused");
      return;
    }
    // A POST of this agent's still in flight (a test): this one waits for it, it is never cut.
    // The host's callbacks ran since the read: write only onto the same webhook, never bring back one they removed.
    const same = () => {
      const cur = this.store.get(id);
      return cur && cur.gen === w.gen ? cur : null;
    };
    if (this.aborts.has(id) || (this.host.deferred(id) && now - w.pending_at < WAKE_DEFER_MAX_MS)) {
      const cur = same();
      if (!cur) return;
      this.store.put(id, { ...cur, due: now + WAKE_DEFER_MS });
      return this.schedule(id);
    }
    if (!this.spend(id, now)) {
      this.drop(id);
      this.setStatus(id, w.gen, "limit");
      return;
    }
    const cur = same();
    if (!cur) return;
    this.store.put(id, { ...cur, pending_at: null, pending_kind: null, pending_source: null, due: null, sent_at: now });
    await this.post(id, cur, { v: 1, event: "pin", kind, at: new Date(now).toISOString() });
  }

  /**
   * The alarm: every wake whose time came while no timer was left to deliver it. None is left due in the past
   * afterwards (each is sent, dropped or put off), so the alarm set from `nextDue()` never rings again at once.
   */
  deliverDue(): void {
    const now = Date.now();
    // Each deliver runs up to its POST before the next line: by then its row is sent, dropped or put off.
    for (const { id, due } of this.store.pending()) if (due <= now) this.later(this.deliver(id));
    // One whose host threw before it decided is dropped: a past due would make the alarm ring again at once, for ever.
    for (const { id, due } of this.store.pending()) if (due <= now) this.drop(id);
  }

  /** One POST to the agent's webhook, no retry: a run may have started even when the answer was lost. */
  private async post(id: string, w: WakeRow, body: Record<string, unknown>): Promise<"ok" | "broken" | "error"> {
    // One POST per agent at a time (deliver waits, test refuses), so none cuts another.
    const controller = new AbortController();
    this.aborts.set(id, controller);
    const timer = setTimeout(() => controller.abort(), WAKE_DEADLINE_MS);
    let outcome: "ok" | "broken" | "error";
    let code: number | null = null;
    try {
      // Only Grok Bot's trigger, whatever the store holds.
      if (!WAKE_URL.test(w.url)) throw new Error("not a webhook");
      const response = await fetch(w.url, {
        method: "POST",
        headers: { authorization: `Bearer ${w.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
      void response.body?.cancel().catch(() => {});
      outcome = wakeOutcome(response);
      code = (response.type as string) === "opaqueredirect" ? null : response.status;
    } catch {
      // Never the URL or the key in a log: the error may carry them.
      outcome = "error";
    } finally {
      clearTimeout(timer);
      if (this.aborts.get(id) === controller) this.aborts.delete(id);
    }
    // Only for the webhook that was sent, read again now: one cleared or set again meanwhile keeps its own state, and a
    // pin that came during the POST keeps its pending wake.
    const cur = this.store.get(id);
    if (cur && cur.gen === w.gen) {
      this.store.put(id, { ...cur, delivered_at: Date.now(), delivered_event: body.event === "test" ? "test" : "pin", delivered_outcome: outcome, delivered_code: code, status: outcome, status_at: new Date().toISOString() });
    }
    this.host.changed();
    return outcome;
  }

  /** Stop one agent's wakes: its POST in flight is cut and its timer goes. Its webhook stays. */
  stop(id: string): void {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** Stop every agent's wakes; with `forget`, every webhook goes too (its key with it). */
  stopAll(forget = false): void {
    for (const id of new Set([...this.aborts.keys(), ...this.timers.keys()])) this.stop(id);
    if (forget) this.store.removeAll();
  }

  /** The object's storage is about to be wiped: nothing in memory outlives it. */
  resetMemory(): void {
    this.stopAll();
    this.tests.clear();
  }

  /** Start over is under way: no webhook is set and no wake is made due until `endReset`. */
  beginReset(): void {
    this.resetting = true;
  }
  endReset(): void {
    this.resetting = false;
  }

  /** Turn off: the webhook goes; the budget, the hint and the decline stay. */
  clear(id: string): void {
    this.stop(id);
    this.store.remove(id);
    this.host.changed();
  }

  /** The agent or grant ended: its webhook, hint and decline go, and what memory held of it. */
  purge(id: string): void {
    this.stop(id);
    this.store.purge(id);
    this.tests.delete(id);
  }

  /** The owner sets the agent's webhook (only while offered, only Grok Bot's trigger URL). A new one starts clean. */
  set(id: string, body: unknown): { ok: true } | { ok: false; error: "unknown" | "not_offered" | "invalid" } {
    if (this.resetting || !this.host.alive(id)) return { ok: false, error: "unknown" };
    if (!this.host.offered(id)) return { ok: false, error: "not_offered" };
    const wake = parseWake(body);
    if (!wake) return { ok: false, error: "invalid" };
    this.stop(id);
    this.store.put(id, {
      gen: randomHex(8), url: wake.url, key: wake.key, created_at: new Date().toISOString(),
      sent_at: null, status: null, status_at: null, pending_at: null, pending_kind: null, pending_source: null, due: null,
      delivered_at: null, delivered_event: null, delivered_outcome: null, delivered_code: null,
    });
    this.host.changed();
    return { ok: true };
  }

  /** Send a test to the agent's webhook now: allowed when broken, one per WAKE_TEST_GAP_MS, counted in the day's budget. */
  async test(id: string): Promise<{ ok: true; status: "ok" | "broken" | "error" } | { ok: false; error: "no_webhook" | "paused" | "too_soon" | "limit" }> {
    const w = this.store.get(id);
    if (this.resetting || !w || !this.host.alive(id)) return { ok: false, error: "no_webhook" };
    // As a wake: only while the agent still declares Grok bot.
    if (!this.host.offered(id)) return { ok: false, error: "paused" };
    const now = Date.now();
    if (this.aborts.has(id) || now - (this.tests.get(id) ?? 0) < WAKE_TEST_GAP_MS) return { ok: false, error: "too_soon" };
    if (!this.spend(id, now)) return { ok: false, error: "limit" };
    this.tests.set(id, now);
    const status = await this.post(id, w, { v: 1, event: "test", at: new Date(now).toISOString() });
    return { ok: true, status };
  }

  /** wake_on_pin's answer: on, or off with the routine to create; `declined: true` records the person's no while off. */
  setup(id: string, pasteAt: string, args: Record<string, unknown> = {}): ToolResult {
    const w = this.store.get(id);
    // The person said no: the offer stops. They can still ask: this tool keeps answering. Never over a webhook that is set.
    if (args.declined === true && !w) {
      this.store.setDeclined(id, Date.now());
      return toolResult({ wake: "off", declined: true, paste_at: pasteAt, note: `Noted: ${it(this.place)} will not suggest Wake on pin again. If the person asks for it later, call wake_on_pin again.` });
    }
    const last: WakeDelivery | null = w && w.delivered_at !== null
      ? { at: new Date(w.delivered_at).toISOString(), event: w.delivered_event === "test" ? "test" : "pin", outcome: w.delivered_outcome === "ok" ? "ok" : w.delivered_outcome === "broken" ? "broken" : "error", http_status: w.delivered_code ?? null }
      : null;
    return toolResult(wakeSetup(this.place, !!w, w?.status ?? null, pasteAt, last));
  }

  /** Whether this result may carry the offer: off, not declined, not in the last day. Marks it given. */
  hintDue(id: string): boolean {
    if (this.store.get(id) || this.store.declined(id) !== null) return false;
    const now = Date.now();
    const at = this.store.hint(id);
    if (at !== null && now - at < WAKE_HINT_EVERY_MS) return false;
    this.store.setHint(id, now);
    return true;
  }
}
