# @apc/server

Agent Pointed Context (APC) for an app's server: the two core MCP tools (`get_current_view`, `wait_for_focus`), the `attention` and `then` keys every tool result carries, presence events, revoke from the app, `apc.json`, the Direct profile's grants, Dock consent and `apc_link`. Runs wherever there is `fetch` and Web Crypto (Cloudflare Workers, Node 20+, Deno, Bun). Docs: https://apc.tineira.com/docs

## Install

```sh
npm i @apc/server@next @modelcontextprotocol/sdk zod
```

Pre-releases go out on the `next` tag while the standard is 0.x. `@modelcontextprotocol/sdk` (^1.32.1) and `zod` (^4) are peer dependencies; `@apc/protocol` comes with it.

## Example

Register the two APC tools next to your own, and attach the envelope to every result while a pin is unread:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APC_INSTRUCTIONS, attachAttention, attentionFor, isUnread, registerApcTools } from "@apc/server";

const server = new McpServer({ name: "my-app", version: "1.0.0" }, { instructions: APC_INSTRUCTIONS });

registerApcTools(server, {
  readView: async () => myViewTrimmedTo(grant), // identifiers only, cut to the caller's access
  readFocus: async () => myPinFor(grant), // { kind, id, part, params, next, next_args, ... }
  focusUnread: async () => isUnread(await myPinRow(grant)),
  markSeen: async () => stampSeen(grant),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// in your tool wrapper, after each tool runs:
if (isUnread(row) && focus) result = attachAttention(result, attentionFor(focus));
```

Serve your `apc.json` (every APC app does, at `/.well-known/apc.json` on its own origin):

```ts
import { apcJsonResponse, apcManifest } from "@apc/server";

app.get("/.well-known/apc.json", (c) =>
  apcJsonResponse(apcManifest({ name: "My app", origin: new URL(c.req.url).origin, profiles: ["direct"], connect: "/connect" })),
);
```

Then check it with [`@apc/conformance`](https://www.npmjs.com/package/@apc/conformance): `npx @apc/conformance@next https://your.app`.

Source, the worked examples (Pulse and Signals) and the changelog: https://github.com/tineira/agent-pointed-context. MIT.
