/**
 * Signals' pure parts (TIN-384): its one screen, its one kind of target (a post, or a part of it),
 * and what the agent reads. The posts come from Pulse's model (model/market.ts) for the visitor's
 * seed. No Workers APIs here, so the tests run it.
 */
import type { FocusPayload, FocusRow, FocusTarget, ViewPayload } from "@apc/protocol";
import { canonicalTarget, parseTarget } from "@apc/protocol";
import { MONTHS } from "../../../demo/src/model/seed.ts";
import { POST_PARTS, type Post } from "../../../demo/src/model/market.ts";

export const KINDS = ["competitor_offer", "our_ad"] as const;
export type PostKind = (typeof KINDS)[number];

export interface StoredView {
  screen: "feed";
  params: { kind?: PostKind; month?: string };
  selection: { kind: "post"; id: string } | null;
  updated_at: string;
}

export function sanitizeView(raw: unknown, posts: readonly Post[], now = new Date()): StoredView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { screen?: unknown; params?: unknown; selection?: unknown };
  if (r.screen !== "feed") return null;
  const p = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
  const params: StoredView["params"] = {};
  if ((KINDS as readonly unknown[]).includes(p.kind)) params.kind = p.kind as PostKind;
  if (typeof p.month === "string" && MONTHS.includes(p.month)) params.month = p.month;
  const s = r.selection as { kind?: unknown; id?: unknown } | null | undefined;
  const selection = s && s.kind === "post" && typeof s.id === "string" && posts.some((x) => x.id === s.id) ? { kind: "post" as const, id: s.id } : null;
  return { screen: "feed", params, selection, updated_at: now.toISOString() };
}

export const VIEW_STALE_S = 30 * 60;

export function viewPayload(view: StoredView | null, origin: string, now = Date.now()): ViewPayload | null {
  if (!view) return null;
  const query = new URLSearchParams({ ...view.params, ...(view.selection ? { post: view.selection.id } : {}) }).toString();
  const age = Math.max(0, Math.round((now - Date.parse(view.updated_at)) / 1000));
  return {
    screen: view.screen,
    params: { ...view.params },
    selection: view.selection,
    app_url: `${origin}/${query ? `?${query}` : ""}`,
    updated_at: view.updated_at,
    age_seconds: age,
    stale: age > VIEW_STALE_S,
    next: view.selection ? "get_post" : null,
  };
}

/** A pin on a post or one of its parts. A code is only on our ads. */
export function checkPin(raw: unknown, posts: readonly Post[]): { target: FocusTarget } | { error: string } {
  const target = raw && typeof raw === "object" ? parseTarget(raw as Record<string, unknown>) : null;
  if (!target || target.kind !== "post" || !target.id || target.params !== null) return { error: "invalid_target" };
  const post = posts.find((p) => p.id === target.id);
  if (!post) return { error: "not_found" };
  if (target.part && !(POST_PARTS as readonly string[]).includes(target.part)) return { error: "invalid_target" };
  if (target.part === "code" && post.kind !== "our_ad") return { error: "invalid_target" };
  return { target };
}

/** A pin dropped back on the target it already has (a click on a badge, TIN-482) changes nothing: it keeps its read state. */
export function samePin(current: FocusRow | null, target: FocusTarget): boolean {
  return !!current && canonicalTarget(current) === canonicalTarget(target);
}

const PART_NOTES: Record<string, string> = {
  offer: "the person pointed at the offer: post.offer",
  audience: "the person pointed at who it targets: post.audience (region, plan)",
  code: "the person pointed at the promo code: post.code",
  text: "the person pointed at the post's text: post.text",
};

export function focusPayload(row: FocusRow | null, posts: readonly Post[], origin: string): FocusPayload | null {
  if (!row || row.kind !== "post" || !row.id) return null;
  const post = posts.find((p) => p.id === row.id);
  const base = { kind: row.kind, id: row.id, part: row.part, params: null, pinned_at: row.pinned_at, app_url: `${origin}/?post=${row.id}`, next: "get_post", next_args: { id: row.id } };
  if (!post) return { ...base, gone: true };
  return { ...base, ...(row.part && PART_NOTES[row.part] ? { part_note: PART_NOTES[row.part] } : {}) };
}

export function postAnswer(posts: readonly Post[], id: string, origin: string) {
  const post = posts.find((p) => p.id === id);
  if (!post) return { error: "not_found", message: "no such post" } as const;
  return { post, app_url: `${origin}/?post=${id}` };
}

export function listPosts(posts: readonly Post[], filter: { kind?: string; month?: string }) {
  const rows = posts
    .filter((p) => !filter.kind || p.kind === filter.kind)
    .filter((p) => !filter.month || p.month === filter.month)
    .map((p) => ({ id: p.id, kind: p.kind, author: p.author, month: p.month, audience: p.audience, offer: p.offer, ...(p.kind === "our_ad" ? { code: p.code, channel: p.channel } : { ends_month: p.ends_month }) }));
  return { total: rows.length, rows };
}
