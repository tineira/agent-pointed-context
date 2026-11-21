/**
 * The hero's data (TIN-1066): Pulse's real answers for the chart of active customers, Oct 2025 to May 2026, from
 * hero-data.json. scripts/build-hero-data.mjs computes that file with Pulse's own code, and
 * scripts/test/site-hero-data.test.mjs fails when it drifts. Nothing on the stage shows a figure the file does not hold.
 */

export type Plan = "starter" | "team" | "business";
export type Region = "latam" | "na" | "emea";

/** What an agent receives for a pin on one bar (Pulse's resolveFocus). */
export interface HeroFocus {
  kind: "figure";
  id: null;
  part: null;
  params: { key: "active_customers"; month: string };
  pinned_at: string;
  app_url: string;
  next: "get_figure";
  next_args: { key: "active_customers"; params: { month: string } };
  part_note: string;
  trimmed: null;
}

export interface HeroCustomerFact {
  customer_id: string;
  plan: Plan;
  region: Region;
  seats: number;
}

/** What get_figure returns for the focus's next_args (Pulse's figureAnswer). */
export interface HeroFigure {
  key: "active_customers";
  params: { month: string };
  as_of: string;
  values: { active: number; seats: number };
  series: { month: string; value: number }[];
  breakdown: { customers: HeroCustomerFact[] };
  inputs: { customers: string[] };
  trimmed: null;
  app_url: string;
}

/** What get_customer returns for one customer (Pulse's customerAnswer). */
export interface HeroCustomer {
  customer: { id: string; name: string; plan: Plan; region: Region; signup_month: string; signup_code?: string | null };
  activity: { month: string; active: boolean; seats: number; events: number }[];
  app_url: string;
}

export interface HeroMonth {
  month: string;
  focus: HeroFocus;
  get_figure: HeroFigure;
  /** The two customers with the most seats that month, most first (a tie in id order). */
  get_customer: HeroCustomer[];
}

export interface HeroData {
  source: string;
  months: HeroMonth[];
}

/** The file, in a chunk of its own: only the landing loads it. */
export async function loadHeroData(): Promise<HeroData> {
  const file = await import("../../hero-data.json");
  return file.default as unknown as HeroData;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-03" as "March 2026". */
export function monthName(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/** "2026-03" as "Mar", for the chart's axis. */
export function monthShort(month: string): string {
  return monthName(month).slice(0, 3);
}

/** The chart's top, in customers: every bar is values.active over this. */
export const CHART_TOP = 140;
