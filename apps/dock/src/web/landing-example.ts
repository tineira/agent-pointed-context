/**
 * The focus the landing shows developers (TIN-620): what an agent connected straight to Pulse receives when the
 * person drops it on March in the chart of active customers. It is Pulse's real output (`resolveFocus` in
 * apps/demo/src/worker/domain.ts, for the pin `{ kind: "figure", params: { key: "active_customers", month: "2026-03" } }`
 * on pulse.apc.tineira.com); apps/dock/test/landing.test.ts checks that it still is.
 */
export const FOCUS_EXAMPLE = {
  kind: "figure",
  id: null,
  part: null,
  params: { key: "active_customers", month: "2026-03" },
  pinned_at: "2026-11-04T14:02:11.000Z",
  app_url: "https://pulse.apc.tineira.com/overview?month=2026-03",
  next: "get_figure",
  next_args: { key: "active_customers", params: { month: "2026-03" } },
  part_note: "values.active is the bar; breakdown.customers lists each active customer with plan, region and seats; inputs.customers are the external ids.",
  trimmed: null,
};
