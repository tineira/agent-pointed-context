#!/usr/bin/env node
/**
 * `apc-conformance`: the HTTP conformance checks (`http.ts`) against a live app, from a terminal.
 *
 *   npx @tineira/apc-conformance https://pulse.example --grant https://pulse.example/mcp/<sid>/<secret>
 *   APC_TOKEN=… npx @tineira/apc-conformance https://app.example --grant https://app.example/api/mcp --bearer-env APC_TOKEN
 *
 * PASS, FAIL or SKIP per check, then how many ran and why the rest were skipped (with a warning when most were); exit 1
 * on any FAIL, 2 on a usage error; `--json` for the report as JSON, with the same in its `coverage`.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { HttpConformanceUsageError, coverageLines, redactSecrets, runHttpConformance, type HttpConformanceReport } from "./http.ts";

const HELP = `apc-conformance: checks a live APC app over HTTP (https://apc.tineira.com/docs)

Usage:
  apc-conformance <app-origin> [--grant <mcp-url>] [--bearer-env <VAR>] [--revoked <mcp-url>] [--revoked-bearer-env <VAR>]
                  [--profile direct|dock] [--json] [--allow-http] [--timeout <s>]

  <app-origin>        The app's origin, e.g. https://pulse.apc.tineira.com
  --grant <mcp-url>   The MCP URL of a live agent connected directly (Direct profile). Runs the MCP checks:
                      initialize, tools/list, get_current_view, wait_for_focus, unknown grant 404.
  --bearer-env <VAR>  The name of an environment variable that holds the grant's bearer token, for an app whose
                      agents authenticate with OAuth (one MCP URL shared by every grant, APC 0.8). The token is
                      sent as Authorization: Bearer and never printed. Never put a token on the command line.
  --revoked <mcp-url> The MCP URL of a grant you revoked in the app: checks the revoked answer.
  --revoked-bearer-env <VAR>  The same, for the revoked grant's token.
  --profile direct|dock  The profile the grant URLs are for (default direct). With dock, a Dock grant's secret URL,
                      checked against apc.json exactly as a hub pairing it checks it; no bearer token then.
  --json              Print the report as JSON.
  --allow-http        Allow http:, for a dev server on the host localhost, 127.0.0.1 or [::1] only (not *.localhost).
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
    if (r.note) lines.push(`      note: ${r.note}`);
  }
  lines.push("", `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  lines.push(...coverageLines(report.coverage));
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
        "bearer-env": { type: "string" },
        "revoked-bearer-env": { type: "string" },
        profile: { type: "string" },
        json: { type: "boolean", default: false },
        "allow-http": { type: "boolean", default: false },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSecrets(message, argv.filter((a) => a.includes("://")))}\n\n${HELP}\n`);
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
  // A token is read from the environment by the variable's name, never from the command line, and never printed.
  const tokens: { bearer?: string; revokedBearer?: string } = {};
  for (const [flag, key] of [["bearer-env", "bearer"], ["revoked-bearer-env", "revokedBearer"]] as const) {
    const name = values[flag];
    if (name === undefined) continue;
    const token = process.env[name];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !token) {
      // The value is never echoed: a token passed here by mistake can look like a variable name.
      process.stderr.write(`--${flag}: give the name of an environment variable that holds the token; the one given ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? "is unset or empty" : "is not a variable name"} (not shown)\n`);
      return 2;
    }
    tokens[key] = token;
  }
  let report: HttpConformanceReport;
  try {
    report = await runHttpConformance({
      origin: positionals[0]!,
      ...(values.grant !== undefined ? { grant: values.grant } : {}),
      ...(values.revoked !== undefined ? { revoked: values.revoked } : {}),
      ...(values.profile !== undefined ? { profile: values.profile as "direct" | "dock" } : {}),
      ...tokens,
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
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`apc-conformance: ${redactSecrets(message, process.argv.slice(2).filter((a) => a.includes("://")))}\n`);
    process.exitCode = 1;
  },
);
