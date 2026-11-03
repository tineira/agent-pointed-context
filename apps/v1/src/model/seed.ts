/**
 * Pulse: synthetic product analytics for a fictional SaaS. Deterministic from
 * one seed, so a sandbox stores only its seed and anyone can rebuild its data.
 * The application knows customers, plans, regions, seats and activity. It does
 * not know revenue (see src/user-side/).
 */

export const PLANS = ["starter", "team", "business"] as const;
export const REGIONS = ["latam", "na", "emea"] as const;
export type Plan = (typeof PLANS)[number];
export type Region = (typeof REGIONS)[number];

/** Eighteen complete months, oldest first. */
export const MONTHS: readonly string[] = Array.from({ length: 18 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 3 + i, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});
export const LAST_MONTH = MONTHS[MONTHS.length - 1]!;

export interface Customer {
  /** External id: the same id the customer has in the person's other systems (billing). */
  id: string;
  name: string;
  plan: Plan;
  region: Region;
  signup_month: string;
}

export interface Activity {
  customer_id: string;
  month: string;
  active: boolean;
  seats: number;
  events: number;
}

export interface Dataset {
  seed: number;
  customers: Customer[];
  activity: Activity[];
}

/** mulberry32: small, fast, good enough for synthetic data. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Blue", "North", "Bright", "Quiet", "Iron", "Silver", "Red", "Open", "Clear", "Swift", "Green", "High", "Deep", "Little", "Golden", "Wild", "Stone", "Cedar", "Copper", "Lumen"];
const SECOND = ["Harbor", "Field", "Peak", "Ridge", "River", "Forge", "Lane", "Grove", "Bay", "Works", "Yard", "Mesa", "Pine", "Delta", "Arc", "Loop", "Gate", "Mill", "Coast", "Signal"];
const SUFFIX = ["Labs", "Co", "Studio", "Group", "Systems", "Health", "Logistics", "Foods", "Media", "Analytics"];

const CHURN: Record<Plan, number> = { starter: 0.07, team: 0.035, business: 0.015 };
const SEATS: Record<Plan, [number, number]> = { starter: [1, 5], team: [5, 30], business: [25, 150] };

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function generateDataset(seed: number, count = 200): Dataset {
  const rand = prng(seed);
  const customers: Customer[] = [];
  const activity: Activity[] = [];
  const names = new Set<string>();
  for (let i = 1; i <= count; i++) {
    let name = "";
    do name = `${pick(rand, FIRST)} ${pick(rand, SECOND)} ${pick(rand, SUFFIX)}`;
    while (names.has(name));
    names.add(name);
    const planRoll = rand();
    const plan: Plan = planRoll < 0.5 ? "starter" : planRoll < 0.85 ? "team" : "business";
    const regionRoll = rand();
    const region: Region = regionRoll < 0.4 ? "latam" : regionRoll < 0.75 ? "na" : "emea";
    // A third of the customers were already there when the window opens.
    const start = rand() < 0.33 ? 0 : 1 + Math.floor(rand() * (MONTHS.length - 1));
    const customer: Customer = { id: `cus_${String(i).padStart(4, "0")}`, name, plan, region, signup_month: MONTHS[start]! };
    customers.push(customer);

    const [lo, hi] = SEATS[plan];
    let seats = lo + Math.floor(rand() * (hi - lo + 1));
    let active = true;
    for (let m = start; m < MONTHS.length; m++) {
      if (m > start) {
        if (active && rand() < CHURN[plan]) active = false;
        else if (!active && rand() < 0.1) active = true;
        if (active) seats = Math.max(lo, Math.min(hi * 2, Math.round(seats * (0.92 + rand() * 0.2))));
      }
      activity.push({
        customer_id: customer.id,
        month: MONTHS[m]!,
        active,
        seats: active ? seats : 0,
        events: active ? Math.round(seats * (20 + rand() * 60)) : 0,
      });
    }
  }
  return { seed, customers, activity };
}
