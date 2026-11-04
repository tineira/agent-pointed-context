# @apc/protocol

The contract an app and an agent share in Agent Pointed Context: wire types, the target grammar, the version of the standard (`APC_STANDARD_VERSION`) and the core. Its changes are in [CHANGELOG.md](CHANGELOG.md).

## The core

What every APC app implements, whichever way agents reach it ([`src/core.ts`](src/core.ts)). It holds per grant: a dock's hub is one more holder of a grant.

| Part | What the app does |
|---|---|
| The view | Reports the person's screen as identifiers (`ViewPayload`), trimmed to each grant. |
| The pin | Keeps one pin per grant, dropped by the person on a target (`FocusTarget`), and gives it as `FocusPayload` with `next` and `next_args`, the call that reads it. While it is unread, every tool result carries `attention`. |
| Presence | After each successful tool call, publishes a `PresenceEvent` (ids only) to the person's page; a read of a target names it. |
| The focus format | `FocusPayload`, from the grammar in [`src/target.ts`](src/target.ts): kinds, ids, parts and key-only params. |
| `get_current_view`, `wait_for_focus` | The two core tools (`CORE_TOOLS`), with `then` on results while a page of the person's is open, never on a wait that came back empty. A wait returns a pin dropped during it, times out cleanly, and ends as soon as the app knows the page is closed. |
| Revoke from the app | Revoke on every agent in the agent bar. At once, in the app alone (it calls nobody): the grant's MCP URL answers 403 with `RevokedAnswer` from then on, a call already running ends the same way, and the grant never works again. |

What belongs to a profile, not to the core:

- **Direct** (the agent connects to the app's own MCP URL): a grant per agent, its secret URL, the list where the person makes and names agents.
- **Dock** (the agent connects once, to a hub): the drop (`application/x-apc-agent`, the handle and the ticket), consent in the app, `POST {hub}/apc/pair`, `POST {hub}/apc/confirm` on every drop, and `POST {app}/apc/revoke`, the hub giving a grant back.

An app offers one profile or both. Pulse (`apps/demo`) implements both (its deploy, with `APC_V2=1`, runs Dock only); Signals (`apps/signals`) offers Dock.

To check an app against the core, run [`@apc/conformance`](../conformance/src/index.ts) on its MCP endpoint (see the root README).
