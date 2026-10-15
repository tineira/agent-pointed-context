/**
 * Everything the sandbox answers, as functions of (data, grant): no storage,
 * no transport. The Durable Object stores rows and calls these; tests call
 * them directly.
 */
import { parseParams, parseTarget, type FocusPayload, type FocusParams, type FocusRow, type FocusTarget, type ViewPayload } from "@apc/protocol";
import { FIGURE_KEYS, figureSpec, type Scope } from "../model/figures.ts";
import { MONTHS, PLANS, REGIONS, type Dataset, type Region } from "../model/seed.ts";

export interface Grant {
  id: string;
  secret: string;
  label: string;
  client_name: string | null;
  /** null: every region. */
  regions: Region[] | null;
  created_at: string;
  last_active_at: string | null;
}

export function scopeOf(grant: Grant): Scope {
  return { regions: grant.regions ?? REGIONS };
}

export function customerVisible(data: Dataset, grant: Grant, id: string): boolean {
  const customer = data.customers.find((c) => c.id === id);
  return !!customer && scopeOf(grant).regions.includes(customer.region);
}

// ---- view ----

export const SCREENS = ["howto", "overview", "customers", "customer", "agents"] as const;
export interface StoredView {
  screen: (typeof SCREENS)[number];
  params: FocusParams;
  selection: { kind: "customer"; id: string } | null;
  updated_at: string;
}

/** The allowlist: closed screens, months, plans, regions and one customer id. Anything else is dropped, never stored. */
export function sanitizeView(raw: unknown, data: Dataset, now = new Date()): StoredView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { screen?: unknown; params?: unknown; selection?: unknown };
  if (typeof r.screen !== "string" || !(SCREENS as readonly string[]).includes(r.screen)) return null;
  const params: FocusParams = {};
  const p = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
  if (typeof p.month === "string" && MONTHS.includes(p.month)) params.month = p.month;
  if (typeof p.plan === "string" && (PLANS as readonly string[]).includes(p.plan)) params.plan = p.plan;
  if (typeof p.region === "string" && (REGIONS as readonly string[]).includes(p.region)) params.region = p.region;
  let selection: StoredView["selection"] = null;
  const s = r.selection as { kind?: unknown; id?: unknown } | null | undefined;
  if (s && s.kind === "customer" && typeof s.id === "string" && data.customers.some((c) => c.id === s.id)) selection = { kind: "customer", id: s.id };
  return { screen: r.screen as StoredView["screen"], params, selection, updated_at: now.toISOString() };
}

export const VIEW_STALE_S = 30 * 60;

/** The view as one grant may see it. A by-id screen outside the grant is null, the same as no view. */
export function trimView(view: StoredView | null, grant: Grant, data: Dataset, origin: string, now = Date.now()): ViewPayload | null {
  if (!view) return null;
  const scope = scopeOf(grant);
  const selectionVisible = view.selection ? customerVisible(data, grant, view.selection.id) : false;
  if (view.screen === "customer" && !selectionVisible) return null;
  const params: FocusParams = { ...view.params };
  if (typeof params.region === "string" && !scope.regions.includes(params.region as Region)) delete params.region;
  const selection = view.selection && selectionVisible ? view.selection : null;
  const query = new URLSearchParams(params as Record<string, string>).toString();
  const path = view.screen === "customer" && selection ? `/customers/${selection.id}` : `/${view.screen}`;
  const age = Math.max(0, Math.round((now - Date.parse(view.updated_at)) / 1000));
  return {
    screen: view.screen,
    params,
    selection,
    app_url: `${origin}${path}${query ? `?${query}` : ""}`,
    updated_at: view.updated_at,
    age_seconds: age,
    stale: age > VIEW_STALE_S,
    next: selection ? "get_customer" : null,
  };
}

// ---- pin ----

export const KINDS = ["customer", "figure"] as const;
const CUSTOMER_PARTS = ["plan", "seats", "usage", "status"];

/** A pin the owner may drop for this grant, or the reason it is refused. */
export function checkPin(raw: unknown, grant: Grant, data: Dataset): { target: FocusTarget } | { error: string } {
  const target = raw && typeof raw === "object" ? parseTarget(raw as Record<string, unknown>) : null;
  if (!target || !(KINDS as readonly string[]).includes(target.kind)) return { error: "invalid_target" };
  if (target.kind === "customer") {
    if (!target.id || (target.part && !CUSTOMER_PARTS.includes(target.part))) return { error: "invalid_target" };
    if (!data.customers.some((c) => c.id === target.id)) return { error: "not_found" };
    if (!customerVisible(data, grant, target.id)) return { error: "out_of_grant" };
    return { target };
  }
  const { key, ...rest } = target.params ?? {};
  const spec = typeof key === "string" ? figureSpec(key) : null;
  const args = spec?.parse(rest);
  if (!spec || !args || !spec.partOk(target.part)) return { error: "invalid_target" };
  if (args.region && !scopeOf(grant).regions.includes(args.region)) return { error: "out_of_grant" };
  return { target };
}

