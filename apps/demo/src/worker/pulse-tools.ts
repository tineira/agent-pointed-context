import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolError, toolResult } from "@apc/server";
import { z } from "zod";
import { FIGURE_KEYS } from "../model/figures.ts";
import { PLANS, REGIONS, type Dataset } from "../model/seed.ts";
import { customerAnswer, figureAnswer, listCustomers, type Grant } from "./domain.ts";

/** Pulse's ordinary reads. A pin names one of them in next; they pass the same grant as any call. */
export function registerPulseTools(server: McpServer, data: Dataset, grant: Grant, origin: string): void {
  server.registerTool(
    "get_figure",
    {
      title: "Read a computed figure",
      description: `Recomputes a figure Pulse draws, with the same function the page uses, over the regions this connection may see. Keys: ${FIGURE_KEYS.join(", ")}. Returns values, breakdown (customers with plan, region, seats), inputs.customers (external ids, the same ids as the person's billing) and trimmed when some regions are hidden from this connection. Usually called with the next_args of a focus.`,
      inputSchema: {
        key: z.string(),
        params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ key, params }) => {
      const answer = figureAnswer(data, grant, key, params, origin);
      return "error" in answer ? toolError(answer.error!, answer.message!) : toolResult(answer);
    },
  );

  server.registerTool(
    "get_customer",
    {
      title: "Read one customer",
      description: "One customer by external id (cus_NNNN): plan, region, signup month, and per month whether it was active, its seats and its usage events.",
      inputSchema: { id: z.string().regex(/^cus_\d{4}$/) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const answer = customerAnswer(data, grant, id, origin);
      return "error" in answer ? toolError(answer.error!, answer.message!) : toolResult(answer);
    },
  );

  server.registerTool(
    "list_customers",
    {
      title: "List customers",
      description: "Customers with their plan, region and, for one month (default the latest), whether they were active and their seats. Filters: plan, region, active. Pages with limit (max 200) and offset.",
      inputSchema: {
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        plan: z.enum(PLANS).optional(),
        region: z.enum(REGIONS).optional(),
        active: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (filter) => toolResult(listCustomers(data, grant, filter)),
  );
}
