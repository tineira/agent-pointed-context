/**
 * The drag payload (APC 0.2, pairing since 0.4): what a dock puts on an agent it lets the person drag onto
 * an app's page. Any page the agent is dropped on can read it, so it holds a public handle and, for a
 * pairing, the hub's origin and a single-use, short-lived ticket; never a grant secret or an MCP URL.
 *
 * It lives here, not only in `@tineira/apc-web`, so an app's server can check a drop with the same grammar
 * its page used (`parseDockDrop` in `@tineira/apc-server`). `@tineira/apc-web` re-exports all of it.
 */

/** What an agent's drag carries. hub and ticket come with pairing (TIN-382): the hub's origin and a single-use, short-lived ticket. */
export interface AgentDrag {
  v: 1;
  agent: string;
  hub?: string;
  ticket?: string;
}

/** The drag type a dock puts on an agent: its payload is agentDragPayload(handle), never a secret. */
export const APC_AGENT_TYPE = "application/x-apc-agent";

/** An agent's public handle in a drag: 1 to 128 of letters, digits, `_`, `.`, `:` and `-`. */
export const AGENT_HANDLE_RE = /^[\w.:-]{1,128}$/;
/** A drag's pairing ticket: 16 to 200 of letters, digits, `_`, `.` and `-`. */
export const DRAG_TICKET_RE = /^[\w.-]{16,200}$/;

/**
 * What an agent's drag carries: a public handle and nothing else. Any page the agent is dropped on
 * can read it, so it must never hold a grant secret or an MCP URL.
 */
export function agentDragPayload(handle: string, pairing?: { hub: string; ticket: string }): string {
  return JSON.stringify(pairing ? { v: 1, agent: handle, hub: pairing.hub, ticket: pairing.ticket } : { v: 1, agent: handle });
}

/**
 * A drag payload, or null when it is not one (another app's data, a wrong version, junk). A hub
 * that is not a bare http(s) origin, or a ticket that is not a short token, is dropped, not the drag.
 *
 * This is the page's first look only. An app's server checks the hub again against its own allowlist
 * (M1, APC 0.10: `parseDockDrop` in `@tineira/apc-server`) on the drop and again on the Allow.
 */
export function parseAgentDrag(text: string): AgentDrag | null {
  try {
    const value = JSON.parse(text) as { v?: unknown; agent?: unknown; hub?: unknown; ticket?: unknown } | null;
    if (value?.v !== 1 || typeof value.agent !== "string" || !AGENT_HANDLE_RE.test(value.agent)) return null;
    const drag: AgentDrag = { v: 1, agent: value.agent };
    const hubOk = typeof value.hub === "string" && value.hub.length <= 200 && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(value.hub);
    const ticketOk = typeof value.ticket === "string" && DRAG_TICKET_RE.test(value.ticket);
    if (hubOk && ticketOk) Object.assign(drag, { hub: value.hub, ticket: value.ticket });
    return drag;
  } catch {
    return null;
  }
}

/** The handle in a drag payload, or null when it is not one. */
export function parseAgentDragPayload(text: string): string | null {
  return parseAgentDrag(text)?.agent ?? null;
}
