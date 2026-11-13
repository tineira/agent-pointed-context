/**
 * The core of APC: what every APC app implements, whichever way agents reach it.
 *
 * An app offers one profile or both:
 *
 * - **Direct**: the agent connects to the app's own MCP endpoint. The connection (a grant per agent,
 *   how the agent authenticates, the agent list where the person makes and names them) is the
 *   profile's, not the core's. Since APC 0.8 the standard does not fix how the agent authenticates:
 *   any binding that meets `GrantRequirement` will do. The reference apps' binding is the secret URL
 *   (one MCP URL per grant, `newDirectGrant` in `@tineira/apc-server`); OAuth (one MCP URL shared by
 *   every grant, the bearer token naming the grant) is another.
 * - **Dock**: the agent connects once, to a hub (the dock), which reaches the app with a grant the
 *   app gave it. Receiving the drop (`application/x-apc-agent`, the handle and the ticket), consent
 *   in the app, pairing (`POST {hub}/apc/pair`), the check on every drop (`POST {hub}/apc/confirm`)
 *   and the hub giving a grant back (`POST {app}/apc/revoke`) are the profile's, not the core's.
 *   Consent in the app is the app's server's to check (APC 0.7), never the page's alone: the server makes
 *   a grant for a dock agent it holds none for only on a request that proves the person allowed it on the
 *   app's page just now (the reference apps: a single-use nonce the page shows its consent with,
 *   `DockConsent` in `@tineira/apc-server`), whatever the page last loaded. A page that missed a revoke must not
 *   pair without asking. Since APC 0.9 the consent shows a pairing code, and the dock's Allow requires it
 *   (`PAIRING_CODE_LENGTH`, below). Since APC 0.10 a dock grant has states (in flight, handoff, live,
 *   dormant, ended, revoked) that say what it answers, and the hub and the app have MUSTs around the hub
 *   call (`dock.ts`).
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
 *    hint `then` while a page of the person's is open and the grant was pinned lately (APC 0.8), at most
 *    one delivering wait per grant (APC 0.8), and a pin marked seen only once the result that carries
 *    it is final (APC 0.8): an app may deliver a pin twice, never lose one.
 * 6. **Revoke from the app**: the person can cut any agent from the app itself, at once, without the
 *    hub (`RevokedAnswer`).
 * 7. **`apc_link`** (an app that offers both profiles): the same agent on both paths shown as one,
 *    with a one-time code; it grants nothing (`ApcLinkOffer`).
 * 8. **`apc.json`** (APC 0.5): what the app is, at `GET {origin}/.well-known/apc.json`: its name, the
 *    standard, its origin, its profiles, where its MCP URLs live, its connect page (`manifest.ts`).
 * 9. **Mobile** (APC 0.6): on a phone or any touch viewport (`APC_MOBILE_MEDIA`) the app shows its agents
 *    in its own page, on both profiles (below).
 *
 * `@tineira/apc-conformance` checks an app against this core, given its MCP endpoint and a small adapter for
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
 * The loop hint. Since APC 0.8 it is present on a result only while both hold: a page of the person's
 * is open (and they share their view), and the grant was pinned within the app's window
 * (`THEN_PIN_WINDOW_MIN`, 30 minutes unless the app sets its own). An open page with no recent pin gives
 * no `then`, so an agent does not wait after every answer. It is never on a `wait_for_focus` that came
 * back with no focus (that one ends the loop).
 *
 * The agent is told (in the instructions, the guide, the note and the tool's description) to run the
 * wait in the background if its client can (a background subagent, say), and otherwise to keep it short
 * and never chain waits.
 */
export const THEN_KEY = "then";
/** The default `then` window, in minutes: the grant's pin, read or unread, is at most this old. An app may set its own. */
export const THEN_PIN_WINDOW_MIN = 30;

/**
 * `get_current_view`: the screen and, if the person pointed the agent, the focus. Returning the focus
 * marks it seen, once the result is final (APC 0.8, `WaitForFocusResult`).
 *
 * **Unavailable (APC 0.8).** When the app cannot answer a core tool just now (its store is down, a check
 * cannot run), the tool still answers in its own shape, with nothing in it and a `note` for the agent:
 * `{ view: null, focus: null, note }` here, `{ focus: null, timed_out: false, page_open: false, note }`
 * from `wait_for_focus`. Never a tool error or an `{ ok, reason }` of the app's own. A revoked grant is not
 * unavailable: it answers `RevokedAnswer`.
 *
 * **Trim, never fail (APC 0.8).** A check on one item of the answer (a filter, the selection, the pin)
 * that cannot run hides that item, and the rest still answers. It never fails the read open (the item
 * shown unchecked), and a defect in one check (a missing column, a value it cannot parse) never fails
 * the read whole. A failure that concerns the grant itself (its auth, an expired session) still fails it
 * closed.
 */
