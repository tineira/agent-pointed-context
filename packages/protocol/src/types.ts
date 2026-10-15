/**
 * Wire types of the three APC channels, as in the companion specification
 * (04-payload-specification.md, https://doi.org/10.5281/zenodo.23383101).
 * Only identifiers and keys travel: never text, amounts or pixels.
 */

/** A key-only value: an id, a month, an enum word, or a list of those. */
export type KeyValue = string | string[];
export type FocusParams = Record<string, KeyValue>;

/** What the person pointed at: a row, a part of a row, or a part of a computed figure. */
export interface FocusTarget {
  kind: string;
  /** The row id; null for a figure, which is named by its params. */
  id: string | null;
  part: string | null;
  params: FocusParams | null;
}

/** The stored pin, one per grant. */
export interface FocusRow extends FocusTarget {
  grant_id: string;
  pinned_at: string;
  seen_at: string | null;
}

/** What the agent receives: the target plus the tool and arguments that read it. */
export interface FocusPayload extends FocusTarget {
  app_url: string;
  pinned_at: string;
  next: string;
  next_args: Record<string, unknown>;
  part_note?: string;
  trimmed?: { hidden_entities: number } | null;
  gone?: boolean;
}

/** Carried on every tool result while the pin is unread. */
export interface Attention {
  focus: FocusPayload;
  note: string;
}

/** The person's screen as identifiers, trimmed to the calling grant. */
export interface ViewPayload {
  screen: string;
  params: FocusParams;
  selection: { kind: string; id: string } | null;
  app_url: string;
  updated_at: string;
  age_seconds: number;
  stale: boolean;
  next: string | null;
}

/** One message on the presence channel, after each successful tool call. */
export interface PresenceEvent {
  v: 1;
  grant_id: string;
  at: string;
  tool: string;
  kind: "read" | "write";
  targets: Array<{ kind: string; id: string }>;
  count: number;
}
