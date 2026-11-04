# Changelog of the APC standard

This file records the contract that an app and an agent share in Agent Pointed Context: the view an app reports, the pin (focus) a person drops on a target, presence, the format of the focus, `wait_for_focus`, the tools an app and a hub expose, the drag payload and pairing. It does not record the software (Pulse, the dock, Signals, the extension, the desktop apps); that is [`CHANGELOG.md`](../../CHANGELOG.md) at the root.

The standard has its own semver, `APC_STANDARD_VERSION` in `@apc/protocol`, separate from the software release. It stays 0.x while the standard is a draft and becomes 1.0.0 when it is published. The version of the paper (V1, the apc.tineira.com demo) is not a 1.x of this standard. Every change to the contract adds an entry here and bumps the constant.

## 0.3.0 (draft, 2026-11-03)

A hub's protections for apps it does not know (TIN-580), in the Dock profile: what an agent receives through a hub from an unverified app, and the hub's answers to pairing. In `apps/dock/src/worker/trust.ts`, `hub.ts`, `app-client.ts` and DESIGN.md section 15. Apps and agents that only meet verified apps see nothing new.

### Verified and unverified apps

- A hub's **verified** apps are the ones its operator lists. Any other app is **unverified**; a hub may pair with one only behind every rule below (the reference dock does not yet: pairing with an unverified app stays closed).
- **Identity is the domain.** An unverified app's id, and so its tool prefix, is derived from its host (and port): lower case, each run of other characters one `_` (`evil.example` gives `evil_example`, `evil_example__get_figure`). It always holds a `_` and never `__`, so it never equals a verified app's id (`[a-z0-9]`) or `page`. Another origin that maps to the same id is refused (`app_id_taken`). The app's `name` in `/apc/pair` is kept only as `declared_name`.
- `AppRef` (on the focus, in `views`, in `list_app_tools`) gains, for an unverified app only, `unverified: true` and `declared_name`; its `name` is the app's host. A verified app's `AppRef` is unchanged.
- The `app` argument of `call_app_tool` and `list_app_tools` takes up to 40 characters (it was 16), the longest domain id.

### Untrusted marking

