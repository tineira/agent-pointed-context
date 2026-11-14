# Integrate your app in an afternoon

This guide builds **Orders**, a small app with a list of a shop's orders, into a complete APC app: Direct first (an agent connects to the app's own MCP URL), then Dock (an agent dragged from a dock). Every sample on this page is a region of three real files in the repo, [orders-app.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-app.ts) (the server), [orders-page.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-page.ts) (the page) and [orders-conformance.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-conformance.ts) (the test). They type-check against the current packages on every build, and the conformance suite passes against them on both profiles.

The server is plain Web standard `Request` and `Response`, so it runs on Node, Deno, Bun or a Cloudflare Worker; the page is plain DOM, so it fits React, Vue or none. State is kept in memory, for one person, so the APC parts stay in sight: your app keeps grants, pins and the view in its own database, per person, and puts the person's routes behind its own sign-in.

## 1. Install

The packages are 0.x pre-releases on npm: the `next` dist-tag carries the newest release, and `latest` can trail it by one while the standard is 0.x. Their version follows the standard's: 0.10.x ships APC 0.10.

```sh
npm i @tineira/apc-server@next @modelcontextprotocol/sdk zod   # the server (the SDK and zod are peers)
npm i @tineira/apc-protocol@next @tineira/apc-web@next         # the page
npm i -D @tineira/apc-conformance@next                         # the tests
```

