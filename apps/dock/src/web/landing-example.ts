/**
 * The focus the build pages show developers (TIN-620, TIN-627): what an agent connected straight to Pulse receives when the
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

/**
 * The same focus as the agent receives it through a dock (TIN-627): the hub adds the app it came from and
 * rewrites the call that reads it to its own `call_app_tool` (`hubFocus` in apps/dock/src/worker/logic.ts, for
 * Pulse, a verified app, under its id "pulse"). apps/dock/test/landing.test.ts checks that it still is.
 */
export const DOCK_FOCUS_EXAMPLE = {
  ...FOCUS_EXAMPLE,
  app: { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" },
  next: "call_app_tool",
  next_args: { app: "pulse", tool: "get_figure", args: { key: "active_customers", params: { month: "2026-03" } } },
};
