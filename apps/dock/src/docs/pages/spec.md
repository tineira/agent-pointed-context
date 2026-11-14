# The APC specification

This is the contract an app, an agent and a dock share in Agent Pointed Context, at the version in the banner above. It is a draft: see [versioning and deprecation](#versioning-and-deprecation). The reference is the code in [`@tineira/apc-protocol`](https://github.com/tineira/agent-pointed-context/tree/main/packages/protocol) (types and constants) and the [conformance suite](/docs/conformance); this page says the same in words. Every change is in the [changelog](/docs/changelog).

**MUST** and **MUST NOT** mark what the reference code enforces: `@tineira/apc-protocol` refuses it, the reference hub refuses it, or the conformance suite fails an app that does not. Everything else describes how the reference apps behave and what a reader can rely on.

## Terms

- **App**: a web app that speaks APC: it has a page the person uses and an MCP endpoint agents call.
- **Agent**: the person's own AI agent, an MCP client (Claude, ChatGPT, Cursor, Grok and others).
- **Grant**: one agent's access to one app, with its own pin and name. A grant holds per agent, never per app. How the agent proves it holds the grant is the app's binding: in the reference apps a secret MCP URL (whoever holds it holds the grant); with OAuth a bearer token on a shared URL (see [the Direct profile](#the-direct-profile)).
- **Hub**: the server side of a **dock**, the window where the person keeps their agents. In the Dock profile the hub holds the grants and relays between agents and apps. The reference hub is at `apc.tineira.com`.
- **The person's page**: the app's page, open in a browser (or a desktop or phone app).
- **Profile**: how agents reach an app: **Direct** or **Dock**. An app offers one or both.

## The core

What every APC app implements, per grant, whichever way agents reach it. A hub is one more holder of a grant, so the core is the same for it.

### The view

The screen the person is on, as identifiers, trimmed to what the calling grant may see (`ViewPayload`):

| Field | |
|---|---|
| `screen` | the screen's name |
| `params` | key-only params: the period, filters |
| `selection` | at most one selected row, `{ kind, id }`, or null |
| `app_url` | where it is |
| `updated_at`, `age_seconds`, `stale` | when the page last reported it |
| `next` | the tool that reads the screen, or null |

### The pin and the focus format

The person drops the agent's mark on a **target**: `{ kind, id, part, params }`. A target names a row (`id`), a computation (`params`), or both, and **MUST** have one of the two.

- `kind` and every param key match `[a-z][a-z0-9_]{0,31}`; `id` matches `[A-Za-z0-9_.:-]{1,80}`.
- `part` names a piece of the target (`total`, `step:new`): a word, optionally followed by `:` and a token.
- `params` **MUST** carry keys only: string tokens, or lists of at most 20, in at most 1 KB. A bare number is an amount, never a key, and is refused (a month such as `2026-03` passes). Free text never travels.
- In the page, a pointable element carries `data-focus="kind:id"`, with `data-focus-part` and `data-focus-params` (JSON) when needed (`focusAttrs` in `@tineira/apc-protocol`).

The app keeps **one pin per grant**: a new drop replaces it, unread. It is **unread** while it was dropped after the last read that returned it. What the agent receives is the **focus** (`FocusPayload`): the target plus `app_url`, `pinned_at`, and `next` and `next_args`, the exact tool call that reads it. It may carry `part_note`, `trimmed` (what the grant may not see was left out) and `gone` (the row no longer exists).

### Attention

While a grant's pin is unread, every tool result on that grant carries `attention: { focus, note }`, as a top-level key of the structured result **and** of the JSON text, so a model that sees only text sees it too. It points at `get_current_view`; it never instructs.

### Presence

After each successful tool call, the app publishes a `PresenceEvent` to the person's page: `{ v: 1, grant_id, at, tool, kind, targets, count }`, ids only, `kind` being `read` or `write`, at most 20 `targets` of `{ kind, id }`. A read of a target **MUST** name it in `targets`. The page lights up what the agent read.

#### Wait events (since 0.11)

The page shows that an agent is listening (a drop reaches it now) from a second kind of presence message, never by guessing from recent calls: `PresenceWaitEvent`, `{ v: 1, grant_id, at, kind: "wait", state }`, `state` being `open` or `closed`, ids only, with no targets. It travels on the same channel, with the same rule: only the grant's owner reads it.

- **Optional, and only with an atomic place.** An app **MAY** send wait events, and only if it can tell takeovers and releases atomically (below); an app that cannot **MUST NOT** send them. A page that gets none shows no "waiting". An app that sends any **MUST** follow every rule in this section.
- An app that sends them **MUST** send `open` when a `wait_for_focus` claims the grant's one place for a wait, and `closed` when the wait gives it up: on return (a pin, a timeout, a closed page), on cancel, and when the grant is revoked or deleted during it. A wait refused (within `WAIT_CLAIM_GAP_S`, or on a revoked grant) sends nothing.
- **Atomic: what "can tell" means.** Its place for a wait says, in the step that takes it, whether another wait held it, and, in the step that gives it up, whether this wait held it (a compare-and-swap and a compare-and-delete on a store row). An app that can only check and then release, in two steps, **MUST NOT** send wait events: a claim between the two would end the page on `closed` while a wait runs, and no "waiting" beats a wrong one.
- **A takeover** sends the old wait's `closed`, then the new wait's `open`, both when the new wait claims the place. The old wait sends nothing when it later finds it was taken over. So a grant's last wait event always says whether a wait holds its place now.
- **A `closed` that never comes.** A worker can die before it sends `closed`. A page **MUST** treat an `open` as closed once it is older than the app's longest wait (its ceiling for `timeout_s`; 50 s, `WAIT_CEILING_DEFAULT_S`, unless the app sets its own) plus `WAIT_EVENT_MARGIN_S` (10 s), counted on the page's clock from when the event arrived, never from `at`. A live wait overruns its timeout by at most one poll and its last checks, which the margin covers; a lost `closed` leaves the page "waiting" for a minute at most. An app **SHOULD** tell a page that connects during a wait about it (Pulse and Signals send the open event first), and leave out one past the same limit. An `open` for a wait the page already has open keeps the first arrival, so a replay never restarts its clock; a page that first hears of a wait from a replay counts from then, so there a lost `closed` can show for up to twice the limit.
- **Dock grants.** A Dock agent waits on the hub, not on the app: the waits an app sees on a dock grant are the hub's relays. A page **MUST NOT** show a dock grant as waiting, whatever its wait events say. The dock shows its own agents' waits, from the hub's place for each agent.
- A page that reads the channel ignores a message it does not know, so a page before 0.11 is not affected (`flashTargets` ignores wait events). A page reads the five keys strictly and drops a key it does not know (the event only drives a display); an app sends exactly the five.

`announceWaits` in `@tineira/apc-server` sends the events from a grant's place for a wait, only from an `AtomicWaitSlot` such as `MemoryWaitSlots` (`registerApcTools` does it when given `waitPresence`); `foldWaitEvent` and `waitOpen` in `@tineira/apc-web` turn them into "a wait is open now", with the rule above.

### `get_current_view`

Takes no arguments. Returns `{ view, focus }`: the view (or null) and the focus (or null). Returning the focus marks it seen, once the result is final (see [seen once delivered](#seen-once-delivered)).

When the app cannot answer just now, it still answers in this shape, `{ view: null, focus: null, note }`, never a tool error or a shape of its own. A check on one item of the answer that cannot run hides that item and the rest answers; only a failure of the grant itself (its auth) fails the read. A dormant dock grant (since 0.10) answers `{ view: null, focus: null, idle: true, note }`: see [the grant's states](#the-grants-states).

### `wait_for_focus` and `then`

`wait_for_focus({ timeout_s })` holds the call until the person pins the agent, or `timeout_s` passes (a whole number from 1 to the app's ceiling; optional, 25 by default in `@tineira/apc-server`).

- A pin dropped during the wait is returned, marked seen: `{ focus, timed_out: false }`.
- With none, it returns `focus: null` with a `note`, and `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app knows the person's page is closed. `page_open` is left out while the person does not share their view (an app without that switch always shares).
- A dormant dock grant (since 0.10) answers at once `{ focus: null, timed_out: false, page_open: false, idle: true, note }`. An answer without `idle` (an app before 0.10) reads as page closed or unavailable, as before.
- **One wait per grant.** At most one wait of a grant delivers. A new wait takes over: the one it replaces ends at its next check with `focus: null, timed_out: false` and a note, and delivers and marks nothing. A new wait within 2 seconds of one still running (`WAIT_CLAIM_GAP_S`) is refused instead, with `focus: null, timed_out: false, retry_after_s` and a note. A wait whose request the client cancels stops and frees its place at once: MCP's `notifications/cancelled` (to a stateless server it comes in a POST of its own, so the app keeps its calls in flight per grant to find the one it names: `InflightCalls`), and an HTTP abort where the host reports one.

`then` is the loop hint: a key on a result, placed like `attention`, present while a page of the person's is open (and they share their view) **and** the grant was pinned in the last 30 minutes, read or unread (`THEN_PIN_WINDOW_MIN`; an app may set its own window). An open page with no recent pin gives no `then`, so an agent does not wait after every answer. It tells the agent to call `wait_for_focus` after answering, in the background if its client can, and otherwise to keep the wait short and never chain waits. It **MUST NOT** be on a `wait_for_focus` result that came back with no focus: that result ends the loop.

### Seen once delivered

Checking for a pin, or polling for one, never marks it seen: only returning it does. An app marks a pin seen only once the result that carries it is final (in a wait, after the wait gave its place up and checked once more that its request was not cancelled), and marks that exact pin, by its `pinned_at`, never a newer one dropped meanwhile. It returns the result whether or not the mark succeeds. So a pin may be delivered twice, and is never lost to a wait that was taken over or cancelled, or to a newer pin. MCP has no acknowledgement: a result lost after the app sent it, with no abort the app could see, cannot be told apart, and that pin is marked seen.

### Revoke from the app

Every agent in the app's agent bar, Direct or Dock, has Revoke. It holds in the app alone and at once: the app calls nobody, so it works with the hub down.

- From then on every request with the grant, whatever the method, **MUST** be answered with `{ error: "revoked", revoked_by, revoked_at, message }` (`RevokedAnswer`), `revoked_by` being the app's host. The HTTP status is the binding's: 403 with a secret URL, 401 with `WWW-Authenticate: Bearer error="invalid_token"` with a bearer token. An unknown or expired grant answers without a `RevokedAnswer` (404 with a secret URL), so a holder can tell "taken back" from "gone".
- A call already running when the grant is revoked **MUST** end as a tool error with the same answer and no app data. Whether a grant was revoked is told by the grant itself (its secret, and the hash the app keeps of it), never by a grant id a later grant may reuse.
- A revoked grant never works again. The person lets the agent back with a new grant: a new MCP URL (Direct), or a new drop with consent in the app and in the dock (Dock).

### Mobile

On a phone there is no dock window, extension or desktop pet to drag from, so the agent in the app's page is the only way to point it. In a viewport that matches `(pointer: coarse), (max-width: 640px)` (`APC_MOBILE_MEDIA`), on both profiles:

- The app shows all its agents in the page, each mark visible and usable for pinning. The agent bar is never collapsed or hidden there, and stays reachable while the page scrolls, without covering content.
- A finger can pin without a mouse drag (phones do no HTML5 drag and drop): tap the agent's mark, then the target ("tap to pin", with a clear state and a way to cancel), or drag the mark with pointer events. It makes the same pin. Unpin and Revoke work by touch, with finger-sized targets.

The reference viewport is 375 × 812 (`APC_MOBILE_VIEWPORT`). An app that claims 0.6.0 or later **MUST** give the conformance suite its page on a phone.

### The agent in the page

How an app shows each connected agent inside its page (since 0.11). These are SHOULDs: an app may keep its own mark for agents, but an app that shows a pet **SHOULD** show this one, the character the dock draws. `@tineira/apc-web` ships it: `createPet` and `<apc-pet>`, the header `<apc-pets>`, the pin badge `<apc-pin>`, the brand logos and `petState`.

- **The pet.** One character for every agent: a soft blob with two eyes, with the agent's logo as a badge at its bottom right. It is APC's own; no vendor's character is drawn or animated.
- **The header.** The pets sit in the app's header, next to the person's account, up to 3 of them, then one button: "+N" for the rest, or a list button when all show. That button opens a popover with every agent: what it is doing, where its pin is (a click goes there) and whether it read it. A pet whose pin is on another page wears a dot. A pet is only a mark: a click, a tap or Enter on it is pinning's (it arms the agent), never the popover's, so the popover never covers the target the person is about to tap.
- **The pin badge.** Where an agent is pinned, the element wears the agent's logo, with × to unpin. Several agents on one element each keep a badge: the app places them side by side, so every × stays reachable (the package gives each badge its place, `pinStackIndex`, and the step, `PIN_STACK_STEP`).
- **Marks.** A pet and a pin badge are marks: they carry `data-apc-mark` and `data-grant`, so the person drags them (or taps them, then a target) to point the agent, as with the agent bar.

**States.** The pet has 8 states. The app drives each one from data it has, and shows a state only when that data says so; nothing is guessed from timing:

| State | What drives it in an app |
|---|---|
| `dragging` | the person is dragging this agent's mark, in this page |
| `pairing` | a pairing request of this agent waits on the person |
| `offline` | no agent client is connected on the grant, or the grant was revoked |
| `pinned` | the agent's pin is unread |
| `calling` | a call is in flight, or the page just heard one (presence) |
| `read` | the agent just read its pin (shown for 6 s, `READ_HOLD_MS`) |
| `waiting` | a `wait_for_focus` of this agent is open, as the page-readable wait signal says. Never inferred from how recently the agent called |
| `idle` | connected, and none of the above |

The first state that holds, top to bottom, is shown (`petState`).

**Motion.** One `requestAnimationFrame` loop per window drives every pet in it. It stops while the page is hidden and slows down (20 frames a second) once every pet has kept its state for 10 s. With `prefers-reduced-motion: reduce`, each pet is a still pose of its state.

**Phone.** In a viewport that matches `APC_MOBILE_MEDIA`, the pets stay in the header, side by side, and every tap target (a pet, the list button, ×, the popover's links) is at least 44 px.

**Logos.** A badge is the brand's logo (`brandFor` the client's declared name), else the icon the client sent, else a neutral mark in a colour of the agent's own. Brands only: never a vendor's mascot. A logo says which agent is connected, never that it is verified.

**Colour scheme.** The pet **SHOULD** follow the page's colour scheme.

- On a light page, the light pet: a dark body with a white outline and eyes.
- On a dark page, the inverse pet: a near-white body (not pure white), a dark outline and eyes, and a shine tuned to the light body.
- The badge's white disc keeps a thin outline in the inverse pet, so it reads on both bodies. The orange ring, the "!" and the other state marks do not change.
- The package takes `scheme: "light" | "dark" | "auto"`. `auto` follows `prefers-color-scheme`; an app with its own theme switch passes its theme. An app with a strict palette tints the body and the line (`tint`, or `--apc-pet-body` and `--apc-pet-line`).

## The Direct profile

The agent connects to the app's own MCP endpoint.

- **A grant per agent, whatever the auth.** The standard does not fix how the agent authenticates. A grant **MUST** have a stable id per agent connection (pins, views, presence and `apc_link` are keyed by it), be revocable from the app alone (ending everything that could bring it back without the person: with OAuth, its refresh tokens and authorization too) and checked before and after each tool call, tell revoked apart from expired or unknown, and be trimmed per grant (`GrantRequirement`). Any binding that meets that will do.
- **The secret URL** (the reference apps): the person makes an agent in the app's page; the app makes a grant with a secret of 128 random bits, which is the last segment of the agent's MCP URL (`newDirectGrant` in `@tineira/apc-server`).
- **OAuth 2.1**: every grant shares one MCP URL, and the bearer token names the grant. A revoked token answers 401 with the `RevokedAnswer` body, so the client does not just authorize again.
- **Hosts with no long-lived process** (stateless functions and a database) still bound `wait_for_focus` by their function's time limit (their own ceiling for `timeout_s`), tell a closed page from a heartbeat the page sends, and check the grant before and after each tool call.
- **The agent list**: where the person makes and names agents and copies the URL, or a prompt that asks the agent to add it (`<apc-direct-agents>` in `@tineira/apc-web`). An agent names itself on `initialize` (`clientInfo.name`) until the person renames it.
- **The agent bar** shows Direct agents in full, always: the app is the only place the person sees and points them.

## The Dock profile

The agent connects once, to a hub. The person drags it from the dock onto any app they paired.

### The drop

The dock puts the agent on a drag with the type `application/x-apc-agent` and the payload `{ v: 1, agent, hub, ticket }`: a public handle, the hub's bare origin, and a ticket. The payload **MUST NOT** hold a secret or an MCP URL: any page the agent is dropped on can read it. The **ticket** is single use, lives 240 seconds (since 0.9; 60 before), is bound to that agent, and opens a pairing request or a confirmation and nothing else. The reference dock refreshes a ticket once it has less than 180 seconds left (it checks every 10), so a drag carries one with about three minutes left, and the app's two-minute consent fits in it.

### Consent in the app

Consent is the app's server's to check, never its page's alone. The page sends every dock drop to its server. For an agent it holds no grant for (never paired, revoked, or one the dock no longer confirms), the server answers `consent_required` with a nonce; the page shows its consent ("Let your agent from the dock at … read Orders?") with that nonce, and the Allow sends it back. The server makes a grant only for a request that brings the nonce back. In the reference apps (`DockConsent` in `@tineira/apc-server`) the nonce has 128 random bits, works once, for the same dock and agent, for two minutes. One drop of an agent is answered at a time: a second request while the first waits on the hub answers `pairing_in_progress` (see [one pending pairing](#one-pending-pairing)).

Since 0.9 the consent shows a [pairing code](#the-pairing-code), and the server answers `consent_required` with both: `{ consent, pairing_code }`. The page shows the code formatted (`K7M-4P2`): "After Allow, your dock asks for this code: **K7M-4P2**. Type it only in your own dock; never give it to anyone. Whoever types it gets this access."

### The pairing code

A drag can be put on any page, and anyone who runs a dock can make tickets for their own agent. Without a code, someone could lure an app's owner into dropping their agent and clicking Allow, and approve the pairing in their own dock. The code closes that: only the app's owner sees it, and the dock's Allow needs it.

- The app **MUST** make a new code with every consent: 6 characters of Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 30 bits; `newPairingCode` in `@tineira/apc-server`), shown only on the app owner's page. After the Allow it sends the code, raw (`K7M4P2`), in `pairing_code` of `/apc/pair`, and nowhere else: not over MCP, not in a URL, not to `/apc/confirm`.
- The hub keeps it with the pending pairing and **MUST NOT** show it: not in the dock's state, not in what it sends the dock's pages, not in any answer. The dock owner types it to approve; the hub compares it in constant time with what the app sent, ignoring case, spaces and dashes (O reads as 0, I and L as 1). A missing or malformed code is refused and not counted. A wrong one counts (`wrong_pairing_code`, with `attempts_left`); the fifth removes the request and gives the grant back (`pairing_code_refused`). A request with a code that nobody approves goes after two minutes, its grant given back. A match clears the code. Deny and unpair need no code.
- The app **MUST** keep the grant only when the hub acknowledges the code (below), and delete it, before it answers its page, on any other answer: a hub that does not check codes never holds a grant.
- The reference hub requires the code: it refuses a pairing without one (`pairing_code_required`). Other hubs SHOULD require it too.
- After the Allow the reference apps show the code again, with the time left and Cancel (the app's revoke), until the hub connects (its first `initialize` on the grant) or the grant goes, and say: "If your dock doesn't ask for this code, the agent wasn't yours: Cancel."

### Pairing: `POST {hub}/apc/pair`

With the person's yes, the app's server makes a grant and hands it to the hub, server to server:

```json
POST https://apc.tineira.com/apc/pair
{ "ticket": "…", "agent": "ag_…", "app": { "name": "Orders", "origin": "https://orders.example" }, "mcp_url": "https://orders.example/mcp/…", "pairing_code": "K7M4P2" }
```

The hub checks the body first, before it reads or spends the ticket: a `pairing_code` that is present but not a code (`null`, `""`, a number) is `invalid_pairing_code`, so a malformed request leaves the ticket good. Then it checks the ticket, the app's origin and its [`apc.json`](#apcjson) (it **MUST** refuse the pairing when the file is missing, redirected, invalid, names another origin, does not list `"dock"`, or does not cover `mcp_url`), and answers HTTP 200 with `{ ok: true, pairing_id, status: "pending", agent: { name, icon }, pairing_code: "required" }`, or HTTP 400 with `{ ok: false, error }`. `pairing_code: "required"` is the acknowledgement: the hub keeps the code and will ask for it. The pairing counts only when the person has also said yes in the dock, with the code. The app links the grant to the agent only once the hub took it, and pins it.

The app **MUST** treat any other answer as a refusal and delete the grant: a redirect (it calls the hub with `redirect: "error"`), any status but 200 and 400, a 200 without the acknowledgement (`hub_ignores_pairing_code`), no answer within its time limit. `pairWithHub` in `@tineira/apc-server` does exactly that. Since 0.10 the call also follows [the app's rules on the hub call](#the-app-and-the-hub-call) (M1 to M9), and the grant is [in flight](#the-grants-states) until the acknowledgement. Only an absent `pairing_code` is a pairing without a code, from an app before 0.9: the reference hub refuses it with `pairing_code_required`, and other hubs SHOULD.

### Every drop: `POST {hub}/apc/confirm`

On a drop of an agent it already holds a grant for, the app asks the hub whether that pairing still stands: `{ ticket, agent, mcp_url }`. HTTP 200 with `{ ok: true, status }` (`"pending"` or `"paired"`) pins it; while it is pending the reference apps show the pairing code again. The answer never carries the code. `{ ok: false, error: "not_paired" }` means the dock no longer pairs it: the app drops the grant and asks the person again (the ticket is still good). A hub never confirms a revoked or blocked pairing. Since 0.10 the hub expires overdue requests before it answers (H2) and answers `not_paired` for a pairing it holds as ended; what the app does with a grant still in handoff is in [one pending pairing](#one-pending-pairing).

### The hub gives a grant back: `POST {app}/apc/revoke`

When the person unpairs an app in the dock, denies its request, types the fifth wrong code, lets the request expire, or drops the agent again before approving (H3), the hub sends `{ mcp_url }` to the app's `/apc/revoke`, and the app ends that grant and deletes its pin. This is the hub's side; the app's own Revoke is core and needs no hub.

Since 0.10 (M7) `/apc/revoke` is public and **MUST** answer the same HTTP 200 to any input, with its body capped. It ends a grant whose secret hash matches and that is in any state but revoked or ended, in flight included; that grant then answers 404. On a revoked or already ended grant it does nothing: revoked stays revoked.

### The grant's states

Since 0.10 a dock grant has a state in the app, and the state says what the grant answers (`DockGrantState` and `dockGrantAnswer` in `@tineira/apc-protocol`). The states, in order of precedence, are **revoked > ended > in flight > handoff > dormant > live**: the first that applies is the one used.

| State | Begins | Ends |
|---|---|---|
| **in flight** | the Allow | the hub's acknowledgement of `/apc/pair`; on a failure the grant ends before the page hears back. A grant still in flight `T_ack` after the Allow **MUST** end, whatever happened to the call |
| **handoff** | the acknowledgement | the first `initialize` whose connection is committed |
| **live** | the committed `initialize` | dormancy, revoke or end |
| **dormant** (SHOULD) | `T_idle` after the last wake action (live grants only) | the next wake action |
| **ended** | `T_connect` after the acknowledgement with no committed `initialize` (**MUST**); a give-back (`/apc/revoke`); long dormancy | never |
| **revoked** | the owner's Revoke, or Cancel | never |

The time limits (`T_ACK_MAX_MS`, `T_CONNECT_MAX_MS` and the recommended times in `@tineira/apc-protocol`):

- `T_ack` is at most 30 seconds: more than the hub call's own 10-second deadline (M3), so an answer that comes in time is kept.
- `T_connect` is at most 10 minutes.
- `T_idle` is the app's; 30 minutes is recommended. Long dormancy is the app's; 30 days is recommended.

**What each state answers** (**MUST** wherever the app implements the state):

| Method | in flight | handoff | live | dormant | ended | revoked |
|---|---|---|---|---|---|---|
| any request | HTTP 404, state unchanged | (rows below) | (rows below) | (rows below) | HTTP 404 | 403 `RevokedAnswer` |
| `initialize` | 404 | served; commits the connection | served | served, does not wake | 404 | `RevokedAnswer` |
| `ping`, `tools/list` | 404 | served | served | served | 404 | `RevokedAnswer` |
| `tools/call` | 404 | tool error `pairing` | app data | core tools: the idle shapes; other tools: tool error `idle` | 404 | `RevokedAnswer` |
| other methods (`resources/*`, `prompts/*`) | 404 | JSON-RPC -32000, `data: { error: "pairing", message }` | as the app serves them | JSON-RPC -32000, `data: { error: "idle", message }` | 404 | `RevokedAnswer` |
| notifications | 404 | ignored (202) | as 0.8 | as 0.8 | 404 | `RevokedAnswer` |

The first row covers every request to the grant's URL, whatever its method, including a `GET`, a `DELETE` or a body that does not parse. A 404 leaves the state unchanged. `RevokedAnswer` is 403 with the secret URL, as in 0.8. No answer in handoff or dormant carries `attention`, `then`, an `apc_link` offer or a presence event.

**The tool errors** are `{ error: "pairing", message }` (the person has not finished pairing) and `{ error: "idle", message }` (the person is away from the app), carried in both `structuredContent` and `content[0].text` (as JSON), with `isError: true` (`DockGrantErrorAnswer`).

**The idle shapes** are **MUST** for an app that sleeps:

- `get_current_view` answers `{ view: null, focus: null, idle: true, note }` (`idleCurrentView`).
- `wait_for_focus` answers `{ focus: null, timed_out: false, page_open: false, idle: true, note }` at once (`idleWaitForFocus`).
- An answer without `idle` (an app before 0.10) reads as unavailable or page closed, as before. Dormant returns no data, and is distinct from revoked, unavailable and page closed.

**The transitions:**

- **`initialize` fails closed.** It **MUST NOT** return a result unless the move out of handoff has committed. On a persistence failure it answers JSON-RPC -32603 or HTTP 500, so the hub's introduction fails where the person sees it.
- **The commit out of handoff is conditional.** It happens only if the grant is neither revoked nor ended, in the same atomic step. If Cancel or an end won the race, `initialize` answers by the state that won: `RevokedAnswer` or 404.
- **The acknowledgement's move is conditional too.** The move from in flight to handoff happens only if the grant is neither ended (by a give-back or `T_ack`) nor revoked, in the same atomic step.
- **A served call** is a `tools/call` that returned app data in the live state. `ping`, `tools/list`, `initialize` and the `pairing` and `idle` errors are not served calls.
- **Wake actions** are authenticated actions of the grant's own user on the app's page: a page heartbeat, which **MUST** be sent at least every `T_idle / 2` while the page is open, or a confirmed drop. Agent traffic (`initialize`, `ping`, `tools/list`, `tools/call`) never wakes a grant and never extends it.
- **Cancel revokes.** Cancel, on the waiting card, is allowed only in handoff, before any served call; afterwards the grant answers `RevokedAnswer`. The check and the revoke are one atomic step, so Cancel never revokes a live grant or one that has served a call, and every tool handler re-checks revoke after its work and before it returns data (as 0.8 already requires).

A Dock grant serves app data only while live: after the acknowledgement **and** a committed `initialize`, and while not dormant, ended or revoked.

### One pending pairing

There is one pending pairing per (user, hub, agent), at the app and at the hub (H3).

- **Before the acknowledgement**, a new drop may replace the pending consent, with a new nonce and a new code. The stale Allow fails closed (`consent_expired`). A second Allow while the first waits on the hub gets `pairing_in_progress`.
- **After the acknowledgement and before the committed `initialize`**, a drop calls `/apc/confirm`. On `pending` with the app's own stored expiry still ahead, the page shows the **same** code and the time left: no new consent and no new code. The drop's target replaces the pending pin.
- On `not_paired`, or once the stored expiry has passed, the app ends the grant and starts a fresh consent. A hub answers `not_paired` for a pairing it holds as ended, too.
- The app cannot tell "waiting for the code" from "the code was accepted and the hub is introducing": both answer `pending`, and the app shows the same code for both. While the hub is introducing, the dock's own page says it is connecting and takes no code; a code typed then does not count against the five wrong codes.
- On `paired` before the app has seen `initialize`, the grant stays in handoff. The page hides the code and says it is connecting, and the drop's target is pinned once the grant is live. Only `initialize` moves the state, never a `confirm` answer.
- **The page treats its stored expiry as the truth.** It clamps the countdown at zero, stops showing the code past it, and says the dock did not finish in time.

### The app and the hub call

What an app **MUST** do around the drop and the hub call (`DockAppRequirement`):

- **M1. Allowlist.** Parse the drop's `hub` with `new URL`. Refuse anything unparsable, not `https:` (except a declared local-dev origin), or carrying userinfo, a path other than `/`, a query or a fragment. Compare `url.origin` for exact equality with a constant allowlist, on the drop **and** again on the Allow. Otherwise answer `hub_not_allowed`, with no consent and no grant.
- **M2. Redirects.** Never follow a redirect. Call the hub with `redirect: "manual"` (or `"error"` where the runtime implements it: Cloudflare Workers does not, and throws a `TypeError` before sending anything), and refuse any 3xx, an `opaqueredirect` or `response.redirected`.
- **M3. Time limit.** One deadline, at most 10 seconds (`HUB_CALL_DEADLINE_MS`), covers the headers and the whole body.
- **M4. Byte cap**, at most 8 KiB (`HUB_ANSWER_MAX_BYTES`). A `content-length` that is present must be ASCII digits only (`/^\d+$/`) and at most the cap, or the answer is refused before it is read. The decoded stream is cut at the cap. An absent `content-length` is not refused. The declared and decoded lengths are never compared, because of `gzip`.
- **M5. No lock across the call.** No database transaction or row lock is held across the hub call. One drop, Allow or confirm runs at a time per (user, hub, agent), across instances (an advisory lock and a partial unique index will do).
- **M6. Owner-session endpoints** (the drop, the consent and its Allow, the heartbeat, Cancel) need the owner's authenticated session, and every state change is a `POST` with the media type `application/json`. A request that carries `Origin` is refused unless it equals the app's **configured** public origin (behind a proxy, the deployment configures its external origin; the app never derives it from the request URL). A request whose `Sec-Fetch-Site` is `cross-site` or `same-site` is refused. A request with neither header comes from a client that is not a browser (Pulse for Windows, say) and is taken on the session alone: a browser always sends `Origin` on a cross-origin `POST`, so a hostile page cannot strip it, and `application/json` across origins needs a CORS preflight the app never grants. A heartbeat may be a WebSocket; its handshake follows the same `Origin` rule.
- **M7. `/apc/revoke`**, as [above](#the-hub-gives-a-grant-back-post-appapcrevoke).
- **M8. `apc.json`** lists `dock` only when the app can pair right now (its configuration is present), computed per request or cached 60 seconds at most (a `max-age` of 60 or less).
- **M9.** The app sends hub requests to the parsed `url.origin` of M1, never to the raw `hub` string.

### The hub's duties

What a hub **MUST** do (`DockHubRequirement`; the reference hub follows them):

- **H1.** The hub sends `initialize` on a grant's MCP URL only after the dock owner approved the pairing with the code, and sends no `initialize`, `tools/list` or `tools/call` before that. While approving, the dock takes no code.
- **H2.** `/apc/confirm` expires overdue pending requests before it answers, so an expired request answers `not_paired`.
- **H3.** `/apc/pair` replaces an unapproved pending request for the same agent and app origin rather than keeping two. Unapproved means no correct code has been accepted yet: H3 never replaces an approving or paired one. The replaced request does not count toward the hub's pairing cap. The hub gives its URL back (`/apc/revoke`) after answering `/apc/pair`, asynchronously, and only when that URL differs from the new request's. The new request's wrong-code count starts at 0, since it carries a new code from a fresh consent.
- **H4.** The hub relays `{ error: "pairing" }` and `{ error: "idle" }` as tool errors: verbatim for verified apps, inside the untrusted envelope for unverified ones. It carries `idle: true` per app in `get_current_view`'s `views[]`. It keeps an idle flag per app, unverified apps included, cleared by the next answer that lacks `idle`. An app's idle answer never ends the hub's wait early and never reads as page closed. When every app is idle, `wait_for_focus` answers `{ focus: null, timed_out: false, page_open: false, idle: true, note }`, saying the apps are asleep and wake when the person opens them, not that the person left. With a mixed fleet, the answer names the apps that are asleep, and the hub waits as usual.
- **H5.** A 404 from a pairing that was introduced, or is in handoff, is reported as `pairing_ended` ("drop the agent on the app again"), never as `app_unreachable`. The hub keeps an `ended` tombstone, like `revoked`: outside the cap, deleted on a re-pair, and `relay()` and `decide()` on it answer `pairing_ended`, not `unknown_app` or `unknown_pairing`.
- **H6.** The hub's instructions and `guide` say what the errors mean. `idle`: the person is away from that app; tell them, and do not retry. `pairing`: the person has not finished pairing yet; wait, or tell them.
- **H7.** The copy of an app's `apc.json` used for a pairing decision is at most 60 seconds old: the hub fetches it fresh on `/apc/pair`, or honours a `max-age` of 60 or less. A 5xx or unreachable `apc.json` never falls back to a stale copy that lists `dock`: the pairing is refused (`apc_json_unreachable`).

### The derived secret (optional)

An app may derive a dock grant's secret instead of storing a random one. The recipe is optional; what holds either way is that the hash and salt the app stores cannot rebuild the secret.

- **Inputs:** K, at least 32 random bytes; `<app>`, a fixed lowercase tag without `|`, never changed (changing it equals rotating K); a salt of 16 random bytes, base64url; the grant id, without `|`.
- **The secret** is `base64url_unpadded(HMAC-SHA256(K, "<app>-dock-v1|<grantId>|<salt>")[0..16])`: 22 characters, 128 bits.
- **Storage:** keep `SHA-256(ascii(secret))` and the salt, and look a grant up by a unique index on that hash (a hash-index lookup is acceptable). Never compare the secret in plaintext; a comparison in memory compares digests in constant time.
- **Rotation:** rotating K silently ends every Dock grant at its next confirm (`not_paired`, then a new consent), and direct calls get 404. It is a mass end: not a kill switch, and not routine. To rotate without that, keep a key id per grant and derive with that grant's key.

### What secures the Dock

The Dock's security is the 0.9 pairing code plus a secret URL over TLS. There is no end-to-end encryption, and the hub sees what it relays.

The pairing code gates the honest hub's approval, and that hub's `initialize` is the owner's yes (H1). The code never gates the app's data path. Against a hub that breaks H1, or against someone holding the URL, the URL is the credential, as in 0.9. No app can detect a breach of H1: hub conformance and the operator's allowlist are the controls. Other ways to authenticate the link from the app to the dock are left open for future versions.

The page never sees the MCP URL or the secret, and the code is shown only on the owner's page and sent only in `/apc/pair`. APC covers pointing only: confirmations and approvals of what an agent does are outside the standard.

### The hub's tools

A hub exposes to the agent its own `get_current_view` (the focus, now with `app: { id, name, origin }`, and a `views` list, one per paired app), one `wait_for_focus` across all apps, `list_app_tools`, and `call_app_tool({ app, tool, args })`. Each app's other tools are relayed as `<app>__<tool>` (at most 64 characters). The hub rewrites `next` and `next_args` to its own tool names, removes the apps' `attention` and `then`, and adds its own. Since 0.10 it relays the apps' `pairing` and `idle` answers as [H4](#the-hubs-duties) says. A browser extension is one more app of the hub, with id `page`; a page reading is the focus kind `page_reading`, read with `page__get_reading`.

## `apc_link`

An app that offers both profiles shows the same agent on both paths as one.

- **The offer.** When a connection arrives (`initialize`) with the same MCP client as one already connected on the opposite path, the app puts `apc_link: { code, expires_in, note }` on a result of the new connection, placed like `attention`, at most once per MCP session. On the Dock path it rides on one of the app's own tools, never a core tool.
- **The answer.** The agent calls `apc_link({ code })` on its other connection: directly, or through the dock as `<app>__apc_link`. The app answers `{ linked: true, note }` or the tool error `{ error: "link_refused", reason, message }`.
- **The code** has at least 96 random bits, works once, for 120 seconds, only on a different connection on the opposite path that it was offered to. Otherwise the reason is `unknown_code`, `expired`, `used`, `same_connection`, `same_path`, `not_offered` or `already_linked`. The app keeps only its hash.
- **Linking grants nothing.** Each path keeps its grant, trimming and pin; the agent bar shows one agent. Revoke on it cuts both grants; the person can unlink.
- **Which client.** On Direct, `clientInfo.name` of the agent's `initialize`. On Dock the hub initializes the app as itself, so it names the agent's own client in `params._meta["apc.tineira.com/agent_client"]`, to verified apps only.

## `apc.json`

Every APC origin **MUST** say what it is at `GET {origin}/.well-known/apc.json`, from that origin, as JSON of at most 16 KiB:

```json
{ "name": "Orders", "standard": "0.11.0", "origin": "https://orders.example",
  "profiles": ["direct", "dock"], "mcp": { "path": "/mcp/" },
  "direct": { "connect": "https://orders.example/agents" } }
```

- `standard`: the version of this standard it implements.
- `origin`: exactly the origin it is served from; a file that names another is refused.
- `profiles`: `"direct"`, `"dock"` or both for an app; `"hub"` alone for a hub, which then also gives `dock: { pair, confirm }`. A reader ignores words and keys it does not know. Since 0.10 an app lists `"dock"` only while it can pair, and the file is computed per request or cached 60 seconds at most (M8).
- `mcp.path`: every grant's MCP URL on the origin starts with `origin + path`. Unless `mcp.endpoints` is present (below), a hub pairs only an MCP URL under it, with no encoded `/`, `\`, `.` or `%` and no `.` or `..` segment after it. A Direct app whose grants share one URL (a bearer token names the grant) may serve it at `mcp.path` itself, or without its last `/` (`/api/mcp` for `"/api/mcp/"`).
- `mcp.endpoints` (0.11, optional): the exact MCP endpoints of the origin and the profiles each serves; when present, only they cover a URL ([below](#mcpendpoints-011)).
- `direct.connect` (with `"direct"`): the page on the same origin where the person connects an agent directly.
- `direct.auth` and `direct.resource_metadata` (optional, information only): how agents authenticate (`"url"`, `"oauth"`) and, with OAuth, the protected-resource metadata URL on the origin. A reader never requires them.

A dock agent dropped on an app that offers only Direct is answered, never lost: the page tells the person that it connects agents directly, with its connect page (`directOnlyNote`), and pairs nothing. A page that cannot read its own `apc.json` pairs nothing either.

### `mcp.endpoints` (0.11)

An origin that serves several MCP endpoints, some of them not APC, declares the APC ones exactly:

```json
"mcp": { "path": "/mcp/",
         "endpoints": [ { "path": "/mcp", "profiles": ["direct"] },
                        { "path": "/mcp/{secret}", "profiles": ["dock"] } ] }
```

Each entry is a `path` and the `profiles` it serves. A path is exact. `{secret}` as its last segment stands for one grant's secret. When `mcp.endpoints` is present, a reader of 0.11 or later **MUST** cover an MCP URL only by an entry of it, never by `mcp.path`: anything else on the origin is not APC. `mcp.path` may stay beside it for readers before 0.11, which still cover all of it. An app keeps it while any such reader exists (a hub, the browser extension, its own bundled `@tineira/apc-web`); one that wants the narrower rule for every reader leaves it out and accepts that older readers refuse the file.

**Reading the file.** A reader **MUST** treat the file as invalid when:

- `mcp` has neither `path` nor `endpoints`, or has a `path` that fails the rule above (with or without `endpoints`);
- `endpoints` is there and is not a list, or has more than 16 entries;
- an entry is not an object; its `path` is not a string of at most 200 characters that starts with `/`, or holds `%`, `?`, `#`, `\`, whitespace, a control character or a format character (Unicode `White_Space`, `Cc`, `Cf`), or a `.` or `..` segment; its `profiles` is not a list of at most 8 strings; or two entries have the same `path`;
- `mcp.path` is there and a usable entry lies outside it: `P/{secret}` needs `P/` to start with `mcp.path`; an exact path needs to start with `mcp.path` or to equal it without its last `/`.

A reader **MUST** drop, whole, an entry it does not fully understand, and never use part of it: an entry with any key but `path` and `profiles`, or a path outside the 0.11 grammar (fixed segments of `A-Z a-z 0-9 . _ ~ ! $ & ' ( ) * + , ; = : @ -`, then at most one final `/{secret}` after at least one fixed segment; so no trailing `/`, no empty segment, no other `{…}`). A dropped entry covers nothing, but still names its path (below). Profile words other than `direct` and `dock` are left out of an entry one by one, and so is `dock` on an exact path: a Dock grant is one URL per grant. An entry may list a profile the top-level `profiles` does not (an app that is not pairing right now, M8); it covers nothing for that profile. A file left with no usable entry still parses, and covers nothing.

**Matching.** A reader **MUST** cover an MCP URL for a profile R (`direct` or `dock`; a hub pairing a Dock app checks `dock`) only when all of these hold:

1. It is an absolute `http`/`https` URL on the file's origin, with no user or password.
2. The string holds no `?`, `#` or `%`, and is exactly `origin + path` as a URL parser writes it back: no dot segment, backslash, upper-case host, written default port or encoding.
3. The top-level `profiles` and a usable entry both list R, and either:
   - the entry is exact, the path equals it (case-sensitive), and the grants share the URL (a bearer token names the grant); or
   - the entry is `P/{secret}`, the path is `P/s` where `s` is 16 to 128 of `A-Z a-z 0-9 _ -`, and no entry's path equals it, usable or dropped, or begins with it followed by `/`, compared without ASCII case (exact wins: a sibling an entry names, or the fixed parent of a deeper entry, is never a secret).

An app **MUST NOT** serve anything but its grants on a child of `P` that fits the secret, other than the exact entries it declares: `P/{secret}` claims every such child. Keep fixed routes out of a `{secret}` parent. A file that narrows does not end pairings already made; the app revokes them. `declaresMcpUrl(manifest, url, { profile, shared })` and `mcpUrlCoverage` in `@tineira/apc-protocol` implement this, and these vectors are its tests (`packages/protocol/test/mcp-endpoint-vectors.json`):

<!-- mcp-endpoint-vectors:start -->
```json
{
  "shared-urls": {"name":"Example","standard":"0.11.0","origin":"https://www.cars.example","profiles":["direct"],"mcp":{"path":"/api/","endpoints":[{"path":"/api/mcp","profiles":["direct"]},{"path":"/api/ops/mcp","profiles":["direct"]}]},"direct":{"connect":"https://www.cars.example/connect"}},
  "split": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct","dock"],"mcp":{"path":"/mcp/","endpoints":[{"path":"/mcp","profiles":["direct"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ledger.example/connect"}},
  "split-not-pairing": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct"],"mcp":{"path":"/mcp/","endpoints":[{"path":"/mcp","profiles":["direct"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ledger.example/connect"}},
  "named-siblings": {"name":"Example","standard":"0.11.0","origin":"https://ops.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/operations-console","profiles":["direct"]},{"path":"/mcp/tenant-admin-console/mcp","profiles":["direct"]},{"path":"/mcp/future-console-entry/","profiles":["direct"]},{"path":"/mcp/later-feature-route","profiles":["direct"],"methods":["POST"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ops.example/connect"}},
  "direct-template": {"name":"Example","standard":"0.11.0","origin":"https://orders.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/{secret}","profiles":["direct"]}]},"direct":{"connect":"https://orders.example/connect"}},
  "unknown-key": {"name":"Example","standard":"0.11.0","origin":"https://orders.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/{secret}","profiles":["dock"],"requires":"pairing_code"}]},"direct":{"connect":"https://orders.example/connect"}},
  "path-only": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct","dock"],"mcp":{"path":"/mcp/"},"direct":{"connect":"https://ledger.example/connect"}}
}
```

| File | URL | Profile | Shared | Covered | Why |
|---|---|---|---|---|---|
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | **yes** | a grant's secret under the dock template |
| `split` | `https://ledger.example/mcp` | direct | yes | **yes** | the shared Direct URL, with a bearer |
| `split` | `https://ledger.example/mcp` | direct | no | no | an exact endpoint covers a shared URL only |
| `split` | `https://ledger.example/mcp` | dock | no | no | the hub never pairs a shared URL |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | direct | no | no | the template serves dock only |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | (none) | no | no | no profile given covers nothing |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/x` | dock | no | no | a secret is one segment |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnO` | dock | no | no | 15 characters is too short for a secret |
| `split` | `https://ledger.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | dock | no | no | 129 characters is too long for a secret |
| `split` | `https://ledger.example/mcp/abcdefgh.ijklmnop` | dock | no | no | no dot in a secret |
| `split` | `https://ledger.example/mcp/abcdefgh~ijklmnop` | dock | no | no | no tilde in a secret |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?` | dock | no | no | an empty query |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv#` | dock | no | no | an empty fragment |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?a=1` | dock | no | no | a query |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/` | dock | no | no | a trailing slash |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv;x=1` | dock | no | no | a matrix parameter |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv\|` | dock | no | no | a pipe |
| `split` | `https://ledger.example//mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a double slash |
| `split` | `https://ledger.example/mcp/./AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a dot segment |
| `split` | `https://ledger.example/mcp/%41AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | any percent-encoding |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/..%2f` | dock | no | no | encoded traversal |
| `split` | `https://ledger.example/mcp/%2e%2e%2fadminabcdefghij` | dock | no | no | encoded dots and slash |
| `split` | `https://ledger.example/mcp\AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a backslash |
| `split` | `https://ledger.example/Mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | the path is case-sensitive |
| `split` | `https://LEDGER.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | an upper-case host is not written as parsed |
| `split` | `https://ledger.example:443/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a written default port |
| `split` | `https://u:p@ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | credentials |
| `split` | `blob:https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a blob: URL has the origin, not the scheme |
| `split` | `https://evil.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | another origin |
| `split` | `not a url` | dock | no | no | not a URL |
| `split-not-pairing` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | the top level does not list dock: not pairing right now |
| `split-not-pairing` | `https://ledger.example/mcp` | direct | yes | **yes** | Direct still covered |
| `shared-urls` | `https://www.cars.example/api/mcp` | direct | yes | **yes** | the personal endpoint |
| `shared-urls` | `https://www.cars.example/api/ops/mcp` | direct | yes | **yes** | the ops endpoint |
| `shared-urls` | `https://www.cars.example/api/mcp/public` | direct | yes | no | not declared, although mcp.path /api/ holds it |
| `shared-urls` | `https://www.cars.example/api/mcp/` | direct | yes | no | a trailing slash is another URL |
| `shared-urls` | `https://www.cars.example/API/mcp` | direct | yes | no | the path is case-sensitive |
| `shared-urls` | `https://www.cars.example/api/mcp?x=1` | direct | yes | no | a query |
| `shared-urls` | `https://www.cars.example/api//mcp` | direct | yes | no | a double slash |
| `shared-urls` | `https://www.cars.example/api/mcp;x` | direct | yes | no | a matrix parameter |
| `shared-urls` | `https://www.cars.example/api/mcp` | direct | no | no | an exact endpoint covers a shared URL only |
| `shared-urls` | `https://www.cars.example/api/mcp` | dock | no | no | the app does not offer dock |
| `named-siblings` | `https://ops.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | **yes** | a grant's secret |
| `named-siblings` | `https://ops.example/mcp/operations-console` | dock | no | no | exact wins: a sibling the file names |
| `named-siblings` | `https://ops.example/mcp/Operations-Console` | dock | no | no | exact wins without ASCII case |
| `named-siblings` | `https://ops.example/mcp/tenant-admin-console` | dock | no | no | exact wins: the fixed parent of a deeper entry |
| `named-siblings` | `https://ops.example/mcp/future-console-entry` | dock | no | no | exact wins: named by an entry this reader drops (trailing slash) |
| `named-siblings` | `https://ops.example/mcp/later-feature-route` | dock | no | no | exact wins: named by an entry this reader drops (unknown key) |
| `named-siblings` | `https://ops.example/mcp/operations-console` | direct | yes | **yes** | the exact endpoint itself |
| `named-siblings` | `https://ops.example/mcp/later-feature-route` | direct | yes | no | an entry with an unknown key covers nothing |
| `named-siblings` | `https://ops.example/mcp/future-console-entry/` | direct | yes | no | an exact path ending in / is not understood in 0.11 |
| `direct-template` | `https://orders.example/mcp/0123456789abcdef0123456789abcdef` | direct | no | **yes** | a Direct secret URL |
| `direct-template` | `https://orders.example/mcp/0123456789abcdef0123456789abcdef` | dock | no | no | a Direct-only template never pairs |
| `unknown-key` | `https://orders.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | an entry with an unknown key is dropped whole |
| `path-only` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?a=1` | dock | no | **yes** | no endpoints: the 0.10 rule under mcp.path, unchanged |
| `path-only` | `https://ledger.example/mcp` | direct | yes | **yes** | no endpoints: the 0.8 shared allowance, unchanged |
<!-- mcp-endpoint-vectors:end -->

## The hub's trust model

What a hub does about apps it does not know. The rules below are the reference hub's; a hub that follows them protects agents the same way.

### Verified and unverified apps

A hub's **verified** apps are the ones its operator lists. Any other app is **unverified**. Its identity is its domain: its id, and so its tool prefix, comes from its host (`evil.example` gives `evil_example__get_order`), always holds a `_` and never `__`, so it can never take a verified app's prefix or `page`. What it calls itself is kept only as `declared_name`. An unverified app **MUST** use HTTPS on a domain name (no IP address, no single-label or `localhost` host), and its redirects are not followed.

### The warning

An unverified app pairs only after the person approves the dock's warning for its domain: the domain first, **Not verified**, what the app calls itself marked as its own word, and the risk (your agent will read whatever this app tells it, which could lead it to move data out of your other apps), with **Deny** as the default button. The approval is once per domain per dock; Deny, Unpair or Remove withdraws it. The hub, not the page, enforces it.

### Untrusted marking

What an unverified app gives reaches the agent marked:

- A relayed result arrives in an envelope, in the structured result and the text: `{ app, untrusted: true, note, result }` (or `text: [...]`).
- Its entry in `views`, its focus and its `attention` carry `untrusted: true`.
- Its tools are listed with the label `[Unverified app at <host>, calls itself "<name>". Untrusted: …]` and no annotations of its own (an app could claim `readOnlyHint`).
- A failed call is `app_unreachable` with the hub's own reason only, never the app's error text.
- Its `then` and `page_open` are not counted, so it cannot keep the agent waiting.

### Limits

The reference hub reads at most 1 MiB of each answer from a verified app and 256 KiB from an unverified one, with a time limit that covers the body; it keeps an unverified app's view only under 8 KB, its tool schemas under 8 KB, its descriptions cut at 1 KB, 32 tools at most; it takes its pin only when well formed, on its own origin and not dated ahead; and it holds 20 app pairings per dock at most (`too_many_apps`).

### The blocklist and the kill switch

A hub may block domains (a domain covers its subdomains): a blocked app cannot pair (`app_blocked`), and a pairing made before reads as blocked and is never called again. The reference hub also has a kill switch that closes it to every unverified app at once; verified apps are untouched.

## The browser extension

With the APC browser extension the person can drop a dock agent on any web page, APC or not. Everything the person can see inside the outline the extension draws while they drag (a block of text, a form's question or a whole form), including what they typed there, and their selection, is read on the drop, and only then, and handed to the hub as a page reading, with `untrusted: true`: what a page says is data from that page, never instructions. Card, account and id numbers go only as the person set in the extension; passwords and one-time codes never. This is the extension's, for pages without APC: an APC app decides itself what it exposes to an agent, through its own tools. On a Direct-only app that does not answer dock drops itself, the extension tells the person to connect directly.

## Versioning and deprecation

The standard has its own [semver](https://semver.org), `APC_STANDARD_VERSION` in `@tineira/apc-protocol`, separate from the software release. Every change to the contract adds an entry to the [changelog](/docs/changelog) and bumps it; an app says which version it implements in its `apc.json`.

- **0.x, now: a draft.** Any minor release may change the contract, compatible or not. The changelog says what changed and what an app must do. A patch release (0.7.0 to 0.7.1) never changes the contract: it fixes the software or the wording; any change to the contract is a new minor (0.x) or major version. The suite checks an app that claims any version from 0.5.0 up to its own, and passes a newer patch of its own minor with a note (its checks still apply); a newer minor fails until the suite is updated.
- **1.0: the contract frozen.** From 1.0, a change that breaks a conforming app, agent or hub needs a new major version; a minor version only adds (a new optional key, a new tool, a new profile); a patch only clarifies.
- **Deprecation (proposed for 1.0).** Something to be removed or changed incompatibly is first marked deprecated in a minor release, in the changelog and here, and keeps working for at least one more minor release **and** at least 3 months, whichever is longer, before a major release removes it. A security fix may shorten that window; the changelog then says why.

Comments on this policy, and any proposal to change the contract, go in a [contract change issue](https://github.com/tineira/agent-pointed-context/issues/new?template=contract-change.md).

## Licence

The text of this specification and of these docs is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), like the paper: you may share and adapt it with credit to "Agent Pointed Context, apc.tineira.com". The code (`@tineira/apc-*`, the examples, the reference apps) is [MIT](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE). See [LICENSE-spec](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE-spec).
