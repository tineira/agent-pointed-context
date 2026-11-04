# Integrate your app in an afternoon

This guide builds **Orders**, a small app with a list of a shop's orders, into a complete APC app: Direct first (an agent connects to the app's own MCP URL), then Dock (an agent dragged from a dock). Every sample on this page is a region of three real files in the repo, [orders-app.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-app.ts) (the server), [orders-page.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-page.ts) (the page) and [orders-conformance.ts](https://github.com/tineira/agent-pointed-context/blob/main/apps/dock/src/docs/examples/orders-conformance.ts) (the test). They type-check against the current packages on every build, and the conformance suite passes against them on both profiles.

The server is plain Web standard `Request` and `Response`, so it runs on Node, Deno, Bun or a Cloudflare Worker; the page is plain DOM, so it fits React, Vue or none. State is kept in memory, for one person, so the APC parts stay in sight: your app keeps grants, pins and the view in its own database, per person, and puts the person's routes behind its own sign-in.

## 1. Install

The packages are 0.x pre-releases on npm's `next` dist-tag (never `latest` before the standard is 1.0), and their version follows the standard's: 0.7.x ships APC 0.7.

```sh
npm i @tineira/apc-server@next @modelcontextprotocol/sdk zod   # the server (the SDK and zod are peers)
npm i @tineira/apc-protocol@next @tineira/apc-web@next         # the page
npm i -D @tineira/apc-conformance@next                         # the tests
```

The first publish is pending: until the packages appear on npm, these lines are what you will run, and meanwhile the sources are in the repo, [`packages/protocol`](https://github.com/tineira/agent-pointed-context/tree/main/packages/protocol), [`packages/server`](https://github.com/tineira/agent-pointed-context/tree/main/packages/server), [`packages/web`](https://github.com/tineira/agent-pointed-context/tree/main/packages/web) and [`packages/conformance`](https://github.com/tineira/agent-pointed-context/tree/main/packages/conformance), small enough to add to your workspace or copy.

They are ESM with type declarations. `@tineira/apc-protocol` and `@tineira/apc-web` have no Node imports (`@tineira/apc-web` is browser code for any bundler); `@tineira/apc-server` runs wherever there are `fetch` and Web Crypto (Workers, Node 20+); `@tineira/apc-conformance` needs Node 22.15+.

| Package | Gives you |
|---|---|
| `@tineira/apc-protocol` | the types, the target grammar (`parseTarget`), `focusAttrs`, `apc.json` |
| `@tineira/apc-server` | the two APC tools, `attention` and `then`, presence, grants, revoke, consent, `apc_link`, `apc.json` |
| `@tineira/apc-web` | pinning (drag and tap), the agent bar `<apc-agents>`, the Direct agent list, presence, the view reporter |
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

<!-- include orders-app.ts#mcp -->

On Cloudflare Workers, give the server `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` (from `@modelcontextprotocol/sdk/validation/cfworker`), and keep the state in a Durable Object: `sqlKv(ctx.storage.sql)` gives `DockConsent` and `ApcLinks` their table.

## 8. Around every tool

This is where APC rides on your results. Every tool, the two APC tools included, runs inside one wrapper that:

- ends the call `revoked` if its grant was revoked, before or while it ran;
- puts `attention` on the result while the grant's pin is unread;
- publishes presence to the person's page, naming what a read touched;
- puts `then` on the result while a page of the person's is open, but never on a wait that came back empty;
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

## 10. Revoke

Revoke holds in the app alone, at once, and calls nobody. The app keeps a hash of the secret, so the URL answers `revoked` from then on, and a call already running ends the same way.

<!-- include orders-app.ts#revoke -->

## 11. Try it with your agent

Run the app on a public HTTPS origin (a tunnel works for a test), make an agent on the page, and add its URL to your agent (Claude, ChatGPT, Cursor, Grok: any client that takes a remote MCP server). Drag its mark onto an order and ask "what is this?". The agent sees `attention` on its next call, or calls `get_current_view`, then `get_order` with the focus's `next_args`.

## 12. Dock: agents dragged from a dock

Add `"dock"` to the profiles and list the hubs you pair with. A dock's agent arrives as a drag with a hub, a public handle and a single-use ticket. The page sends every such drop to the server (`resolveAgent: () => null` and `onUnknownAgent` above); the server decides:

<!-- include orders-app.ts#dock -->

- **No grant for that agent yet:** the server answers `consent_required` with a nonce, the page asks the person, and only the Allow that brings the nonce back makes a grant and pairs it with the hub (`POST {hub}/apc/pair`). The person then allows it in their dock too.
- **A grant already:** the server asks the hub whether the pairing still stands (`POST {hub}/apc/confirm`) and pins it, or asks the person again.
- **The person unpairs in the dock:** the hub calls your `POST /apc/revoke` with the grant's MCP URL, and the grant goes.

The hub reads your `apc.json` before it pairs: it must list `"dock"`, name your origin, and cover the MCP URL you send. The reference dock at `apc.tineira.com` pairs with any app that passes its checks, as **Not verified** until it is on its list: the person sees a warning with your domain first ([the hub's trust model](/docs/spec#the-hubs-trust-model)), and your results reach the agent marked untrusted.

With both profiles, the same agent connected both ways is offered `apc_link` and shows once in your bar: the `ApcLinks` calls above (`arrived` on `initialize`, `offer` around every tool, `registerApcLinkTool`) are all it takes.

## 13. Test it

Run the conformance suite against your app before you ship: see [Conformance](/docs/conformance), whose adapter for Orders is the third file of this guide.

## Checklist

- `GET /.well-known/apc.json` names your origin, your profiles and `mcp.path`.
- Every pointable element has `data-focus`; targets carry ids and keys only.
- `get_current_view` and `wait_for_focus` are registered on every grant.
- Every tool runs inside the wrapper: revoke check, `attention`, presence, `then`.
- The agent bar is on every page, with Revoke; on a phone it stays in the page.
- Revoke answers 403 `revoked` to every method; an unknown grant 404.
- Dock: every drop goes to the server; consent is the server's nonce.
- The conformance suite passes, on each profile you offer.
