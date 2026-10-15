# Agent Pointed Context

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23404049.svg)](https://doi.org/10.5281/zenodo.23404049) [![CI](https://github.com/tineira/agent-pointed-context/actions/workflows/ci.yml/badge.svg)](https://github.com/tineira/agent-pointed-context/actions/workflows/ci.yml)

Point your own AI agent at what you see in an app, without sharing the screen.

[![Agent Pointed Context: an agent's mark dragged onto a bar of a chart; only a key travels to the person's own agent, which reads the data behind it and joins it with the person's own MRR file, kept apart from the app.](docs/landing.jpg)](https://apc.tineira.com)

**Try it:** [apc.tineira.com](https://apc.tineira.com). No sign-up: each visitor gets a private sandbox with synthetic data, deleted after 6 hours without use. The [how-to](https://apc.tineira.com/how-to) takes about five minutes with Claude Code, claude.ai, ChatGPT, Grok, Cursor or any agent that accepts a remote MCP server by URL.

This repo is the open reference implementation and demo of **Agent Pointed Context (APC)**:

> T. Neira. *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen.* Zenodo, 2026. https://doi.org/10.5281/zenodo.23382909
>
> T. Neira. *Agent Pointed Context: design records and payload specification.* Zenodo, 2026. https://doi.org/10.5281/zenodo.23383101

## The idea

An app exposes three small channels to any agent connected over the [Model Context Protocol](https://modelcontextprotocol.io), and they carry identifiers and keys only, never pixels, text or amounts:

1. **View**: the screen the person is on, as identifiers (page, month, filters, at most one selected row).
2. **Pin**: the person drags their agent's mark onto a row, a cell or one step of a computed figure. The pin carries a key and the exact tool call that reads it (`next`, `next_args`). It reaches the agent on its next tool result, with no polling by the model, or right away through `wait_for_focus`.
3. **Presence**: each agent is a mark on screen and lights up on what it reads.

The agent reads what a pin points at through its ordinary tools, under the access it already has. And because it is **your own agent**, it already knows things the app does not: your files, your other tools, your memory. In the demo, Pulse (a fictional SaaS analytics app) knows customers and seats but not revenue; you give your agent a file of MRR per customer, point at a bar, and ask how much MRR it is. Your agent matches the customer ids behind the bar with your file and answers. Pulse never receives an MRR value.

[![The how-to's featured case: bring what you know, MRR per customer, step by step.](docs/how-to-mrr.jpg)](https://apc.tineira.com/how-to?topic=examples)

## What the demo shows

| Claim | Where to see it |
|---|---|
| Pointers, not content | the focus payload on the landing; tests refuse amounts and free text in pins and views |
| Delivery without polling by the model | the `attention` envelope on the next tool result, in the structured result and in the text |
| The pointer leads to the data, not the picture | `get_figure` returns the customer ids behind a bar or a bridge step |
| Same inputs, same function, same number | the page and the server import one pure function; a test compares them for every figure and month |
| Pointing grants no access | add a restricted agent (LATAM only): it gets a figure cut to its region, and is told so |
| Presence | each agent's mark pulses on its tool calls and outlines the rows it reads |
| The join happens in your agent | the MRR walkthrough; no server module can import the MRR generator (a test checks it) |
| Any MCP client | the How-to and Agents pages log, per agent, how it connected and read its pins |

Measurements (load test up to 150 visitors at once, CPU per request) are in [DESIGN.md §9b](DESIGN.md#9b-capacity-measured-2026-10-15-production).

## Use the pattern in your app

The packages are TypeScript sources in this workspace (not on npm yet). They are small, so copying them is fine too.

| Package | What it gives you |
|---|---|
| [`@apc/protocol`](packages/protocol) | wire types, the target grammar (kinds, parts, key-only params), `data-focus` attributes |
| [`@apc/server`](packages/server) | `registerApcTools` (`get_current_view`, `wait_for_focus`), `attachAttention` for the envelope, `presenceEvent` |
| [`@apc/web`](packages/web) | `enablePinning` (drag a mark onto anything with `data-focus`), `flashTargets` for presence, `createViewReporter` |

On the server, register the two APC tools next to your own and attach the envelope to every result while a pin is unread:

```ts
import { registerApcTools, attachAttention, attentionFor, isUnread } from "@apc/server";

registerApcTools(server, {
  readView: async () => myViewTrimmedTo(grant),          // identifiers only, cut to the caller's access
  readFocus: async () => myPinFor(grant),                 // { kind, id, part, params, next, next_args, ... }
  focusUnread: async () => isUnread(await myPinRow(grant)),
  markSeen: async () => stampSeen(grant),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// in your tool wrapper, after each tool runs:
if (isUnread(row) && focus) result = attachAttention(result, attentionFor(focus));
```

In the page, mark what can be pointed at and let the person drag their agent's mark onto it:

```tsx
import { focusAttrs } from "@apc/protocol";
import { enablePinning } from "@apc/web";

<g {...focusAttrs({ kind: "figure", params: { key: "active_customers", month: "2026-03" } })}>…</g>
<tr {...focusAttrs({ kind: "customer", id: "cus_0042" })}>…</tr>

enablePinning({ onPin: (grantId, target) => savePin(grantId, target) });
```

The demo is the full worked example: [`apps/demo/src/worker`](apps/demo/src/worker) (the sandbox, the MCP endpoint, grant trimming, the figure registry) and [`apps/demo/src/web`](apps/demo/src/web) (marks, pins, presence).

## Run it

Node 24 and pnpm through corepack:

```sh
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm dev          # http://localhost:5173 (Vite + the local Workers runtime)
```

Deploy your own copy to Cloudflare Workers (the free plan is enough to try it):

```sh
cd apps/demo
npx wrangler login
# in wrangler.jsonc, remove the "routes" entry or point it at your own domain
node node_modules/vite/bin/vite.js build && npx wrangler deploy
```

On Windows the local Workers runtime needs the Microsoft Visual C++ Redistributable, and it sometimes crashes when a new sandbox starts; the page retries. Deployed, this does not happen.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | wire types and the target grammar |
| `packages/server` | the attention envelope, `get_current_view`, `wait_for_focus`, presence events |
| `packages/web` | drag-to-pin, presence marks, view reporting |
| `apps/demo` | Pulse, the demo app: a Cloudflare Worker with one Durable Object per visitor, a Vite + React front end |
| `scripts/loadtest.mjs` | the load test behind DESIGN.md §9b |
| `DESIGN.md` | design, decisions, measurements |

## What the hosted demo stores

Per sandbox, until it is deleted 6 hours after its last use: its seed, its agents' grants, your current view (identifiers only, and you can switch it off), pins, and an event log of tool calls including their arguments (so you can check what your agent sent). The MRR file is made in your browser and never sent. There are no analytics. Cloudflare keeps its usual request logs for the Worker.

## Status

Cut 1 is live. Open work is tracked in [issues](https://github.com/tineira/agent-pointed-context/issues): the plan and seat screens, the canary check over the event log, reusing the MCP server per agent, the client compatibility matrix across agents, per-client connection guides, and the evaluation harness (cut 2).

Security issues: please use GitHub's private vulnerability reporting (Security tab), not a public issue.

## Credits

The look follows [hue-switch-console](https://github.com/tineira/hue-switch-console) by the same author, reused here under MIT. Its colour themes come from the [Omarchy](https://github.com/basecamp/omarchy) palettes (MIT). Fonts: [Geist](https://vercel.com/font) (SIL Open Font License).

## Cite

This software: T. Neira. *Agent Pointed Context: reference implementation and demo.* Zenodo. https://doi.org/10.5281/zenodo.23404049 (all versions; v0.1.0 is https://doi.org/10.5281/zenodo.23404050). See also [CITATION.cff](CITATION.cff). Please cite the paper for the pattern itself.

## License

MIT for the code (see [LICENSE](LICENSE)). The paper and its companion record are CC BY 4.0.
