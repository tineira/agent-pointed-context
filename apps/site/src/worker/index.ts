/** The standard's public pages and docs. No hub state or credentials are needed here. */
import { Hono } from "hono";
import { SITE_CSP } from "./csp.ts";
import { withByteRanges } from "./range.ts";

const app = new Hono<{ Bindings: Env }>();

// _headers covers asset-first responses; Worker responses (notably byte ranges, and assets fetched through the
// Worker) need these too, and set them over whatever the asset answered.
app.use("*", async (c, next) => {
  await next();
  const response = new Response(c.res.body, c.res);
  response.headers.set("content-security-policy", SITE_CSP);
  response.headers.set("x-frame-options", "DENY");
  c.res = response;
});

app.on(["GET", "HEAD"], "/media/*", async (c) => {
  const request = c.req.raw;
  // Assets ignore Range and omit Content-Length on HEAD. Fetch GET, then slice/strip the body.
  const asset = await c.env.ASSETS.fetch(request.method === "HEAD" ? new Request(request, { method: "GET" }) : request);
  return withByteRanges(request, asset);
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
