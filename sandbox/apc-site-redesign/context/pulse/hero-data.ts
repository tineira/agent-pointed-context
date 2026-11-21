// Real Pulse data for the hero demo: the focus and the get_figure answer for "active customers" per month,
// from the demo's one shared world (DEMO_SEED), exactly as pulse.apc.tineira.com computes them.
import { writeFileSync } from "node:fs";
import { DEMO_SEED, generateDataset } from "file:///D:/agent-pointed-context/apps/demo/src/model/seed.ts";
import { figureAnswer, resolveFocus } from "file:///D:/agent-pointed-context/apps/demo/src/worker/domain.ts";

const data = generateDataset(DEMO_SEED);
const origin = "https://pulse.apc.tineira.com";
const grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
const out: Record<string, unknown> = {};
for (const month of months) {
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month }, pinned_at: "2026-11-04T14:02:11.000Z", seen_at: null };
  const focus = resolveFocus(pin as never, grant as never, data, origin);
  const answer = figureAnswer(data, grant as never, "active_customers", { month }, origin, new Date("2026-11-04T14:02:12.000Z")) as Record<string, any>;
  const customers: any[] = answer.breakdown?.customers ?? [];
  const named = (c: any) => ({ ...c, name: (data.customers as any[]).find((x) => x.id === c.customer_id || x.external_id === c.customer_id)?.name ?? null });
  const bySeats = [...customers].map(named).sort((a, b) => (b.seats ?? 0) - (a.seats ?? 0));
  const count = (k: string) => customers.reduce((m: Record<string, number>, c) => ((m[c[k]] = (m[c[k]] ?? 0) + 1), m), {});
  out[month] = {
    focus,
    get_figure: answer,
    summary: {
      active: answer.values,
      customers: customers.length,
      top_by_seats: bySeats.slice(0, 3),
      total_seats: customers.reduce((s, c) => s + (c.seats ?? 0), 0),
      by_plan: count("plan"),
      by_region: count("region"),
    },
  };
}
writeFileSync(process.argv[2]!, JSON.stringify({ source: "Pulse demo world (DEMO_SEED), computed with Pulse's own resolveFocus and figureAnswer", months: out }, null, 2));
console.log(JSON.stringify(Object.fromEntries(months.map((m) => [m, (out[m] as any).summary])), null, 1).slice(0, 2500));