export interface CurrentViewResult {
  view: ViewPayload | null;
  focus: FocusPayload | null;
  /** Why the result is empty, when the app could not answer it just now (APC 0.8). */
  note?: string;
  /**
   * The grant is dormant (Dock profile, APC 0.10, `idleCurrentView`): the person is away from the app, which
   * answers no data until they come back. Distinct from unavailable, page closed and revoked. An answer
   * without it (an app before 0.10) reads as unavailable, as before.
   */
  idle?: true;
}

/**
 * `wait_for_focus({ timeout_s })`: holds the call until the person pins the agent or `timeout_s`
 * passes (1 to the app's ceiling). A pin dropped during the wait is returned, marked seen. With no
 * pin: `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app
 * knows the person's page is closed. `page_open` is left out while the person does not share their
 * view (an app without that switch always shares). The default timeout is the app's: 25 to 45 s suits
 * a conversation (`WAIT_DEFAULT_S` in `@tineira/apc-server` is 25), bounded by what its host can hold.
 *
 * **One wait per grant (APC 0.8).** At most one wait of a grant delivers. A new wait takes over: the one
 * it replaces ends at its next check with `focus: null, timed_out: false` and a note, delivers nothing,
 * and never marks a pin seen. A new wait that starts within `WAIT_CLAIM_GAP_S` of one still running is
 * refused instead, with `focus: null, timed_out: false, retry_after_s` and a note: two waits fired
 * together would otherwise take over from each other in a loop. A wait whose request the client cancels
 * stops and frees its place at once: MCP's `notifications/cancelled` (which, to a stateless server, comes
 * in a POST of its own: the app keeps the calls in flight per grant to find the one it names,
 * `InflightCalls` in `@tineira/apc-server`), and an HTTP abort where the host reports one (on Cloudflare
 * Workers, `request.signal` with the `enable_request_signal` flag, or a compatibility date from 2026-11-17).
 *
 * **Seen once delivered (APC 0.8).** Checking for a pin, or polling for one, never marks it seen:
 * only returning it does. An app marks a pin seen only once the result that carries it is final (in a
 * wait, after it gave its place up and checked one last time that its request was not cancelled), and
 * marks that exact pin (by its `pinned_at`), never a newer one dropped meanwhile. It returns the result
 * whether or not the mark succeeds. So a pin may be delivered twice, and is never lost to a wait that was
 * taken over or cancelled, or to a newer pin. MCP has no acknowledgement: a result lost after the app sent
 * it (the connection dropped with no abort the app could see) is not something an app can tell, and that
 * pin is marked seen. A hub that relays a wait holds the pin it was handed: it keeps it unread until its
 * own agent gets it.
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
  /** On a wait refused because another wait of the grant started just before it (APC 0.8): when to try again. */
  retry_after_s?: number;
  /**
   * The grant is dormant (Dock profile, APC 0.10, `idleWaitForFocus`): answered at once with `timed_out: false,
   * page_open: false`. A hub never reads it as page closed and never ends its own wait on it. An answer
   * without it (an app before 0.10) reads as page closed or unavailable, as before.
   */
  idle?: true;
  note: string;
}

/** How soon after one wait of a grant another is refused rather than taking over, in seconds (APC 0.8). */
export const WAIT_CLAIM_GAP_S = 2;

