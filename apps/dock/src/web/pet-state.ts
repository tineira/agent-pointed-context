/**
 * A desktop pet's state (TIN-479), pure so it is testable without a browser. The APC dock for
 * Windows shows each agent as a pet (pet.tsx); what the pet draws comes from its mood, so a new look
 * (TIN-483: a character, the logo as its badge) reads the same state.
 */

/** off: not connected yet. idle / waiting: as on its tile. asking: a pairing request waits on it. */
export type PetMood = "off" | "idle" | "waiting" | "asking";

export function petMood(agent: { client_name: string | null; waiting: boolean }, requests: number): PetMood {
  if (requests > 0) return "asking";
  if (!agent.client_name) return "off";
  return agent.waiting ? "waiting" : "idle";
}

/**
 * Where the drag held the pet, in CSS px from its top left (inside it): on a drop nothing took, the
 * app puts that point under the cursor, so the pet lands where it was let go.
 */
export function grabPoint(client: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }): [number, number] {
  const inside = (v: number, len: number) => Math.min(Math.max(v, 0), len);
  return [inside(client.x - box.left, box.width), inside(client.y - box.top, box.height)];
}

/**
 * Whether a drag that ended moves the pet: only when nothing took it ("none"). An APC app that took
 * the agent says "link"; an agent's chat that took the connect prompt says "copy". Esc and a drop on
 * the pet itself say "none" too: the app leaves the pet where it is when the cursor is still on it.
 */
export const movesPet = (dropEffect: string | undefined) => dropEffect === "none";
