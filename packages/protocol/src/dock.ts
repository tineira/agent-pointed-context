/**
 * The Dock profile as built (APC 0.10, TIN-882): the states of a dock grant in the app, what each state
 * answers, the time limits, and what the hub and the app must do around the hub call.
 *
 * Before 0.10 the profile said how a pairing starts (consent, the code, `/apc/pair`) and not what a grant
 * answers between the Allow and the hub's first `initialize`. Apps filled the gap differently: one served
 * data between the hub's acknowledgement and `initialize`, two had no gate at all. 0.10 fixes it.
 *
 * **The binding stays the secret MCP URL** (whoever holds it holds the grant). The Dock's security is the
 * 0.9 pairing code plus that URL over TLS: there is no end-to-end encryption, and the hub sees what it
 * relays. The code gates the honest hub's approval, and that hub's `initialize` is the dock owner's yes
 * (H1); the code never gates the app's data path. Against a hub that breaks H1, or someone holding the
 * URL, the URL is the credential, as in 0.9: no app can detect a breach of H1, and hub conformance and the
 * operator's allowlist are the controls. Since 0.12 the binding (H8, M10 to M12; `bindingVerdict` in core.ts)
 * ties the hub's `initialize` to the app's own `/apc/pair` call for that agent, so a URL the app did not hand to
 * that pairing never goes live. It does not stop a drop's ticket being relayed through a real account on the
 * app; closing that is planned before 1.0.
 *
 * ## The grant's states, in order of precedence
 *
 * `revoked` > `ended` > `in_flight` > `handoff` > `dormant` > `live` (`DOCK_GRANT_STATES`): the first that
 * applies is the one used (`dockGrantStateOf`).
 *
 * - **`in_flight`**: from the Allow to the hub's 0.9 acknowledgement of `/apc/pair` (on a failure the grant
 *   ends before the page hears back). A grant still in flight `T_ACK_MAX_MS` after the Allow ends, whatever
 *   happened to the call (MUST).
 * - **`handoff`**: from the acknowledgement to the first `initialize` whose connection is committed.
 * - **`live`**: from that `initialize` to dormancy, revoke or end.
 * - **`dormant`** (SHOULD): `T_idle` after the last wake action, live grants only; until the next wake action.
 * - **`ended`**: `T_connect` after the acknowledgement with no committed `initialize` (MUST, at most
 *   `T_CONNECT_MAX_MS`); a give-back (`POST {app}/apc/revoke`); long dormancy (`LONG_DORMANCY_RECOMMENDED_MS`).
 * - **`revoked`**: the owner's Revoke, or Cancel on the waiting card.
 *
 * What each state answers, per method, is `dockGrantAnswer` (MUST wherever the state is implemented). No
 * answer in `handoff` or `dormant` carries `attention`, `then`, an `apc_link` offer, or a presence event.
 *
 * ## The rules on the transitions
 *
 * - **`initialize` fails closed.** It MUST NOT return a result unless the move out of handoff has committed;
 *   on a persistence failure it answers JSON-RPC -32603 or HTTP 500, so the hub's introduction fails visibly.
 *   The commit is conditional on the grant being neither revoked nor ended, in the same atomic step: if
 *   Cancel or an end won the race, `initialize` answers by the state that won (`RevokedAnswer` or 404).
 * - **The acknowledgement's move** from in_flight to handoff is conditional the same way: on the grant being
 *   neither ended (by a give-back or `T_ack`) nor revoked, in the same atomic step.
 * - **A served call** is a `tools/call` that returned app data in the live state. `ping`, `tools/list`,
 *   `initialize` and the `pairing` and `idle` errors are not served calls.
 * - **Wake actions** are authenticated actions of the grant's own user on the app's page: a page heartbeat
 *   (MUST be sent at least every `T_idle / 2` while the page is open), or a confirmed drop. Agent traffic
 *   (`initialize`, `ping`, `tools/list`, `tools/call`) never wakes a grant and never extends it.
 * - **Cancel revokes**: afterwards the grant answers `RevokedAnswer`. It is allowed only in handoff, before
 *   any served call; the check and the revoke are one atomic step, and every tool handler re-checks revoke
 *   after its work and before it returns data (as 0.8 already requires).
 */
import type { IdleCurrentView, IdleWaitForFocus } from "./core.ts";

/** A dock grant's state in the app (APC 0.10). */
export type DockGrantState = "revoked" | "ended" | "in_flight" | "handoff" | "dormant" | "live";
/** The states in order of precedence: the first that applies is the one used. */
export const DOCK_GRANT_STATES: readonly DockGrantState[] = ["revoked", "ended", "in_flight", "handoff", "dormant", "live"];

