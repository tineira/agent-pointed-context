/**
 * What the hero's agent answers after reading a bar (TIN-1066): what the chart does not show. Active customers and
 * total seats, the mix by plan and by region, the customer with the most seats and the runner-up (or a tie), and the
 * change against the month before, all from what get_figure and get_customer returned (hero-data.json). Pure, so it is tested.
 */
import { monthName, type HeroCustomerFact, type HeroMonth, type Plan, type Region } from "./data.ts";

export const PLAN_NAMES: Record<Plan, string> = { starter: "Starter", team: "Team", business: "Business" };
export const REGION_NAMES: Record<Region, string> = { latam: "LATAM", na: "North America", emea: "EMEA" };
const PLAN_ORDER: Plan[] = ["starter", "team", "business"];
const REGION_ORDER: Region[] = ["latam", "na", "emea"];

export interface Leader {
  id: string;
  name: string;
  seats: number;
  plan: Plan;
  region: Region;
}

export interface HeroAnswer {
  month: string;
  active: number;
  seats: number;
  /** Most customers first. */
  plans: { plan: Plan; count: number }[];
  regions: { region: Region; count: number }[];
  /** The two customers with the most seats; `tie` when they have the same. */
  top: { tie: boolean; first: Leader; second: Leader };
  /** The month before, from get_figure's series. */
  previous: { month: string; active: number } | null;
}

/** The two customers with the most seats: most first, a tie in id order (as scripts/build-hero-data.mjs picks them). */
export function topTwo(customers: readonly HeroCustomerFact[]): HeroCustomerFact[] {
  return [...customers].sort((a, b) => b.seats - a.seats || a.customer_id.localeCompare(b.customer_id)).slice(0, 2);
}

function tally<K extends string>(facts: readonly HeroCustomerFact[], of: (f: HeroCustomerFact) => K, order: readonly K[]): { key: K; count: number }[] {
  const counts = new Map<K, number>(order.map((k) => [k, 0]));
  for (const f of facts) counts.set(of(f), (counts.get(of(f)) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).filter((e) => e.count > 0).sort((a, b) => b.count - a.count || order.indexOf(a.key) - order.indexOf(b.key));
}

export function heroAnswer(m: HeroMonth): HeroAnswer {
  const figure = m.get_figure;
  const facts = figure.breakdown.customers;
  const leader = (fact: HeroCustomerFact | undefined): Leader => {
    if (!fact) throw new Error(`${m.month}: fewer than two customers`);
    // get_figure gives ids only: the name is what get_customer returned for that id.
    const read = m.get_customer.find((c) => c.customer.id === fact.customer_id);
    if (!read) throw new Error(`${m.month}: no get_customer answer for ${fact.customer_id}`);
    return { id: fact.customer_id, name: read.customer.name, seats: fact.seats, plan: fact.plan, region: fact.region };
  };
  const [a, b] = topTwo(facts);
  const first = leader(a);
  const second = leader(b);
  const at = figure.series.findIndex((s) => s.month === m.month);
  const before = at > 0 ? figure.series[at - 1] : undefined;
  return {
    month: m.month,
    active: figure.values.active,
    seats: figure.values.seats,
    plans: tally(facts, (f) => f.plan, PLAN_ORDER).map(({ key, count }) => ({ plan: key, count })),
    regions: tally(facts, (f) => f.region, REGION_ORDER).map(({ key, count }) => ({ region: key, count })),
    top: { tie: first.seats === second.seats, first, second },
    previous: before ? { month: before.month, active: before.value } : null,
  };
}

/** A run of text, bold or not. */
export type Segment = string | { strong: string };

const num = (n: number) => n.toLocaleString("en-US");

/** The answer as the agent says it: paragraphs of segments, the key figures bold. */
export function answerParagraphs(a: HeroAnswer): Segment[][] {
  const plans = a.plans.map((p) => `${p.count} on ${PLAN_NAMES[p.plan]}`).join(", ");
  const regions = a.regions.map((r) => `${REGION_NAMES[r.region]} ${r.count}`).join(", ");
  const { first, second } = a.top;
  const where = (l: Leader) => `${PLAN_NAMES[l.plan]}, ${REGION_NAMES[l.region]}`;
  const most: Segment[] = a.top.tie
    ? [`Two customers share the most seats, ${num(first.seats)} each: `, { strong: first.name }, ` (${where(first)}) and `, { strong: second.name }, ` (${where(second)}).`]
    : ["The most seats: ", { strong: first.name }, ` (${num(first.seats)}, ${where(first)}), then `, { strong: second.name }, ` (${num(second.seats)}, ${where(second)}).`];
  const paragraphs: Segment[][] = [
    [{ strong: `${num(a.active)} active customers` }, ` in ${monthName(a.month)}, with `, { strong: `${num(a.seats)} seats` }, " in total."],
    [`${plans}. By region: ${regions}.`],
    most,
  ];
  if (a.previous) {
    const change = a.active - a.previous.active;
    const before = monthName(a.previous.month);
    paragraphs.push([change === 0 ? `The same as in ${before}.` : `${change > 0 ? "Up" : "Down"} ${num(Math.abs(change))} from ${num(a.previous.active)} in ${before}.`]);
  }
  return paragraphs;
}

/** The answer as plain text: what a screen reader is told. */
export function answerText(a: HeroAnswer): string {
  return answerParagraphs(a)
    .map((p) => p.map((s) => (typeof s === "string" ? s : s.strong)).join(""))
    .join(" ");
}
