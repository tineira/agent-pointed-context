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
