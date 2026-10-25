// Distinct MCP agent sessions per day and client, from Workers Analytics Engine (TIN-347). Run by hand.
// usage: CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... node scripts/mcp-sessions.mjs [days=30] [--json]
// The token needs Account > Account Analytics > Read. A session is one agent grant of one sandbox
// (apps/demo/src/worker/sessions.ts), or one agent of one APC v2 dock, shown as [dock] (TIN-416); days are UTC.
import { countSessions, dailyTotals, sessionsSql } from "./lib/mcp-sessions.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const days = Number(args.find((a) => !a.startsWith("--")) ?? 30);
const { CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_ANALYTICS_TOKEN) {
  console.error("usage: CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... node scripts/mcp-sessions.mjs [days=30] [--json]");
  process.exit(2);
}

const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
  method: "POST",
  headers: { authorization: `Bearer ${CF_ANALYTICS_TOKEN}` },
  body: sessionsSql(days),
});
const text = await r.text();
if (!r.ok) {
  console.error(`analytics_engine/sql ${r.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}
const rows = JSON.parse(text).data ?? [];
const byClient = countSessions(rows);
const totals = dailyTotals(rows);

if (json) {
  console.log(JSON.stringify({ days, totals, by_client: byClient }, null, 2));
} else {
  for (const t of totals) {
    console.log(`${t.day}  ${String(t.sessions).padStart(5)}  total`);
    for (const c of byClient.filter((c) => c.day === t.day)) console.log(`            ${String(c.sessions).padStart(5)}  ${c.client_name}${c.source === "dock" ? "  [dock]" : ""}`);
  }
  if (!totals.length) console.log(`no sessions in the last ${days} days`);
}