/**
 * What a Direct grant must be, whatever way the agent authenticates (APC 0.8). The standard does not fix
 * the binding (a secret MCP URL, OAuth, an API key, mTLS); any binding that meets these will do:
 *
 * - `stable_id`: **a stable id per agent connection.** Pins, views, presence and `apc_link` are keyed by it.
 * - `revocable_in_app`: **revocable from the app alone.** The app revokes it in its own store, calling
 *   nobody, and checks it on every request, and before and after each tool call. Revoking ends everything
 *   that could bring the grant back without the person: with OAuth, the refresh tokens and the
 *   authorization behind it too, so a client that answers a 401 by refreshing or re-authorizing silently
 *   gets nothing. The person lets the agent back with a new grant.
 * - `revoked_told_apart`: **revoked is told apart from expired or unknown**, with a `RevokedAnswer` body,
 *   so the agent tells the person and stops retrying, where an expired credential may just be renewed.
 * - `trimmed_per_grant`: **pointing grants no access.** What a grant may read is trimmed per grant; a pin
 *   never widens it.
 *
 * Two bindings are described:
 *
 * - **The secret URL** (the reference apps; `newDirectGrant` and `directMcpUrl` in `@tineira/apc-server`):
 *   one MCP URL per grant, under `apc.json`'s `mcp.path`; whoever holds the URL holds the grant. Revoked is
 *   HTTP 403 with `RevokedAnswer`; an unknown or expired grant is 404.
 * - **OAuth 2.1**: one MCP URL shared by every grant, the bearer token naming the grant. Revoked is HTTP
 *   401 with `WWW-Authenticate: Bearer error="invalid_token"` and the `RevokedAnswer` body, so the client
 *   tells "taken back by the person" from "expired" and does not just authorize again.
 *
 * On a host with no long-lived process (stateless functions and a database), an app still bounds
 * `wait_for_focus` by its function's time limit (its own ceiling for `timeout_s`), tells a closed page from
 * a heartbeat the page sends, and checks the grant before and after each tool call.
 */
export type GrantRequirement = "stable_id" | "revocable_in_app" | "revoked_told_apart" | "trimmed_per_grant";
export const GRANT_REQUIREMENTS: readonly GrantRequirement[] = ["stable_id", "revocable_in_app", "revoked_told_apart", "trimmed_per_grant"];

/**
 * Revoke from the app. Every agent in the app's agent bar, Direct or Dock, has Revoke, and it holds
 * in the app alone:
 *
 * - It takes effect at once: the grant, its pin and (Dock) the app's link to the hub go. The app
 *   calls nobody, so it works with the hub down.
 * - From then on every request with the grant, whatever the method, is answered with a `RevokedAnswer`
 *   body. The HTTP status is the binding's (APC 0.8, `GrantRequirement`): `REVOKED_HTTP_STATUS` (403)
 *   with a secret URL, `REVOKED_HTTP_STATUS_BEARER` (401, with `WWW-Authenticate: Bearer
 *   error="invalid_token"`) with OAuth. A call already running when the grant is revoked ends as a tool
 *   error whose `error` is `"revoked"`, with no app data. An unknown or expired grant is answered without
 *   a `RevokedAnswer` (404 with a secret URL; a plain 401 with OAuth), so the holder can tell "taken back"
 *   from "gone". Whether a grant was revoked is told by the grant itself (its secret or token), never by
 *   an id a later grant may reuse (0.7).
 * - A revoked grant never works again. To let the agent back, the person makes a new grant: a new
 *   MCP URL (Direct), or a new drop, with consent in the app and in the dock (Dock).
 * - A hub that gets a `RevokedAnswer` marks that pairing revoked ("Revoked by <app host>"), stops
 *   relaying to it, drops what it kept from it (its view and the pin it took), and never pairs it
 *   again by itself.
 */
export const REVOKED_ERROR = "revoked";
/** The status of a revoked grant with the secret-URL binding. */
export const REVOKED_HTTP_STATUS = 403;
/** The status of a revoked grant with a bearer token (OAuth), with `WWW-Authenticate: Bearer error="invalid_token"` (APC 0.8). */
export const REVOKED_HTTP_STATUS_BEARER = 401;

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

/**
 * Mobile (APC 0.6). On a phone there is no dock window, browser extension or desktop pet to drag an
 * agent from, so the agent in the app's own page is the only way the person can point it (give it
 * focus). So, in a viewport that matches `APC_MOBILE_MEDIA`, on both profiles:
 *
 * - **The agents are shown in the page**, all of them, each with its mark visible and usable for
 *   pinning. This holds whatever the app's profiles, and whatever the agent bar does elsewhere: the
 *   Dock profile's rule that the bar may collapse to a small indicator does not apply, and the bar is
 *   never hidden or collapsed. It stays reachable while the page scrolls, without covering content
 *   the person needs.
 * - **The person can pin with a finger, with no mouse drag.** Browsers on phones do not do HTML5
 *   drag and drop, so the app takes a touch alternative: touching the agent's mark and then a target
 *   ("tap to pin": a clear state, a way to cancel), or dragging the mark with a finger with pointer
 *   events. The result is the same pin (`FocusTarget`) as a mouse drag. Removing the pin (unpin) and
 *   Revoke work by touch too, with targets large enough for a finger.
 *
 * `APC_MOBILE_VIEWPORT` is the reference viewport the conformance suite and the apps are checked at.
 */
