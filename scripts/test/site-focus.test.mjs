// The site's example matches the real app output, without coupling the apps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDataset } from "../../apps/demo/src/model/seed.ts";
import { resolveFocus } from "../../apps/demo/src/worker/domain.ts";
import { FOCUS_EXAMPLE } from "../../apps/site/src/web/landing-example.ts";
test("the payload is Pulse's real output for the March bar", () => {
  const grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, pinned_at: FOCUS_EXAMPLE.pinned_at, seen_at: null };
  assert.deepEqual(resolveFocus(pin, grant, generateDataset(7), "https://pulse.apc.tineira.com"), FOCUS_EXAMPLE);
});
