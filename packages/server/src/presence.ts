import type { PresenceEvent, PresenceWaitEvent } from "@tineira/apc-protocol";

export const PRESENCE_MAX_TARGETS = 20;

/** Ids only: which agent, which tool, read or write, and up to 20 targets. */
export function presenceEvent(input: {
  grantId: string;
  tool: string;
  kind: "read" | "write";
  targets: Array<{ kind: string; id: string }>;
  at?: Date;
}): PresenceEvent {
  const seen = new Set<string>();
  const targets: Array<{ kind: string; id: string }> = [];
  for (const target of input.targets) {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind: target.kind, id: target.id });
  }
  return {
    v: 1,
    grant_id: input.grantId,
    at: (input.at ?? new Date()).toISOString(),
    tool: input.tool,
    kind: input.kind,
    targets: targets.slice(0, PRESENCE_MAX_TARGETS),
    count: targets.length,
  };
}

/** A wait opened or closed (APC 0.11): ids only, for the person's page. `announceWaits` sends these for you. */
export function presenceWaitEvent(input: { grantId: string; state: "open" | "closed"; at?: Date }): PresenceWaitEvent {
  return { v: 1, grant_id: input.grantId, at: (input.at ?? new Date()).toISOString(), kind: "wait", state: input.state };
}
