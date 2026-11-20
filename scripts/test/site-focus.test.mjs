// The site examples match the real app output and the hub's documented rewrite, without coupling the apps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDataset } from "../../apps/demo/src/model/seed.ts";
import { resolveFocus } from "../../apps/demo/src/worker/domain.ts";
import { FOCUS_EXAMPLE, DOCK_FOCUS_EXAMPLE } from "../../apps/site/src/web/landing-example.ts";
test("the payloads are Pulse's real output for the March bar, and the hub's rewrite of it", () => {
  const grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, pinned_at: FOCUS_EXAMPLE.pinned_at, seen_at: null };
  assert.deepEqual(resolveFocus(pin, grant, generateDataset(7), "https://pulse.apc.tineira.com"), FOCUS_EXAMPLE);
  // The hub's real rewrite (hubFocus) lives with the hub in tineira/agent-dock since TIN-1010, which checks it
  // there. Here: the example is the app's focus with the app added and the read wrapped in call_app_tool, as
  // the spec's hub section describes, for Pulse, a verified app under its id "pulse".
  const { app, next, next_args, ...rest } = DOCK_FOCUS_EXAMPLE;
  const { next: appNext, next_args: appArgs, ...appRest } = FOCUS_EXAMPLE;
  assert.deepEqual(rest, appRest);
  assert.deepEqual(app, { id: "pulse", name: "Pulse", origin: "https://pulse.apc.tineira.com" });
  assert.equal(next, "call_app_tool");
  assert.deepEqual(next_args, { app: "pulse", tool: appNext, args: appArgs });
});
