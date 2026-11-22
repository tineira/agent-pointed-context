/**
 * The Direct copy for Pulse's v2 deploy (TIN-1098): where APC_PROFILES offers Direct — the standard's
 * deploy, "direct,dock" — the data pages' hint and the How-to (dock-only.tsx) teach connecting directly,
 * in the site's /try voice, instead of inviting people to an agent dock. The dock copy stays only on a
 * dock-only deploy (no Direct), until the 2.0 cut (TIN-1011); the replies to a real dock drop (the
 * consent card, "Confirm in your dock", the waiting cards) are other components and stay. Plain
 * TypeScript rather than TSX so `node --test` can import it (no TSX loader here, see strings.test.ts):
 * the tests prove which text each deploy shows (test/direct-copy.test.ts).
 */

/** Whether Pulse's v2 deploy offers the Direct profile: the standard's deploy does ("direct,dock"), a dock-only one does not. */
export function directOffered(state: { profiles?: readonly string[] }): boolean {
  return !!state.profiles?.includes("direct");
}

/** The agent bar's props for the dock hint (TIN-1100): off (`dockHint: null`) where Direct is offered, the bar's default hint on a dock-only deploy. */
export function barDockHint(offersDirect: boolean): { dockHint?: null } {
  return offersDirect ? { dockHint: null } : {};
}

/** The data pages' hint while no agent is here: connect one directly on the Agents page (dock-only.tsx appends the Agents link). */
export const DIRECT_HINT =
  "No agent can read Pulse yet. Press Connect an agent on the Agents page: it gives the MCP address, with Copy, and the prompt that asks your agent to add it, with Copy prompt. Add the address to your agent as a remote MCP server, then drag its mark from the top onto any chart or customer.";

/** The How-to's lead where Pulse offers Direct: the Agents page's own sentence. */
export const DIRECT_INTRO =
  "Pulse is one of the apps your agent can read. Connect an agent to Pulse alone: it gets its own URL, and Pulse's data goes straight to it.";

/** The How-to's steps where Pulse offers Direct, the site's /try walk: the Agents page's address, the remote MCP server, the drag from the top, the question. */
export const DIRECT_STEPS: readonly string[] = [
  "Open the Agents page and press Connect an agent: it gets its own MCP address, with Copy, and a prompt that asks your agent to add it, with Copy prompt.",
  "Add the address to your agent as a remote MCP server — Claude, ChatGPT and Grok take one, and so does any agent that accepts a remote MCP server.",
  "Drag your agent's mark from the top onto a bar, a step of the bridge or a customer. On a phone, tap the mark, then the thing.",
  'Ask: "what is this?" Your agent reads the numbers behind what you pointed at, not a picture of them.',
];
