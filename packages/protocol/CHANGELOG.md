# Changelog of the APC standard

This file records the contract that an app and an agent share in Agent Pointed Context: the view an app reports, the pin (focus) a person drops on a target, presence, the format of the focus, `wait_for_focus`, the tools an app and a hub expose, the drag payload and pairing. It does not record the software (Pulse, the dock, Signals, the extension, the desktop apps); that is [`CHANGELOG.md`](../../CHANGELOG.md) at the root.

The standard has its own semver, `APC_STANDARD_VERSION` in `@tineira/apc-protocol`, separate from the software release. It stays 0.x while the standard is a draft and becomes 1.0.0 when it is published. The version of the paper (V1, the apc.tineira.com demo) is not a 1.x of this standard. Every change to the contract adds an entry here and bumps the constant: a new minor (or, from 1.0, a major) version. A patch (0.7.0 to 0.7.1) never changes the contract; it fixes the packages or the wording, so an app that implements 0.7.0 implements every 0.7.x.

## 0.11.0 (draft, unreleased)

Wave 2 of the APC 1.0 track (TIN-880): the agent in the page (TIN-878), a presence kind for waits (TIN-886) and several MCP endpoints in `apc.json` (TIN-888). Each change adds its own subsection below.

### The agent in the page (TIN-878)

