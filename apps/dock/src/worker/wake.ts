/**
 * Wake on pin (TIN-962, experimental): the dock POSTs to a Grok Bot webhook trigger when the person points an agent that
 * is not calling, so the bot starts a run and reads the pin with get_current_view. The hub learns of the pin from the
 * app's ring (`@tineira/apc-server` ring.ts), from the browser extension's reading, or from a pairing turning paired.
 *
 * Pure parts only (checks, limits, outcomes); the state lives in the hub (hub.ts).
 */
import { productOf } from "../../../demo/src/model/products.ts";
import { RING_NONCE, RING_SIG, RING_WINDOW_MS } from "@tineira/apc-server";
import { WAKE_DAY_MAX, WAKE_GAP_MS, WAKE_ROUTINE_NAME, WAKE_ROUTINE_PROMPT } from "../wake-shared.ts";

export { WAKE_DAY_MAX, WAKE_GAP_MS, WAKE_ROUTINE_NAME, WAKE_ROUTINE_PROMPT };

/** The one product a webhook may be set for, and is sent for. */
export const WAKE_PRODUCT = "grok-bot";
/** The only webhook shape the dock calls: Grok Bot's automation trigger. */
export const WAKE_URL = /^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[A-Za-z0-9_-]{8,128}$/;
/** The trigger's key: printable ASCII, no spaces. */
export const WAKE_KEY = /^[\x21-\x7e]{16,512}$/;
/** After a pin, the dock waits this long before it wakes the agent: a call already under way may take the pin. */
export const WAKE_SETTLE_MS = 2_000;
/** While a call or an app wait of the agent is in flight, the wake is put off this long, again and again... */
export const WAKE_DEFER_MS = 3_000;
/** ...for at most this long after the pin: then it goes anyway. */
export const WAKE_DEFER_MAX_MS = 60_000;
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

/**
 * The tool a Grok bot agent gets from the hub (TIN-967): how to set up Wake on pin itself. It takes no input and never
 * returns or asks for the webhook's URL or key, which only the person sees in Grok Bot and pastes into the dock page.
 */
export const WAKE_TOOL = {
  name: "wake_on_pin",
  title: "Set up Wake on pin (Grok Bot)",
  description:
    "For Grok Bot: lets the dock start a run of yours when the person points you while you are not working, so you answer without being asked. Returns whether it is on, and while it is off the routine to create (a routine with a webhook trigger, whose instructions it gives) and paste_at: the dock page where the person pastes that routine's webhook URL and key. Never ask the person for the URL or the key in chat: they paste them into the dock themselves.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
} as const;

/** The line the hub adds to its instructions for a Grok bot agent while no webhook is set. */
export const WAKE_HINT =
  "You are Grok Bot: this dock can wake you when the person points you while you are not working. Offer it to the person once; if they agree, call wake_on_pin and follow what it returns. Never ask for the webhook's URL or key in chat.";

/** What wake_on_pin answers: on, or off with the routine to create; never the URL or the key. */
export function wakeSetup(on: boolean, status: string | null, pasteAt: string): Record<string, unknown> {
  if (on) {
    return {
      wake: "on",
      status,
      paste_at: pasteAt,
      note: "Wake on pin is on: the dock wakes you when the person points you while you are not working. Nothing to set up. To change or turn it off, the person opens paste_at.",
    };
  }
  return {
    wake: "off",
    routine: { name: WAKE_ROUTINE_NAME, trigger: "webhook", instructions: WAKE_ROUTINE_PROMPT },
    paste_at: pasteAt,
    steps: [
      `Create a routine named "${WAKE_ROUTINE_NAME}" with a webhook trigger (not a schedule) and routine.instructions as its instructions.`,
      "Tell the person where in Grok Bot they find that routine's webhook URL and key.",
      "Ask them to open paste_at, paste the URL and the key under Wake on pin, Save, and press Send a test.",
    ],
    note: "You never see the webhook's key, and must not ask for it: the person copies it from Grok Bot into the dock page.",
  };
}
