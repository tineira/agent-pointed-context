// Canary check over a sandbox's event log (DESIGN.md section 3, C7). Run by hand; deploys nothing.
// usage: node scripts/canary.mjs <events.jsonl> <mrr-by-customer.csv>
// Reads every mrr value (third column) of the person's file and reports how many appear anywhere in the
// raw text of the log, as written or with a thousands separator (1,234.57) or without ".00"; and how
// many inbound events and args bytes the log holds. Exit 0 when no value is found, 1 otherwise.
// Known boundary: the log holds the arguments of the tool calls that passed the MCP SDK's schema
// validation, recorded before the domain validates them (instrument() in apps/demo/src/worker/sandbox.ts),
// not every inbound byte: a call the SDK refused, or a body that was not a tool call, is not in it.
import { readFile } from "node:fs/promises";
import { canary } from "./lib/canary.mjs";

const [LOG, CSV] = process.argv.slice(2);
if (!LOG || !CSV) {
  console.error("usage: node scripts/canary.mjs <events.jsonl> <mrr-by-customer.csv>");
  process.exit(2);
}
const result = canary(await readFile(LOG, "utf8"), await readFile(CSV, "utf8"));
const shown = result.found.slice(0, 5).join(" ") + (result.found.length > 5 ? " …" : "");
console.log(
  `canary: ${result.found.length} of ${result.values} mrr values found in the log (${result.inbound} inbound events, ${result.args_bytes} args bytes)${result.found.length ? `: ${shown}` : ""}`,
);
process.exit(result.found.length ? 1 : 0);