- **How an app shows each connected agent in its page is part of the standard, as SHOULDs.** An app may keep its own mark; an app that shows a pet SHOULD show the APC pet: in the header up to 3 pets, then a "+N" (or list) button that opens a popover, a pin badge with × on the pinned element (the app places several side by side), the pets and badges being marks, and a pet only a mark (a tap arms it, it never opens the popover) (`data-apc-mark`, `data-grant`). On a phone the pets stay in the header and every tap target is at least 44 px. Logos are brands only, never a vendor's mascot.
- **The 8 states and what drives each in an app** (`petState`, `PetInput`, `PET_STATES` in `@tineira/apc-web`): dragging, pairing, offline (no client, or revoked), pinned (an unread pin), calling (a call in flight or just heard), read (shown for `READ_HOLD_MS`), waiting (an open `wait_for_focus`, only from the page-readable wait signal, never inferred from timing), idle. Every input is optional and defaults to "not happening".
- **Motion**: one `requestAnimationFrame` loop per window, stopped while the page is hidden, slower once every pet is calm, a still pose with `prefers-reduced-motion`.
- **Colour scheme (SHOULD follow the page)**: the light pet on light pages, the inverse pet on dark ones (a near-white body, a dark outline and eyes, a thin outline on the badge's disc); the state marks do not change. `scheme: "light" | "dark" | "auto"` (`resolvePetScheme`, `petPalette`), and `tint` or `--apc-pet-body` / `--apc-pet-line` for a strict palette.
- In the spec's "The agent in the page" and the integrate guide.

### Wait events on the presence channel (TIN-886)

Before, a page could not tell whether its agent was listening, so apps guessed from recent calls (75 s, 5 minutes) and showed "waiting" with no wait running. In `packages/protocol/src/presence.ts`, the spec's [presence](https://apc.tineira.com/docs/spec#presence) and DESIGN.md section 23.

- **A presence kind `"wait"`**: `PresenceWaitEvent`, `{ v: 1, grant_id, at, kind: "wait", state: "open" | "closed" }`, ids only, no targets, on the existing presence stream with its read and write rules. `PresenceMessage` is either kind; `parsePresenceWaitEvent` and `isPresenceWaitEvent` take exactly those five keys. `PresenceEvent` is unchanged.
- **When.** An app **must** send `open` when a `wait_for_focus` claims the grant's place, and `closed` when it gives it up: on return, timeout, cancel, or the grant revoked or deleted. A refused wait sends nothing. A takeover sends the old wait's `closed`, then the new wait's `open`, both at the claim, and the old wait sends nothing later.
- **Expiry.** A page **must** treat an `open` as closed once it is older, on the page's clock from arrival, than the app's ceiling (`WAIT_CEILING_DEFAULT_S`, 50 s, unless the app sets its own) plus `WAIT_EVENT_MARGIN_S` (10 s; `waitOpenLimitMs`), so a lost `closed` cannot leave it "waiting" for ever. An app **should** tell a page that connects mid-wait.
- **Dock grants.** A page **must not** show a dock grant as waiting: its agent waits on the hub, and the app sees only the hub's relays.
- `@tineira/apc-server`: `presenceWaitEvent`; `announceWaits(slot, grantId, publish)` sends the events from a `WaitSlot`; `registerApcTools` takes `waitPresence: { grantId, publish }`. `WaitSlot.claim` may report `tookOver` and `release` whether it held the place (both optional: a store that reports neither still works); `MemoryWaitSlots` reports both, keeps the closed of a grant forgotten mid-wait, and has `held(grantId)`. The default ceiling is `WAIT_CEILING_DEFAULT_S`.
- `@tineira/apc-web`: `foldWaitEvent`, `waitOpen` (what a pet's `waiting` input takes) and `nextWaitExpiry`; `flashTargets` takes any `PresenceMessage` and ignores wait events.
- `@tineira/apc-conformance`: `takePresence()` returns `PresenceMessage[]`. Two checks, on the Direct profile of an app that claims 0.11.0: a wait sends `open`, then `closed`; a takeover sends `open, closed, open, closed`.

An app before 0.11 sends no wait events, and its pages are not affected by them; to claim 0.11.0 it sends them.

## 0.10.0 (draft, 2026-11-13)

The Dock profile as built (TIN-882): a dock grant has states, each state answers in a fixed way, and the hub and the app have MUSTs around the hub call. Before, the profile said how a pairing starts and not what a grant answers between the Allow and the hub's first `initialize`: one app served data in that window, two had no gate at all. In `packages/protocol/src/dock.ts` and `core.ts`, the spec's Dock profile and DESIGN.md section 22. The binding stays the secret MCP URL; other bindings are left open for future versions.

### Grant states

- **A dock grant is `in_flight`, `handoff`, `live`, `dormant`, `ended` or `revoked`, in that order of precedence from the last** (`DockGrantState`, `DOCK_GRANT_STATES`: revoked > ended > in_flight > handoff > dormant > live; `dockGrantStateOf`). In flight runs from the Allow to the hub's acknowledgement; handoff from the acknowledgement to the first committed `initialize`; live from then on; dormant (SHOULD) after `T_idle` with no wake action; ended after `T_ack` (at most 30 s, `T_ACK_MAX_MS`) still in flight, after `T_connect` (at most 10 minutes, `T_CONNECT_MAX_MS`) in handoff, on a give-back, or after long dormancy; revoked on the owner's Revoke or on Cancel.
- **Each state answers in a fixed way** (`dockGrantAnswer`, MUST wherever the state is implemented; `dockGrantCallOf` classifies a JSON-RPC message, a message with no `id` or any `notifications/*` method being a notification). In flight and ended answer HTTP 404 to every request, whatever its method, a `GET` or a body that does not parse included; revoked answers `RevokedAnswer` as in 0.8; live serves. Handoff serves `initialize` (which commits the connection), `ping` and `tools/list`; a `tools/call` is the tool error `{ error: "pairing", message }`, another method JSON-RPC -32000 with that as `data`, a notification 202. Dormant serves `initialize` (without waking), `ping` and `tools/list`; the core tools answer their idle shapes; another tool is the tool error `{ error: "idle", message }`, another method -32000. No answer in handoff or dormant carries `attention`, `then`, an `apc_link` offer or a presence event.
- **The idle shapes** (MUST for an app that sleeps): `get_current_view` answers `{ view: null, focus: null, idle: true, note }` (`idleCurrentView`), `wait_for_focus` `{ focus: null, timed_out: false, page_open: false, idle: true, note }` (`idleWaitForFocus`). They are the types `IdleCurrentView` and `IdleWaitForFocus`: `CurrentViewResult` becomes `CurrentViewAnswer | IdleCurrentView` and `WaitForFocusResult` gains `IdleWaitForFocus`, so an idle answer can carry no data and no timeout. An answer without `idle` (a 0.9 app) reads as before. `isIdleAnswer`, `isPairingAnswer`.
- **Tool errors** (`DockGrantErrorAnswer`) are carried in both `structuredContent` and `content[0].text` (JSON), with `isError: true`.
- **Transitions.** `initialize` fails closed: no result unless the move out of handoff committed (on a persistence failure, JSON-RPC -32603 or HTTP 500), and the commit is conditional on the grant being neither revoked nor ended in the same atomic step. The acknowledgement's move from in flight to handoff is conditional the same way. A served call is a `tools/call` that returned app data while live. Wake actions are the owner's authenticated page heartbeat (at least every `T_idle / 2` while the page is open) or a confirmed drop; agent traffic never wakes or extends a grant. Cancel revokes, only in handoff before any served call, atomically.
- **Recommended times**: `T_idle` 30 minutes (`T_IDLE_RECOMMENDED_MS`), long dormancy 30 days (`LONG_DORMANCY_RECOMMENDED_MS`).

### The hub (H1 to H7)

- **H1.** The hub sends `initialize` on a grant only after the dock owner approved with the code, and nothing before; while approving, the dock takes no code. **H2.** `/apc/confirm` expires overdue requests before it answers. **H3.** One pending request per (agent, app origin): `/apc/pair` replaces an unapproved one (never an approving or paired one), outside the cap, giving its URL back afterwards when it differs, the new one's wrong-code count at 0. **H4.** `pairing` and `idle` are relayed as tool errors (in the envelope for an unverified app), `idle: true` per app in `views[]`, an idle answer never ends the hub's wait or reads as page closed, and an all-idle wait answers the idle shape. **H5.** A 404 from a pairing introduced or in handoff is `pairing_ended` (`PAIRING_ENDED_ERROR`), with an `ended` tombstone. **H6.** The instructions and guide say what `idle` and `pairing` mean. **H7.** The `apc.json` copy for a pairing decision is at most 60 s old (`APC_JSON_PAIRING_MAX_AGE_S`), and an unreachable one refuses the pairing (`apc_json_unreachable`).

### The app (M1 to M9)

- **M1** a constant allowlist of hub origins, parsed with `new URL`, on the drop and the Allow (`hub_not_allowed`); **M2** no redirects; **M3** one deadline of at most 10 s for headers and body (`HUB_CALL_DEADLINE_MS`); **M4** at most 8 KiB read (`HUB_ANSWER_MAX_BYTES`), with a strict `content-length` rule; **M5** no lock held across the hub call, one drop, Allow or confirm at a time per (user, hub, agent); **M6** the owner-session endpoints are `POST` `application/json`, refuse a foreign `Origin` or a cross-site `Sec-Fetch-Site`, and take a request with neither on the session alone; **M7** `/apc/revoke` answers the same 200 to anything and ends a matching grant in any state but revoked or ended; **M8** `apc.json` lists `dock` only while the app can pair, cached 60 s at most; **M9** hub requests go to the parsed origin.

### One pending pairing

Before the acknowledgement a new drop replaces the pending consent (the stale Allow is `consent_expired`); a second Allow is `pairing_in_progress`. After it and before `initialize`, a drop asks `/apc/confirm`: `pending` with the app's own expiry ahead shows the same code and the time left; `not_paired` or a passed expiry ends the grant and starts a fresh consent; `paired` keeps the grant in handoff until `initialize`. The page treats its stored expiry as the truth.

### Packages

`@tineira/apc-protocol`: `dock.ts` (the states, the answer table, the tool errors, the idle shapes, the time limits, `PAIRING_ENDED_ERROR`, `DockDropError`, and the H and M rules in prose). The drag payload moves here from `@tineira/apc-web`, unchanged, so an app's server can check a drop with the page's grammar (`drag.ts`: `AgentDrag`, `APC_AGENT_TYPE`, `agentDragPayload`, `parseAgentDrag`, `parseAgentDragPayload`, and the grammar as `AGENT_HANDLE_RE` and `DRAG_TICKET_RE`); `@tineira/apc-web` re-exports it. `HubCallError` gains `hub_not_allowed` (a hub that is not a bare origin: nothing is sent).

`@tineira/apc-server` (TIN-883):

- **`pairWithHub` and `confirmWithHub` follow M2, M3, M4 and M9**: the call goes to the hub's parsed origin (`hubCallOrigin`; anything but a bare `https:` origin, or `http:` on a loopback host, is `hub_not_allowed`, nothing sent); a 3xx, `opaqueredirect` or `redirected` answer is `hub_refused`; one deadline of at most 10 s covers the headers and the whole body (`hub_unreachable`); a `content-length` that is not digits or is over 8 KiB is refused before reading, and the decoded body is read as a stream and cut at 8 KiB (`hub_refused`), with an absent `content-length` taken and never compared.
- **`toolError` sets `structuredContent`** with the same `{ error, message }` as its text. MCP SDK clients validate `structuredContent` against a tool's `outputSchema` even on `isError`, so a tool that declares one must admit `{ error, message }` (for a JSON Schema, `{ type: "object", anyOf: [own, errorShape] }`), and a core tool's must admit its idle shape, or the client rejects the error.
- **`parseDockDrop(body, { hubs, localDevHubs })`** (M1): the hub parsed with `new URL`, `https:` (or a listed loopback origin), no userinfo, path, query or fragment, written as its own origin, and exactly equal to one on the allowlist; the agent and ticket in the drag grammar. It answers `{ ok, hub, agent, ticket }` or `hub_not_allowed` / `invalid_drop`; call it on the drop and again on the Allow.
- **`handleDockGiveBack(request, { origin, endGrantBySecretHash })`** (M7): `POST /apc/revoke` answers the same 200 to any input, reads at most 4 KiB within 5 s, and hands the app the `secretHash` of the URL's secret to end that grant unless it is revoked or ended; it never logs the URL.
- **`dockGrantGate(state, message, { host })`** and **`dockGrantToolResult(state, tool)`**: the answer table as a gate for an app's MCP handler, with the exact HTTP 404, 202, `RevokedAnswer`, JSON-RPC -32000, `pairing` / `idle` tool error or idle shape; a request method without an id is another method, never served by a grant that is not live. Such an answer is returned as is, before the app's wrapper (no activity stamp, presence, `attention`, `then` or `apc_link`): the app's obligation, documented.
- **The derived-secret recipe** (optional): `deriveDockSecret(key, appTag, grantId, salt)` (a `grantId` of 1 to 80 of `[A-Za-z0-9_.:-]`), `dockSecretHash(secret)` and `newDockSalt()`, Web Crypto only.
- **`apcJsonResponse` caches `max-age=60`** (was 300; M8, H7).

The reference hub and apps, and the conformance checks, follow in their own changes.

An app that implements 0.9 keeps working with a 0.10 hub: its answers carry no `idle`, and read as they did. To claim 0.10.0 it implements the states it uses as the table says, and M1 to M9.

## 0.9.0 (draft, 2026-11-12)

The pairing code: on the Dock profile the app's consent shows a code, and the dock's Allow requires it (TIN-859). A drag can be put on any page, and anyone who runs a dock can mint tickets for their own agent; before, they could lure an app's owner into a drop and an Allow and get their own agent paired with the owner's data. In `packages/protocol/src/core.ts`, `packages/server/src/consent.ts`, `packages/server/src/hub-client.ts`, `packages/conformance` and DESIGN.md section 12.

### Pairing

- **The app shows a pairing code with its consent, and sends it to the hub.** Six characters of Crockford base32 (`PAIRING_CODE_LENGTH`, `PAIRING_CODE_ALPHABET`, 30 bits), new for every consent, shown as `K7M-4P2` (`formatPairingCode`) with the warning to type it only in the person's own dock. After the Allow the app sends it raw in `pairing_code` of `POST {hub}/apc/pair` (`DockPairRequest`). An app that implements 0.9 **must** send it. The code never goes over MCP, in a URL, to `/apc/confirm` or anywhere but the app owner's page and that one request.
- **The hub keeps it and answers `pairing_code: "required"`** (`PAIRING_CODE_ACK`, `DockPairAnswer`), never shows it (not in the dock's state, a broadcast or any answer), and checks the body before it spends the ticket: a `pairing_code` that is present but not a code (`null`, `""`, a number) is `invalid_pairing_code`. Only an absent key is a pairing without a code; a hub may refuse those (`pairing_code_required`).
- **The dock owner's Allow needs the code.** The hub compares it in constant time (`pairingCodesMatch`) with what the app sent; a missing or malformed code is refused without counting; a wrong one counts, `wrong_pairing_code` with `attempts_left`, and the fifth (`PAIRING_CODE_MAX_ATTEMPTS`) removes the request and gives the grant back (`pairing_code_refused`). A request with a code that nobody approves goes after `PAIRING_CODE_TTL_MS` (120 s), its grant given back; one without keeps the old ten minutes. Deny and unpair need no code. Typing is forgiving: case, spaces and dashes are ignored, O reads as 0 and I or L as 1 (`normalizePairingCode`).
- **The app keeps a grant only on the acknowledgement**: a non-redirected HTTP 200 with `ok: true`, `pairing_code: "required"` and a string `pairing_id`. A hub's own refusal is HTTP 400 with `ok: false` and its error. Anything else (another status, a redirect, a missing acknowledgement, no answer) and the app deletes the grant before it answers its page (`hub_refused`, `hub_unreachable`, `hub_ignores_pairing_code`, `HubCallError`). `/apc/confirm` is believed the same way: 200, `ok: true`, `status` `"pending"` or `"paired"`.
- **A drag's ticket lives 240 s** (`TICKET_TTL_MS`; it was 60 s), longer than the app's two-minute consent, so the person has the time to read the card.
- **What the app shows after the Allow** (reference behaviour, not a MUST): the code again, the time left, and Cancel, until the hub connects (its first `initialize` on the grant) or the grant goes; if the person's own dock never asks for that code, the agent was someone else's.

### Packages

- `@tineira/apc-server`: `DockConsent.ask` returns `{ nonce, pairing_code }`, and `take` is replaced by `takeConsent`, which returns `{ ok: true, pairing_code }` or `{ ok: false }` (no boolean to test by mistake): every caller has to show the code and send it. New: `newPairingCode`, and `pairWithHub` / `confirmWithHub` (`redirect: "error"`, a 10 s limit, the rules above).
- `@tineira/apc-conformance`: `standInHub`, a hub to pair with in process, faithful on tickets, the code, wrong codes, expiry, the give-back and the acknowledgement, with broken modes (`no_ack`, `redirect`, `error_500`). An adapter on the Dock profile gives `dock: { hub, drop }`, required of an app that claims 0.9.0 or later (as `page.mobile` since 0.6). New checks: the consent shows a well-formed code and the app sends that code; every consent shows a new code; a hub that does not acknowledge, redirects or says yes with a 500 holds no grant; five wrong codes or the code's expiry give the grant back; the right code pairs.

An app that implements 0.8 keeps pairing with a hub in its default mode (`when_sent`), without a code, until the operator requires one; to claim 0.9.0 it shows and sends the code and fails closed on the hub's answer.

## 0.8.0 (draft, 2026-11-12)

The core tools made robust, from a second implementation in use, and the Direct profile freed from how the agent authenticates (TIN-839, TIN-667). In `packages/protocol/src/core.ts`, `manifest.ts`, `packages/server/src/tools.ts`, `waits.ts`, `packages/conformance` and DESIGN.md section 21.

### The loop

- **`then` only after a recent pin.** A result carries `then` only while a page of the person's is open (and shared) **and** the grant was pinned within the app's window, read or unread (`THEN_PIN_WINDOW_MIN`, 30 minutes unless the app sets its own; `thenApplies` in `@tineira/apc-server`). An open page with no recent pin gives no `then`, so an agent no longer waits after every answer. Before, an open page was enough.
- **Wait in the background.** The instructions (`APC_INSTRUCTIONS`), the `guide` prompt, the `then` note and `wait_for_focus`'s description tell the agent to run the wait in the background if its client can (a background subagent, say), and otherwise to keep it short and never chain waits (`WAIT_IN_BACKGROUND`). The default timeout stays the app's: 25 to 45 s suits a conversation.
- **One wait per grant.** At most one wait of a grant delivers. A new wait takes over: the one it replaces ends at its next check with `focus: null, timed_out: false` and a note, delivers nothing and marks nothing seen. A new wait within `WAIT_CLAIM_GAP_S` (2 s) of one still running is refused instead, with `focus: null, timed_out: false, retry_after_s` (new in `WaitNoFocus`) and a note, so two waits fired together do not take over from each other in a loop. A wait whose request the client cancels stops and frees its place at once: MCP's `notifications/cancelled`, which reaches a stateless server in a POST of its own (`InflightCalls` keeps the calls in flight per grant to find the one it names), and an HTTP abort where the host reports one.
- **Seen once delivered.** Checking for a pin, or polling for one, never marks it seen: only returning it does. An app marks a pin seen only once the result that carries it is final (in a wait, after it gave its place up and checked once more that its request was not cancelled), and marks that exact pin by its `pinned_at`, never a newer one dropped meanwhile. The result goes out whether or not the mark succeeds. So a pin may be delivered twice, and is never lost to a wait that was taken over or cancelled, or to a newer pin. MCP has no acknowledgement: a result lost after the app sent it, with no abort the app could see, cannot be told apart, and that pin is marked seen. Before, the reference marked the pin seen inside the tool, before the result left, so a wait the client had given up on, or a newer pin dropped between the read and the mark, could be lost.
- **Unavailable has its own shape, and trim never fails the read.** A core tool the app cannot answer just now still answers in its own shape with a `note` (new, optional, in `CurrentViewResult`): `{ view: null, focus: null, note }`, or `{ focus: null, timed_out: false, page_open: false, note }`; never a tool error or an `{ ok, reason }` of the app's own. A check on one item of the answer that cannot run hides that item and the rest answers; it never fails the read open, and a defect in one check never fails it whole (guidance, not wire format).

### The Direct profile, whatever the auth

- **What a grant must be** (`GrantRequirement`, `GRANT_REQUIREMENTS`): a stable id per agent connection (pins, views, presence and `apc_link` are keyed by it); revocable from the app alone, checked on every request and before and after each tool, and revoking ends what could bring it back without the person (with OAuth, its refresh tokens and authorization); revoked told apart from expired or unknown; trimmed per grant, so pointing grants no access. Any binding that meets them will do. The secret URL (`newDirectGrant`, `directMcpUrl`) stays the reference apps' binding; OAuth 2.1 (one MCP URL shared by every grant, the bearer token naming the grant) is another.
- **The revoked answer's status is the binding's.** Every binding answers a revoked grant with the `RevokedAnswer` body. The status is 403 with a secret URL (`REVOKED_HTTP_STATUS`, unchanged) and 401 with `WWW-Authenticate: Bearer error="invalid_token"` with a bearer token (`REVOKED_HTTP_STATUS_BEARER`). An unknown or expired grant answers without a `RevokedAnswer`.
- **`apc.json`.** A Direct app whose grants share one URL may serve it at `mcp.path` itself or at `mcp.path` without its last `/`; one origin may serve several such endpoints under the path, one per role (`declaresMcpUrl(manifest, url, { shared: true })`; a hub pairing a Dock app still requires one URL per grant). `direct.auth` (a short word such as `"url"` or `"oauth"`) and `direct.resource_metadata` (with OAuth, the protected-resource metadata URL on the origin) may say how agents authenticate, as information only: a reader never requires them.
- **Hosts with no long-lived process.** An app on stateless functions bounds `wait_for_focus` by its function's time limit (its own ceiling for `timeout_s`), tells a closed page from a heartbeat, and checks the grant before and after each tool call.

### Conformance

- A connection may carry headers: `AgentConnection.headers` (`{ authorization: "Bearer …" }`), and the CLI takes `--bearer-env <VAR>` and `--revoked-bearer-env <VAR>`, the name of an environment variable that holds the token (never the token itself on the command line; it is never printed). With a bearer token the revoked checks expect 401, the grant's URL may be `mcp.path` itself, and the unknown-grant 404 check is skipped.
- New checks of an app that claims 0.8.0 or later: an open page with no pin gives no `then`; a newer wait takes over and the older one delivers nothing; a second wait right after the first is refused with `retry_after_s` and the first still delivers; a wait cancelled by `notifications/cancelled`, and one cancelled by an HTTP abort, marks nothing seen and frees its place. Of an app that claims less, those checks pass with a note that they did not apply. The `then` check pins the agent first.

An app that implements 0.7 keeps working with agents and docks unchanged; to claim 0.8.0 it adds the `then` window, one wait per grant, and seen once delivered. `@tineira/apc-server`'s `ApcToolContext` now requires `waitSlot` (`MemoryWaitSlots.for(grantId)` for an app whose waits run in one process), takes `signal` (the request's, with `InflightCalls`' for MCP's cancel), and calls `markSeen(pinnedAt)` with the pin it delivered.

## 0.7.1 (draft, 2026-11-04)

No change to the contract: an app or a hub that implements 0.7.0 implements 0.7.1, and `standard` in `apc.json` may say either. This is the first release of `@tineira/apc-protocol`, `@tineira/apc-server`, `@tineira/apc-web` and `@tineira/apc-conformance` published by `.github/workflows/publish.yml` (npm trusted publishing) rather than from a maintainer's machine.

- **The package names in the doc comments are the published ones.** `core.ts` and `manifest.ts` (and so the `.d.ts` files in `dist/`) named `@apc/server`, `@apc/web` and `@apc/conformance`, from before the rename; they now say `@tineira/apc-server`, `@tineira/apc-web` and `@tineira/apc-conformance`.
- **The conformance checks take a newer patch of their own standard.** An app whose `apc.json` says a newer patch of the minor `@tineira/apc-conformance` knows (0.7.2 against 0.7.1) passes the standard check with a note, since a patch never changes the contract; a newer minor still fails until the checks are updated. Before, an app that moved to 0.7.1 failed against the 0.7.0 checks. The in-process suite keeps the note too: after `run()`, the check's `note` says it, and `runConformance` puts it on the result. (`standardSupport` in `packages/conformance/src/shared.ts`, `packages/conformance/src/index.ts`)
- The four packages and `APC_STANDARD_VERSION` are 0.7.1; nothing else in what the packages ship changed.

## 0.7.0 (draft, 2026-11-04)

Consent in the app, checked by the app's server, and revoke told by the grant itself (TIN-606). In `packages/protocol/src/core.ts`, `packages/server/src/consent.ts` and DESIGN.md section 14.

- **Consent in the app is the app's server's to check (the Dock profile).** An app makes a grant for a dock agent it holds no grant for only on a request that proves the person allowed it on the app's page just now, whatever the page last loaded: a page that missed a revoke, or a pairing the dock forgot, must not pair without asking. The reference apps send every dock drop to their server; for an agent with no grant it answers `consent_required` (`CONSENT_REQUIRED`) with a nonce, the page shows its consent with it, and the Allow sends it back. `DockConsent` in `@apc/server` gives and takes the nonce: 128 random bits, once, for the same dock and agent, within `DOCK_CONSENT_TTL_MS` (two minutes). The drag's ticket is not spent until the app calls `POST {hub}/apc/pair`. One drop of an agent is answered at a time: a second request for the same dock and agent while the first waits on the hub answers `pairing_in_progress` and changes nothing, and the new grant is linked to the agent only once the hub took it. Nothing changes between the app and the hub.
- **Whether a grant was revoked is told by the grant itself** (its secret, and the hash the app keeps of it), never by a grant id a later grant may reuse: a call running when its grant was revoked ends `revoked` even if a new grant took the id, and a later grant with a revoked one's id that is given back ends its running call as an unknown grant, not as revoked.

## 0.6.0 (draft, 2026-11-04)

On mobile, every app shows the agent in its page (TIN-608). In `packages/protocol/src/core.ts`, `packages/web`, `packages/conformance` and DESIGN.md section 19.

- **A new core rule (item 9).** In a viewport that matches `APC_MOBILE_MEDIA` (`(pointer: coarse), (max-width: 640px)`: a touch device, or a narrow window), an app shows its agents in its own page, each with its mark visible and usable for pinning, on both profiles. On a phone there is no dock window, extension or desktop pet to drag from, so the agent in the page is the only way the person can point it. The Dock profile's rule that the agent bar may collapse (0.4.0) does not apply there: the bar is never collapsed or hidden, and it stays reachable while the page scrolls without covering content.
- **A finger can pin.** With no mouse drag (phone browsers do no HTML5 drag and drop): touching the agent's mark and then a target (tap to pin, with a clear state and a way to cancel), or dragging the mark with a finger by pointer events. The result is the same pin as a mouse drag's. Unpin and Revoke work by touch, with finger-sized targets.
- `APC_MOBILE_MEDIA` and `APC_MOBILE_VIEWPORT` (375 x 812, the reference viewport) are exported.
- **Conformance.** An adapter may give `page.mobile` (`ApcMobilePage`: `agentBar`, `pinByTouch`, `unpinByTouch`). The suite then checks that every connected agent is shown in the page and the bar cannot be collapsed, that a pin made by touch is read by the agent through `get_current_view`, and that unpin by touch removes it.
- An app that implemented 0.5 and meets the rule needs no change to its MCP surface or `apc.json`; `standard` in `apc.json` may say 0.5.0 or 0.6.0.

## 0.5.0 (draft, 2026-11-03)

Discovery with `apc.json`, and a clear answer to a drop an app cannot take (TIN-579). In `packages/protocol/src/manifest.ts`, `packages/server/src/apc-json.ts`, `packages/web/src/pinning.ts`, `packages/conformance`, `apps/dock/src/worker/hub.ts` and DESIGN.md section 17.

### `apc.json`

- **Every APC origin says what it is** at `GET {origin}/.well-known/apc.json` (`APC_JSON_PATH`), from that origin, as JSON (`ApcManifest`): `name`, `standard` (the version it implements), `origin` (exactly the origin it is served from), `profiles`, `mcp: { path }` (every grant's MCP URL on the origin starts with `origin + path`), and, with `"direct"`, `direct: { connect }` (the page on its own origin where the person connects an agent directly). At most `APC_JSON_MAX_BYTES` (16 KiB).
- **`profiles`** is `"direct"`, `"dock"` or both for an app, and `"hub"` alone for a dock's hub (`ApcRole`), so apps and tools can tell a dock from an app. A hub's file also has `dock: { pair, confirm }`, its pairing endpoints. A reader ignores profile words and keys it does not know.
- `parseApcManifest(raw, origin)` checks a file read from `origin`: the manifest, or `apc_json_wrong_origin` (it names another origin) or `apc_json_invalid` (anything else, with a reason). `declaresMcpUrl(manifest, url)` says whether an MCP URL is an http(s) URL on the origin and under `mcp.path`, with no encoded `/`, `\`, `.` or `%` (`%2f`, `%5c`, `%2e`, `%25`) in its path and no `.` or `..` segment after `mcp.path`, so a server that decodes later cannot be walked out of it. Every URL in a manifest is http(s) on its origin (`urlOnOrigin`; a `blob:` URL of the origin is not). `compareStandard` orders versions.

### Pairing (the Dock profile)

- **A hub reads the app's `apc.json` before it pairs** (`POST {hub}/apc/pair`), once the ticket and the app's origin have passed, under the hub's transport rules (0.3.0): a time limit and the byte cap, and no redirect followed for any app, verified or not (the file is the origin's own or none). It refuses the pairing (`ApcJsonRefusal`) when the file is missing (`apc_json_missing`: a 4xx), answered with a redirect (`apc_json_redirected`, any app: a redirect is the origin answering), cannot be read as one (`apc_json_invalid`), names another origin (`apc_json_wrong_origin`), does not list `"dock"` (`dock_not_offered`), or does not cover the MCP URL the app sent (`mcp_url_not_declared`). An unverified app whose file cannot be reached (no answer, a time limit, a 5xx) is refused too (`apc_json_unreachable`).
- A hub may keep the copy it read: the reference dock uses it for 10 minutes, then reads the file again. A verified app whose file cannot be reached at all (no answer, a time limit, a 5xx) keeps pairing, checked against the last copy the hub read, or on the operator's word when it has none. Even then the MCP URL must lie under `APC_DEFAULT_MCP_PATH` (`/mcp/`) and pass `declaresMcpUrl`'s checks: the operator's word covers the profiles, never the path. A definite answer (missing, a redirect, invalid, another origin) refuses a verified app too. The hub reads the file only when an app asks to pair: a pairing made stays until it is revoked or unpaired.

### A drop an app cannot take

- **A dock agent dropped on an app that offers only Direct is answered, never lost.** The app (with `@apc/web`: `enablePinning({ profiles, direct: { name, connect }, onDockUnsupported })`) takes the drop anywhere on the page and tells the person that it connects agents directly, with its connect page, in the words of `directOnlyNote(name)`. It never pairs or pins such a drop. `profiles` may be a list, a promise or a loader such as `loadApcProfiles` (the page's own `apc.json`, read with no redirect, 3 s and 16 KiB at most). A dock agent's drop made before the profiles are known is held, then answered or paired as they say. When they cannot be read, the drop is answered, never paired: `DockUnsupported.reason` is `unchecked`, in the words of `couldNotCheckNote(name)`, and a loader is asked again on the next drop (`reason` is `direct_only` for a Direct-only app). While it takes native drops, `enablePinning` sets `data-apc-native-drops` on the root element; the browser extension answers a Direct-only app (by its `apc.json`) that does not, in its own words (the domain first).

### Conformance

- The suite reads the app's `apc.json` through the adapter's `fetch`: served as JSON from the app's origin, valid, a standard from 0.5.0 to the suite's own, the profile under test listed (both with `link`), never `"hub"`, the grant's MCP URL under `mcp.path`, and `direct.connect` on its origin.

## 0.4.0 (draft, 2026-11-03)

`apc_link`: one agent on both paths, shown as one (TIN-578). In `packages/protocol/src/core.ts`, `packages/server/src/links.ts`, `packages/conformance` and DESIGN.md section 16.

- **The offer.** When a connection arrives (`initialize`) with the same MCP client as one already connected on the opposite path to the same app, the app puts `apc_link: { code, expires_in, note }` (`ApcLinkOffer`, key `APC_LINK_KEY`) on a result of the new connection, a top-level key of the structured result and of the text, like `attention`. On the Dock path it rides on a result of one of the app's own tools, never a core tool (the hub merges those). The app asks at most once per MCP session, from one `initialize` to the next.
- **The answer.** The agent calls the tool `apc_link({ code })` (`APC_LINK_TOOL`) on its other connection to the same app: directly, or through the dock as `<app>__apc_link`. The app answers `ApcLinkDone` (`{ linked: true, note }`), or a tool error `ApcLinkRefused` (`{ error: "link_refused", reason, message }`).
- **The code** has at least 96 random bits, works once and expires after `APC_LINK_TTL_S` (120) seconds. It is redeemed only on a different connection to the same app, on the opposite path, among those it was offered to (the same client, neither linked). Otherwise the reason is `unknown_code`, `expired`, `used`, `same_connection`, `same_path`, `not_offered` or `already_linked`. The app keeps only its hash.
- **Linking grants nothing.** Each path keeps its own grant, trimming and pin; the agent bar shows one agent with both paths. Revoke on a linked agent cuts both grants, and the person can unlink, which removes the link only.
- **The client on the Dock path.** The hub initializes an app as itself (`clientInfo.name` "apc-hub"), so it names the agent's own MCP client in `params._meta["apc.tineira.com/agent_client"]` (`APC_AGENT_CLIENT_META`) of that `initialize`. On the Direct path the client is the agent's own `clientInfo.name`.
- `oppositePath` gives the other profile. `APC_INSTRUCTIONS` and the `guide` prompt tell the agent what an `apc_link` key means.
- The hub names the agent's client to verified apps only: an unverified app (0.3.0) learns nothing of it, so it is never offered a link through the hub.

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
