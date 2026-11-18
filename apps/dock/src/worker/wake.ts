/**
 * Wake on pin (TIN-962, experimental): the dock POSTs to a Grok Bot webhook trigger when the person points an agent that
 * is not calling, so the bot starts a run and reads the pin with get_current_view. The hub learns of the pin from the
 * app's ring (`@tineira/apc-server` ring.ts), from the browser extension's reading, or from a pairing turning paired.
 *
 * The engine and its pure parts live in `@tineira/apc-server` (wake.ts, TIN-973), shared with apps that wake the agents
 * connected to them directly; this file keeps what is the dock's alone: the ring's form and the dock's copy.
 */
import { productOf } from "../../../demo/src/model/products.ts";
import { RING_NONCE, RING_SIG, RING_WINDOW_MS, WAKE_DOCK_PLACE, wakeHint, wakeResultHint, wakeTool } from "@tineira/apc-server";

export { WAKE_DAY_MAX, WAKE_DEADLINE_MS, WAKE_DEFER_MAX_MS, WAKE_DEFER_MS, WAKE_GAP_MS, WAKE_HINT_EVERY_MS, WAKE_KEY, WAKE_SETTLE_MS, WAKE_TEST_GAP_MS, WAKE_URL, parseWake, wakeDay, wakeOutcome, withKey, type WakeDelivery, type WakeKind, type WakeStatus } from "@tineira/apc-server";
export { WAKE_ROUTINE_NAME, WAKE_ROUTINE_PROMPT } from "../wake-shared.ts";

/** The one product a webhook may be set for, and is sent for. */
export const WAKE_PRODUCT = "grok-bot";
/** Ring nonces kept against replay: as long as a ring is accepted, and at most this many. */
export const RING_SEEN_MAX = 2_000;
export { RING_WINDOW_MS };

/** The dock's copy: the tool a Grok bot agent gets from the hub, the line in its instructions, the offer in its results. */
export const WAKE_PLACE = WAKE_DOCK_PLACE;
export const WAKE_TOOL = wakeTool(WAKE_DOCK_PLACE);
export const WAKE_HINT = wakeHint(WAKE_DOCK_PLACE);
export const WAKE_RESULT_HINT = wakeResultHint(WAKE_DOCK_PLACE);

/** Whether the agent's client says it is Grok bot (its declared name: a hint, never authentication). */
export function isWakeProduct(clientName: string | null, clientUa: string | null): boolean {
  return productOf(clientName, clientUa)?.id === WAKE_PRODUCT;
}

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
