// The reader of the site's page views (TIN-1040).
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeViews, viewsSql } from "../lib/site-views.mjs";

const row = (day, path, { referrer = "", country = "CL", device = "desktop", fetched = "document", views = 1 } = {}) => ({ day: `${day} 00:00:00`, path, referrer, country, device, fetched, views: String(views) });

test("the query weighs each group by its sample interval, over the dataset's five blobs", () => {
  const sql = viewsSql(7);
  assert.match(sql, /FROM apc_site_views/);
  assert.match(sql, /INTERVAL '7' DAY/);
  assert.match(sql, /sum\(_sample_interval\) AS views/);
  assert.match(sql, /blob1 AS path, blob2 AS referrer, blob3 AS country, blob4 AS device, blob5 AS fetched/);
  for (const bad of [0, 1.5, 91]) assert.throws(() => viewsSql(bad));
});

test("views per day leave bots and prefetches out, and count them apart", () => {
  const rows = [
    row("2026-11-20", "/", { referrer: "news.ycombinator.com", views: 3 }),
    row("2026-11-20", "/docs/spec", { referrer: "apc.tineira.com", device: "mobile" }),
    row("2026-11-20", "/docs/spec", { device: "bot", fetched: "", views: 5 }),
    row("2026-11-20", "/build", { fetched: "prefetch" }),
    row("2026-11-21", "/try", { country: "AR", views: 2 }),
  ];
  const s = summarizeViews(rows);
  assert.deepEqual(s.days, [{ day: "2026-11-20", views: 4, bots: 6 }, { day: "2026-11-21", views: 2, bots: 0 }]);
  assert.deepEqual(s.paths, [["/", 3], ["/try", 2], ["/docs/spec", 1]]);
  assert.deepEqual(s.referrers, [["news.ycombinator.com", 3], ["(direct)", 2]], "a move between the site's own pages is not an arrival");
  assert.deepEqual(s.countries, [["CL", 4], ["AR", 2]]);
  assert.deepEqual(s.devices, [["desktop", 5], ["mobile", 1]]);
});
