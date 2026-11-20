/** The standard's public pages and docs. No hub state or credentials are needed here. */
import { Hono } from "hono";
import { SITE_CSP } from "./csp.ts";
import { withByteRanges } from "./range.ts";
import { viewPoint } from "./views.ts";

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
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
