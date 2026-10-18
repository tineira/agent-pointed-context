/**
 * The client compatibility matrix (claim C8), from the event log alone: per
 * agent, did it connect, did a pin reach it, how did it read the pin, and did
 * it follow the pin's next call. No content, only what the log already holds.
 */
import type { Grant } from "./domain.ts";

export interface LoggedEvent {
  id: number;
  at: string;
  type: string;
  grant_id: string | null;
  [key: string]: unknown;
}

export interface CompatRow {
  grant_id: string;
  label: string;
  restricted: boolean;
  client_name: string | null;
  client_version: string | null;
  protocol_version: string | null;
  user_agent: string | null;
  /** Sent initialize. */
  connected: boolean;
  /** Asked for the tool list. */
  listed_tools: boolean;
  tool_calls: number;
  tools: string[];
  pins: number;
  /** Tool results that carried the attention envelope. */
  envelopes: number;
  /** Pins whose read stamped them seen, and through which tool. */
  pins_read: number;
  read_via: { get_current_view: number; wait_for_focus: number };
  /** Pins read after an envelope had reached the agent: the agent acted on the envelope. */
  read_after_envelope: number;
  /** Pins whose next call (next + next_args) the agent made. */
  next_reads: number;
  wait_calls: number;
  /** wait_for_focus calls that started within 30 s after the grant's last call ended, when that call was not itself a wait: the agent waited after answering. */
  waits_after_answer: number;
  median_pin_to_seen_ms: number | null;
  median_pin_to_next_ms: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const WAIT_AFTER_ANSWER_MS = 30_000;

/**
 * A tool_call is logged when the call ends, with its duration in ms. A wait
 * counts when the last call to end before it started is not a wait and ended
 * at most 30 s before: a wait right after a timed-out wait is a re-wait.
 */
export function waitsAfterAnswer(calls: LoggedEvent[]): number {
  const spans = calls.map((c) => {
    const end = Date.parse(c.at);
    return { wait: c.tool === "wait_for_focus", start: end - (typeof c.ms === "number" ? c.ms : 0), end };
  });
  let count = 0;
  for (const w of spans) {
    if (!w.wait) continue;
    let last: (typeof spans)[number] | null = null;
    for (const c of spans) if (c !== w && c.end <= w.start && (!last || c.end > last.end)) last = c;
    if (last && !last.wait && w.start - last.end <= WAIT_AFTER_ANSWER_MS) count++;
  }
  return count;
}

export function compatSummary(grants: Grant[], events: LoggedEvent[]): CompatRow[] {
  return grants.map((grant) => {
    const mine = events.filter((e) => e.grant_id === grant.id);
    const of = (type: string) => mine.filter((e) => e.type === type);
    const lastInit = of("initialize").at(-1);
    const calls = of("tool_call");
    const pins = of("pin");
    const pinnedAt = new Map(pins.map((p) => [str(p.pinned_at), Date.parse(p.at)]));
    const envelopesFor = new Set(of("envelope_delivered").map((e) => str(e.pinned_at)));
    const seen = of("seen");
    const nexts = of("next_read");
    const since = (e: LoggedEvent) => {
      const start = pinnedAt.get(str(e.pinned_at));
      return start === undefined ? null : Date.parse(e.at) - start;
    };
    return {
      grant_id: grant.id,
      label: grant.label,
      restricted: grant.regions !== null,
      client_name: str(lastInit?.client_name) ?? grant.client_name,
      client_version: str(lastInit?.client_version),
      protocol_version: str(lastInit?.protocol_version),
      user_agent: str(lastInit?.user_agent),
      connected: !!lastInit,
      listed_tools: of("tools_list").length > 0,
      tool_calls: calls.length,
      tools: [...new Set(calls.map((c) => String(c.tool)))].sort(),
      pins: pins.length,
      envelopes: of("envelope_delivered").length,
      pins_read: seen.length,
      read_via: {
        get_current_view: seen.filter((e) => e.via === "get_current_view").length,
        wait_for_focus: seen.filter((e) => e.via === "wait_for_focus").length,
      },
      read_after_envelope: seen.filter((e) => envelopesFor.has(str(e.pinned_at))).length,
      next_reads: nexts.length,
      wait_calls: calls.filter((c) => c.tool === "wait_for_focus").length,
      waits_after_answer: waitsAfterAnswer(calls),
      median_pin_to_seen_ms: median(seen.map(since).filter((v): v is number => v !== null)),
      median_pin_to_next_ms: median(nexts.map(since).filter((v): v is number => v !== null)),
    };
  });
}
