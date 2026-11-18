/**
 * Wake on pin (TIN-962, TIN-967): what the hub and the dock page share, so they never say different things. The limits
 * and the routine's text live with the wake engine in `@tineira/apc-server` (TIN-973), in a file without imports that
 * the page can take alone; the dock's routine is the engine's dock place.
 */
import { WAKE_DOCK_PLACE, wakeRoutinePrompt } from "../../../packages/server/src/wake-shared.ts";

export { WAKE_DAY_MAX, WAKE_GAP_MS } from "../../../packages/server/src/wake-shared.ts";

/** The routine Grok Bot creates for the dock. Fixed text: nothing in it comes from an app, a page or the person. */
export const WAKE_ROUTINE_NAME = WAKE_DOCK_PLACE.routineName;
export const WAKE_ROUTINE_PROMPT = wakeRoutinePrompt(WAKE_DOCK_PLACE);
