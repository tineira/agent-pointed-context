import assert from "node:assert/strict";
import { test } from "node:test";
import { APC_STANDARD_VERSION, revokedAnswer } from "@tineira/apc-protocol";
import { HttpConformanceUsageError, IN_PROCESS_ONLY, redactGrantUrl, runHttpConformance, type HttpConformanceOptions } from "../src/index.ts";

const ORIGIN = "https://app.example";
const GRANT = `${ORIGIN}/mcp/s1/live-secret`;
const REVOKED = `${ORIGIN}/mcp/s1/gone-secret`;

interface FakeOptions {
  manifest?: unknown;
  redirectManifest?: boolean;
  revokedStatus?: number;
  unknownStatus?: number;
  then?: boolean;
}

/** A small APC app behind a fetch: apc.json, one live grant and one revoked. */
function fakeApp(o: FakeOptions = {}): { fetch: (r: Request) => Promise<Response>; seen: Request[] } {
  const seen: Request[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const view = { screen: "overview", params: {}, selection: null, app_url: `${ORIGIN}/`, updated_at: "2026-11-04T10:00:00.000Z", age_seconds: 3, stale: false, next: null };
  const tool = (payload: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
  return {
    seen,
    async fetch(request) {
      seen.push(request);
      assert.equal(request.redirect, "manual", "never follows a redirect");
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/apc.json") {
        if (o.redirectManifest) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/apc.json" } });
        return json(o.manifest ?? { name: "Fake", standard: APC_STANDARD_VERSION, origin: ORIGIN, profiles: ["direct"], mcp: { path: "/mcp/" }, direct: { connect: `${ORIGIN}/?connect` } });
      }
      if (url.href === REVOKED) return json(revokedAnswer("app.example", "2026-11-04T10:00:00.000Z"), o.revokedStatus ?? 403);
      if (url.href !== GRANT) return json({ error: "not_found" }, o.unknownStatus ?? 404);
      const rpc = (await request.json()) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
      if (rpc.method === "tools/list")
        return reply({
          tools: [
            { name: "get_current_view", inputSchema: { type: "object", properties: {} } },
            { name: "wait_for_focus", inputSchema: { type: "object", properties: { timeout_s: { type: "integer", minimum: 1 } } } },
          ],
        });
      if (rpc.params.name === "get_current_view") return reply(tool({ view, focus: null, ...(o.then ? { then: "call wait_for_focus" } : {}) }));
      if (rpc.params.name === "wait_for_focus") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return reply(tool({ focus: null, timed_out: true, note: "No pin came." }));
      }
      return json({ error: "nope" }, 400);
    },
  };
}

const run = (o: FakeOptions, extra: Partial<HttpConformanceOptions> = {}) => {
  const app = fakeApp(o);
  return runHttpConformance({ origin: ORIGIN, grant: GRANT, revoked: REVOKED, fetch: app.fetch, ...extra });
};
const status = (report: Awaited<ReturnType<typeof run>>, id: string) => report.results.find((r) => r.id === id)?.status;

test("a conforming app passes every HTTP check, and the in-process ones are reported skipped", async () => {
  const report = await run({ then: true });
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => r.status === "fail"), null, 2));
  assert.equal(report.passed, 11);
  assert.equal(report.skipped, IN_PROCESS_ONLY.length);
  assert.deepEqual(report.app, { name: "Fake", standard: APC_STANDARD_VERSION, profiles: ["direct"] });
});

test("without --grant or --revoked the MCP checks are skipped, not failed", async () => {
  const app = fakeApp();
  const report = await runHttpConformance({ origin: `${ORIGIN}/`, fetch: app.fetch });
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 4);
  assert.equal(status(report, "mcp-initialize"), "skip");
  assert.equal(status(report, "revoked-answers"), "skip");
  assert.ok(app.seen.every((r) => new URL(r.url).pathname === "/.well-known/apc.json"), "nothing but apc.json is read");
});

test("a redirect on apc.json fails and is not followed", async () => {
  const app = fakeApp({ redirectManifest: true });
  const report = await runHttpConformance({ origin: ORIGIN, fetch: app.fetch });
  assert.equal(status(report, "apc-json-served"), "fail");
  assert.match(report.results[0]!.detail!, /redirect/);
  assert.equal(status(report, "apc-json-valid"), "skip");
  assert.ok(!app.seen.some((r) => r.url.includes("elsewhere")));
});

test("an apc.json that names another origin, a hub, or a revoked grant that answers 200 fails", async () => {
  const wrong = await run({ manifest: { name: "Fake", standard: "0.7.0", origin: "https://other.example", profiles: ["direct"], mcp: { path: "/mcp/" }, direct: { connect: "https://other.example/" } } });
  assert.equal(status(wrong, "apc-json-valid"), "fail");
  const hub = await run({ manifest: { name: "Dock", standard: "0.7.0", origin: ORIGIN, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${ORIGIN}/apc/pair`, confirm: `${ORIGIN}/apc/confirm` } } });
  assert.equal(status(hub, "apc-json-profiles"), "fail");
  const revoked = await run({ revokedStatus: 200 });
  assert.equal(status(revoked, "revoked-answers"), "fail");
  const unknown = await run({ unknownStatus: 403 });
  assert.equal(status(unknown, "grant-unknown-404"), "fail");
});

test("unsafe URLs are refused before any request", async () => {
  const refused = async (options: Partial<HttpConformanceOptions>) => {
    const app = fakeApp();
    await assert.rejects(runHttpConformance({ origin: ORIGIN, fetch: app.fetch, ...options }), HttpConformanceUsageError);
    assert.equal(app.seen.length, 0);
  };
  await refused({ origin: "http://app.example" });
  await refused({ origin: "http://app.example", allowHttp: true });
  await refused({ origin: "file:///etc/passwd" });
  await refused({ origin: `${ORIGIN}/some/path` });
  await refused({ origin: "https://user:pw@app.example" });
  await refused({ grant: "https://attacker.example/mcp/s1/x" });
  await refused({ revoked: "http://app.example/mcp/s1/x" });
  const local = fakeApp();
  const report = await runHttpConformance({ origin: "http://localhost:8787", allowHttp: true, fetch: local.fetch });
  assert.equal(report.origin, "http://localhost:8787");
});

test("a grant's secret never shows in the report", async () => {
  const report = await run({ manifest: { name: "Fake", standard: "0.7.0", origin: ORIGIN, profiles: ["direct"], mcp: { path: "/other/" }, direct: { connect: `${ORIGIN}/` } } });
  assert.equal(status(report, "grant-declared"), "fail");
  const out = JSON.stringify(report);
  assert.ok(!out.includes("live-secret") && !out.includes("gone-secret"), out);
  assert.equal(redactGrantUrl(GRANT), `${ORIGIN}/mcp/s1/<secret>`);
});
