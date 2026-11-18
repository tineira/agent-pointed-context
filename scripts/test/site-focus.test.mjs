// The site examples match the real app and hub output, without coupling the apps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateDataset } from "../../apps/demo/src/model/seed.ts";
import { resolveFocus } from "../../apps/demo/src/worker/domain.ts";
import { hubFocus } from "../../apps/dock/src/worker/logic.ts";
import { FOCUS_EXAMPLE, DOCK_FOCUS_EXAMPLE } from "../../apps/site/src/web/landing-example.ts";
const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
test("the payloads are Pulse's real output for the March bar, and the hub's real rewrite of it", () => {
  const grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, pinned_at: FOCUS_EXAMPLE.pinned_at, seen_at: null };
  assert.deepEqual(resolveFocus(pin, grant, generateDataset(7), "https://pulse.apc.tineira.com"), FOCUS_EXAMPLE);
  // Pulse is verified on apc.tineira.com (APP_ORIGINS), so nothing marks it untrusted; its id is "pulse".
  assert.deepEqual(hubFocus(FOCUS_EXAMPLE, { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" }), DOCK_FOCUS_EXAMPLE);
  assert.equal(hubFocus(FOCUS_EXAMPLE, { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" }, true).next, "pulse__get_figure", "the prefixed name the page mentions");
  assert.match(read("apps/dock/wrangler.jsonc"), /"APP_ORIGINS": "https:\/\/pulse\.apc\.tineira\.com\/#id=pulse&name=Pulse,/);
});