export const APC_MOBILE_MEDIA = "(pointer: coarse), (max-width: 640px)";
export const APC_MOBILE_VIEWPORT = { width: 375, height: 812 } as const;

/**
 * The pairing code (Dock profile, APC 0.9). A drag can be put on a page by anyone: whoever runs a dock can
 * mint tickets for their own agent and lure the app's owner into a drop and an Allow. So a pairing is
 * approved in the dock only with a code that only the app's owner sees.
 *
 * - **The app makes it** with its consent nonce: `PAIRING_CODE_LENGTH` characters of `PAIRING_CODE_ALPHABET`
 *   (Crockford base32, 30 bits), new for every consent (`newPairingCode` and `DockConsent` in
 *   `@tineira/apc-server`), and shows it on its consent card, formatted `K7M-4P2` (`formatPairingCode`). After
 *   the Allow, the app sends it raw (`K7M4P2`) in `pairing_code` of `POST {hub}/apc/pair` (`DockPairRequest`).
 *   An app that implements 0.9 **must** send it. It never goes anywhere else: not over MCP, not in a URL,
 *   not to `/apc/confirm`.
 * - **The hub keeps it** with the pending pairing, never shows it (not in the dock's state, not in a
 *   broadcast, not in any answer) and answers a pairing that carries one with `pairing_code: "required"`
 *   (`PAIRING_CODE_ACK`, `DockPairAnswer`). It checks the body before it spends the ticket: a `pairing_code`
 *   that is present but does not normalize (`null`, `""`, a number) is `invalid_pairing_code`. Only an absent
 *   key is a pairing without a code (an app from before 0.9); a hub may refuse those too
 *   (`pairing_code_required`).
 * - **The dock owner types it** to approve: the hub compares it, in constant time, with the one the app sent.
 *   A wrong one counts; after `PAIRING_CODE_MAX_ATTEMPTS` the request goes and the grant is given back
 *   (`pairing_code_refused`). A request with a code that nobody approves goes after `PAIRING_CODE_TTL_MS`, its
 *   grant given back. A match clears the code. Deny and unpair need no code.
 * - **The app keeps a grant only on the acknowledgement**: a non-redirected HTTP 200 with `ok: true`,
 *   `pairing_code: "required"` and a string `pairing_id` (`pairWithHub` in `@tineira/apc-server`). Anything
 *   else (another status, a redirect, a missing acknowledgement, no answer) and the app deletes the grant
 *   before it answers its page: a hub that does not check codes never holds a grant (`hub_ignores_pairing_code`).
 *
 * The drag's ticket lives `TICKET_TTL_MS` (240 s since 0.9; 60 s before), longer than the app's consent, so
 * the person has the time to read the card.
 */
export const PAIRING_CODE_LENGTH = 6;
/** Crockford base32: no I, L, O or U, so a code reads out loud without doubt. */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** How long a pending pairing with a code waits for the dock owner, from `/apc/pair`. */
export const PAIRING_CODE_TTL_MS = 120_000;
/** Wrong codes a hub takes for one pairing; the last one removes it. */
export const PAIRING_CODE_MAX_ATTEMPTS = 5;
/** What a hub that keeps the code answers in `pairing_code`. */
export const PAIRING_CODE_ACK = "required";
/** How long a drag's ticket works (APC 0.9: 240 s). */
export const TICKET_TTL_MS = 240_000;

/** Why a hub refuses a pairing or an approval over its code. */
export type PairingCodeError = "invalid_pairing_code" | "pairing_code_required" | "wrong_pairing_code" | "pairing_code_refused";
/** Why an app did not keep a grant after asking a hub to pair (`pairWithHub`), when the hub gave no reason of its own. */
export type HubCallError = "hub_unreachable" | "hub_refused" | "hub_ignores_pairing_code";

