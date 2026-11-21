/**
 * The hero's months and values (TIN-1070): the months the landing's simulated hero shows, and each month's active
 * customers from Pulse's demo world, by the function get_figure answers with (activeCustomers, as the Overview's chart).
 * Plain TypeScript, so a test checks it against the landing's own data.
 */
import { activeCustomers, FULL_SCOPE } from "../../model/figures.ts";
import type { Dataset } from "../../model/seed.ts";

/** The landing's months (scripts/build-hero-data.mjs HERO_MONTHS): October 2025 to May 2026. */
export const HERO_MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"] as const;
/** The chart's top, in customers, as on the landing (CHART_TOP). */
export const CHART_TOP = 140;

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthShort = (month: string) => SHORT[Number(month.slice(5, 7)) - 1] ?? month;
export const monthName = (month: string) => `${LONG[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** The hero's bars: each month and its active customers. */
export function heroSeries(data: Dataset): Array<{ month: string; value: number }> {
  const series = activeCustomers(data, { month: HERO_MONTHS[HERO_MONTHS.length - 1]! }, FULL_SCOPE).series ?? [];
  return HERO_MONTHS.map((month) => ({ month, value: series.find((s) => s.month === month)?.value ?? 0 }));
}

