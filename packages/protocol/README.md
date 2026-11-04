# @apc/protocol

The contract an app and an agent share in Agent Pointed Context: wire types, the target grammar, the version of the standard (`APC_STANDARD_VERSION`) and the core. Its changes are in [CHANGELOG.md](CHANGELOG.md). No dependencies, no Node imports: it runs in the browser, on Workers and on Node. Docs: https://apc.tineira.com/docs

## Install

```sh
npm i @apc/protocol@next
```

Pre-releases go out on the `next` tag while the standard is 0.x; the package's version follows the standard's (0.7.x ships APC 0.7).

```ts
import { APC_STANDARD_VERSION, focusAttrs, parseApcManifest } from "@apc/protocol";

// Mark something in your page that the person can point an agent at:
const attrs = focusAttrs({ kind: "customer", id: "cus_0042" }); // { "data-focus": "customer:cus_0042" }

// Read an app's apc.json, checked against the origin it came from:
const res = await fetch("https://pulse.apc.tineira.com/.well-known/apc.json", { redirect: "manual" });
const parsed = parseApcManifest(await res.json(), "https://pulse.apc.tineira.com");
if (parsed.ok) console.log(parsed.manifest.profiles, parsed.manifest.standard, APC_STANDARD_VERSION);
```

## The core

What every APC app implements, whichever way agents reach it ([`src/core.ts`](src/core.ts)). It holds per grant: a dock's hub is one more holder of a grant.

| Part | What the app does |
|---|---|
| The view | Reports the person's screen as identifiers (`ViewPayload`), trimmed to each grant. |
| The pin | Keeps one pin per grant, dropped by the person on a target (`FocusTarget`), and gives it as `FocusPayload` with `next` and `next_args`, the call that reads it. While it is unread, every tool result carries `attention`. |
| Presence | After each successful tool call, publishes a `PresenceEvent` (ids only) to the person's page; a read of a target names it. |
| The focus format | `FocusPayload`, from the grammar in [`src/target.ts`](src/target.ts): kinds, ids, parts and key-only params. |
| `get_current_view`, `wait_for_focus` | The two core tools (`CORE_TOOLS`), with `then` on results while a page of the person's is open, never on a wait that came back empty. A wait returns a pin dropped during it, times out cleanly, and ends as soon as the app knows the page is closed. |
| `apc.json` | Serves `/.well-known/apc.json` from its own origin: what it is and which profiles it offers (below). |
| `apc_link` | Only with both profiles: the same agent on both paths shown as one, with a one-time code; it grants nothing (below). |
| Mobile (0.6) | On a phone or any touch viewport (`APC_MOBILE_MEDIA`) shows its agents in its own page, on both profiles (below). |
| Revoke from the app | Revoke on every agent in the agent bar. At once, in the app alone (it calls nobody): the grant's MCP URL answers 403 with `RevokedAnswer` from then on, a call already running ends the same way (told by the grant's secret, never an id a later grant may reuse, 0.7), and the grant never works again. |

What belongs to a profile, not to the core:

- **Direct** (the agent connects to the app's own MCP URL): a grant per agent, its secret URL, the list where the person makes and names agents.
- **Dock** (the agent connects once, to a hub): the drop (`application/x-apc-agent`, the handle and the ticket), consent in the app (checked by the app's server, never its page alone: 0.7, `DockConsent` in `@apc/server`), `POST {hub}/apc/pair` (the hub reads the app's `apc.json` first), `POST {hub}/apc/confirm` on every drop, and `POST {app}/apc/revoke`, the hub giving a grant back.

Whatever it offers, an app publishes `apc.json` (below).

An app offers one profile or both. Pulse (`apps/demo`) and Signals (`apps/signals`) offer both, declared in `APC_PROFILES` in their `wrangler.jsonc`; the Direct profile's parts are packaged in `@apc/server` (`direct.ts`) and `@apc/web` (`<apc-direct-agents>`).

### Mobile (0.6)

On a phone there is no dock window, browser extension or desktop pet to drag an agent from, so the agent in the app's own page is the only way the person can point it. In a viewport that matches `APC_MOBILE_MEDIA` (`(pointer: coarse), (max-width: 640px)`), on both profiles, an app ([`src/core.ts`](src/core.ts)):

- **shows its agents in the page**, each with its mark visible and usable for pinning. The Dock profile's rule that the agent bar may collapse does not apply there, and the bar is never collapsed or hidden; it stays reachable while the page scrolls without covering content the person needs;
- **lets a finger pin**, with no mouse drag (phone browsers do no HTML5 drag and drop): touching the agent's mark and then a target ("tap to pin", with a clear state and a way to cancel), or dragging the mark with a finger by pointer events. The pin is the same `FocusTarget` as a mouse drag's. Unpin and Revoke work by touch, with finger-sized targets.

`@apc/web` does both (`<apc-agents>`, `enablePinning`). `APC_MOBILE_VIEWPORT` (375 x 812) is the reference viewport; `@apc/conformance` checks it through the adapter's `page.mobile`.

### `apc_link` (0.4)

An app that offers both profiles shows the same agent on both paths as one ([`src/core.ts`](src/core.ts)). When a connection arrives with the same MCP client as one already connected on the opposite path, the app puts `apc_link: { code, expires_in, note }` on a result of the new connection (on the Dock path, of one of its own tools), at most once per MCP session. The agent sends it back with the tool `apc_link({ code })` on its other connection (through a dock, `<app>__apc_link`). The code works once, for 120 s, only on a different connection on the opposite path that it was offered to; otherwise `link_refused` with a reason. Linking grants nothing: each path keeps its grant, the bar shows one agent, Revoke cuts both, and the person can unlink. On the Dock path the hub names the agent's own client in `_meta["apc.tineira.com/agent_client"]` of its `initialize`.

### `apc.json` (0.5)

Every APC origin says what it is at `GET {origin}/.well-known/apc.json` ([`src/manifest.ts`](src/manifest.ts)): its `name`, the `standard` it implements, its `origin` (exactly the one it is served from), its `profiles` (`"direct"`, `"dock"` or both; `"hub"` alone for a dock), `mcp.path` (where its MCP URLs live) and, with Direct, `direct.connect` (its page where the person connects an agent directly). `@apc/server` builds an app's (`apcManifest`, `apcJsonResponse`). A hub reads it before it pairs and refuses an app whose file is missing, invalid, names another origin, lists no `"dock"` or does not cover the MCP URL; a dock agent dropped on a Direct-only app is answered with how to connect directly (`directOnlyNote`), in the page and in the browser extension.

To check an app against the core, run [`@apc/conformance`](../conformance) on its MCP endpoint (see the root README), or `npx @apc/conformance@next <app-origin>` against a live app.