/** What the agent receives for its pin: the target, its deep link, and the exact call that reads it. */
export function resolveFocus(row: FocusRow | null, grant: Grant, data: Dataset, origin: string): FocusPayload | null {
  if (!row) return null;
  const base = { kind: row.kind, id: row.id, part: row.part, params: row.params, pinned_at: row.pinned_at };
  if (row.kind === "customer" && row.id) {
    if (!customerVisible(data, grant, row.id)) return null;
    const notes: Record<string, string> = {
      plan: "the plan is customer.plan",
      seats: "seats per month are in activity[].seats",
      usage: "usage events per month are in activity[].events",
      status: "active or not per month is in activity[].active",
    };
    return {
      ...base,
      app_url: `${origin}/customers/${row.id}`,
      next: "get_customer",
      next_args: { id: row.id },
      ...(row.part && notes[row.part] ? { part_note: notes[row.part] } : {}),
    };
  }
  if (row.kind === "figure" && row.params) {
    const { key, ...rest } = row.params;
    const spec = typeof key === "string" ? figureSpec(key) : null;
    const args = spec?.parse(rest);
    if (!spec || !args) return { ...base, app_url: origin, next: "get_figure", next_args: {}, gone: true };
    const scope = scopeOf(grant);
    if (args.region && !scope.regions.includes(args.region)) return null;
    const hidden = args.region ? 0 : REGIONS.length - scope.regions.length;
    const note = spec.partNote(row.part);
    return {
      ...base,
      app_url: `${origin}${spec.path(args)}`,
      next: "get_figure",
      next_args: { key, params: spec.nextParams(args, row.part) },
      ...(note ? { part_note: note } : {}),
      trimmed: hidden > 0 ? { hidden_entities: hidden } : null,
    };
  }
  return null;
}

// ---- reads the agent makes ----

export function figureAnswer(data: Dataset, grant: Grant, key: string, rawParams: unknown, origin: string, now = new Date()) {
  const spec = figureSpec(key);
  if (!spec) return { error: "unknown_figure", message: `key must be one of ${FIGURE_KEYS.join(", ")}` } as const;
  const params = parseParams(rawParams ?? {});
  const args = params ? spec.parse(params) : null;
  if (!args) return { error: "invalid_params", message: "params are keys only: month (YYYY-MM), plan, region, step" } as const;
  const scope = scopeOf(grant);
  if (args.region && !scope.regions.includes(args.region)) return { error: "not_found", message: "no such figure" } as const;
  const result = spec.compute(data, args, scope);
  return {
    key,
    params: args,
    as_of: now.toISOString(),
    values: result.values,
    ...(result.series ? { series: result.series } : {}),
    breakdown: result.breakdown,
    inputs: result.inputs,
    trimmed: result.hidden_regions.length ? { hidden_entities: result.hidden_regions.length } : null,
    app_url: `${origin}${spec.path(args)}`,
  };
}

export function customerAnswer(data: Dataset, grant: Grant, id: string, origin: string) {
  if (!customerVisible(data, grant, id)) return { error: "not_found", message: "no such customer" } as const;
  const customer = data.customers.find((c) => c.id === id)!;
  const activity = data.activity.filter((a) => a.customer_id === id).map(({ customer_id: _, ...rest }) => rest);
  return { customer, activity, app_url: `${origin}/customers/${id}` };
}

export function listCustomers(
  data: Dataset,
  grant: Grant,
  filter: { month?: string; plan?: string; region?: string; active?: boolean; limit?: number; offset?: number },
) {
  const scope = scopeOf(grant);
  const month = filter.month && MONTHS.includes(filter.month) ? filter.month : MONTHS[MONTHS.length - 1]!;
  const seats = new Map(data.activity.filter((a) => a.month === month).map((a) => [a.customer_id, a]));
  const rows = data.customers
    .filter((c) => scope.regions.includes(c.region))
    .filter((c) => !filter.plan || c.plan === filter.plan)
    .filter((c) => !filter.region || c.region === filter.region)
    .map((c) => ({ ...c, month, active: seats.get(c.id)?.active ?? false, seats: seats.get(c.id)?.seats ?? 0 }))
    .filter((c) => filter.active === undefined || c.active === filter.active);
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  return { month, total: rows.length, rows: rows.slice(offset, offset + limit), has_more: offset + limit < rows.length, next_offset: offset + limit < rows.length ? offset + limit : null };
}
