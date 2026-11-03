/**
 * The figures Pulse draws, as pure functions. The page imports them to draw;
 * the server imports the same functions to answer get_figure. Same data, same
 * parameters, same scope, same code: same number (claim C4).
 */
import { MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "./seed.ts";

/** What a reader may see: the regions of its grant. The owner sees all three. */
export interface Scope {
  regions: readonly Region[];
}
export const FULL_SCOPE: Scope = { regions: REGIONS };

export interface CustomerFact {
  customer_id: string;
  plan: Plan;
  region: Region;
  seats: number;
}

export interface FigureResult {
  values: Record<string, number>;
  series?: Array<{ month: string; value: number }>;
  breakdown: Record<string, CustomerFact[]>;
  /** External ids behind the number: the join keys an agent can match with what the person knows. */
  inputs: { customers: string[] };
  /** Regions the request named that the scope hid. */
  hidden_regions: Region[];
}

type Params = Record<string, string | string[]>;

function isMonth(v: unknown): v is string {
  return typeof v === "string" && MONTHS.includes(v);
}
function isPlan(v: unknown): v is Plan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}
function isRegion(v: unknown): v is Region {
  return typeof v === "string" && (REGIONS as readonly string[]).includes(v);
}

/** The regions a figure is computed over: what it asked for, cut to the scope. */
export function lens(region: Region | undefined, scope: Scope): { visible: Region[]; hidden: Region[] } {
  const asked = region ? [region] : [...REGIONS];
  return { visible: asked.filter((r) => scope.regions.includes(r)), hidden: asked.filter((r) => !scope.regions.includes(r)) };
}

function index(data: Dataset) {
  const byCustomerMonth = new Map<string, { active: boolean; seats: number }>();
  for (const a of data.activity) byCustomerMonth.set(`${a.customer_id}|${a.month}`, a);
  return (customerId: string, month: string | undefined) => (month ? byCustomerMonth.get(`${customerId}|${month}`) : undefined);
}

function previousMonth(month: string): string | undefined {
  const i = MONTHS.indexOf(month);
  return i > 0 ? MONTHS[i - 1] : undefined;
}

// ---- active_customers: active customers per month, one bar per month ----

export interface ActiveArgs {
  month: string;
  plan?: Plan;
  region?: Region;
}

export function activeCustomers(data: Dataset, args: ActiveArgs, scope: Scope): FigureResult {
  const { visible, hidden } = lens(args.region, scope);
  const at = index(data);
  const eligible = data.customers.filter((c) => visible.includes(c.region) && (!args.plan || c.plan === args.plan));
  const series = MONTHS.map((month) => ({ month, value: eligible.filter((c) => at(c.id, month)?.active).length }));
  const facts: CustomerFact[] = eligible
    .filter((c) => at(c.id, args.month)?.active)
    .map((c) => ({ customer_id: c.id, plan: c.plan, region: c.region, seats: at(c.id, args.month)!.seats }));
  return {
    values: { active: facts.length, seats: facts.reduce((sum, f) => sum + f.seats, 0) },
    series,
    breakdown: { customers: facts },
    inputs: { customers: facts.map((f) => f.customer_id) },
    hidden_regions: hidden,
  };
}

// ---- customer_bridge: from last month's active customers to this month's ----

export const BRIDGE_STEPS = ["start", "new", "reactivated", "churned", "end"] as const;
export type BridgeStep = (typeof BRIDGE_STEPS)[number];

export interface BridgeArgs {
  month: string;
  region?: Region;
  step?: BridgeStep;
}

