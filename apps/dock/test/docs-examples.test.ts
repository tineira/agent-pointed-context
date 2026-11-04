/**
 * The docs' Orders example (apps/dock/src/docs/examples, shown at /docs/integrate and /docs/conformance) is a
 * conforming APC app: the conformance suite runs against it on both profiles, the apc_link checks with Direct.
 * The samples type-check through apps/dock/tsconfig.docs.json (`pnpm typecheck`).
 */
import { test } from "node:test";
import { ordersChecks } from "../src/docs/examples/orders-conformance.ts";

for (const profile of ["direct", "dock"] as const) {
  for (const check of ordersChecks(profile, { link: profile === "direct" })) test(check.name, check.run);
}
