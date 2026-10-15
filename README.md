# Agent Pointed Context

Point your own AI agent at what you see in an application, without sharing the screen.

This repo is the open reference implementation and demo of **Agent Pointed Context (APC)**, described in:

> T. Neira. *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen.* Zenodo, 2026. https://doi.org/10.5281/zenodo.23382909

The application exposes three identifier-only channels to any agent connected over MCP: the person's **view**, a **pin** the person drops on a row or on a part of a computed figure, and the agent's **presence** on screen. The agent reads what a pin points at through its ordinary, authorized tools, and joins it with what it already knows about the person, which the application never sees.

**Status:** work in progress (cut 1). See [DESIGN.md](DESIGN.md).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | wire types and the target grammar |
| `packages/server` | the attention envelope, `get_current_view`, `wait_for_focus`, presence events |
| `packages/web` | drag-to-pin, presence marks, view reporting |
| `apps/demo` | Pulse, a synthetic SaaS analytics app on Cloudflare Workers + Durable Objects |

## Develop

Node 24 and pnpm (through corepack):

```sh
corepack pnpm install
corepack pnpm test
corepack pnpm dev        # http://localhost:5173
```

## License

MIT for the code. The paper is CC BY 4.0.
