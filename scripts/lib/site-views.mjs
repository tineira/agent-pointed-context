// The site's page views from the apc_site_views Analytics Engine dataset (TIN-1040; apps/site/src/worker/views.ts).
// The SQL returns one row per (day, path, referrer, device, fetch) with its weighted count, sum(_sample_interval),
// so a sampled point still counts for the views it stands for; the summary is done here.
// blob1 the page (one of the site's own, or "(other)"), blob2 the referrer's host name, blob3 the country, blob4 the
// device class ("bot" for crawlers and our own checks), blob5 how the browser fetched it. A prefetch is not counted
// as a view; a page the person then opens from that prefetch makes no second request, so it is missed (it shows
// under bots). A returning browser's 304 counts as a view. Views, not people: there is no visitor id.

export const DATASET = "apc_site_views";

/** The site's own host: a referrer from it is a move between its pages, not an arrival. */
export const OWN_HOST = "apc.tineira.com";

export function viewsSql(days) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be an integer from 1 to 90");
  return [
    "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS path, blob2 AS referrer, blob3 AS country, blob4 AS device, blob5 AS fetched, sum(_sample_interval) AS views",
    `FROM ${DATASET}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "GROUP BY day, path, referrer, country, device, fetched",
    "ORDER BY day",
    "FORMAT JSON",
  ].join("\n");
}

/** A view a person made: not a bot, not a prefetch. */
export const isPersonView = (r) => r.device !== "bot" && r.fetched !== "prefetch";

const add = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);
const top = (map, limit) => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);

/**
 * Rows from the SQL API -> { days: [{ day, views, bots }], paths, referrers, countries, devices }, each list
 * [name, views] by views descending. Bots and prefetches count only in `bots`; arrivals from the site itself are
 * left out of `referrers` ("(direct)" when there was no referrer).
 */
export function summarizeViews(rows, limit = 15) {
  const days = new Map();
  const paths = new Map();
  const referrers = new Map();
  const countries = new Map();
  const devices = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const n = Number(r.views) || 0;
    if (!days.has(day)) days.set(day, { day, views: 0, bots: 0 });
    if (!isPersonView(r)) {
      days.get(day).bots += n;
      continue;
    }
    days.get(day).views += n;
    add(paths, r.path || "/", n);
    if (r.referrer !== OWN_HOST) add(referrers, r.referrer || "(direct)", n);
    add(countries, r.country || "??", n);
    add(devices, r.device || "?", n);
  }
  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    paths: top(paths, limit),
    referrers: top(referrers, limit),
    countries: top(countries, limit),
    devices: top(devices, limit),
  };
}
