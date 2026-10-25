/**
 * What every page shows to connect an agent: its MCP URL with a copy button, the same URL as a QR,
 * the agent's card, and the panel above the data pages while no agent is connected. Shared by the
 * Agents page, the how-to and the data pages, so no page module imports another for these.
 */
import { useEffect, useState } from "react";
import { AgentIcon } from "./agent-icon.tsx";
import { productName } from "../model/products.ts";
import { mcpUrl, type Api, type GrantState, type SandboxState } from "./api.ts";
import { askYourAgentPrompt, Qr, SCAN_HINT } from "./qr.tsx";
import { AppLink } from "./ui.tsx";

export { askYourAgentPrompt, Qr, SCAN_HINT } from "./qr.tsx";

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

/** The QR with its hint beside it; the hint drops under the QR when the column is narrow. */
export function QrRow(props: { text: string; hint?: string }) {
  return (
    <div className="qr-row">
      <Qr text={props.text} />
      <p className="hint">{props.hint ?? SCAN_HINT}</p>
    </div>
  );
}

/** The agent's manual as a skill for Claude Code and other CLIs (skills/pulse-agent/SKILL.md in the repo). */
export const SKILL_COMMAND = "npx skills add https://github.com/tineira/agent-pointed-context --skill pulse-agent";
/** The MCP server name an agent card's Claude Code command uses. */
export const serverName = (grant: { regions: unknown[] | null }) => (grant.regions ? "pulse-restricted" : "pulse");

/** The agent most people connect first: the first unrestricted one. */
export const defaultGrant = (state: SandboxState): GrantState => state.grants.find((g) => !g.regions) ?? state.grants[0]!;

/** A second product on this agent's URL, while it still uses it (TIN-358): the warning clears an hour after its last call. */
export function activeConflict(g: GrantState, now = Date.now()): GrantState["conflict"] {
  const at = Date.parse(g.conflict?.at ?? "");
  return g.conflict && at && now - at < 60 * 60_000 ? g.conflict : null;
}

export function ago(iso: string | null, now = Date.now()): string | null {
  const t = Date.parse(iso ?? "");
  if (!t) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "active just now";
  if (s < 3600) return `active ${Math.round(s / 60)} min ago`;
  return `active ${Math.round(s / 3600)} h ago`;
}

/**
 * One agent: its mark, its label, the client that connected, and its MCP URL. A connected agent's
 * card is compact: its URL, QR and manual sit behind "Show connection" (TIN-359), since the URL is
 * its credential and is rarely needed once it is in the agent. An agent not connected yet shows them.
 */
export function AgentCard(props: {
  sid: string;
  grant: GrantState;
  name: string;
  initials: string | undefined;
  compact?: boolean;
  manual?: boolean;
  onRename?: (name: string) => Promise<void>;
  onConflict?: (action: "split" | "adopt") => Promise<GrantState | undefined>;
}) {
  const g = props.grant;
  const [editing, setEditing] = useState<string | null>(null);
  // After "Give it its own URL": the new agent's URL, shown right here for the client that needs it.
  const [handoff, setHandoff] = useState<{ client: string; grant: GrantState } | null>(null);
  const conflict = activeConflict(g);
  const url = mcpUrl(props.sid, g);
  const connected = !!g.client_name;
  const [open, setOpen] = useState(!connected);
  // An agent that connects while the page is open folds its card.
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);
  const seen = g.pin && g.pin.seen_at && g.pin.seen_at >= g.pin.pinned_at;
  const active = ago(g.last_active_at);
  return (
    <div className={props.compact ? "grant grant-compact" : "grant"}>
      <div className="grant-head">
        <h3>
          <span className="mark-inline mark-logo" title={props.initials}>
            <AgentIcon clientName={g.client_name} clientUa={g.client_ua} clientIcon={g.client_icon} motion={connected ? "idle" : "off"} size={16} />
          </span>{" "}
          {editing !== null ? (
            <form
              className="grant-rename"
              onSubmit={async (e) => {
                e.preventDefault();
                await props.onRename?.(editing);
                setEditing(null);
              }}
            >
              <input value={editing} maxLength={40} autoFocus aria-label="Agent name" placeholder="Empty: back to its own name" onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
              <button type="submit">Save</button>
              <button type="button" className="link" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              {props.name}
              {props.onRename && (
                <button type="button" className="link grant-toggle grant-rename-open" onClick={() => setEditing(g.owner_name ?? props.name)}>
                  Rename
                </button>
              )}
            </>
          )}
          {connected ? <span className="muted"> · connected as {g.client_name}</span> : <span className="muted"> · not connected yet</span>}
        </h3>
        {connected && (
          <span className="grant-meta">
            {active && <span>{active}</span>}
            {g.pin && <span className={seen ? "grant-pin seen" : "grant-pin"}>{seen ? "read your pin" : "pin not read yet"}</span>}
            <button type="button" className="link grant-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide connection" : "Show connection"}
            </button>
          </span>
        )}
      </div>
      {conflict && props.onConflict && (
        <div className="grant-conflict" role="alert">
          <span>
            <strong>{productName(conflict.client_name, conflict.user_agent)}</strong> is using {props.name}'s URL. One URL is one agent: the pin, the name and the access are per URL. Give it its own?
          </span>
          <span className="grant-conflict-actions">
            <button
              type="button"
              onClick={async () => {
                const fresh = await props.onConflict!("split");
                if (fresh) setHandoff({ client: productName(conflict.client_name, conflict.user_agent), grant: fresh });
              }}
            >
              Give it its own URL
            </button>
            <button type="button" onClick={() => void props.onConflict!("adopt")}>
              It's the same agent now
            </button>
          </span>
        </div>
      )}
      {handoff && (
        <div className="grant-conflict grant-handoff">
          <span>
            Put this new URL in <strong>{handoff.client}</strong>, in place of the old one. It shows up as its own agent once it connects.
          </span>
          <CopyField text={mcpUrl(props.sid, handoff.grant)} />
          <QrRow text={mcpUrl(props.sid, handoff.grant)} />
          <button type="button" className="link grant-toggle" onClick={() => setHandoff(null)}>
            Done
          </button>
        </div>
      )}
      {open && (
        <div className="grant-body">
          <CopyField text={url} />
          <QrRow text={url} />
          {props.manual && (
            <p className="hint">
              Its manual, if you want it to have one: the server's prompt named guide (<code>/mcp__{serverName(g)}__guide</code> in Claude Code, the + menu in Claude Desktop), or the pulse-agent skill (<code>{SKILL_COMMAND}</code>).
            </p>
          )}
        </div>
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
          <p className="hint">Don't know how to connect an MCP server? Ask your agent:</p>
          <CopyField text={askYourAgentPrompt(url)} label="Copy prompt" />
          <p className="hint">
            <AppLink href="/how-to">Step by step for your agent, in the How-to →</AppLink>
          </p>
        </div>
        <QrRow text={url} />
      </div>
    </section>
  );
}
