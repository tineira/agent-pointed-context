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
