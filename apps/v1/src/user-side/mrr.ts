/**
 * The person's own knowledge, not the application's.
 *
 * In the real world, revenue per customer lives in the person's billing system
 * or spreadsheet, outside the analytics product, and they do not want to give
 * it to the product. The demo makes such a file only so anyone can reproduce
 * the scenario: the browser generates it from the sandbox's seed and offers it
 * as a download. No server module imports this file (a test checks it), so the
 * application has no MRR code and no MRR values.
 */
import { generateDataset, prng } from "../model/seed.ts";

const PRICE_PER_SEAT = { starter: 12, team: 18, business: 25 } as const;

export interface MrrRow {
  customer_id: string;
  month: string;
  mrr: string;
}

/** Decimal strings with non-zero cents, so a leaked value is easy to spot (the canary check). */
export function mrrRows(seed: number): MrrRow[] {
  const data = generateDataset(seed);
  const rand = prng(seed ^ 0x5eed);
  const discount = new Map(data.customers.map((c) => [c.id, 0.7 + rand() * 0.45]));
  const plan = new Map(data.customers.map((c) => [c.id, c.plan]));
  const rows: MrrRow[] = [];
  for (const a of data.activity) {
    if (!a.active) continue;
    const cents = Math.round(a.seats * PRICE_PER_SEAT[plan.get(a.customer_id)!] * discount.get(a.customer_id)! * 100);
    const value = cents % 100 === 0 ? cents + 37 : cents;
    rows.push({ customer_id: a.customer_id, month: a.month, mrr: (value / 100).toFixed(2) });
  }
  return rows;
}

export function mrrCsv(seed: number): string {
  return ["customer_id,month,mrr", ...mrrRows(seed).map((r) => `${r.customer_id},${r.month},${r.mrr}`)].join("\n") + "\n";
}
