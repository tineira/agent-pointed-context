/**
 * The core of APC: what every APC app implements, whichever way agents reach it.
 *
 * An app offers one profile or both:
 *
 * - **Direct**: the agent connects to the app's own MCP URL, one per agent. The connection (a grant
 *   per agent, its secret MCP URL, the agent list where the person makes and names them) is the
 *   profile's, not the core's.
 * - **Dock**: the agent connects once, to a hub (the dock), which reaches the app with a grant the
 *   app gave it. Receiving the drop (`application/x-apc-agent`, the handle and the ticket), consent
 *   in the app, pairing (`POST {hub}/apc/pair`), the check on every drop (`POST {hub}/apc/confirm`)
 *   and the hub giving a grant back (`POST {app}/apc/revoke`) are the profile's, not the core's.
 *
 * The core is the same on both, and per grant: the hub is one more holder of a grant.
 *
 * 1. **The view**: what the person sees, as identifiers (`ViewPayload`), trimmed to the grant.
 * 2. **The pin**: the person drops the agent's mark on a target (`FocusTarget`); the app keeps one
 *    pin per grant (`FocusRow`) and gives it as `FocusPayload`, with `next` and `next_args`, the
 *    call that reads it. While the pin is unread, every tool result carries `attention`.
 * 3. **Presence**: after each successful tool call the app publishes a `PresenceEvent` (ids only) to
 *    the person's page; a read of a target names it in `targets`.
 * 4. **The focus format**: `FocusPayload`, from the grammar in `target.ts`.
 * 5. **`get_current_view` and `wait_for_focus`**, the two core tools (`CORE_TOOLS`), with the loop
 *    hint `then` while a page of the person's is open.
 * 6. **Revoke from the app**: the person can cut any agent from the app itself, at once, without the
 *    hub (`RevokedAnswer`).
 *
 * `@apc/conformance` checks an app against this core, given its MCP endpoint and a small adapter for
 * what happens in the page.
 */
import type { FocusPayload, ViewPayload } from "./types.ts";

/** How an agent reaches an app. An app offers one or both; the core is the same on each. */
export type ApcProfile = "direct" | "dock";

/** The two tools every APC app exposes, on every grant. */
export const CORE_TOOLS = ["get_current_view", "wait_for_focus"] as const;
export type CoreTool = (typeof CORE_TOOLS)[number];

/** The key an unread pin puts on every tool result (structured and in the text): `{ focus, note }`. */
export const ATTENTION_KEY = "attention";
/**
 * The loop hint: present on a result while a page of the person's is open and they share their view,
 * except on a `wait_for_focus` that came back with no focus (that one ends the loop).
 */
export const THEN_KEY = "then";

/** `get_current_view`: the screen and, if the person pointed the agent, the focus. Reading the focus marks it seen. */
export interface CurrentViewResult {
  view: ViewPayload | null;
  focus: FocusPayload | null;
}

/**
 * `wait_for_focus({ timeout_s })`: holds the call until the person pins the agent or `timeout_s`
 * passes (1 to the app's ceiling). A pin dropped during the wait is returned, marked seen. With no
 * pin: `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app
 * knows the person's page is closed. `page_open` is left out while the person does not share their
 * view (an app without that switch always shares).
 */
export type WaitForFocusResult = WaitGotFocus | WaitNoFocus;
export interface WaitGotFocus {
  focus: FocusPayload;
  timed_out: false;
}
export interface WaitNoFocus {
  focus: null;
  timed_out: boolean;
  page_open?: boolean;
  note: string;
}

/**
 * Revoke from the app. Every agent in the app's agent bar, Direct or Dock, has Revoke, and it holds
 * in the app alone:
 *
 * - It takes effect at once: the grant, its pin and (Dock) the app's link to the hub go. The app
 *   calls nobody, so it works with the hub down.
 * - From then on every request to the grant's MCP URL, whatever the method, is answered with HTTP
 *   `REVOKED_HTTP_STATUS` (403) and a `RevokedAnswer` body. A call already running when the grant is
 *   revoked ends as a tool error whose `error` is `"revoked"`, with no app data. An unknown or
 *   expired grant stays 404, so the holder can tell "taken back" from "gone".
 * - A revoked grant never works again. To let the agent back, the person makes a new grant: a new
 *   MCP URL (Direct), or a new drop, with consent in the app and in the dock (Dock).
 * - A hub that gets a `RevokedAnswer` marks that pairing revoked ("Revoked by <app host>"), stops
 *   relaying to it, drops what it kept from it (its view and the pin it took), and never pairs it
 *   again by itself.
 */
export const REVOKED_ERROR = "revoked";
export const REVOKED_HTTP_STATUS = 403;

export interface RevokedAnswer {
  error: typeof REVOKED_ERROR;
  /** The host of the app that revoked the grant, e.g. "pulse.example". */
  revoked_by: string;
  revoked_at: string;
  message: string;
}

export function revokedAnswer(host: string, revokedAt: string): RevokedAnswer {
  return {
    error: REVOKED_ERROR,
    revoked_by: host,
    revoked_at: revokedAt,
    message: `The person revoked this agent's access in the app at ${host}. It does not come back: to reconnect, the person makes a new grant there.`,
  };
}

export function isRevokedAnswer(body: unknown): body is RevokedAnswer {
  const b = body as Partial<RevokedAnswer> | null;
  return !!b && typeof b === "object" && b.error === REVOKED_ERROR && typeof b.revoked_by === "string";
}
