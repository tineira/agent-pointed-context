/**
 * The hub as an MCP client of a paired app (TIN-382): one JSON-RPC request per call over Streamable
 * HTTP, no session (APC apps are stateless). The app's grant is the secret in its MCP URL, kept by
 * the hub only.
 */
export interface AppToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface AppTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

const PROTOCOL = "2025-06-18";

export class AppCallError extends Error {}

async function rpc(mcpUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, "user-agent": "apc-hub/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new AppCallError(`${method}: HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  type Reply = { result?: unknown; error?: { message?: string } } | null;
  let message: Reply = null;
  if (type.includes("text/event-stream")) {
    // The last data line that carries a response.
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5)) as Reply;
        if (parsed && ("result" in parsed || "error" in parsed)) message = parsed;
      } catch {
        // skip
      }
    }
  } else {
    message = (await response.json()) as Reply;
  }
  if (!message) throw new AppCallError(`${method}: no response`);
  if (message.error) throw new AppCallError(`${method}: ${message.error.message ?? "error"}`);
  return message.result;
}

/**
 * Introduce the hub to the app with the agent's mark (TIN-388): the app shows the agent as
 * "<name> via dock" with its icon, a small PNG, in clientInfo.icons as MCP defines it.
 */
export async function initializeApp(mcpUrl: string, title: string, icon: string | null): Promise<void> {
  const icons = icon ? [{ src: icon, mimeType: "image/png", sizes: ["64x64"] }] : undefined;
  await rpc(mcpUrl, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "apc-hub", title, version: "0.1.0", ...(icons ? { icons } : {}) } }, 10_000);
}

/**
 * Give a grant back (TIN-388): whoever holds a grant may return it, and the app deletes it, its pins
 * and its dock link. The MCP URL is the proof. An app that does not know the endpoint answers 404.
 */
export async function revokeGrant(mcpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${new URL(mcpUrl).origin}/apc/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_url: mcpUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listAppTools(mcpUrl: string): Promise<AppTool[]> {
  const result = (await rpc(mcpUrl, "tools/list", {}, 10_000)) as { tools?: AppTool[] } | null;
  return Array.isArray(result?.tools) ? result.tools.slice(0, 64) : [];
}

export async function callAppTool(mcpUrl: string, name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<AppToolResult> {
  return ((await rpc(mcpUrl, "tools/call", { name, arguments: args }, timeoutMs)) ?? {}) as AppToolResult;
}

/** A result's structured content, or the JSON of its first text block. */
export function structured(result: AppToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