export function customerBridge(data: Dataset, args: BridgeArgs, scope: Scope): FigureResult {
  const { visible, hidden } = lens(args.region, scope);
  const at = index(data);
  const prev = previousMonth(args.month);
  const steps: Record<BridgeStep, CustomerFact[]> = { start: [], new: [], reactivated: [], churned: [], end: [] };
  for (const c of data.customers) {
    if (!visible.includes(c.region)) continue;
    const before = at(c.id, prev);
    const now = at(c.id, args.month);
    const fact = (seats: number): CustomerFact => ({ customer_id: c.id, plan: c.plan, region: c.region, seats });
    if (before?.active) steps.start.push(fact(before.seats));
    if (now?.active) {
      steps.end.push(fact(now.seats));
      if (!before) steps.new.push(fact(now.seats));
      else if (!before.active) steps.reactivated.push(fact(now.seats));
    } else if (before?.active) {
      steps.churned.push(fact(0));
    }
  }
  const values = Object.fromEntries(BRIDGE_STEPS.map((s) => [s, steps[s].length])) as Record<BridgeStep, number>;
  const breakdown = args.step ? { [args.step]: steps[args.step] } : steps;
  const ids = new Set(Object.values(breakdown).flat().map((f) => f.customer_id));
  return { values, breakdown, inputs: { customers: [...ids] }, hidden_regions: hidden };
}

// ---- the registry: every figure the page can be pointed at ----

export interface FigureSpec<A> {
  parse(params: Params): A | null;
  compute(data: Dataset, args: A, scope: Scope): FigureResult;
  /** Parts a pin may name on this figure. */
  partOk(part: string | null): boolean;
  /** Arguments for get_figure that read the pointed part. */
  nextParams(args: A, part: string | null): Record<string, string>;
  partNote(part: string | null): string | undefined;
  /** Deep link into the page that draws it. */
  path(args: A): string;
}

function only<K extends string>(params: Params, keys: readonly K[]): boolean {
  return Object.keys(params).every((k) => (keys as readonly string[]).includes(k));
}

const activeSpec: FigureSpec<ActiveArgs> = {
  parse(params) {
    if (!only(params, ["month", "plan", "region"])) return null;
    if (!isMonth(params.month)) return null;
    if (params.plan !== undefined && !isPlan(params.plan)) return null;
    if (params.region !== undefined && !isRegion(params.region)) return null;
    return { month: params.month, ...(params.plan ? { plan: params.plan as Plan } : {}), ...(params.region ? { region: params.region as Region } : {}) };
  },
  compute: activeCustomers,
  // "series": the person pointed at the whole chart, not one month (TIN-357).
  partOk: (part) => part === null || part === "series",
  nextParams: (args) => ({ ...args }),
  partNote: (part) =>
    part === "series"
      ? "The person pointed at the whole chart, not one month: series holds every month's active customers (the trend). values.active and breakdown are the selected month."
      : "values.active is the bar; breakdown.customers lists each active customer with plan, region and seats; inputs.customers are the external ids.",
  path: (args) => `/overview?month=${args.month}${args.plan ? `&plan=${args.plan}` : ""}${args.region ? `&region=${args.region}` : ""}`,
};

const bridgeSpec: FigureSpec<BridgeArgs> = {
  parse(params) {
    if (!only(params, ["month", "region", "step"])) return null;
    if (!isMonth(params.month)) return null;
    if (params.region !== undefined && !isRegion(params.region)) return null;
    if (params.step !== undefined && !(BRIDGE_STEPS as readonly unknown[]).includes(params.step)) return null;
    return { month: params.month, ...(params.region ? { region: params.region as Region } : {}), ...(params.step ? { step: params.step as BridgeStep } : {}) };
  },
  compute: customerBridge,
  partOk: (part) => part === null || BRIDGE_STEPS.some((s) => part === `step:${s}`),
  nextParams: (args, part) => ({ ...args, ...(part?.startsWith("step:") ? { step: part.slice(5) } : {}) }),
  partNote: (part) =>
    part?.startsWith("step:")
      ? `${part.slice(5)} is one of the five steps in values; its customers are in breakdown.${part.slice(5)}.`
      : "values holds the five steps (start + new + reactivated - churned = end); breakdown lists the customers of each.",
  path: (args) => `/overview?month=${args.month}${args.region ? `&region=${args.region}` : ""}`,
};

export const FIGURES = {
  active_customers: activeSpec,
  customer_bridge: bridgeSpec,
} as const;
export type FigureKey = keyof typeof FIGURES;
export const FIGURE_KEYS = Object.keys(FIGURES) as FigureKey[];

export function figureSpec(key: string): FigureSpec<any> | null {
  return (FIGURES as Record<string, FigureSpec<any>>)[key] ?? null;
}
