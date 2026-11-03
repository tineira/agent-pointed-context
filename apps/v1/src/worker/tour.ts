/**
 * The guided first run (TIN-361), as one pure function of what the sandbox knows. The page shows a
 * step and the person's answers (ack, skip, done) are stored in the sandbox, so a reload resumes.
 *
 *   connect    no agent yet: nothing to guide (the How-to covers it)
 *   connected  an agent connected: "it's connected, go to Overview" (until acknowledged)
 *   point      no pin yet: an arrow from the agent's mark to a bar
 *   pinned     a pin the agent has not read: the prompt to give it
 *   read_once  it read one pin: "move the mark, without writing to it"
 *   read_twice it read a second pin: "Bring what you know" (until done)
 *   off        skipped or done
 */
export type TourStep = "off" | "connect" | "connected" | "point" | "pinned" | "read_once" | "read_twice";

export function tourStep(t: { skipped: boolean; done: boolean; acked: boolean; grantId: string | null; hasPin: boolean; reads: number }): TourStep {
  if (t.skipped || t.done) return "off";
  if (!t.grantId) return "connect";
  if (!t.acked) return "connected";
  if (t.reads >= 2) return "read_twice";
  if (t.reads === 1) return "read_once";
  return t.hasPin ? "pinned" : "point";
}
