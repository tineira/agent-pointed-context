// The site's page views per day, with its top pages, referrers, countries and devices, from Workers Analytics
// Engine (TIN-1040). Run by hand. Views, not visitors: the site keeps no visitor id (apps/site/src/worker/views.ts).
// usage: CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... node scripts/site-views.mjs [days=30] [--json]
// The token needs Account > Account Analytics > Read, the same as scripts/mcp-sessions.mjs. Days are UTC.
import { summarizeViews, viewsSql } from "./lib/site-views.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const days = Number(args.find((a) => !a.startsWith("--")) ?? 30);
const { CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_ANALYTICS_TOKEN) {
  console.error("usage: CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... node scripts/site-views.mjs [days=30] [--json]");
  process.exit(2);
}

const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
  method: "POST",
  headers: { authorization: `Bearer ${CF_ANALYTICS_TOKEN}` },
  body: viewsSql(days),
});
const text = await r.text();
if (!r.ok) {
  console.error(`analytics_engine/sql ${r.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}
const summary = summarizeViews(JSON.parse(text).data ?? []);

if (json) {
  console.log(JSON.stringify({ days, ...summary }, null, 2));
} else if (!summary.days.length) {
  console.log(`no page views in the last ${days} days`);
} else {
  console.log("day          views   bots");
  for (const d of summary.days) console.log(`${d.day}  ${String(d.views).padStart(5)}  ${String(d.bots).padStart(5)}`);
  for (const [title, list] of [["pages", summary.paths], ["referrers", summary.referrers], ["countries", summary.countries], ["devices", summary.devices]]) {
    console.log(`\n${title}`);
    for (const [name, views] of list) console.log(`  ${String(views).padStart(5)}  ${name}`);
  }
}
