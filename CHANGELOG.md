# Changelog

## 0.2.0 (2026-10-19)

- **A customer pin carries no params; a figure pin only the keys its figure reads.** A pin like `{"kind":"customer","id":"cus_0001","params":{"note":"SECRET-1234.57"}}` was stored, logged and handed to the agent; it is now refused with `invalid_target`, and so is a figure pin with an extra key. (`apps/demo/src/worker/domain.ts`)
- **The activity switch also stops the pulse on an agent's mark**, as it already stopped the flash on what the agent read. Marks and pins stay visible. (`apps/demo/src/web/App.tsx`, `apps/demo/src/web/presence.ts`)
- **With view sharing off, agents no longer learn whether the page is open.** No result carries `then`, and `wait_for_focus` waits its full timeout without reporting `page_open` or ending early when the page closes; it still returns a pin dropped during the wait. Nothing changes with sharing on. (`apps/demo/src/worker/sandbox.ts`, `apps/demo/src/worker/page.ts`, `packages/server/src/tools.ts`, `packages/server/src/prompts.ts`, `skills/pulse-agent/SKILL.md`)
- **Canary check:** `node scripts/canary.mjs <events.jsonl> <mrr-by-customer.csv>` reports whether any of the person's MRR values appear in a sandbox's event log, and exits 1 if one does. (`scripts/canary.mjs`, `scripts/lib/canary.mjs`)
- **DESIGN.md corrections:** the envelope for a pin on a monthly bar is 571 bytes, not 401; what `envelope_bytes` and `then_bytes` measure; the 2 s poll and the 75 s fallback window of `wait_for_focus`; the sharing-off behavior; the log's boundary for the canary; the customer-pin allowlist. (`DESIGN.md`)
