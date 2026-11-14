/**
 * The secrets in what the dock logs itself are redacted (TIN-911), and an agent's MCP request logs nothing at all. An agent's MCP URL (`/mcp/<did>/<secret>`),
 * an app's grant URL (a secret path segment under its MCP path), a ticket, a reader claim or token and a computer's
 * secret are each a bearer credential: whoever reads the log could replay them. The Worker's invocation logs are
 * off for the same reason (`observability.logs.invocation_logs` in wrangler.jsonc): they record the request URL. The
 * platform may still stamp a log record with its request's URL, so nothing is logged from an `/mcp/` request.
 */

/** An MCP path's secret part: everything after `/mcp/` up to the end of the path (a dock agent's `<did>/<secret>`, an app grant's secret). */
const MCP_PATH = /(\/mcp\/)[^\s"'?#]+/g;
/** A secret passed as a query value: `?token=`, `&k=`, `secret`, `claim`, `ticket`, `code`. */
const QUERY = /([?&](?:token|k|key|secret|claim|ticket|code)=)[^&\s"'#]+/gi;
/** A ticket, claim, reader token or cookie value: the dock's id, a dot, a secret. Glued to `_` or `-` too. */
const DOTTED = /(?<![0-9a-f])[0-9a-f]{32}\.[0-9a-f]{32}(?![0-9a-f])/gi;
/** Any other long hex run (a secret on its own, a device secret), in either case. */
const HEX = /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi;

/** The text with every secret it may hold replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  return text.replace(MCP_PATH, "$1[redacted]").replace(QUERY, "$1[redacted]").replace(DOTTED, "[redacted]").replace(HEX, "[redacted]");
}

/** An error as the dock logs it: its stack (or message) with every secret redacted. */
export function loggable(error: unknown): string {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return redactSecrets(text);
}