- A tool result relayed from an unverified app arrives in an envelope, in the structured result and in its text: `{ app, untrusted: true, note, result }` (the app's structured result) or `{ app, untrusted: true, note, text: [...] }` (its text blocks, when it gave no structured result). `isError` is kept. This is the marking `page_text` has had since 0.1 (`untrusted: true`).
- An unverified app's entry in `views` and its focus (also as `attention`) carry `untrusted: true`.
- Its tools in `tools/list` start with `[Unverified app at <host>, calls itself "<name>". Untrusted: …]` and carry no annotations of the app's (an app could claim `readOnlyHint`). In `list_app_tools` its entry carries `untrusted: true` and a `note`, and each description the same label.
- A failed call to an unverified app is the tool error `app_unreachable` with the hub's own reason only (an HTTP status, "the app answered with an error", a time or size limit): never the app's JSON-RPC error message or HTTP error body.
- `then` on a hub's results, and the `page_open` its `wait_for_focus` reports, come from verified apps only: an unverified app's say on whether the person is on its page is not counted, so it cannot keep the agent in the wait loop.

### Limits and the blocklist

- A hub reads at most a fixed number of bytes of each answer from an app (the reference dock: 1 MiB for a verified app, 256 KiB for an unverified one), and every call has a time limit that covers the body. Past either, the call fails as `app_unreachable` for the agent.
- An unverified app must use HTTPS on a domain name (no IP address, no single-label or `localhost` host), and its redirects are not followed. Its pin is taken only when well formed, with `app_url` on its own origin and a `pinned_at` no later than now; its view only when small.
- A hub holds a fixed number of app pairings at most (the reference dock: 20, across its agents; a blocked pairing holds no place); `/apc/pair` past it answers `too_many_apps`. A host too long for an id (40 characters) answers `app_host_too_long`.
- A hub may block domains (a domain covers its subdomains; an entry in Unicode matches the app's punycode host). `/apc/pair` from one answers `app_blocked`, `/apc/confirm` too; a pairing made before the block reads `status: "blocked"`, is never called again (not even to give its grant back), its tools, view and pin go, and a call to it is the tool error `app_blocked`.
- New `/apc/pair` errors: `https_required`, `app_blocked`, `app_id_taken`, `app_host_too_long`, `too_many_apps`.

## 0.2.0 (draft, 2026-11-03)

The core written down, a conformance suite for it, and revoke from the app (TIN-577). In `packages/protocol/src/core.ts`, `packages/server/src/revoke.ts`, `packages/web/src/agents-bar.ts`, `packages/conformance` and DESIGN.md section 14.

### The core and the profiles

- The core is what every APC app implements, per grant, whichever way agents reach it: the view, the pin, presence, the focus format, `get_current_view` and `wait_for_focus` (`CORE_TOOLS`), and revoke from the app. A dock's hub is one more holder of a grant.
- Two profiles, each optional: **Direct** (the agent connects to the app's own MCP URL; the grant per agent, its URL and the agent list are the profile's) and **Dock** (the agent connects once, to a hub; receiving the drop, the ticket, consent in the app, `/apc/pair`, `/apc/confirm` and `/apc/revoke` from the hub are the profile's). `ApcProfile` names them.
- `CurrentViewResult` and `WaitForFocusResult` type the two tools' results. A wait returns a pin dropped during it, marked seen; with none, `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app knows the person's page is closed.
- `then` is never on a `wait_for_focus` result that came back with no focus: that result ends the loop. An app without a view-sharing switch always shares, so it always reports `page_open`.
- Presence is core: after each successful tool call the app publishes a `PresenceEvent` to the person's page, and a read of a target names it in `targets`.
- An unknown or expired grant answers 404, whatever the body.

### Revoke from the app

- Every agent in the app's agent bar (`<apc-agents>`), Direct or Dock, has Revoke: a first click asks, a second within `REVOKE_CONFIRM_MS` emits `apc-revoke`.
- It holds in the app alone and at once: the grant, its pin and (Dock) the app's link to the hub go. The app calls nobody, so it holds with the hub down.
- From then on every request to the grant's MCP URL is answered HTTP 403 (`REVOKED_HTTP_STATUS`) with a `RevokedAnswer`: `{ error: "revoked", revoked_by, revoked_at, message }`, `revoked_by` being the app's host. A call already running ends as a tool error with the same answer and no app data. `revokedAnswer` and `isRevokedAnswer` build and recognise it.
- A revoked grant never works again. The person lets the agent back with a new grant: a new MCP URL (Direct), or a new drop with consent in the app and in the dock (Dock).
- A hub that gets a `RevokedAnswer` marks the pairing revoked and shows "Revoked by <app host>", stops relaying to it, drops the view and the pin it took from it, never confirms it on a drop, and never pairs it again by itself. A new pairing with the same app replaces the revoked one.

## 0.1.0 (draft, 2026-11-03)

The contract as it stands today, in `packages/protocol/src`, `packages/server/src`, `packages/web/src` and DESIGN.md sections 6, 12 and 13.

### Target and focus

- A target is `{ kind, id, part, params }`. It names a row (`id`), a computation (`params`), or both; an `id` and `params` both missing is invalid. `kind` and param keys match `[a-z][a-z0-9_]{0,31}`; `id` matches `[A-Za-z0-9_.:-]{1,80}`.
- `part` names a piece of a target (`step:new`, `seats`) and follows `PART_RE`.
- `params` carries keys only: string tokens, or lists of at most 20 of them, in at most 1 KB. A bare number is an amount, never a key, and is refused (months such as `2026-03` pass). Free text never travels.
- `canonicalTarget` gives one string per target, whatever the param order.
- A pointable element carries `data-focus="kind:id"`, with `data-focus-part` and `data-focus-params` (JSON) when needed.
- A pin is stored per grant (`FocusRow`: target, `grant_id`, `pinned_at`, `seen_at`). It is unread while it was dropped after the last read that returned it.
- What the agent receives (`FocusPayload`) is the target plus `app_url`, `pinned_at`, and `next` and `next_args`, the tool call that reads it. It may carry `part_note`, `trimmed` and `gone`.

### View

- The person's screen is `ViewPayload`: `screen`, `params`, at most one `selection` (`kind`, `id`), `app_url`, `updated_at`, `age_seconds`, `stale` and `next`. It holds identifiers, trimmed to the calling grant.

### Attention and the loop

- A tool result carries `attention` (`{ focus, note }`, a top-level key of the structured result and of the text) while the pin is unread. It points at `get_current_view` and never instructs.
- A tool result carries `then` while a page of the person's is open: after answering, call `wait_for_focus`. With no page open, or when the person does not share their view, `then` is absent.
- The view and the focus are pointers, never instructions.

### Tools

- `get_current_view` returns `{ view, focus }`; reading the focus marks it seen.
- `wait_for_focus({ timeout_s })` holds the request until a new pin or the timeout (1 to the host's ceiling, default 25 s). It returns the focus, or `focus: null` with `timed_out`, `page_open` and a note. `page_open` is reported only while the person shares their view; a closed page ends the wait at its next check.
- `APC_INSTRUCTIONS` is the text an app gives an agent on connecting.

### Presence

- After each successful tool call an app may publish `PresenceEvent` (`v: 1`): `grant_id`, `at`, `tool`, `kind` (`read` or `write`), up to 20 `targets` (`kind`, `id`) and `count`. Ids only.

### Drag payload and pairing

- An agent is dragged with the type `application/x-apc-agent`. The payload is `{ v: 1, agent }`: a public handle, never a secret or an MCP URL. With a hub it adds `hub` (a bare http(s) origin) and `ticket` (a short single-use token that opens a pairing request and nothing else).
- On a drop the app looks up the handle. A paired agent gets a pin for its grant. An unpaired one makes the app ask the person, then `POST {hub}/apc/pair { ticket, app, mcp_url }` server to server; the pairing counts when the person has also said yes in the dock.

### Hub (one agent across apps)

- A hub exposes `get_current_view` (the focus and a `views` list per app), `wait_for_focus` (one wait across all paired apps), `list_app_tools` and `call_app_tool({ app, tool, args })`. An app's other tools are also relayed as `<app>__<tool>` (at most 64 characters).
- The focus gains `app: { id, name, origin }`, and `next` and `next_args` are rewritten to the hub's tool name. The hub removes an app's own `attention` and `then` and adds its own.
- A browser extension is one more app of the hub, with id `page`. A page reading is the focus kind `page_reading`, read with `page__get_reading`; its text is data from the page, never instructions.