The packages are on npm, so these lines work as written. The sources are also in the repo: [`packages/protocol`](https://github.com/tineira/agent-pointed-context/tree/main/packages/protocol), [`packages/server`](https://github.com/tineira/agent-pointed-context/tree/main/packages/server), [`packages/web`](https://github.com/tineira/agent-pointed-context/tree/main/packages/web) and [`packages/conformance`](https://github.com/tineira/agent-pointed-context/tree/main/packages/conformance), small enough to add to your workspace or copy.

They are ESM with type declarations. `@tineira/apc-protocol` and `@tineira/apc-web` have no Node imports (`@tineira/apc-web` is browser code for any bundler); `@tineira/apc-server` runs wherever there are `fetch` and Web Crypto (Workers, Node 20+); `@tineira/apc-conformance` needs Node 22.15+.

| Package | Gives you |
|---|---|
| `@tineira/apc-protocol` | the types, the target grammar (`parseTarget`), `focusAttrs`, `apc.json` |
| `@tineira/apc-server` | the two APC tools, `attention` and `then`, presence, grants, revoke, consent, `apc_link`, `apc.json` |
| `@tineira/apc-web` | pinning (drag and tap), the agent bar `<apc-agents>`, the Direct agent list, presence, the view reporter, the agent pet (`createPet`, `<apc-pets>`, `petState`) and the wait helpers (`waitOpen`, `agentWaitOpen`) |
| `@tineira/apc-conformance` | the suite that checks your app |

The server's imports:

<!-- include orders-app.ts#imports -->

## 2. Decide what can be pointed at

Pick the things a person would ask about: here, an order, and its total as a part of it. A target is `{ kind, id, part, params }`, ids and keys only ([the focus format](/docs/spec#the-pin-and-the-focus-format)). Never put amounts or free text in a target: the agent reads those through your tools.

<!-- include orders-app.ts#data -->

In the page, every pointable element carries `data-focus`, made by `focusAttrs`:

<!-- include orders-page.ts#markup -->

## 3. Grants, and `apc.json`

Each agent gets its own **grant**: an id, and a secret that is the last segment of its MCP URL.

<!-- include orders-app.ts#grant -->

The app's routes: `apc.json`, the MCP URLs, the hub's give-back (Dock), and the person's own routes. `apcManifest` builds the `apc.json` from what the app offers; `apcJsonResponse` serves it as public JSON.

<!-- include orders-app.ts#routes -->

The person's routes need their session, and every change is a JSON `POST` checked against the origin you configured, never one read from the request ([M6](/docs/spec#the-app-and-the-hub-call)): another site's page cannot drop, allow or cancel for them, and a client that is not a browser is taken on its session.

<!-- include orders-app.ts#owner -->

## 4. Direct: an agent per grant

The person makes an agent on the page, and copies its URL into their agent as a remote MCP server (Streamable HTTP, no OAuth: the access is in the URL).

<!-- include orders-app.ts#direct -->

In the page, `<apc-direct-agents>` is that list, with the URL and a prompt the person can paste to their agent, which asks it to add the server itself:

<!-- include orders-page.ts#direct -->

## 5. The view

The page reports the screen as identifiers whenever it changes, and the server keeps it, checked:

<!-- include orders-page.ts#view -->

<!-- include orders-app.ts#view -->

## 6. The pin

The person drops an agent's mark on a target. The server keeps one pin per grant, and turns it into the focus the agent receives, with `next` and `next_args`: the exact call that reads it.

<!-- include orders-app.ts#pin -->

## 7. The MCP endpoint

One MCP server per request, for the grant in the URL. `registerApcTools` adds `get_current_view` and `wait_for_focus`, reading through the functions you give it; your own tools sit next to them. A revoked grant is answered 403 before anything else, whatever the method.

Three of those functions keep the core's promises (APC 0.8). `markSeen(pinnedAt)` marks that exact pin seen, never a newer one: the tools call it only once the result is final, so a pin is never lost. `waitSlot` is the grant's one place for a wait: `MemoryWaitSlots` keeps it in memory, which is right when every request of the person runs in one process (as here, or in a Durable Object); on stateless functions keep a row per grant with the holder's token and when it claimed. `signal` ends a wait the client gave up on: the request's own, and `InflightCalls`', since a server that is new for every POST sees MCP's `notifications/cancelled` only in a POST of its own.

<!-- include orders-app.ts#mcp -->

On Cloudflare Workers, give the server `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` (from `@modelcontextprotocol/sdk/validation/cfworker`), and keep the state in a Durable Object: `sqlKv(ctx.storage.sql)` gives `DockConsent` and `ApcLinks` their table.

## 8. Around every tool

This is where APC rides on your results. Every tool, the two APC tools included, runs inside one wrapper that:

- ends the call `revoked` if its grant was revoked, before or while it ran;
- puts `attention` on the result while the grant's pin is unread;
- publishes presence to the person's page, naming what a read touched (and, since APC 0.11, `registerApcTools` sends a wait's `open` and `closed` there itself when you give it `waitPresence`);
- puts `then` on the result while a page of the person's is open and the grant was pinned in the last 30 minutes (`thenApplies`), but never on a wait that came back empty;
- carries an `apc_link` offer, once per session, when the same agent is connected both ways.

<!-- include orders-app.ts#around -->

## 9. The agent bar and pinning

In the page, `<apc-agents>` is the agent bar: each agent's mark (drag it onto a target), its pin (× to unpin), ⊘ to revoke (a second click confirms), and the path it came by. `enablePinning` makes marks draggable onto anything with `data-focus`, and on a phone lets a finger tap a mark and then a target.

<!-- include orders-page.ts#bar -->

The page's event stream is how the server knows a page is open, and how presence reaches the page:

<!-- include orders-page.ts#events -->

<!-- include orders-app.ts#page -->

<!-- include orders-page.ts#pinning -->

On a phone, `@tineira/apc-web` already keeps the bar in the page, uncollapsed, at the bottom of the viewport, with finger-sized marks, and turns a tap on a mark into "tap to pin". Check your own layout at 375 × 812 ([mobile](/docs/spec#mobile)).

### The agent in the page

To show your agents as the dock does, put `<apc-pets>` in your header: each agent a pet, up to 3, then a "+N" (or list) button that opens a popover of every agent ([the agent in the page](/docs/spec#the-agent-in-the-page)). Each pet is a mark and only a mark, so `enablePinning` drags it like the bar's, and a tap or Enter on it arms the agent. Feed `petState` only what your page knows; a field you leave out stays at its default, so a pet never shows a wait your page cannot see. Pass `waiting` once your page reads the wait signal.

<!-- include orders-page.ts#pets -->

- **Colours.** `scheme = "auto"` follows `prefers-color-scheme`. With your own theme switch, set `scheme` to `"light"` or `"dark"` when it changes. To tint the pet to a strict palette, set `tint` (`{ body, line }`, hex) or the custom properties `--apc-pet-body` and `--apc-pet-line`.
- **Size.** `--apc-pets-size` (36 px by default) sizes the pets; each stays a 44 px target. A lone pet anywhere else is `createPet({ state, badge, label })` (or `<apc-pet>`), sized by `size` or `--apc-pet-size`.
- **Logos.** `agentBadge({ clientName, key })` gives the brand's logo, else the client's icon, else a neutral mark in the agent's own colour. `<apc-pin>` wears the same badge when you set `badge` on its agent; `pinStackIndex` places several badges on one element.
- **Words.** `<apc-pets>` takes `strings` (`PetsStrings`) like the other components.

## 10. Revoke

Revoke holds in the app alone, at once, and calls nobody. The app keeps a hash of the secret, so the URL answers `revoked` from then on, and a call already running ends the same way.

<!-- include orders-app.ts#revoke -->

## 11. Try it with your agent

Run the app on a public HTTPS origin (a tunnel works for a test), make an agent on the page, and add its URL to your agent (Claude, ChatGPT, Cursor, Grok: any client that takes a remote MCP server). Drag its mark onto an order and ask "what is this?". The agent sees `attention` on its next call, or calls `get_current_view`, then `get_order` with the focus's `next_args`.

## 12. Dock: agents dragged from a dock

Add `"dock"` to the profiles and list the hubs you pair with. A dock's agent arrives as a drag with a hub, a public handle and a single-use ticket. The page sends every such drop to the server (`resolveAgent: () => null` and `onUnknownAgent` above); the server decides:

<!-- include orders-app.ts#dock -->

- **The hub is checked first, twice:** `parseDockDrop` takes the drag's hub only if it is exactly one of the origins on your allowlist, on the drop and again on the Allow (`hub_not_allowed` otherwise), and every hub call goes to the origin it returns.
- **No grant for that agent yet:** the server answers `consent_required` with a nonce and a [pairing code](/docs/spec#the-pairing-code); the page asks the person and shows the code; only the Allow that brings the newest nonce back makes a grant (a newer drop replaces the consent, and the older Allow gets `consent_expired`). The grant is stored **in flight** and handed to the hub (`POST {hub}/apc/pair`, with the code). `pairWithHub` refuses redirects, ends at 10 s and reads 8 KiB at most; the grant is kept only if the hub acknowledges the code (`pairing_code: "required"` on a plain 200), and ends otherwise, before the server answers the page. No lock is held across that call; a second Allow meanwhile gets `pairing_in_progress`.
- **Waiting for the dock (handoff):** the acknowledgement moves the grant to handoff, if nothing ended it meanwhile. The person then allows it in their dock too, typing the code, and the hub's first `initialize` makes the grant **live**. Until then the page shows the code with Cancel, which revokes the grant and works only before the dock connected: if the person's own dock never asks for that code, the agent was someone else's.
- **A grant already:** the server asks the hub whether the pairing still stands (`confirmWithHub`, `POST {hub}/apc/confirm`). Still pending: the page shows the same code, never a new one. Paired but not connected yet: it says so. Live: the drop pins it. `not_paired`, or the code's time is up: the grant ends and the person is asked again.
- **The person unpairs in the dock** (or denies, types five wrong codes, or lets the request expire): the hub calls your `POST /apc/revoke` with the grant's MCP URL, and the grant ends. `handleDockGiveBack` answers the same 200 whatever it was sent.

What a dock grant answers follows its state, and `dockGrantGate` decides it before the MCP transport and the wrapper of step 8 (in `mcp` above): 404 in flight, the `pairing` error to a tool call in handoff, the app's data only once live. A grant with no acknowledgement 30 s after the Allow, or no `initialize` 10 minutes after the acknowledgement, ends (404). Orders also sleeps: 30 minutes after the person's last wake action (the page's heartbeat, a drop) a live grant goes **dormant** and returns no data, only `idle`, until they are back; agent traffic never wakes it.

The page shows the code in its consent, and the agents waiting for their dock:

<!-- include orders-page.ts#waiting -->

The hub reads your `apc.json` before it pairs: it must list `"dock"`, name your origin, and cover the MCP URL you send. The reference dock at `apc.tineira.com` pairs with any app that passes its checks, as **Not verified** until it is on its list: the person sees a warning with your domain first ([the hub's trust model](/docs/spec#the-hubs-trust-model)), and your results reach the agent marked untrusted.

With both profiles, the same agent connected both ways is offered `apc_link` and shows once in your bar: the `ApcLinks` calls above (`arrived` on `initialize`, `offer` around every tool, `registerApcLinkTool`) are all it takes.

## 13. Test it

Run the conformance suite against your app before you ship: see [Conformance](/docs/conformance), whose adapter for Orders is the third file of this guide.

## Localize the page

`@tineira/apc-web` draws words: the agent bar, the pin badge, the Direct agent list and the notes `enablePinning` shows. An app in another language passes every one of them, without forking the package. Each component takes one `strings` object (`<apc-agents>`, `<apc-pin>` and `<apc-direct-agents>` as a property; `enablePinning({ strings })`), typed by `BarStrings`, `PinStrings`, `DirectStrings` and `PinningStrings`. The keys you leave out keep their English default, exactly what the package always showed, so an app that passes nothing changes nothing.

<!-- include orders-page.ts#localize -->

- **Tooltips and `aria-label`s are strings too**, not only the visible text: the mark's title, the pin dot, ×, ⊘ and its "Revoke?" confirmation, Unlink, the collapse and dismiss buttons.
- **Names, counts and labels are functions**, so no sentence is built from English fragments: `reading(names)` and `readingCount(count)` (plurals are yours), `joinPins(labels)` for a linked agent's two pins ("A and B"), `status(agent)` and `prompt(url, appName)` for the Direct list.
- **The dock hint** can be translated (`dockHint`, or `bar.dockHint = { text, url }`) or turned off (`bar.dockHint = null`, or `dock-hint="off"`). An app that offers Direct only turns it off.
- **A dock agent dropped on a Direct-only app** is answered with the protocol's `directOnlyNote(name)`. Pass `directOnlyNote` and `couldNotCheckNote` in `PinningStrings` for your own words, or handle `onDockUnsupported` yourself.
- **Dates and times** you show (a pin's "read at …") follow the page: `formatPageTime(date)` uses `<html lang>`, or `locale` when you name one, and never the operating system's. `pageLocale()` gives the tag. The bar itself shows no date.
- **Left as they are:** the symbols (×, ⊘, ‹, !, ✓), and what you pass in (agent names, pin labels, warnings, URLs).

Localizing changes no protocol text, the tools or conformance: [Conformance](/docs/conformance) passes in any language.

## Operating APC on stateless hosts

The Orders sample keeps its state in one process, as a Durable Object does. Many apps have no such process: a function per request (Vercel, say) and a Postgres database (Supabase, say). Two apps built that way, Autio (its dealer and personal MCPs) and Surplus, rewrote the server side and met the same traps. This section is what they learned. It is guidance, not rules: the [spec](/docs/spec) says what must hold, and this says what it took to hold on a host with no memory between requests. The ids in parentheses are the issues where each point was found.

### A wait is a row

Keep one row per grant: the holder's token, when it claimed, when it expires. Autio calls the table `apc_wait`, Surplus `ledger.agent_wait`.

- **Claim under a lock.** The claim takes a per-grant advisory lock (`pg_advisory_xact_lock`), deletes the grant's expired rows and writes a fresh holder token. The newest wait takes the slot over (Autio TIN-807). A claim made less than 2 s after the last is refused with `retry_after_s`, the real time left, so two waits fired together do not take the slot from each other in a loop (Autio TIN-844). Surplus also sets a `lock_timeout` of 2.5 s on the claim, so a stuck lock ends the call and not the pool (Surplus TIN-846).
- **The old wait finds out by itself.** It keeps polling until its own timeout. Each poll asks whether its token still holds the slot, and a wait that lost it answers no focus and marks nothing. Giving the slot up answers whether it was still held, and only a wait that held it delivers (Autio TIN-807, Surplus TIN-846).
- **Poll every 2 s, each poll in its own short transaction.** Nothing is held across the sleep: no lock, no open transaction. Each poll checks that the grant is still live, so a revoke ends the wait at its next poll (Surplus TIN-847).
- **Default 45 s, and set the route's time limit above the longest wait.** Autio accepts 1 to 60 s with a route limit of 120 s; Surplus accepts 1 to 50 s with 60 s (Autio TIN-822).
- **Tell the agent what happened.** At the timeout: `timed_out: true` and `page_open: true`. A wait taken over: `focus: null` and a note. A page that closed: `page_open: false`. When the wait cannot run at all, answer that last shape with a note, never a tool error (Autio TIN-797).

### Cancellation arrives in another request

A stateless server is new for every POST. MCP's `notifications/cancelled` comes in a POST of its own, to a server that never saw the call, so the SDK cannot deliver it. The database has to.

- **Key the wait by (grant, request key).** The grant comes from the credential, never from the body. The request key is the JSON-RPC id of the `wait_for_focus` call, normalized the same way on the claim and on the cancel: `n:<integer>` for a safe integer, `s:<string>` for a well-formed string of 1 to 128 characters, and nothing else is a key. `7` and `"7"` are two keys, and id `0` is valid (`request-key.ts` in both apps, Autio TIN-844).
- **A cancel deletes the slot that holds that key.** A cancel from another grant touches nothing. Answer the notification `202` with an empty body, after a bounded transaction; a cancel that fails is logged by code and still answers `202` (Autio TIN-844, Surplus TIN-846).
- **Plant an early-cancel marker for a cancel that overtook its call.** Two requests are in flight, and the cancel can win. When no slot matches, store the key in a marker for the grant: at most 8 keys, 10 s. A claim whose key is in the marker consumes it and answers `cancelled`. Both run under the same per-grant lock, so they always see each other's rows. Without a marker that cancel is lost, and the wait that follows runs for a client that has gone (Autio TIN-844, Surplus TIN-846).
- **Only waits are keyed.** A cancel for any other call, or one that arrives after the final answer, finds nothing to stop. The standard allows that window.
- **Vercel: `request.signal` is off unless you turn it on.** A client hang-up fires `request.signal` only for a function with `supportsCancellation` (in `vercel.json`, per route file), and Vercel then ends that function, except for work held by `waitUntil`. Surplus turns it on for exactly its MCP routes and its REST `wait_for_focus` route, and splits that route out of its catch-all so that no REST write is on a cancellable function (Surplus TIN-866).
- **Hold the work before the handler starts.** Register a promise with `after()` (that is `waitUntil`) first, and release it in a `finally` once the handler settled. A tool's write then finishes even when the client is gone. If the hold cannot be registered, fail closed: answer 503 and run nothing. Hold deferred work (audit rows, presence) the same way, even when it is registered after the client left. Read the signal only where stopping is safe, the wait loop and the delivery step, never in a write (Surplus TIN-866).

### Trim, never fail

One bad item must not fail the whole view read.

- **Check each item on its own.** The view's selection, a filter's id, the pin: each goes through its own check, and an item whose check throws is hidden, never shown unchecked. The rest of the state still answers. Surplus does this in TypeScript (`guardedAccess`); Autio does it in SQL (`apc_record_check_or_hidden`), where an unreadable pin reads as no pin and a filter that cannot be checked is dropped (Autio TIN-797).
- **Hide only what is a defect, and fail on the rest.** Autio hides on a closed list of SQLSTATEs (42703 undefined column, 42P01 undefined table, 42883 undefined function, 22P02 invalid text) and logs a warning with the code and the kind, nothing else. Anything else is raised again: an auth failure (42501) must still fail the whole read closed. Hiding is the narrowest answer, so nothing becomes visible that the check would not allow (Autio TIN-797).
- **An applied migration does not prove every branch.** PL/pgSQL resolves a query only when its branch runs. Autio shipped a check whose personal `car` branch read a column that does not exist. The migration applied cleanly; the first view with a car pin then failed the whole state, and both core tools answered unavailable (Autio TIN-797, TIN-794). Call each branch of a check function once in a test: one call per target kind.
- **Say why a read is empty.** A null view or focus carries a `note`. Log the cause as a code (`rpc_<code>`, `timeout`, `throw`), never an id or a value (Autio TIN-797).

### Mark seen only after delivery

A pin is lost if you mark it seen on a read the client never receives.

- **No read marks.** Not `get_current_view`'s read, not a wait's poll, not the envelope's read: a read can time out or be thrown away.
- **Mark once the body is final.** Build the whole answer first, with `attention` and `then`. Then mark that exact pin by the `pinned_at` the database sent, with all its microseconds, so a newer pin is never marked by mistake. In a wait, mark after the slot is cleared. Skip the mark when the request was aborted. If the mark fails or times out, return the body anyway: a pin delivered twice is safe, a pin lost is not (Autio TIN-674, Surplus TIN-846).

### Revoke, and the order of locks

- **Lock the grant row first, then its children.** A transaction that touches a grant and the rows that point to it (tokens, codes, pin, wait rows) locks the grant row first, then the children in one fixed order (Surplus: codes, links, pin, wait). A revoke deletes the grant's pin and wait rows in its own transaction, and a pin re-checks that the grant is live under the grant's lock, so a pin can never land after a revoke (Surplus TIN-847, Autio `apc_pin` and `apc_grant_revoked_cleanup`).
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`, for a grant writer.** A child insert (a token, a wait claim) takes a `KEY SHARE` lock on its grant through the foreign key. `FOR UPDATE` blocks it; `FOR NO KEY UPDATE` does not, and still keeps grant writers in line. Nobody changes a grant's id, so it is enough. The owner's pin takes `FOR SHARE`, so a pin and a revoke run one after the other: the pin commits first and the revoke deletes it, or the pin fails (Surplus TIN-847).
- **A job that touches several grants locks them in one order.** Surplus's page heartbeat locks the owner's dock grants with `order by id for no key update` before it writes any of them, as revoke-all does. Two transactions that take the same rows in different orders can deadlock. The heartbeat also retries once on a deadlock (40P01) or a serialization loss (40001), logs the SQLSTATE if that fails too, and never fails the page for it (Surplus TIN-847, TIN-850).
- **Prove it on two real connections.** Surplus has tests that run two transactions at once on the real migrations (`ledger-grant-children-concurrency`, `ledger-dock-concurrency`). A mock cannot show a deadlock.

### Ship order, and rollback order

Every grant check reads the grant's columns, on every request. So a migration that adds a grant column ships **before** the build that reads it. If the build goes first, every agent gets a 401 until the migration lands (Surplus TIN-850, the dock grants migration).

- **Roll back in the opposite order.** Revert the app to a build that does not read the columns, then run the rollback migration. Keep that rollback as a file next to the migration.
- **Do not fall back on a missing column.** Surplus's token lookup does not catch 42703. The grant checks after it read the same columns, so a fallback would only move the failure. Failing closed is right.
- **Or make the change safe in either order.** Autio added a parameter to `apc_wait_claim` with `default null`, so the build from before the migration still resolves the function and the migration can go first (Autio TIN-844).

### Presence over a private realtime channel

The reference examples send presence on a page event stream. Without a long-lived process, use a private channel of your database's realtime service instead (Supabase Realtime in both apps).

- **Ids only.** The event is APC's `PresenceEvent`: the grant, the tool, read or write, and at most 20 targets as `{kind, id}`. Never a name, an amount or free text (Surplus TIN-847).
- **Owner-only, private.** One topic per person (`apc-user:{user_id}` in Autio, `agents:{user_id}` in Surplus): a private channel, a policy that lets only that person read it, and no client may write to it. An agent token never listens. Surplus sends the event from the server through Realtime's broadcast endpoint, as private only. Autio sends it from a database function that runs for the agent's own grant (`apc_publish_presence`), which publishes nothing unless the person's page heartbeat is fresh (Autio TIN-670).
- **Send after a successful call, and never let it fail one.** A missing function, an error or a read over 3 s leaves the tool's body as it is. Hold the send like the rest of the deferred work (see above).
- **The same channel carries the revoke.** Both apps broadcast an event when a grant ends, so every tab and device drops the agent's mark without a reload. Autio wraps only the send in its revoke triggers, so a failed broadcast can never fail a revoke (Autio TIN-815, Surplus TIN-847).
- **Do not infer "waiting".** A page cannot read the wait row, so it should not guess a waiting state from recent calls. Both apps did guess it (a call heard in the last 75 s, or the last call being a wait), and that shows "waiting" when no wait is running. Show no waiting state unless the app sends the presence `wait` events of APC 0.11, which only an app that claims and releases a wait atomically may send (Autio TIN-795, Surplus TIN-877, TIN-886).

## Checklist

- `GET /.well-known/apc.json` names your origin, your profiles and `mcp.path`. If the origin serves other MCP endpoints too, it lists the APC ones in `mcp.endpoints` (0.11; [the spec](/docs/spec#mcpendpoints-011)): exact paths, and `/{secret}` last for one URL per grant. Keep fixed routes out of a `{secret}` parent, and keep `mcp.path` for readers before 0.11. `declaresMcpUrl` now takes the profile (`{ profile: "dock" }`, or `{ profile: "direct", shared: true }` for an exact endpoint whose grants share the URL).
- Every pointable element has `data-focus`; targets carry ids and keys only.
- `get_current_view` and `wait_for_focus` are registered on every grant.
- Every tool runs inside the wrapper: revoke check, `attention`, presence, `then`.
- The agent bar is on every page, with Revoke; on a phone it stays in the page.
- If you show agents as pets: `<apc-pets>` in the header, its states fed only by what the page knows, its colours following the page's scheme.
- Revoke answers `revoked` to every method (403 with a secret URL; 401 with a bearer token); an unknown grant 404.
- `wait_for_focus` holds one wait per grant, and a pin is marked seen only once delivered.
- Dock: every drop goes to the server; the hub is on your allowlist, checked on the drop and on the Allow (`parseDockDrop`); consent is the server's nonce; the consent shows the pairing code, the server sends it to the hub and keeps the grant only on the hub's acknowledgement (`pairWithHub`).
- Dock: a grant serves data only after the hub's `initialize` (`dockGrantGate`); `POST /apc/revoke` answers the same 200 to anything (`handleDockGiveBack`); the person's routes check `Origin`, `Sec-Fetch-Site` and the JSON media type; `apc.json` lists `dock` only while you can pair.
- The conformance suite passes, on each profile you offer.
