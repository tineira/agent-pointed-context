/**
 * The MCP URL as a QR, and the prompt a person pastes to their agent: what connecting an agent
 * shows, in Pulse (connect.tsx) and in the agent dock (TIN-403). No imports of Pulse's page code, so
 * the dock can use it.
 */
import { connectPrompt } from "@tineira/apc-web";
import { encode } from "uqr";
import { useMemo } from "react";

/** Black modules on a white plate, so a phone camera can read it in either theme. */
export function Qr(props: { text: string; label?: string }) {
  const code = useMemo(() => encode(props.text, { ecc: "M", border: 4 }), [props.text]);
  const n = code.size;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = code.data[y];
    if (!row) continue;
    for (let x = 0; x < n; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} width="196" height="196" role="img" aria-label={props.label ?? "QR code of the MCP URL"} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#141a24" />
    </svg>
  );
}

export const SCAN_HINT = "Scan with a phone, then paste the URL into the agent. Opening the link in the browser does not connect it.";

/**
 * What a person pastes to their own agent to connect it (TIN-360). Many agents can add a server
 * themselves when asked in the chat (the Grok bot, Claude Code…), so it asks for that first, under a
 * name the person will recognise, and for the steps only if the agent cannot (TIN-408).
 */
export function askYourAgentPrompt(url: string, name = "Pulse"): string {
  // The Direct profile's connect instructions, from @tineira/apc-web (TIN-578): one text for every app.
  return connectPrompt(url, name);
}

/** The other way round (TIN-411): what a person pastes to their agent to drop the server again. */
export function askToDisconnectPrompt(name: string, host: string): string {
  return `Please remove the remote MCP server named "${name}" (its URL starts with https://${host}/mcp/) from your connectors. If you can remove it yourself, do it now and tell me when it's gone. If you can't, tell me the exact steps to remove it in the app I'm using you in right now.`;
}
