/** Historical milestones, with no app data or credentials (TIN-489). */
export interface Onboarding {
  connected: boolean;
  pin_read: boolean;
  second_app: boolean;
  reading_sent: boolean;
  kept: boolean;
  /** At most two app origins per agent: two agents reading one app each is not a join. */
  read_apps: Record<string, string[]>;
}

export const newOnboarding = (): Onboarding => ({ connected: false, pin_read: false, second_app: false, reading_sent: false, kept: false, read_apps: {} });

export type OnboardingEvent =
  | { type: "connected" | "pin_read" | "reading_sent" | "kept" }
  | { type: "app_read"; agent: string; app: string };

export function advanceOnboarding(previous: Onboarding, event: OnboardingEvent): Onboarding {
  if (event.type !== "app_read") return previous[event.type] ? previous : { ...previous, [event.type]: true };
  if (previous.second_app) return previous;
  const apps = previous.read_apps?.[event.agent] ?? [];
  if (apps.includes(event.app)) return previous;
  const next = [...apps, event.app];
  return { ...previous, second_app: next.length >= 2, read_apps: { ...previous.read_apps, [event.agent]: next } };
}

/** The checklist's items, in order (the dock's Try your dock). The last one, Keep it at hand, is optional. */
export const CHECKLIST_LENGTH = 5;

/**
 * Where the checklist stands (TIN-701): each item's check, how many are done, and whether the dock
 * is ready (every item but the optional last one). The dock draws the checklist from it: one line,
 * above the footer while it is not ready and at the very bottom once it is. An agent the dock sees
 * connected counts as connected before the hub's milestone lands.
 */
export function setupProgress(agents: readonly { client_name: string | null }[], progress: Onboarding): { done: boolean[]; count: number; ready: boolean; connected: boolean } {
  const connected = progress.connected || agents.some((a) => !!a.client_name);
  const done = [connected, progress.pin_read, progress.second_app, progress.reading_sent, progress.kept];
  return { done, count: done.filter(Boolean).length, ready: done.slice(0, CHECKLIST_LENGTH - 1).every(Boolean), connected };
}