/**
 * The state a grant is in, given the states that apply to it: the first in `DOCK_GRANT_STATES` that does.
 * A grant to which none of the others applies is `live`.
 */
export function dockGrantStateOf(applies: Partial<Record<DockGrantState, boolean>>): DockGrantState {
  for (const state of DOCK_GRANT_STATES) if (applies[state]) return state;
  return "live";
}

/**
 * The longest a grant may stay in flight after the Allow (APC 0.10): it MUST end once in flight this long.
 * More than the hub call's own deadline (`HUB_CALL_DEADLINE_MS`), so an answer that comes in time is kept.
 */
export const T_ACK_MAX_MS = 30_000;
/** The longest a grant may wait in handoff, from the acknowledgement, for a committed `initialize` (APC 0.10): it MUST end then. */
export const T_CONNECT_MAX_MS = 10 * 60_000;
/**
 * The recommended `T_idle` (APC 0.10): a live grant with no wake action this long goes dormant (SHOULD). The
 * page's heartbeat MUST come at least every `T_idle / 2` while the page is open.
 */
export const T_IDLE_RECOMMENDED_MS = 30 * 60_000;
/** The recommended long dormancy (APC 0.10): a grant dormant this long ends. */
export const LONG_DORMANCY_RECOMMENDED_MS = 30 * 24 * 60 * 60_000;
/** The app's one deadline for a hub call, headers and the whole body (M3, APC 0.10): at most 10 s. */
export const HUB_CALL_DEADLINE_MS = 10_000;
/** The most of a hub's answer an app reads (M4, APC 0.10): 8 KiB. */
export const HUB_ANSWER_MAX_BYTES = 8192;
/** The longest a copy of an app's `apc.json` may be cached for a pairing decision, by the app (M8) or the hub (H7), in seconds. */
export const APC_JSON_PAIRING_MAX_AGE_S = 60;

/** The tool error of a grant in handoff: the person has not finished pairing yet. */
export const PAIRING_ERROR = "pairing";
/** The tool error of a dormant grant, for a tool that is not a core tool: the person is away from the app. */
export const IDLE_ERROR = "idle";
export type DockGrantError = typeof PAIRING_ERROR | typeof IDLE_ERROR;

/**
 * A grant's tool error in handoff or dormant (APC 0.10): `{ error, message }`, carried in both
 * `structuredContent` and `content[0].text` (as JSON), with `isError: true`. On a method other than
 * `tools/call` it is JSON-RPC error `DOCK_GRANT_RPC_ERROR_CODE` with this as its `data`.
 */
export interface DockGrantErrorAnswer {
  error: DockGrantError;
  message: string;
}
/** The JSON-RPC error code of a grant in handoff or dormant, on a method other than `tools/call` (`resources/*`, `prompts/*`). */
export const DOCK_GRANT_RPC_ERROR_CODE = -32000;

/** What the agent is told by a grant in handoff. The hub's instructions say: wait, or tell the person. */
export const PAIRING_MESSAGE = "The person has not finished pairing this app with their dock yet. Wait, or tell them.";
/** What the agent is told by a dormant grant. The hub's instructions say: tell the person, and do not retry. */
export const IDLE_MESSAGE = "The person is away from this app, so it is asleep. It wakes when they open it again: tell them, and do not retry.";

export function pairingAnswer(message: string = PAIRING_MESSAGE): DockGrantErrorAnswer {
  return { error: PAIRING_ERROR, message };
}
export function idleAnswer(message: string = IDLE_MESSAGE): DockGrantErrorAnswer {
  return { error: IDLE_ERROR, message };
}

/** `get_current_view` of a dormant grant (MUST for an app that sleeps): no data, and `idle: true`. */
export function idleCurrentView(note: string = IDLE_MESSAGE): IdleCurrentView {
  return { view: null, focus: null, idle: true, note };
}
/** `wait_for_focus` of a dormant grant (MUST for an app that sleeps): no focus, at once, and `idle: true`. */
export function idleWaitForFocus(note: string = IDLE_MESSAGE): IdleWaitForFocus {
  return { focus: null, timed_out: false, page_open: false, idle: true, note };
}

/**
 * Whether an answer says the grant is asleep: the `idle` tool error (`{ error: "idle", message }`), or a core
 * tool's idle shape (`idle: true` with a `note`). An answer without `idle` (from a 0.9 app) is not idle: it
 * reads as unavailable or page closed, as before.
 */
