/**
 * What dragging an agent out of the dock puts on the drag (TIN-908), for every surface that drags one:
 * a tile, a Float logo, the strip and a Dock for Windows pet.
 *
 * Only a connected agent drags, and its drag is the APC payload: a public handle, this hub's origin and
 * a single-use ticket, never a secret or an MCP URL (the standard's "the payload MUST NOT hold a secret
 * or an MCP URL"). An agent not connected yet does not drag at all: any page it was dropped on could
 * read the drag, so its MCP URL and the prompt that holds it are only ever shown, copied or put in a QR
 * by an explicit action (Connect this agent). Before TIN-908 its drag was that prompt (TIN-408).
 */
import { agentDragPayload, APC_AGENT_TYPE } from "@tineira/apc-protocol";

/** The fields of an agent a drag looks at; `mcp_url` is never one of them. */
export interface DraggedAgent {
  id: string;
  client_name: string | null;
}

/** The part of a DataTransfer the drag writes to. */
export interface DragSink {
  setData(type: string, data: string): void;
  effectAllowed: DataTransfer["effectAllowed"];
}

/** Whether an agent can be dragged out of the dock: only once a client has connected to it. */
export function canDrag(agent: DraggedAgent | undefined): boolean {
  return !!agent?.client_name;
}

/**
 * Fills a drag of `agent` and says whether it may go on. False (an agent not connected yet, or one
 * gone from the dock) writes nothing, and the caller cancels the drag.
 */
export function fillAgentDrag(dt: DragSink | null | undefined, agent: DraggedAgent | undefined, fresh: { hub: string; ticket: string } | undefined): boolean {
  if (!agent || !canDrag(agent)) return false;
  if (dt) {
    dt.setData(APC_AGENT_TYPE, agentDragPayload(agent.id, fresh));
    dt.effectAllowed = "link";
  }
  return true;
}

/**
 * Starts a drag of `agent` from a dragstart event: filled when it may go on, cancelled (default
 * prevented, nothing written) when not. The caller marks the agent as dragged only on true, since a
 * cancelled drag gets no dragend.
 */
export function startAgentDrag(e: { dataTransfer: DragSink | null; preventDefault(): void }, agent: DraggedAgent | undefined, fresh: { hub: string; ticket: string } | undefined): boolean {
  if (fillAgentDrag(e.dataTransfer, agent, fresh)) return true;
  e.preventDefault();
  return false;
}

/** The tooltip on an agent's drag handle. */
export function dragTitle(agent: DraggedAgent & { name: string }, where = "anything in an APC app"): string {
  return canDrag(agent) ? `Drag ${agent.name} onto ${where} to point it there (or to pair it with that app)` : `Connect ${agent.name} first: use Connect this agent in the dock`;
}
