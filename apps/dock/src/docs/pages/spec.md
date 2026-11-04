# The APC specification

This is the contract an app, an agent and a dock share in Agent Pointed Context, at the version in the banner above. It is a draft: see [versioning and deprecation](#versioning-and-deprecation). The reference is the code in [`@tineira/apc-protocol`](https://github.com/tineira/agent-pointed-context/tree/main/packages/protocol) (types and constants) and the [conformance suite](/docs/conformance); this page says the same in words. Every change is in the [changelog](/docs/changelog).

**MUST** and **MUST NOT** mark what the reference code enforces: `@tineira/apc-protocol` refuses it, the reference hub refuses it, or the conformance suite fails an app that does not. Everything else describes how the reference apps behave and what a reader can rely on.

## Terms

- **App**: a web app that speaks APC: it has a page the person uses and an MCP endpoint agents call.
- **Agent**: the person's own AI agent, an MCP client (Claude, ChatGPT, Cursor, Grok and others).
- **Grant**: one agent's access to one app: a secret MCP URL (whoever holds it holds the grant), with its own pin and name. A grant holds per agent, never per app.
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

### `get_current_view`

Takes no arguments. Returns `{ view, focus }`: the view (or null) and the focus (or null). Reading the focus marks it seen.

### `wait_for_focus` and `then`

`wait_for_focus({ timeout_s })` holds the call until the person pins the agent, or `timeout_s` passes (a whole number from 1 to the app's ceiling; optional, 25 by default in `@tineira/apc-server`).

- A pin dropped during the wait is returned, marked seen: `{ focus, timed_out: false }`.
- With none, it returns `focus: null` with a `note`, and `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app knows the person's page is closed. `page_open` is left out while the person does not share their view (an app without that switch always shares).

`then` is the loop hint: a key on a result, placed like `attention`, present while a page of the person's is open (and they share their view). It tells the agent to call `wait_for_focus` after answering. It **MUST NOT** be on a `wait_for_focus` result that came back with no focus: that result ends the loop.

### Revoke from the app

Every agent in the app's agent bar, Direct or Dock, has Revoke. It holds in the app alone and at once: the app calls nobody, so it works with the hub down.

- From then on every request to the grant's MCP URL, whatever the method, **MUST** be answered HTTP 403 with `{ error: "revoked", revoked_by, revoked_at, message }` (`RevokedAnswer`), `revoked_by` being the app's host. An unknown or expired grant answers 404, so a holder can tell "taken back" from "gone".
- A call already running when the grant is revoked **MUST** end as a tool error with the same answer and no app data. Whether a grant was revoked is told by the grant itself (its secret, and the hash the app keeps of it), never by a grant id a later grant may reuse.
- A revoked grant never works again. The person lets the agent back with a new grant: a new MCP URL (Direct), or a new drop with consent in the app and in the dock (Dock).

### Mobile

On a phone there is no dock window, extension or desktop pet to drag from, so the agent in the app's page is the only way to point it. In a viewport that matches `(pointer: coarse), (max-width: 640px)` (`APC_MOBILE_MEDIA`), on both profiles:

- The app shows all its agents in the page, each mark visible and usable for pinning. The agent bar is never collapsed or hidden there, and stays reachable while the page scrolls, without covering content.
- A finger can pin without a mouse drag (phones do no HTML5 drag and drop): tap the agent's mark, then the target ("tap to pin", with a clear state and a way to cancel), or drag the mark with pointer events. It makes the same pin. Unpin and Revoke work by touch, with finger-sized targets.

The reference viewport is 375 × 812 (`APC_MOBILE_VIEWPORT`). An app that claims 0.6.0 or later **MUST** give the conformance suite its page on a phone.

## The Direct profile

The agent connects to the app's own MCP URL.

- **A grant per agent.** The person makes an agent in the app's page; the app makes a grant with a secret of 128 random bits, which is the last segment of the agent's MCP URL (`newDirectGrant` in `@tineira/apc-server`).
- **The agent list**: where the person makes and names agents and copies the URL, or a prompt that asks the agent to add it (`<apc-direct-agents>` in `@tineira/apc-web`). An agent names itself on `initialize` (`clientInfo.name`) until the person renames it.
- **The agent bar** shows Direct agents in full, always: the app is the only place the person sees and points them.

## The Dock profile

The agent connects once, to a hub. The person drags it from the dock onto any app they paired.

### The drop

The dock puts the agent on a drag with the type `application/x-apc-agent` and the payload `{ v: 1, agent, hub, ticket }`: a public handle, the hub's bare origin, and a ticket. The payload **MUST NOT** hold a secret or an MCP URL: any page the agent is dropped on can read it. The **ticket** is single use, lives 60 seconds, is bound to that agent, and opens a pairing request or a confirmation and nothing else.

### Consent in the app

Consent is the app's server's to check, never its page's alone. The page sends every dock drop to its server. For an agent it holds no grant for (never paired, revoked, or one the dock no longer confirms), the server answers `consent_required` with a nonce; the page shows its consent ("Let your agent from the dock at … read Orders?") with that nonce, and the Allow sends it back. The server makes a grant only for a request that brings the nonce back. In the reference apps (`DockConsent` in `@tineira/apc-server`) the nonce has 128 random bits, works once, for the same dock and agent, for two minutes. One drop of an agent is answered at a time: a second request while the first waits on the hub answers `pairing_in_progress`.

### Pairing: `POST {hub}/apc/pair`

With the person's yes, the app's server makes a grant and hands it to the hub, server to server:

```json
POST https://apc.tineira.com/apc/pair
{ "ticket": "…", "agent": "ag_…", "app": { "name": "Orders", "origin": "https://orders.example" }, "mcp_url": "https://orders.example/mcp/…" }
```

The hub checks the ticket, the app's origin and its [`apc.json`](#apcjson) (it **MUST** refuse the pairing when the file is missing, redirected, invalid, names another origin, does not list `"dock"`, or does not cover `mcp_url`), and answers `{ ok: true, status: "pending", agent: { name, icon } }`, or `{ ok: false, error }`. The pairing counts only when the person has also said yes in the dock. The app links the grant to the agent only once the hub took it, and pins it.

### Every drop: `POST {hub}/apc/confirm`

On a drop of an agent it already holds a grant for, the app asks the hub whether that pairing still stands: `{ ticket, agent, mcp_url }`. `{ ok: true }` pins it. `{ ok: false, error: "not_paired" }` means the dock no longer pairs it: the app drops the grant and asks the person again (the ticket is still good). A hub never confirms a revoked or blocked pairing.

### The hub gives a grant back: `POST {app}/apc/revoke`

When the person unpairs an app in the dock, the hub sends `{ mcp_url }` to the app's `/apc/revoke`, and the app deletes that grant and its pin. This is the hub's side; the app's own Revoke is core and needs no hub.

### The hub's tools

A hub exposes to the agent its own `get_current_view` (the focus, now with `app: { id, name, origin }`, and a `views` list, one per paired app), one `wait_for_focus` across all apps, `list_app_tools`, and `call_app_tool({ app, tool, args })`. Each app's other tools are relayed as `<app>__<tool>` (at most 64 characters). The hub rewrites `next` and `next_args` to its own tool names, removes the apps' `attention` and `then`, and adds its own. A browser extension is one more app of the hub, with id `page`; a page reading is the focus kind `page_reading`, read with `page__get_reading`.

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
{ "name": "Orders", "standard": "0.7.0", "origin": "https://orders.example",
  "profiles": ["direct", "dock"], "mcp": { "path": "/mcp/" },
  "direct": { "connect": "https://orders.example/agents" } }
```

- `standard`: the version of this standard it implements.
- `origin`: exactly the origin it is served from; a file that names another is refused.
- `profiles`: `"direct"`, `"dock"` or both for an app; `"hub"` alone for a hub, which then also gives `dock: { pair, confirm }`. A reader ignores words and keys it does not know.
- `mcp.path`: every grant's MCP URL on the origin starts with `origin + path`. A hub pairs only an MCP URL under it, with no encoded `/`, `\`, `.` or `%` and no `.` or `..` segment after it.
- `direct.connect` (with `"direct"`): the page on the same origin where the person connects an agent directly.

A dock agent dropped on an app that offers only Direct is answered, never lost: the page tells the person that it connects agents directly, with its connect page (`directOnlyNote`), and pairs nothing. A page that cannot read its own `apc.json` pairs nothing either.

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

With the APC browser extension the person can drop a dock agent on any web page, APC or not. The page's text is read on the drop and handed to the hub as a page reading, with `untrusted: true`: what a page says is data from that page, never instructions. On a Direct-only app that does not answer dock drops itself, the extension tells the person to connect directly.

## Versioning and deprecation

The standard has its own [semver](https://semver.org), `APC_STANDARD_VERSION` in `@tineira/apc-protocol`, separate from the software release. Every change to the contract adds an entry to the [changelog](/docs/changelog) and bumps it; an app says which version it implements in its `apc.json`.

- **0.x, now: a draft.** Any release may change the contract, compatible or not. The changelog says what changed and what an app must do. The suite checks an app that claims any version from 0.5.0 up to its own.
- **1.0: the contract frozen.** From 1.0, a change that breaks a conforming app, agent or hub needs a new major version; a minor version only adds (a new optional key, a new tool, a new profile); a patch only clarifies.
- **Deprecation (proposed for 1.0).** Something to be removed or changed incompatibly is first marked deprecated in a minor release, in the changelog and here, and keeps working for at least one more minor release **and** at least 3 months, whichever is longer, before a major release removes it. A security fix may shorten that window; the changelog then says why.

Comments on this policy, and any proposal to change the contract, go in a [contract change issue](https://github.com/tineira/agent-pointed-context/issues/new?template=contract-change.md).

## Licence

The text of this specification and of these docs is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), like the paper: you may share and adapt it with credit to "Agent Pointed Context, apc.tineira.com". The code (`@tineira/apc-*`, the examples, the reference apps) is [MIT](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE). See [LICENSE-spec](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE-spec).