export function isIdleAnswer(body: unknown): body is DockGrantErrorAnswer | IdleCurrentView | IdleWaitForFocus {
  if (!body || typeof body !== "object") return false;
  const b = body as { error?: unknown; message?: unknown; idle?: unknown; note?: unknown };
  return (b.error === IDLE_ERROR && typeof b.message === "string") || (b.idle === true && typeof b.note === "string");
}
/** Whether an answer is the `pairing` tool error (`{ error: "pairing", message }`): the grant is in handoff. */
export function isPairingAnswer(body: unknown): body is DockGrantErrorAnswer {
  if (!body || typeof body !== "object") return false;
  const b = body as { error?: unknown; message?: unknown };
  return b.error === PAIRING_ERROR && typeof b.message === "string";
}

/** What reaches a dock grant, as the answer table splits it. */
export type DockGrantCall = "initialize" | "ping" | "tools/list" | "core_tool" | "app_tool" | "other_method" | "notification";

/**
 * Classifies a JSON-RPC message, as received, for `dockGrantAnswer`. A message with no `id` member, or any
 * `notifications/*` method, is a notification. A `tools/call` names its tool in `params.name`: a core tool
 * (`get_current_view`, `wait_for_focus`) or any other.
 */
export function dockGrantCallOf(message: { method: string; id?: string | number | null; params?: unknown }): DockGrantCall {
  if (message.id === undefined || message.method.startsWith("notifications/")) return "notification";
  if (message.method === "initialize" || message.method === "ping" || message.method === "tools/list") return message.method;
  if (message.method === "tools/call") {
    const tool = message.params && typeof message.params === "object" ? (message.params as { name?: unknown }).name : undefined;
    return tool === "get_current_view" || tool === "wait_for_focus" ? "core_tool" : "app_tool";
  }
  return "other_method";
}

/**
 * How a grant answers, per state and call (APC 0.10, MUST wherever the state is implemented):
 *
 * - `serve`: as 0.8. `wakes` is always false: agent traffic never wakes a dormant grant or extends one, so
 *   `initialize` in dormant is served and the grant stays dormant. `commits` is true only for `initialize` in
 *   handoff: that answer commits the connection (the grant goes live), and only if, in the same atomic step,
 *   the grant is still in handoff (neither revoked nor ended); otherwise `initialize` answers by the state
 *   that won (`RevokedAnswer` or 404). It returns no result until the commit is durable.
 * - `not_found`: HTTP 404, and the state is unchanged.
 * - `revoked`: 403 (secret URL) with `RevokedAnswer`, as 0.8.
 * - `tool_error`: the tool error `{ error, message }` (`DockGrantErrorAnswer`).
 * - `rpc_error`: JSON-RPC `DOCK_GRANT_RPC_ERROR_CODE`, with `data: { error, message }`.
 * - `idle_shape`: the core tool's idle shape (`idleCurrentView`, `idleWaitForFocus`).
 * - `ignored`: HTTP 202, nothing done.
 *
 * | Call | in_flight | handoff | live | dormant | ended | revoked |
 * |---|---|---|---|---|---|---|
 * | any request (a `GET`, a `DELETE`, one that does not parse, too) | 404, state unchanged | rows below | rows below | rows below | 404 | revoked |
 * | `initialize` | 404 | serve, commits | serve | serve, no wake | 404 | revoked |
 * | `ping`, `tools/list` | 404 | serve | serve | serve | 404 | revoked |
 * | `tools/call` | 404 | tool error `pairing` | serve | core: idle shape; other: tool error `idle` | 404 | revoked |
 * | other methods | 404 | -32000 `pairing` | serve | -32000 `idle` | 404 | revoked |
 * | notifications | 404 | 202, ignored | serve | serve | 404 | revoked |
 *
 * Since 0.12 (M11), `initialize` in handoff, live or dormant is `not_found` (HTTP 404, the state unchanged) when
 * `options.binding` is `"mismatch"` (`bindingVerdict`): it does not carry the grant's own pairing.
 */
export type DockGrantAnswerKind =
  | { kind: "serve"; commits: boolean; wakes: false }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "tool_error"; error: DockGrantError }
  | { kind: "rpc_error"; code: typeof DOCK_GRANT_RPC_ERROR_CODE; error: DockGrantError }
  | { kind: "idle_shape" }
  | { kind: "ignored" };

