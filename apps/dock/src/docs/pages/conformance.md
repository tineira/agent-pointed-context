# Conformance

`@tineira/apc-conformance` checks an app against the [core](/docs/spec#the-core) of the standard the way an agent or a dock's hub reaches it: JSON-RPC over the app's MCP endpoint, stateless, plus `GET /.well-known/apc.json`. What only the app's page knows (whether a page is open, the view it reports, the pin the person drops, the presence it receives, Revoke in the agent bar) comes through a small **adapter** the app writes.

It checks the version of the standard it ships with, and any app that claims a version from 0.5.0 up to it, or a newer patch of it (a patch never changes the contract; the check passes with a note). It runs two ways: [from the command line](#run-it-from-the-command-line), against a live app over HTTP (what HTTP alone can reach), or [from code](#run-it-from-code), in your tests, with an adapter for the page (everything).

## What the suite checks

With an adapter (the [code](#run-it-from-code) way), on the profile under test, Direct or Dock:

- **`apc.json`**: served as JSON from the app's own origin, valid, a standard the suite knows, the profile under test listed (both, with `apc_link`), never `"hub"`, the grant's MCP URL under `mcp.path`, `direct.connect` on the app's origin.
- **The tools**: `get_current_view` and `wait_for_focus` listed; `get_current_view` takes no required argument; `timeout_s` is an optional whole number from 1.
- **The view**: identifiers only (`params` are keys), and no focus before a pin.
- **The pin**: rides as `attention`, in the structured result and in the text, on any result until it is read; `next` with `next_args` reads it; a new pin replaces it, unread again.
- **`wait_for_focus`**: returns a pin dropped during the wait, soon after; times out cleanly with a note and no `then`; ends at once when the person has no page open.
- **`then`**: on results only while the person's page is open and the agent was pinned lately; an open page with no pin gives none (of an app that claims 0.8.0 or later).
- **One wait per grant** (0.8.0 or later): a newer wait takes over and the older one returns nothing; a second wait right after the first is refused with `retry_after_s`, and the first still delivers; a wait the client cancels marks nothing seen and frees its place, so a pin dropped after it is still unread.
- **Presence**: one event per read, ids only, naming the target the read touched.
- **Wait events** (0.11.0 or later, Direct, of an app that sends them; one that sends none passes with a note): a wait sends `open` while it runs and `closed` once it returns, `{ v, grant_id, at, kind: "wait", state }` and nothing more; a takeover sends the old wait's `closed` before the new wait's `open`, and nothing more from the old wait; a cancelled wait and a wait cut by a revoke send `closed`; a refused wait and a wait on a revoked grant send nothing. On the Dock profile they are not checked: a page shows no waiting for a dock grant.
- **Revoke**: the revoked grant answers `revoked` (403 with a secret URL, 401 with a bearer token) to `initialize`, `tools/list`, `tools/call`, a GET and a DELETE; it cannot be pinned; another agent is untouched; a call already running ends `revoked`, with no data.

An adapter whose app authenticates agents with a bearer token (OAuth) gives the token in each connection's `headers` (`{ authorization: "Bearer …" }`); the grant's URL may then be `mcp.path` itself.
- **Mobile** (0.6 and later): every agent is shown in the page, the bar cannot be collapsed, a finger pins and the agent reads the pin, and unpin works by touch.
- **The pairing code** (Dock, 0.9 and later; the adapter gives `dock`): the consent shows a well-formed code and the app sends that code, raw, to the hub; every consent shows a new code; a hub that does not acknowledge the code, redirects, or says yes with HTTP 500 holds no grant (its MCP URL answers 404); five wrong codes, or the code's time running out, give the grant back; the right code pairs.
- **The Dock profile as built** (Dock, 0.10 and later; the adapter gives `dock.lifecycle`, see [below](#the-dock-profile-as-built-010)):
  - **The gate fails closed**: the suite reads the claimed standard from `apc.json` at the adapter's owner origin, which must be a bare origin and the same as the grants' origin. Only an app that provably claims a standard before 0.10.0 skips the checks, with a note, and only once a grant it makes lives at the owner origin (an owner origin pointed at an older deployment fails closed). An `apc.json` the suite cannot read or parse, a missing `dock.lifecycle` (or one of its required members, `restart` included) fails every 0.10 check. After each check the suite gives back (`/apc/revoke`) every grant the stand-in hub paired meanwhile.
  - **The answer table**: in each state the adapter can put a grant into (in flight, handoff, live, dormant for an app that sleeps, ended, revoked), the exact answer to `initialize`, `ping`, `tools/list`, `get_current_view`, `wait_for_focus`, one of the app's own tools, another method (`resources/list`) and two notifications (one with no `id`, and `notifications/cancelled` with an `id`, still a notification), as `dockGrantAnswer` in `@tineira/apc-protocol` says, with each message classified by `dockGrantCallOf`. In flight, ended and revoked, the "any request" row too: a `GET`, a `DELETE` and a `POST` that does not parse answer 404 (in flight, ended) or `RevokedAnswer` (revoked). The `pairing` and `idle` tool errors carry `{ error, message }` in `structuredContent` and in `content[0].text`; the idle shapes carry `idle: true` (and `wait_for_focus` answers at once); no answer in handoff or dormant carries `attention`, `then`, `apc_link` or a presence event; a 404 in flight leaves the state unchanged.
  - **The transitions**: `initialize` commits the move out of handoff, and fails closed (HTTP 500 or JSON-RPC -32603, no result, still in handoff) when its commit cannot persist; `initialize` raced against Cancel, and against a give-back, in both orders, ends by the state that won; Cancel revokes only in handoff before a served call (never a live grant, served or not, nor an ended one); a give-back or `T_ack` while in flight ends the grant for good, even if the acknowledgement comes after; `T_ack` (30 s) ends a grant whose Allow never heard back across a restart of the app, and a late acknowledgement does not bring it back; `T_connect` (10 minutes, or the app's own `connectMs`) ends a grant never connected, and a late introduction does not bring it back; `T_idle` sleeps a live grant, and the page's heartbeat and a confirmed drop wake it; with `dormancyMs`, long dormancy ends a grant asleep that long, and a heartbeat does not bring it back (without it, a note says long dormancy was not checked); agent traffic never wakes a grant or extends it; handoff, revoked and ended each win over dormant (a grant in handoff past `T_idle` is held only while the app's `T_connect` is longer; otherwise a note says so).
  - **The hub call**: M1, tricky hubs (a longer host, userinfo, a path, a query, a fragment, `http:` unless the hub is a local-dev `http:` origin, another port, a trailing dot, a backslash, unparsable) answer `hub_not_allowed` with no consent and no request on the drop, and on an Allow that carries a hub (an app that binds the hub to the consent on the server says so with `allowCarriesHub: false`, and its Allow must call only the drop's hub). Not on the adapter's word: the suite also posts the Allow to `owner.allow` itself with a foreign hub in `hub` and in place of every value that names the drop's hub, whatever its member's name; it must be refused or ignored (no call off the hub's origin, and a yes only with an `/apc/pair` at the stand-in since). M2 to M4 hold on both hub calls, `/apc/pair` after the Allow and `/apc/confirm` on a drop of a grant in handoff, and once on a paired grant (live, or dormant for an app that sleeps). A confirm call that fails is not taken: the drop shows no code (it is refused, or a fresh consent starts), its target is not pinned, nothing is made live and a dormant grant is not woken. M2, a redirect, a 3xx, an `opaqueredirect` or a redirected answer holds no grant, and the app's request never reaches the redirect's target (the stand-in logs a fetch that follows as reaching it); M3, one deadline covers the headers and the body: stalled headers, a stalled body, headers then a body each held 60% of the app's deadline (`hubDeadlineMs`, 10 s by default), and headers held 90% of it then a body that never ends, all refused by the deadline plus 30% of it (at least 1 s, at most 2.5 s), so two deadlines that add up past the limit fail (under a declared deadline of about 3.3 s the 1 s floor applies, and a second deadline shorter than it goes unseen) (the stand-in honours the request's `AbortSignal`, so a deadline kept with `AbortSignal.timeout` on the fetch works); M4, a `content-length` over the cap or not digits only, and a body over the cap, are refused, while a `content-length` other than the decoded body's (gzip) is taken; M5, with the hub's answer held, another agent's drop and Allow answer within 2.5 s, a second Allow of the same consent gets `pairing_in_progress`, and a new drop of the same agent either waits for the first or answers `pairing_in_progress` (never a second consent or `/apc/pair`); serialization across instances cannot be seen from one process; M9, a drop whose hub ends in `/` calls `{hub}/apc/pair` and `{hub}/apc/confirm`, not `//apc/…`.
  - **M6**, on all four owner endpoints (the drop, the Allow, the heartbeat, Cancel; a missing one fails): a foreign `Origin` (or `null`, or another scheme), look-alikes of the configured origin (a longer host, another port, a trailing dot, a prefix, the origin cut short, so a `startsWith`, `endsWith` or `includes` comparison fails; the same on the WebSocket handshake, the other scheme included), `Sec-Fetch-Site: cross-site` or `same-site`, a media type other than `application/json`, and no session are refused (4xx); its own `Origin`, and neither header, are taken on the session. The configured origin, not the request's: the suite also sends each request to another host (`https://apc-conformance-internal.example`) with that host as its `Origin`, as the inside of a proxy sees it, and expects a refusal. An app that compares `Origin` with its request URL takes it; one that compares with its configuration, or refuses hosts it does not serve, refuses it. A 4xx passes and a 2xx fails. Any other answer (a redirect, a 5xx, a request that does not get through) is compared with the same request carrying a foreign `Origin`: the same answer is a host or a proxy answering, and the probe is left unchecked with a note; another answer fails, since the app took the request's own host as its origin. A WebSocket heartbeat (`{ websocket: path }`) gets the same probes on its handshake. Every state change is a `POST`: a `GET` with the session and the body's fields as a query may answer anything, but must change nothing (no hub call, no grant revoked, a dormant grant still asleep, and no consent: every token of the GET drop's answer is tried as the nonce of an Allow, in the member(s) `owner.allow.body()` has and the drop's body lacks, and none may make the app send `/apc/pair`). Cancel's `body()` should make its grant during the call, through `dock.hub`; for a grant paired beforehand the suite watches every grant in handoff the stand-in paired, and with none a note says the probe did not run.
  - **M7**: `/apc/revoke` answers the same 200 and the same body to any input (not JSON, a foreign URL, an unknown grant, 1 MiB, a body that never ends, answered within 2.5 s), ends a matching grant in handoff or live (which then answers 404), and leaves a revoked grant revoked and an ended one ended.
  - **M8**: `apc.json` lists `dock` while the app can pair and not with pairing disabled, with a `max-age` of 60 or less.
  - **The code goes only in `/apc/pair`**: never in `/apc/confirm`, a URL the app calls, or an MCP answer on the grant.
  - **One pending pairing**: a second drop on a pending pairing shows the same code, with no new consent or `/apc/pair`, and its target is the pin once the grant is live; `not_paired` ends the grant and starts a fresh consent; past the app's stored expiry (two minutes, through the time seam) a drop shows no code, ends the grant and starts a fresh consent; `paired` before `initialize` says it is connecting and stays in handoff until `initialize`; before the acknowledgement a new drop replaces the consent and the stale Allow gets `consent_expired`.
- **`apc_link`** (an app with both profiles): the same client on the other path is offered a code once per session and the code links them; a code is refused on the connection that got it, on the same path, on another client, once used, and once expired; another client is offered nothing; Revoke on a linked agent cuts both grants; Unlink gives two agents again.

It does not check how the page draws presence, the agent bar's two-click Revoke in a real browser, or the hub's own rules (H1 to H7: the reference hub is the only hub until after 1.0). On the Dock profile it does not check the page's heartbeat cadence (`T_idle / 2` while the page is open: the page sends it, and the suite only calls `heartbeat()`), long dormancy for an adapter that gives no `dormancyMs`, Cancel while the hub call is held (the grant's id is not known before the acknowledgement), or serialization across instances (M5). It sees the app's hub calls through `hub.fetch`, and while a check runs it wraps the global `fetch` too: an `/apc/pair` or `/apc/confirm` sent through it past the stand-in counts as a call off the hub's origin and is not sent. A call made with another HTTP client is not seen. After each check the suite gives back the grants it made, waiting 2 s at most for each. The docs' Orders example claims 0.10.0 and runs the 0.10 checks as pending until it meets them (TIN-892).

## Run it from the command line

`@tineira/apc-conformance` has a command, `apc-conformance`, that checks a live app over HTTP with no code (the package is a 0.x pre-release on npm; `next` carries the newest release):

```sh
npx @tineira/apc-conformance@next https://orders.example --grant https://orders.example/mcp/<secret>
```

```text
apc-conformance <app-origin> [--grant <mcp-url>] [--bearer-env <VAR>] [--revoked <mcp-url>] [--revoked-bearer-env <VAR>]
                [--json] [--allow-http] [--timeout <s>]
```

| Option | |
|---|---|
| `<app-origin>` | the app's origin |
| `--grant <mcp-url>` | the MCP URL of a live agent connected directly (Direct profile): runs the MCP checks |
| `--bearer-env <VAR>` | for an app whose agents authenticate with OAuth: the name of an environment variable that holds the grant's bearer token. Sent as `Authorization: Bearer`, never printed. Never put a token on the command line |
| `--revoked-bearer-env <VAR>` | the same, for the revoked grant's token |
| `--revoked <mcp-url>` | the MCP URL of a grant you revoked in the app: checks the revoked answer |
| `--json` | the report as JSON |
| `--allow-http` | allows `http:` for a dev server on the host `localhost`, `127.0.0.1` or `[::1]` only (not `*.localhost`) |
| `--timeout <s>` | seconds per request (15 by default) |

It checks what HTTP reaches:

- **`apc.json`**: served with HTTP 200, no redirect, as JSON of at most 16 KiB; the standard's shape, naming the origin it is served from; a standard the checks know (0.5.0 up to the package's, or a newer patch of it, with a note); an app's profiles, with a Direct app's connect page on its origin.
- **With `--grant`**: the grant's MCP URL lies under the origin and `mcp.path`; `initialize` answers as an MCP server with tools; the core tools are listed with their arguments; `get_current_view` answers in the core's format, with `attention` and `then` the same in the structured result and the text; `wait_for_focus({ timeout_s: 1 })` with no pin times out at 1 s (900 to 5000 ms), or ends at once when no page is open, with a note and no `then`; an unknown grant answers HTTP 404 (skipped with `--bearer-env`: there the URL is shared, and an unknown token is the auth's own 401).
- **With `--revoked`**: the revoked grant answers `{ error: "revoked", revoked_by, revoked_at }` to POST, GET and DELETE: HTTP 403, or 401 with `--revoked-bearer-env`.

It prints `PASS`, `FAIL` or `SKIP` per check, and exits 0 when nothing failed, 1 when a check failed and 2 on a usage error. What needs the person's page is reported `SKIP`, with why: a pin dropped (attention, `next`, a pin during a wait), the page opened or closed, presence, Revoke pressed (and a call running when it is), a phone's touch, and `apc_link`. Run those with the adapter below, in your own tests.

It reads only that origin, over https, never follows a redirect, caps every answer's size, times out every request, and prints no grant secret, whatever an answer echoes: a grant URL shows with its last segment as `<secret>`.

## Run it from code

`apcConformance(adapter)` returns named checks for any test runner; `runConformance(adapter)` runs them all and reports. This is the adapter for the Orders app of the [integration guide](/docs/integrate). It runs everything in one process: the app's `fetch` is called directly, the person's page is the app's own event stream, and on the Dock profile the suite's stand-in hub answers pairing.

<!-- include orders-conformance.ts#imports -->

A dock's hub for the Dock profile: `standInHub` from the suite, which makes tickets, keeps the pairing code the app sends, asks for it to approve, gives the grant back after five wrong codes or when the code expires, and can play a broken hub (no acknowledgement, a redirect, a 500) for the checks that the app fails closed:

<!-- include orders-conformance.ts#hub -->

`connect` makes a new agent with full access, the way each profile makes one: on Direct the person makes an agent on the page; on Dock the person drops one from the dock, is asked, and allows it.

<!-- include orders-conformance.ts#connect -->

The pairing code (Dock, 0.9): what the consent shows, and the person's Allow on it. The suite pairs with `hub`, checks what the app sent it, and plays the dock owner typing codes.

<!-- include orders-conformance.ts#dock -->

The person's page: open while its event stream is, which also carries presence.

<!-- include orders-conformance.ts#page -->

The adapter: the app's name and profile, its `fetch`, two targets a full-access agent may be pinned to, one of the app's own read tools (`probe`, on which `attention` must ride), the page, the page on a phone, on the Dock profile the pairing code (`dock`), and with both profiles the `apc_link` hooks.

<!-- include orders-conformance.ts#adapter -->

Then run it, under `node --test` (`for (const c of apcConformance(adapter)) test(c.name, c.run)`) or as a script:

<!-- include orders-conformance.ts#run -->

### The Dock profile as built (0.10)

An app that claims 0.10.0 or later on the Dock profile also gives `dock.lifecycle` (`ApcDockLifecycleAdapter`), so the suite can put a grant into each state and reach the owner's endpoints. Without it, every 0.10 check fails and says so.

| Member | |
|---|---|
| `dropAgent({ agent, ticket, hub, target })` | the person drops an agent, with the drag's `hub` string as the page read it, on `target` (one of `targets` when left out): what the page shows (`consent` with its code and the Allow, `waiting` with the code, `connecting`, `pinned`, or `refused` with the error). The Allow returns the grant's id, and `allow({ hub })` sends it with another hub, as a tampered page would |
| `allowCarriesHub` | whether the page's Allow carries the hub (true), or the server binds it to the consent (false) |
| `cancel(grantId)` | Cancel on the waiting card |
| `heartbeat()` | the page's heartbeat, a wake action |
| `advance(ms)` | the time seam: the app's clock moves forward, for `T_ack`, `T_connect`, `T_idle` and the stored expiry. Not for the hub call's deadline (M3), which runs on the real clock |
| `failCommits(fail)` | while true, the app's storage fails every write |
| `restart()` | the app's process dies with its calls open and comes back on the same storage |
| `idleMs` (optional) | the app's `T_idle`; left out, the app does not sleep and the dormant checks say so |
| `connectMs` (optional) | the app's `T_connect`, when shorter than the standard's 10 minutes (the default); the T_connect check holds the app to it |
| `dormancyMs` (optional) | long dormancy, for an app that sleeps: how long a grant stays dormant, counted from when it fell asleep, before it ends; left out, long dormancy is not checked |
| `hubDeadlineMs` (optional) | the app's deadline on a hub call, at most 10 000 ms (the default) |
| `owner` | the configured public origin (bare), the headers of the owner's session, and the four owner endpoints `drop`, `allow`, `heartbeat` (or `{ websocket: path }`) and `cancel`, each with a fresh body the app takes with a 2xx (Cancel's body pairs a new grant through `dock.hub` during the call) |
| `pairingDisabled()` | the same app with its dock configuration missing: its `fetch`, for `apc.json` |

Orders gives it like this: its clock is the app's `now`, a restart is a new app on the same store, its T_idle is the standard's 30 minutes, and a grant asleep 30 days ends.

<!-- include orders-conformance.ts#lifecycle -->

The stand-in hub plays the hub's side: it can hold `/apc/pair` (the grant is in flight), break the answer of `/apc/pair` (`mode`) or `/apc/confirm` (`confirmMode`) (redirects, a stalled body, the byte cap), forget a pairing (`/apc/confirm` then says `not_paired`), and approve without introducing itself.

### Apps on Cloudflare Durable Objects

`@tineira/apc-conformance/workers` runs a Durable Object on Node's SQLite, with fake pages for the person's WebSockets (`installWorkersStandIn`, `durableObjectRoom`), so the suite runs against your object with no network and no `workerd`. The reference apps do exactly that: [Pulse](https://github.com/tineira/agent-pointed-context/blob/main/apps/demo/test/conformance.test.ts) and [Signals](https://github.com/tineira/agent-pointed-context/blob/main/apps/signals/test/conformance.test.ts).

## What passing means

Passing says your app speaks the core the way agents and hubs expect, on the profile you ran. It says nothing about your data, your access rules or your page beyond the adapter's answers: write the adapter against the real thing (your page's real handlers, your real storage), not a model of what it should do.
