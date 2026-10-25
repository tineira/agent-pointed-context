/**
 * The MCP URL as a QR, and the prompt a person pastes to their agent: what connecting an agent
 * shows, in Pulse (connect.tsx) and in the agent dock (TIN-403). No other imports, so the dock can
 * use it without Pulse's page code.
 */
import { encode } from "uqr";
import { useMemo } from "react";

/** Black modules on a white plate, so a phone camera can read it in either theme. */
export function Qr(props: { text: string }) {
  const code = useMemo(() => encode(props.text, { ecc: "M", border: 4 }), [props.text]);
  const n = code.size;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = code.data[y];
    if (!row) continue;
    for (let x = 0; x < n; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} width="196" height="196" role="img" aria-label="QR code of the MCP URL" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#141a24" />
    </svg>
  );
}

export const SCAN_HINT = "Scan with a phone, then paste the URL into the agent. Opening the link in the browser does not connect it.";

/** What a person pastes to their own agent when they don't know how to add an MCP server there (TIN-360). */
export function askYourAgentPrompt(url: string): string {
  return `I want to connect you to a remote MCP server. URL: ${url}. It uses Streamable HTTP and needs no OAuth: the access is in the URL. Tell me the exact steps to add it in the app I'm using you in right now. Do not open the URL in a browser.`;
}