export function dockGrantAnswer(state: DockGrantState, call: DockGrantCall, options: { binding?: "holds" | "mismatch" } = {}): DockGrantAnswerKind {
  // M11 (APC 0.12): an initialize that does not hold the grant's binding is a 404 wherever it would be served;
  // revoked, ended and in flight answer first, as before.
  if (call === "initialize" && options.binding === "mismatch" && (state === "handoff" || state === "live" || state === "dormant")) return { kind: "not_found" };
  switch (state) {
    case "revoked":
      return { kind: "revoked" };
    case "ended":
    case "in_flight":
      return { kind: "not_found" };
    case "live":
      return { kind: "serve", commits: false, wakes: false };
    case "handoff":
      if (call === "initialize") return { kind: "serve", commits: true, wakes: false };
      if (call === "ping" || call === "tools/list") return { kind: "serve", commits: false, wakes: false };
      if (call === "core_tool" || call === "app_tool") return { kind: "tool_error", error: PAIRING_ERROR };
      if (call === "other_method") return { kind: "rpc_error", code: DOCK_GRANT_RPC_ERROR_CODE, error: PAIRING_ERROR };
      return { kind: "ignored" };
    case "dormant":
      if (call === "core_tool") return { kind: "idle_shape" };
      if (call === "app_tool") return { kind: "tool_error", error: IDLE_ERROR };
      if (call === "other_method") return { kind: "rpc_error", code: DOCK_GRANT_RPC_ERROR_CODE, error: IDLE_ERROR };
      return { kind: "serve", commits: false, wakes: false };
  }
}

/**
 * The hub's error for a pairing whose grant answered 404 after the hub introduced it, or while it was in
 * handoff (H5, APC 0.10): "drop the agent on the app again", never `app_unreachable`. The hub keeps an
 * `ended` tombstone for it, like `revoked`: outside its pairing cap, deleted on a re-pair, and `relay()` and
 * `decide()` on it answer `pairing_ended`, not `unknown_app` or `unknown_pairing`.
 */
export const PAIRING_ENDED_ERROR = "pairing_ended";

/**
 * Why an app refuses a dock drop or an Allow (APC 0.10):
 *
 * - `hub_not_allowed`: the drop's `hub` is not on the app's constant allowlist (M1), checked on the drop and
 *   again on the Allow; no consent and no grant.
 * - `consent_expired`: an Allow on a consent a newer drop replaced (section "One pending pairing").
 * - `pairing_in_progress`: a second Allow while the first waits on the hub.
 */
export type DockDropError = "hub_not_allowed" | "consent_expired" | "pairing_in_progress";

/**
 * The hub MUSTs (APC 0.10; the reference hub at apc.tineira.com follows them):
 *
 * - **H1.** The hub sends `initialize` on a grant's MCP URL only after the dock owner approved the pairing with
 *   the code, and sends no `initialize`, `tools/list` or `tools/call` before that. While approving, the dock
 *   takes no code.
 * - **H2.** `/apc/confirm` expires overdue pending requests before it answers, so an expired request answers
 *   `not_paired`.
 * - **H3.** `/apc/pair` replaces an unapproved pending request (no correct code accepted yet) for the same
 *   (agent, app origin) rather than keeping two; never an `approving` or `paired` one. The replaced request
 *   does not count toward the pairing cap; its URL is given back (`/apc/revoke`) after the hub answers
 *   `/apc/pair`, asynchronously, and only when it differs from the new request's. The new request's
 *   wrong-code count starts at 0.
 * - **H4.** The hub relays `pairing` and `idle` as tool errors: verbatim for verified apps, in the untrusted
 *   envelope for unverified ones. It carries `idle: true` per app in `get_current_view`'s `views[]`. An app's
 *   idle answer never ends the hub's wait early and never reads as page closed; it keeps an idle flag per app
 *   (unverified apps too), cleared by the next answer without `idle`. When every app is idle its
 *   `wait_for_focus` answers the idle shape (`idleWaitForFocus`), saying the apps are asleep and wake when the
 *   person opens them; with a mixed fleet it names the apps asleep and waits as usual.
 * - **H5.** A 404 from a pairing that was introduced, or is in handoff, is `pairing_ended`
 *   (`PAIRING_ENDED_ERROR`), never `app_unreachable`.
 * - **H6.** Its instructions and guide say: `idle`, the person is away from that app (tell them, and do not
 *   retry); `pairing`, the person has not finished pairing yet (wait, or tell them).
 * - **H7.** The copy of an app's `apc.json` used for a pairing decision is at most
 *   `APC_JSON_PAIRING_MAX_AGE_S` old (fetched fresh on `/apc/pair`, or a `max-age` of 60 or less); a 5xx or
 *   unreachable `apc.json` never falls back to a stale copy that lists `dock`: the pairing is refused
 *   (`apc_json_unreachable`).
 * - **H8** (0.12). Every `initialize` the hub sends to a grant carries the pairing's `pairing_id` in
 *   `params._meta[APC_PAIRING_ID_META]` and its agent's handle in `params._meta[APC_AGENT_META]`, to every app,
 *   and `/apc/pair` answers with `binding: "pairing_id"`. A `pairing_id` matches `PAIRING_ID_RE`, holds at least
 *   128 random bits, is unique across the hub, never changes while its pairing exists, and authorizes nothing at
 *   the hub.
 */