/**
 * A code as typed or sent, made canonical: case, spaces and dashes are ignored, O reads as 0 and I or L as 1.
 * Null unless the result is `PAIRING_CODE_LENGTH` characters of `PAIRING_CODE_ALPHABET`.
 */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const c of code) if (!PAIRING_CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** How a code is shown to a person: `K7M4P2` as `K7M-4P2`. For display only; the wire and storage keep it raw. Anything that is not a code is returned untouched, never shaped like one. */
export function formatPairingCode(code: string): string {
  const raw = normalizePairingCode(code);
  return raw ? `${raw.slice(0, 3)}-${raw.slice(3)}` : code;
}

/** Whether two normalized codes are the same, in time that does not depend on where they differ. */
export function pairingCodesMatch(expected: string, given: string): boolean {
  if (expected.length !== PAIRING_CODE_LENGTH || given.length !== PAIRING_CODE_LENGTH) return false;
  let diff = 0;
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** `POST {hub}/apc/pair`: what an app sends after the person's Allow (Dock profile). `pairing_code` is raw, 6 characters. */
export interface DockPairRequest {
  ticket: string;
  agent: string;
  app: { name: string; origin: string };
  mcp_url: string;
  /** Required of an app that implements 0.9; absent only from an app before it. */
  pairing_code?: string;
}

/** The hub's answer to `/apc/pair`: HTTP 200 with the acknowledgement, or HTTP 400 with the reason. */
export type DockPairAnswer =
  | { ok: true; pairing_id: string; status: "pending"; agent: { name: string; icon: string | null }; pairing_code: typeof PAIRING_CODE_ACK }
  | { ok: false; error: string };

/** The other path: Direct for Dock and Dock for Direct. */
export function oppositePath(path: ApcProfile): ApcProfile {
  return path === "direct" ? "dock" : "direct";
}

/**
 * `apc_link` (APC 0.4): the same agent, connected to one app both ways (its own MCP URL, Direct, and
 * through a dock's hub, Dock), shown as one agent in the app's agent bar.
 *
 * - **The offer.** When a connection arrives (`initialize`) with the same MCP client as one already
 *   connected on the opposite path to the same app, the app puts `apc_link: { code, expires_in, note }`
 *   (`ApcLinkOffer`) on a result of that new connection: a top-level key of the structured result and
 *   of the text, like `attention`. On the Dock path it rides on a result of one of the app's own tools,
 *   not a core tool (the hub merges those into its own results). The app asks at most once per MCP
 *   session (from one `initialize` to the next): an agent that does not answer, or answers late, is not
 *   asked again in that session, and stays two entries.
 * - **The answer.** The agent calls the tool `apc_link({ code })` (`APC_LINK_TOOL`) on its *other*
 *   connection to the same app: directly, or through the dock as `<app>__apc_link`. The app links the
 *   two grants and answers `ApcLinkDone`, or refuses with a tool error, `ApcLinkRefused`.
 * - **The code** is random (at least 96 bits), works once, expires after `expires_in` seconds
 *   (`APC_LINK_TTL_S`), and is redeemed only by a different connection to the same app, on the opposite
 *   path, among those the app offered it to (the same MCP client, not already linked). Anything else is
 *   refused with a reason (`ApcLinkRefusal`). The app keeps only a hash of it.
 * - **Linking grants nothing.** Each path keeps its own grant, trimming and pin; the link changes only
 *   what the agent bar shows: one agent with both paths. Revoke on a linked agent cuts both grants. The
 *   person can unlink from the bar, which removes the link and nothing else.
 * - **Which client it is.** On the Direct path, `clientInfo.name` of the agent's own `initialize`. On
 *   the Dock path the hub initializes the app as itself, so it names the agent's own MCP client in
 *   `params._meta[APC_AGENT_CLIENT_META]` of that `initialize`.
 */
export const APC_LINK_TOOL = "apc_link";
/** The key an offer puts on a result. */
export const APC_LINK_KEY = "apc_link";
/** How long a link code lives, in seconds. */
export const APC_LINK_TTL_S = 120;
/** On the Dock path: the `_meta` key of the hub's `initialize` that names the agent's own MCP client. */
export const APC_AGENT_CLIENT_META = "apc.tineira.com/agent_client";

export interface ApcLinkOffer {
  /** One-time; sent back with `apc_link({ code })` on the other connection. */
  code: string;
  /** Seconds left: `APC_LINK_TTL_S` when offered. */
  expires_in: number;
  /** What to do with it, for the agent. */
  note: string;
}

export interface ApcLinkDone {
  linked: true;
  note: string;
}

export const LINK_REFUSED_ERROR = "link_refused";
/**
 * Why a code was refused: `unknown_code` (no such code in this app), `expired`, `used` (it already
 * linked), `same_connection` (sent back on the connection that got it), `same_path` (on another
 * connection of the same path), `not_offered` (on a connection it was not offered to: another client,
 * or one not connected when it was offered), `already_linked` (one of the two is linked already).
 */
export type ApcLinkRefusal = "unknown_code" | "expired" | "used" | "same_connection" | "same_path" | "not_offered" | "already_linked";

export interface ApcLinkRefused {
  error: typeof LINK_REFUSED_ERROR;
  reason: ApcLinkRefusal;
  message: string;
}
