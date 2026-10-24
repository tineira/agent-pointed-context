/**
 * What every page shows to connect an agent: its MCP URL with a copy button, the same URL as a QR,
 * the agent's card, and the panel above the data pages while no agent is connected. Shared by the
 * Agents page, the how-to and the data pages, so no page module imports another for these.
 */
import { encode } from "uqr";
import { useMemo, useState } from "react";
import { AgentIcon } from "./agent-icon.tsx";
import { mcpUrl, type Api, type GrantState, type SandboxState } from "./api.ts";
import { AppLink } from "./ui.tsx";

export function CopyField(props: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line bg-background">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12.5px] leading-relaxed">{props.text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(props.text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="copy-button shrink-0 cursor-pointer border-l border-line px-3 text-xs font-medium text-filament hover:bg-filament-soft"
      >
        {done ? "Copied" : (props.label ?? "Copy")}
      </button>
    </div>
  );
}

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

/** The QR with its hint beside it; the hint drops under the QR when the column is narrow. */
export function QrRow(props: { text: string; hint?: string }) {
  return (
    <div className="qr-row">
      <Qr text={props.text} />
      <p className="hint">{props.hint ?? SCAN_HINT}</p>
    </div>
  );
}

export const claudeCommand = (name: string, url: string) => `claude mcp add --transport http ${name} ${url}`;
/** The agent's manual as a skill for Claude Code and other CLIs (skills/pulse-agent/SKILL.md in the repo). */
export const SKILL_COMMAND = "npx skills add https://github.com/tineira/agent-pointed-context --skill pulse-agent";
/** The MCP server name an agent card's Claude Code command uses. */
export const serverName = (grant: { regions: unknown[] | null }) => (grant.regions ? "pulse-restricted" : "pulse");

/** The agent most people connect first: the first unrestricted one. */
export const defaultGrant = (state: SandboxState): GrantState => state.grants.find((g) => !g.regions) ?? state.grants[0]!;

/** One agent: its mark, its label, the client that connected, and its MCP URL. */
export function AgentCard(props: { sid: string; grant: GrantState; initials: string | undefined; command?: boolean; compact?: boolean }) {
  const g = props.grant;
  const url = mcpUrl(props.sid, g);
  return (
    <div className={props.compact ? "grant grant-compact" : "grant"}>
      <h3>
        <span className="mark-inline mark-logo" title={props.initials}>
          <AgentIcon clientName={g.client_name} clientIcon={g.client_icon} seed={g.id} motion={g.client_name ? "idle" : "off"} size={16} />
        </span>{" "}
        {g.label}
        {g.client_name ? <span className="muted"> · connected as {g.client_name}</span> : <span className="muted"> · not connected yet</span>}
      </h3>
      <CopyField text={url} />
      <QrRow text={url} />
      {props.command && (
        <>
          <p className="hint">Claude Code:</p>
          <CopyField text={claudeCommand(serverName(g), url)} />
        </>
      )}
    </div>
  );
}

export function AddAgentButtons(props: { api: Api; state: SandboxState; onChanged: () => void }) {
  const hasRestricted = props.state.grants.some((g) => g.regions);
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className="inline-flex min-h-9 cursor-pointer items-center rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground hover:border-filament"
        onClick={async () => {
          await props.api.addAgent();
          props.onChanged();
        }}
      >
        Add another agent
      </button>
      {!hasRestricted && (
        <button
          type="button"
          className="inline-flex min-h-9 cursor-pointer items-center rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground hover:border-filament"
          onClick={async () => {
            await props.api.addRestricted("latam");
            props.onChanged();
          }}
        >
          Add a restricted agent (LATAM only)
        </button>
      )}
    </div>
  );
}

const dismissKey = (sid: string) => `pulse.connect-panel.dismissed.${sid}`;

function readDismissed(sid: string): boolean {
  try {
    return localStorage.getItem(dismissKey(sid)) === "1";
  } catch {
    return false;
  }
}

/**
 * Above the data pages while no agent of this sandbox has connected. It goes away by itself when
 * one connects: the sandbox announces that on the page's WebSocket and the app reloads its state.
 * Dismissing it is remembered for this sandbox only, in this browser.
 */
export function ConnectPanel(props: { sid: string; state: SandboxState }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(props.sid));
  if (dismissed || props.state.grants.some((g) => g.client_name)) return null;
  const url = mcpUrl(props.sid, defaultGrant(props.state));
  return (
    <section className="card connect-panel" aria-label="Connect your agent">
      <div className="connect-head">
        <h2>Connect your agent first</h2>
        <button
          type="button"
          className="link dismiss"
          aria-label="Dismiss"
          title="Dismiss for this sandbox"
          onClick={() => {
            try {
              localStorage.setItem(dismissKey(props.sid), "1");
            } catch {
              // Private mode or storage off: dismissed until the page reloads.
            }
            setDismissed(true);
          }}
        >
          ×
        </button>
      </div>
      <p className="hint">No agent is connected to this sandbox yet, so there is no one to point at these charts. Add this URL to your agent as a remote MCP server (Streamable HTTP); no login, the secret in the URL is the access.</p>
      <div className="connect-body">
        <div className="connect-fields">
          <CopyField text={url} />
          <p className="hint">Claude Code, in your terminal:</p>
          <CopyField text={claudeCommand("pulse", url)} />
          <p className="hint">
            <AppLink href="/how-to">Step by step for your agent, in the How-to →</AppLink>
          </p>
        </div>
        <QrRow text={url} />
      </div>
    </section>
  );
}
