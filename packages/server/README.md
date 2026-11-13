# @tineira/apc-server

Agent Pointed Context (APC) for an app's server: the two core MCP tools (`get_current_view`, `wait_for_focus`), the `attention` and `then` keys every tool result carries, presence events, revoke from the app, `apc.json`, the Direct profile's grants, Dock consent and `apc_link`. Runs wherever there is `fetch` and Web Crypto (Cloudflare Workers, Node 20+, Deno, Bun). Docs: https://apc.tineira.com/docs

## Install

```sh
npm i @tineira/apc-server@next @modelcontextprotocol/sdk zod
```

Pre-releases go out on the `next` tag while the standard is 0.x. `@modelcontextprotocol/sdk` (^1.32.1) and `zod` (^4) are peer dependencies; `@tineira/apc-protocol` comes with it.

The `@tineira/apc-*` packages are ESM only: an `import` export, no `require` build. From CommonJS, load them with `await import("@tineira/apc-server")`; on Node 20.19+ or 22.12+ a plain `require()` works too, since they use no top-level await. A CommonJS test runner needs the same: Jest in its default mode cannot load them, so run it with `NODE_OPTIONS=--experimental-vm-modules` and an ESM config, or let its transform handle them (`transformIgnorePatterns: ["node_modules/(?!@tineira/)"]`); Vitest and `node --test` load them as they are.

## Example

Register the two APC tools next to your own, and attach the envelope to every result while a pin is unread:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APC_INSTRUCTIONS, attachAttention, attentionFor, isUnread, registerApcTools } from "@tineira/apc-server";

const server = new McpServer({ name: "my-app", version: "1.0.0" }, { instructions: APC_INSTRUCTIONS });

registerApcTools(server, {
  readView: async () => myViewTrimmedTo(grant), // identifiers only, cut to the caller's access
  readFocus: async () => myPinFor(grant), // { kind, id, part, params, next, next_args, ... }
  focusUnread: async () => isUnread(await myPinRow(grant)),
  markSeen: async (pinnedAt) => stampSeen(grant, pinnedAt), // that exact pin, once the answer is final
  waitSlot: waits.for(grant), // one wait per grant: const waits = new MemoryWaitSlots() where requests share a process
  waitPresence: { grantId: grant, publish: (event) => toPage({ type: "presence", event }) }, // a wait's open and closed (APC 0.11)
  signal: request.signal, // a client that hangs up ends its wait
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// in your tool wrapper, after each tool runs:
if (isUnread(row) && focus) result = attachAttention(result, attentionFor(focus));
```

Serve your `apc.json` (every APC app does, at `/.well-known/apc.json` on its own origin):

```ts
import { apcJsonResponse, apcManifest } from "@tineira/apc-server";

app.get("/.well-known/apc.json", (c) =>
  apcJsonResponse(apcManifest({ name: "My app", origin: new URL(c.req.url).origin, profiles: ["direct"], connect: "/connect" })),
);
```

## Dock helpers (APC 0.10)

For an app on the Dock profile, the helpers that carry pairing and grant security. They fail closed.

- **`parseDockDrop(body, { hubs, localDevHubs })`** checks a drop's `hub` against your constant allowlist of bare `https:` origins (M1). It also checks the agent and ticket. It answers `{ ok, hub, agent, ticket }`, or `hub_not_allowed` / `invalid_drop`. Call it **on the drop and again on the Allow**. Send hub requests to the `hub` it returns, never to the raw string.
- **`pairWithHub` / `confirmWithHub`** call the hub with these guarantees:
  - they send only to the hub's parsed origin (`https:`, or `http:` on a loopback host);
  - they never follow a redirect;
  - one deadline of at most 10 s covers the headers and the body;
  - they read at most 8 KiB, with a strict `content-length` rule.

  Anything else is `hub_not_allowed`, `hub_unreachable`, `hub_refused` or `hub_ignores_pairing_code`.
- **`handleDockGiveBack(request, { origin, endGrantBySecretHash })`** serves `POST /apc/revoke` (M7). It answers the same 200 to any input, reads at most 4 KiB within 5 s, and never logs the URL. Your `endGrantBySecretHash(hash)` ends the grant unless it is revoked or ended. It must return normally for an unknown grant, and must never create state for an unknown tenant.
- **`dockGrantGate(state, message, { host })`** answers a JSON-RPC message by the grant's state before your MCP transport sees it: 404, `RevokedAnswer`, 202, the `pairing` / `idle` tool error, an idle shape, -32000, or `{ serve: true, commits }`. `dockGrantToolResult(state, tool)` gives the same answers inside a tool handler. **Return those answers as is, before your wrapper code**: no activity stamp, presence event, `attention`, `then` or `apc_link`. The `attach*` helpers don't check for them, so gate first and skip the wrapper.
- **`toolError` fills `structuredContent`** with `{ error, message }`. MCP SDK clients check `structuredContent` against a tool's `outputSchema` even on errors. So a tool that declares an `outputSchema` must admit that shape, or the client rejects the error. With a JSON Schema, use `{ type: "object", anyOf: [yours, { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] }] }` (MCP needs `type: "object"` at the root; leave extra keys allowed). With a raw zod shape, make its fields optional and add optional `error` and `message`. The same goes for the core tools' idle shapes.
- **The derived-secret recipe** (optional): `deriveDockSecret(key, appTag, grantId, salt)`, `newDockSalt()` and `dockSecretHash(secret)`. Store only the hash and the salt.

Then check it with [`@tineira/apc-conformance`](https://www.npmjs.com/package/@tineira/apc-conformance): `npx @tineira/apc-conformance@next https://your.app`.

Source, the worked examples (Pulse and Signals) and the changelog: https://github.com/tineira/agent-pointed-context. MIT.
