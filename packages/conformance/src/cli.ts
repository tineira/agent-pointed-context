#!/usr/bin/env node
/**
 * `apc-conformance`: the HTTP conformance checks (`http.ts`) against a live app, from a terminal.
 *
 *   npx @tineira/apc-conformance@next https://pulse.example --grant https://pulse.example/mcp/<sid>/<secret>
 *
 * PASS, FAIL or SKIP per check; exit 1 on any FAIL, 2 on a usage error; `--json` for the report as JSON.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { HttpConformanceUsageError, runHttpConformance, type HttpConformanceReport } from "./http.ts";

const HELP = `apc-conformance: checks a live APC app over HTTP (https://apc.tineira.com/docs)

Usage:
  apc-conformance <app-origin> [--grant <mcp-url>] [--revoked <mcp-url>] [--json] [--allow-http] [--timeout <s>]

  <app-origin>        The app's origin, e.g. https://pulse.apc.tineira.com
  --grant <mcp-url>   The MCP URL of a live agent connected directly (Direct profile). Runs the MCP checks:
                      initialize, tools/list, get_current_view, wait_for_focus, unknown grant 404.
  --revoked <mcp-url> The MCP URL of a grant you revoked in the app: checks the revoked answer.
  --json              Print the report as JSON.
  --allow-http        Allow http:, for a dev server on a loopback host only (localhost, 127.0.0.1, [::1]).
  --timeout <s>       Seconds per request (default 15).
  --version, --help

What it reads: {origin}/.well-known/apc.json and the MCP URLs you give, on that origin only. It never follows
a redirect, caps every answer's size and times out every request. A grant URL is a secret: the report shows it
with its last segment replaced by <secret>.

The checks that need the person's page (a pin dropped, the page opened or closed, presence, Revoke pressed, a
phone's touch, apc_link) are reported as SKIP: run apcConformance(adapter) from @tineira/apc-conformance in the app's
own tests for those.

Exit status: 0 when nothing failed, 1 when a check failed, 2 on a usage error.`;

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function format(report: HttpConformanceReport): string {
  const lines = [`APC conformance over HTTP: ${report.origin}`];
  if (report.app) lines.push(`${report.app.name}, standard ${report.app.standard}, profiles ${report.app.profiles.join(", ")} (checks know up to ${report.checks_standard})`);
  lines.push("");
  for (const r of report.results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    lines.push(`${tag}  ${r.name}${r.status === "pass" && r.ms !== undefined ? ` (${r.ms} ms)` : ""}`);
    if (r.detail) lines.push(`      ${r.detail}`);
  }
  lines.push("", `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        grant: { type: "string" },
        revoked: { type: "string" },
        json: { type: "boolean", default: false },
        "allow-http": { type: "boolean", default: false },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`Give exactly one app origin.\n\n${HELP}\n`);
    return 2;
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const s = Number(values.timeout);
    if (!Number.isFinite(s) || s <= 0 || s > 300) {
      process.stderr.write("--timeout is a number of seconds, from more than 0 to 300\n");
      return 2;
    }
    timeoutMs = Math.round(s * 1000);
  }
  let report: HttpConformanceReport;
  try {
    report = await runHttpConformance({
      origin: positionals[0]!,
      ...(values.grant !== undefined ? { grant: values.grant } : {}),
      ...(values.revoked !== undefined ? { revoked: values.revoked } : {}),
      allowHttp: values["allow-http"],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof HttpConformanceUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : format(report)}\n`);
  return report.failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`apc-conformance: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
