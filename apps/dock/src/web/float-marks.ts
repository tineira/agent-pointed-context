/**
 * Float per agent (TIN-698): which agents float. Pure, so it is testable without a browser.
 *
 * Each agent has a "floats" mark, and the mark is the source of truth: Float being on only says
 * that the marked agents float. Marks are keyed by the agent's id (ag_…, the grant its MCP URL
 * names), which stays the same across the agent's reconnects, never by a connection. A new agent
 * is marked, so only the agents the person unmarked are kept: an agent that leaves the dock keeps
 * its mark for when it comes back. Marks are per device (the web dock in localStorage, the APC dock
 * for Windows in its config folder, apps/dock-desktop/src/float.rs), never sent to the hub.
 */

export interface Marks {
  /** Float is on: the web dock's Picture-in-Picture window is open, or the Windows pets show. */
  on: boolean;
  /** The agents the person took out of Float. Every other agent is marked. */
  unmarked: string[];
}

/** What Float says while it is on and none of the dock's agents is marked (TIN-698). */
export const NONE_SELECTED = "Float on, no agents selected";

/** The most unmarked agents kept: the oldest go first. Agents gone for good leave their mark here. */
export const MAX_UNMARKED = 200;

/** An agent id as the dock makes them (ag_ and hex), as pets.rs checks too. */
export const isAgentId = (id: unknown): id is string => typeof id === "string" && id.length <= 64 && /^ag_[0-9a-f]+$/i.test(id);

export function marked(m: Pick<Marks, "unmarked">, id: string): boolean {
  return !m.unmarked.includes(id);
}

/** The agents that float now: the marked ones while Float is on, none while it is off. */
export function floatingAgents<T extends { id: string }>(m: Marks, agents: T[]): T[] {
  return m.on ? agents.filter((a) => marked(m, a.id)) : [];
}

/** Float is on, the dock has agents, and none of them is marked: say so rather than show nothing. */
export function noneSelected(m: Marks, ids: string[]): boolean {
  return m.on && ids.length > 0 && ids.every((id) => !marked(m, id));
}

/** Marks or unmarks agents. Marking also turns Float on, so the click always shows something. */
export function setMarks(m: Marks, ids: string[], mark: boolean): Marks {
  const valid = [...new Set(ids.filter(isAgentId))];
  if (mark) return { on: true, unmarked: m.unmarked.filter((id) => !valid.includes(id)) };
  const unmarked = [...m.unmarked.filter((id) => !valid.includes(id)), ...valid];
  return { on: m.on, unmarked: unmarked.slice(-MAX_UNMARKED) };
}

/** The unmarked agents as stored: anything else in storage (an older shape, a hand edit) is dropped. */
export function readUnmarked(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "null") as { unmarked?: unknown } | null;
    const list = Array.isArray(v?.unmarked) ? v.unmarked.filter(isAgentId) : [];
    return [...new Set(list)].slice(-MAX_UNMARKED);
  } catch {
    return [];
  }
}

export function writeUnmarked(unmarked: string[]): string {
  return JSON.stringify({ unmarked });
}
