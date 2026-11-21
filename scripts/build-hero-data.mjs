// The landing hero's data: what Pulse answers for the chart of active customers, Oct 2025 to May 2026, computed with
// Pulse's own code from the demo's one shared world (DEMO_SEED), as pulse.apc.tineira.com computes it. Per month: the
// focus an agent receives for a pin on that bar (resolveFocus), what get_figure returns for its next_args
// (figureAnswer), and what get_customer returns for the two customers with the most seats (customerAnswer, with the
// signup codes production Pulse shows). The site may not import apps/demo, so the file is committed and
// scripts/test/site-hero-data.test.mjs recomputes it and fails on any difference.
//
//   node scripts/build-hero-data.mjs          writes apps/site/src/web/hero-data.json
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { demoDataset, demoMarket } from "../apps/demo/src/model/demo-world.ts";
import { customerAnswer, figureAnswer, resolveFocus } from "../apps/demo/src/worker/domain.ts";

export const HERO_DATA_PATH = resolve(import.meta.dirname, "../apps/site/src/web/hero-data.json");
export const HERO_MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
const ORIGIN = "https://pulse.apc.tineira.com";
/** Fixed times, so the file is the same on every run: the pin of FOCUS_EXAMPLE, and the read a second later. */
const PINNED_AT = "2026-11-04T14:02:11.000Z";
const READ_AT = new Date("2026-11-04T14:02:12.000Z");
/** A connected agent that may read every region. */
const GRANT = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };

/** The two customers with the most seats in a get_figure breakdown: most seats first, a tie in id order. */
export function topTwo(customers) {
  return [...customers].sort((a, b) => b.seats - a.seats || a.customer_id.localeCompare(b.customer_id)).slice(0, 2);
}

export function heroData() {
  const data = demoDataset();
  const codes = demoMarket().signupCodes;
  const months = HERO_MONTHS.map((month) => {
    const pin = { grant_id: GRANT.id, kind: "figure", id: null, part: null, params: { key: "active_customers", month }, pinned_at: PINNED_AT, seen_at: null };
    const focus = resolveFocus(pin, GRANT, data, ORIGIN);
    const figure = figureAnswer(data, GRANT, focus.next_args.key, focus.next_args.params, ORIGIN, READ_AT);
    if ("error" in figure) throw new Error(`get_figure ${month}: ${figure.error}`);
    const customers = topTwo(figure.breakdown.customers).map((c) => customerAnswer(data, GRANT, c.customer_id, ORIGIN, codes));
    return { month, focus, get_figure: figure, get_customer: customers };
  });
  return {
    source: "Pulse's demo world (DEMO_SEED), computed with Pulse's own resolveFocus, figureAnswer and customerAnswer by scripts/build-hero-data.mjs",
    months,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(HERO_DATA_PATH, `${JSON.stringify(heroData())}\n`);
  console.log(`wrote ${HERO_DATA_PATH}`);
}
