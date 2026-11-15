/** A pet keeps the room a message needed until the person clicks Done. */
export interface PetBubbleState {
  shown: boolean;
  size: { width: number; height: number } | null;
}

export const PET_BUBBLE_START: PetBubbleState = { shown: false, size: null };

export function petBubbleReducer(
  state: PetBubbleState,
  event: { type: "show" } | { type: "measure"; width: number; height: number } | { type: "done" },
): PetBubbleState {
  if (event.type === "done") return PET_BUBBLE_START;
  if (event.type === "show") return state.shown ? state : { ...state, shown: true };
  // A frame not laid out yet measures 0: wait for a real size.
  if (!(event.width >= 1 && event.height >= 1)) return state;
  const width = Math.max(state.size?.width ?? 0, event.width);
  const height = Math.max(state.size?.height ?? 0, event.height);
  if (width === state.size?.width && height === state.size?.height) return state;
  return { shown: true, size: { width, height } };
}

/**
 * What a bubble says once nothing waits in it. A request the person answered here, accepted by the hub,
 * ends in a short confirmation and the bubble closes itself. A request that left on its own (it expired,
 * or was answered in the dock) keeps the bubble, with why, until Done: nothing shrinks under the cursor
 * the person did not move. While an answer given here is still on its way, it waits. With nothing that
 * left (a refusal they dismissed), it closes at once.
 */
export type PetBubbleEnd = { type: "answered"; text: string } | { type: "waiting" } | { type: "gone" } | { type: "close" };

/** `answers`: id to the confirmation of an answer the hub accepted, or null while it is on its way. */
export function petBubbleEnd(answers: ReadonlyMap<string, string | null>, left: readonly string[]): PetBubbleEnd {
  if (left.length === 0) return { type: "close" };
  if (left.some((id) => answers.get(id) === null)) return { type: "waiting" };
  if (!left.every((id) => typeof answers.get(id) === "string")) return { type: "gone" };
  return { type: "answered", text: answers.get(left[left.length - 1]!)! };
}

/** The confirmation for an answer given in the bubble. */
export function petAnswerText(action: "approve" | "approve_unverified" | "deny", name: string, connect: boolean): string {
  if (action === "deny") return `${name} denied.`;
  return connect ? `✓ Approved: continue in ${name}.` : `✓ ${name} is connected.`;
}

/** How long a confirmation stays, once the pointer is off the bubble. */
export const PET_CONFIRM_MS = 1500;
