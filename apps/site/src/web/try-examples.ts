/**
 * Step 3's examples on /try (TIN-1094): what "this" can mean in Pulse. Three places in Pulse's demo world, each with
 * the numbers Pulse itself shows there and two questions its tools answer. The world never changes (DEMO_SEED), and
 * the site may not import apps/demo, so the numbers are written here and scripts/test/site-try-examples.test.mjs
 * recomputes every one with Pulse's own functions (activeCustomers, customerBridge, the figures' deep links).
 *
 * - The bar: March 2026 in "Active customers per month", 123 active; `series` is the chart's eighteen bars, Apr 2025
 *   to Sep 2026. get_figure answers with values.active and each customer's plan and seats.
 * - The customer: Lumen Delta Systems (`cus_0109`), as its row reads on Customers, which opens on Sep 2026.
 *   get_customer answers with its signup month and its activity, month by month.
 * - The bridge: the Churned step of Sep 2026, 146 + 13 + 1 − 8 = 152. get_figure with step "churned" lists those
 *   customers, each with seats_prev.
 */

/** A path on Pulse's origin, as its figures' and customers' deep links are written. */
type PulsePath = `/${string}`;

export const TRY_BAR = {
  month: "2026-03",
  label: "March 2026",
  active: 123,
  /** Active customers per month, Apr 2025 to Sep 2026. */
  series: [67, 75, 79, 83, 88, 92, 102, 100, 110, 112, 113, 123, 128, 132, 139, 142, 146, 152],
  firstMonth: "2025-04",
  path: "/overview?month=2026-03" as PulsePath,
  asks: ["How many customers is this, and on which plans?", "Who has the most seats here?"],
} as const;

export const TRY_CUSTOMER_ROW = {
  id: "cus_0109",
  name: "Lumen Delta Systems",
  plan: "business",
  region: "latam",
  /** The month Customers opens on, and the customer's seats in it. */
  month: "2026-09",
  seats: 281,
  path: "/customers/cus_0109" as PulsePath,
  asks: ["When did this customer sign up, and how have its seats changed since?", "Was it active every month?"],
} as const;

export const TRY_BRIDGE = {
  month: "2026-09",
  label: "September 2026",
  steps: [
    { step: "start", label: "Start", value: "146" },
    { step: "new", label: "New", value: "+13" },
    { step: "reactivated", label: "Reactivated", value: "+1" },
    { step: "churned", label: "Churned", value: "−8" },
    { step: "end", label: "End", value: "152" },
  ],
  /** The step the agent is dropped on. */
  pointed: "churned",
  path: "/overview?month=2026-09" as PulsePath,
  asks: ["Who are these customers?", "How many seats left with them?"],
} as const;