export type DockHubRequirement = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8";

/**
 * The app MUSTs around the hub call (APC 0.10):
 *
 * - **M1. Allowlist.** Parse the drop's `hub` with `new URL`; refuse anything unparsable, not `https:` (but a
 *   declared local-dev origin), or with userinfo, a path other than `/`, a query or a fragment. Compare
 *   `url.origin` for exact equality with a constant allowlist, on the drop and again on the Allow; otherwise
 *   `hub_not_allowed`, with no consent and no grant.
 * - **M2. Redirects.** Never follow one: `redirect: "manual"` (or `"error"` where the runtime has it; Cloudflare
 *   Workers does not, and throws), and refuse any 3xx, `opaqueredirect` or `response.redirected`.
 * - **M3. Time limit.** One deadline, `HUB_CALL_DEADLINE_MS` at most, covers the headers and the whole body.
 * - **M4. Byte cap**, `HUB_ANSWER_MAX_BYTES` at most. A `content-length` that is present must match `^\d+$`
 *   and be at most the cap, or the answer is refused before reading; the decoded stream is cut at the cap;
 *   an absent `content-length` is not refused; declared and decoded lengths are never compared (gzip).
 * - **M5. No lock across the call.** No database transaction or row lock is held across the hub call. One
 *   drop, Allow or confirm runs at a time per (user, hub, agent), across instances.
 * - **M6. Owner-session endpoints** (drop, consent and Allow, heartbeat, Cancel) need the owner's
 *   authenticated session, and every state change is `POST` with `application/json`. A request with `Origin`
 *   is refused unless it equals the app's configured public origin (never derived from the request URL); one
 *   with `Sec-Fetch-Site` `cross-site` or `same-site` is refused; one with neither header is a non-browser
 *   client and is taken on the session alone. A WebSocket heartbeat's handshake follows the same `Origin` rule.
 * - **M7. `POST {app}/apc/revoke`** answers the same 200 to any input, with its body capped. It ends a grant
 *   whose secret hash matches, in any state but revoked or ended (in flight included); on a revoked or ended
 *   grant it does nothing.
 * - **M8. `apc.json`** lists `dock` only while the app can pair (its config is present), computed per request
 *   or cached `APC_JSON_PAIRING_MAX_AGE_S` at most.
 * - **M9.** The app sends hub requests to the parsed `url.origin` of M1, never to the raw `hub` string.
 * - **M10** (0.12). Whether a grant is a Dock grant comes from the app's own record of how it made it, never from
 *   its URL, the request or its client. With the move out of in flight (the same atomic step) the app stores the
 *   hub's origin, the agent, the acknowledgement's `pairing_id` and whether it declared `binding`
 *   (`DockBinding`); they never change. An acknowledgement whose `binding` is unknown, or declared with an id out
 *   of form, is a refusal (`declaredBinding`). The app reads the keys from the body it gates on.
 * - **M11** (0.12). On a Dock grant in handoff, live or dormant, an `initialize` that does not hold the binding
 *   (`bindingVerdict`) gets HTTP 404, the state unchanged, SHOULD with `{ error: "pairing_mismatch" }`. Every
 *   `initialize` in a request counts, in a batch or without an `id`.
 * - **M12** (0.12). On a grant that is not a Dock grant, a request carrying an `initialize` with either binding
 *   key (`hasBindingKey`) gets HTTP 404 before any other answer, revoked included; the grant is unchanged.
 */
export type DockAppRequirement = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9" | "M10" | "M11" | "M12";

/** The error a 404 of M11 or M12 SHOULD carry (APC 0.12). A hub reads it only as this exact token. */
export const PAIRING_MISMATCH_ERROR = "pairing_mismatch";
