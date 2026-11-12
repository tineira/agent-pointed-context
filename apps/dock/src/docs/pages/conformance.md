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
- **Revoke**: the revoked grant answers `revoked` (403 with a secret URL, 401 with a bearer token) to `initialize`, `tools/list`, `tools/call`, a GET and a DELETE; it cannot be pinned; another agent is untouched; a call already running ends `revoked`, with no data.

An adapter whose app authenticates agents with a bearer token (OAuth) gives the token in each connection's `headers` (`{ authorization: "Bearer …" }`); the grant's URL may then be `mcp.path` itself.
- **Mobile** (0.6 and later): every agent is shown in the page, the bar cannot be collapsed, a finger pins and the agent reads the pin, and unpin works by touch.
- **`apc_link`** (an app with both profiles): the same client on the other path is offered a code once per session and the code links them; a code is refused on the connection that got it, on the same path, on another client, once used, and once expired; another client is offered nothing; Revoke on a linked agent cuts both grants; Unlink gives two agents again.

It does not check how the page draws presence, the agent bar's two-click Revoke in a real browser, or the hub's own rules.

## Run it from the command line

`@tineira/apc-conformance` has a command, `apc-conformance`, that checks a live app over HTTP with no code (the package is a 0.x pre-release on npm's `next` dist-tag; its first publish is pending):

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

`apcConformance(adapter)` returns named checks for any test runner; `runConformance(adapter)` runs them all and reports. This is the adapter for the Orders app of the [integration guide](/docs/integrate). It runs everything in one process: the app's `fetch` is called directly, the person's page is the app's own event stream, and on the Dock profile a stand-in hub answers pairing.

<!-- include orders-conformance.ts#imports -->

A stand-in for a dock's hub, for the Dock profile:

<!-- include orders-conformance.ts#hub -->

`connect` makes a new agent with full access, the way each profile makes one: on Direct the person makes an agent on the page; on Dock the person drops one from the dock, is asked, and allows it.

<!-- include orders-conformance.ts#connect -->

The person's page: open while its event stream is, which also carries presence.

<!-- include orders-conformance.ts#page -->

The adapter: the app's name and profile, its `fetch`, two targets a full-access agent may be pinned to, one of the app's own read tools (`probe`, on which `attention` must ride), the page, the page on a phone, and with both profiles the `apc_link` hooks.

<!-- include orders-conformance.ts#adapter -->

Then run it, under `node --test` (`for (const c of apcConformance(adapter)) test(c.name, c.run)`) or as a script:

<!-- include orders-conformance.ts#run -->

### Apps on Cloudflare Durable Objects

`@tineira/apc-conformance/workers` runs a Durable Object on Node's SQLite, with fake pages for the person's WebSockets (`installWorkersStandIn`, `durableObjectRoom`), so the suite runs against your object with no network and no `workerd`. The reference apps do exactly that: [Pulse](https://github.com/tineira/agent-pointed-context/blob/main/apps/demo/test/conformance.test.ts) and [Signals](https://github.com/tineira/agent-pointed-context/blob/main/apps/signals/test/conformance.test.ts).

## What passing means

Passing says your app speaks the core the way agents and hubs expect, on the profile you ran. It says nothing about your data, your access rules or your page beyond the adapter's answers: write the adapter against the real thing (your page's real handlers, your real storage), not a model of what it should do.
