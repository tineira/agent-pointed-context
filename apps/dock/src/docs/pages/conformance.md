# Conformance

`@apc/conformance` checks an app against the [core](/docs/spec#the-core) of the standard the way an agent or a dock's hub reaches it: JSON-RPC over the app's MCP endpoint, stateless, plus `GET /.well-known/apc.json`. What only the app's page knows (whether a page is open, the view it reports, the pin the person drops, the presence it receives, Revoke in the agent bar) comes through a small **adapter** the app writes.

It checks the version of the standard it ships with, and any app that claims a version from 0.5.0 up to it.

## What it checks

On the profile under test, Direct or Dock:

- **`apc.json`**: served as JSON from the app's own origin, valid, a standard the suite knows, the profile under test listed (both, with `apc_link`), never `"hub"`, the grant's MCP URL under `mcp.path`, `direct.connect` on the app's origin.
- **The tools**: `get_current_view` and `wait_for_focus` listed; `get_current_view` takes no required argument; `timeout_s` is an optional whole number from 1.
- **The view**: identifiers only (`params` are keys), and no focus before a pin.
- **The pin**: rides as `attention`, in the structured result and in the text, on any result until it is read; `next` with `next_args` reads it; a new pin replaces it, unread again.
- **`wait_for_focus`**: returns a pin dropped during the wait, soon after; times out cleanly with a note and no `then`; ends at once when the person has no page open.
- **`then`**: on results only while the person's page is open.
- **Presence**: one event per read, ids only, naming the target the read touched.
- **Revoke**: the revoked grant answers 403 `revoked` to `initialize`, `tools/list`, `tools/call`, a GET and a DELETE; it cannot be pinned; another agent is untouched; a call already running ends `revoked`, with no data.
- **Mobile** (0.6 and later): every agent is shown in the page, the bar cannot be collapsed, a finger pins and the agent reads the pin, and unpin works by touch.
- **`apc_link`** (an app with both profiles): the same client on the other path is offered a code once per session and the code links them; a code is refused on the connection that got it, on the same path, on another client, once used, and once expired; another client is offered nothing; Revoke on a linked agent cuts both grants; Unlink gives two agents again.

It does not check how the page draws presence, the agent bar's two-click Revoke in a real browser, or the hub's own rules.

## Run it from the command line

Coming with the npm release: a command that needs no code. It reads the app's `apc.json` and runs the suite against the app, printing PASS or FAIL per check:

```sh
npx @apc/conformance@next https://orders.example
```

It treats the origin as untrusted (size and time limits, no redirects followed). Checks that need the person's page (pins, presence, Revoke) need the adapter below. Its options may still change before it ships; this section will follow them.

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

`@apc/conformance/workers` runs a Durable Object on Node's SQLite, with fake pages for the person's WebSockets (`installWorkersStandIn`, `durableObjectRoom`), so the suite runs against your object with no network and no `workerd`. The reference apps do exactly that: [Pulse](https://github.com/tineira/agent-pointed-context/blob/main/apps/demo/test/conformance.test.ts) and [Signals](https://github.com/tineira/agent-pointed-context/blob/main/apps/signals/test/conformance.test.ts).

## What passing means

Passing says your app speaks the core the way agents and hubs expect, on the profile you ran. It says nothing about your data, your access rules or your page beyond the adapter's answers: write the adapter against the real thing (your page's real handlers, your real storage), not a model of what it should do.
