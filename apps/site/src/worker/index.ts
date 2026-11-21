/** The standard's public pages and docs. No hub state or credentials are needed here. */
import { Hono } from "hono";
import { SITE_CSP } from "./csp.ts";
import { withByteRanges } from "./range.ts";
import { viewPoint } from "./views.ts";
import { MOVED_PAGES } from "../web/site-pages.ts";

const app = new Hono<{ Bindings: Env }>();

// _headers covers asset-first responses; Worker responses (notably byte ranges, and assets fetched through the
// Worker) need these too, and set them over whatever the asset answered. Assign first, then set (TIN-1036): Hono's
// c.res setter copies the previous response's headers onto the new one, so a header set before the assignment
// would lose to the asset's own.
app.use("*", async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("content-security-policy", SITE_CSP);
  c.res.headers.set("x-frame-options", "DENY");
  // One Analytics Engine point per page view (views.ts, TIN-1040); the pages run through the Worker for it
  // (run_worker_first in wrangler.jsonc). Counting never fails or delays the page.
  try {
    const point = viewPoint(c.req.raw, c.res);
    if (point) c.env.SITE_VIEWS?.writeDataPoint(point);
  } catch {
    // analytics only
  }
});

app.on(["GET", "HEAD"], "/media/*", async (c) => {
  const request = c.req.raw;
  // Assets ignore Range and omit Content-Length on HEAD. Fetch GET, then slice/strip the body.
  const asset = await c.env.ASSETS.fetch(request.method === "HEAD" ? new Request(request, { method: "GET" }) : request);
  return withByteRanges(request, asset);
});
// The pages that left with the Dock's profile (TIN-1061): a permanent redirect, so old links and search results land
// on /build. A trailing slash is allowed, and the query string is kept.
app.on(["GET", "HEAD"], "/build/*", (c, next) => {
  const url = new URL(c.req.url);
  const to = MOVED_PAGES[url.pathname.replace(/\/+$/, "")];
  return to ? c.redirect(`${to}${url.search}`, 301) : next();
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
