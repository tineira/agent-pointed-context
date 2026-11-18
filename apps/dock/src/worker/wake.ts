/**
 * Wake on pin (TIN-962, experimental): the dock POSTs to a Grok Bot webhook trigger when the person points an agent that
 * is not calling, so the bot starts a run and reads the pin with get_current_view. The hub learns of the pin from the
 * app's ring (`@tineira/apc-server` ring.ts), from the browser extension's reading, or from a pairing turning paired.
 *
 * Pure parts only (checks, limits, outcomes); the state lives in the hub (hub.ts).
 */
import { productOf } from "../../../demo/src/model/products.ts";
import { RING_NONCE, RING_SIG, RING_WINDOW_MS } from "@tineira/apc-server";

/** The one product a webhook may be set for, and is sent for. */
export const WAKE_PRODUCT = "grok-bot";
/** The only webhook shape the dock calls: Grok Bot's automation trigger. */
export const WAKE_URL = /^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[A-Za-z0-9_-]{8,128}$/;
/** The trigger's key: printable ASCII, no spaces. */
export const WAKE_KEY = /^[\x21-\x7e]{16,512}$/;
/** After a pin, the dock waits this long before it wakes the agent: a call already under way may take the pin. */
export const WAKE_SETTLE_MS = 2_000;
/** At most one wake per agent in this window. */
export const WAKE_GAP_MS = 30_000;
/** While a call or an app wait of the agent is in flight, the wake is put off this long, again and again... */
export const WAKE_DEFER_MS = 3_000;
/** ...for at most this long after the pin: then it goes anyway. */
export const WAKE_DEFER_MAX_MS = 60_000;
/** Webhook POSTs per agent per UTC day, tests included. */
export const WAKE_DAY_MAX = 100;
/** One test per agent in this window. */
export const WAKE_TEST_GAP_MS = 10_000;
/** The webhook's deadline, headers included. */
export const WAKE_DEADLINE_MS = 10_000;
/** Ring nonces kept against replay: as long as a ring is accepted, and at most this many. */
export const RING_SEEN_MAX = 2_000;
export { RING_WINDOW_MS };

export type WakeKind = "pin" | "page_reading";
export type WakeStatus = "ok" | "broken" | "error" | "paused" | "limit";

/** Whether the agent's client says it is Grok bot (its declared name: a hint, never authentication). */
export function isWakeProduct(clientName: string | null, clientUa: string | null): boolean {
  return productOf(clientName, clientUa)?.id === WAKE_PRODUCT;
}

/** The person's webhook, checked: the trigger URL and key exactly as Grok Bot shows them, trimmed. */
export function parseWake(body: unknown): { url: string; key: string } | null {
  const b = body && typeof body === "object" ? (body as { url?: unknown; key?: unknown }) : {};
  if (typeof b.url !== "string" || typeof b.key !== "string") return null;
  const url = b.url.trim();
  const key = b.key.trim().replace(/^Bearer\s+/i, "");
  return WAKE_URL.test(url) && WAKE_KEY.test(key) ? { url, key } : null;
}

/** What a webhook's answer means: 2xx taken; a refused key or a deleted trigger is broken until set again; anything else an error. */
export function wakeOutcome(response: { status: number; type?: string } | null): "ok" | "broken" | "error" {
  if (!response || response.type === "opaqueredirect") return "error";
  if (response.status >= 200 && response.status < 300) return "ok";
  return [401, 403, 404, 410].includes(response.status) ? "broken" : "error";
}

/** The UTC day of a time, for the daily budget. */
export const wakeDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A ring's body, checked for form only (the signature is the hub's to check). */
export function parseRingBody(body: unknown): { id: string; at: number; n: string; sig: string } | null {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).length !== 4) return null;
  const { id, at, n, sig } = b as { id?: unknown; at?: unknown; n?: unknown; sig?: unknown };
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return null;
  if (typeof n !== "string" || !RING_NONCE.test(n) || typeof sig !== "string" || !RING_SIG.test(sig)) return null;
  return { id, at, n, sig };
}
