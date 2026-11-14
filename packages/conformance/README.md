# @tineira/apc-conformance

Checks an app against the Agent Pointed Context (APC) standard: live over HTTP from a terminal (`apc-conformance`), or the whole suite in your own tests with a small adapter for your page. Node 22.15+. Docs: https://apc.tineira.com/docs

## A live app, from a terminal

```sh
npx @tineira/apc-conformance https://your.app
npx @tineira/apc-conformance https://your.app --grant https://your.app/mcp/<…>/<secret> --revoked <the MCP URL of a grant you revoked> --json
```

It reads `https://your.app/.well-known/apc.json` (its shape, its origin, its profiles, its standard) and, with `--grant` (the MCP URL of an agent connected directly), talks to the grant as an agent does: `initialize`, `tools/list` (the core tools and their arguments), `get_current_view` (the view and focus in the core's format, `attention` and `then` the same in the structured result and the text), `wait_for_focus({ timeout_s: 1 })` (it times out at 1 s, or ends at once when no page is open, with a note and no `then`) and an unknown grant answering 404. With `--revoked` it checks the revoked answer (403 `{ error: "revoked", revoked_by, revoked_at, message }`, `revoked_by` being the app's host, to every request: any JSON-RPC method, a notification, a body that does not parse, POST, GET and DELETE). With a `{secret}` entry in `mcp.endpoints` it checks that a child there that names no grant is not served.

Each check prints `PASS`, `FAIL` or `SKIP`, then `N of M checks ran (H of the T reachable over HTTP); K skipped`, with the reasons grouped, and a warning when more than half of the checks reachable over HTTP were skipped (such a run is no conformance pass; the in-process checks never count toward it); the exit status is 1 when one failed (2 on a usage error), and `--json` prints the report as JSON, with the same in `coverage`. It is safe to point at any URL: https only (`--allow-http` lets `http:` through for a dev server on the hosts `localhost`, `127.0.0.1` and `[::1]` only), grant URLs on the app's origin only, no redirect followed, a size cap on every answer and a timeout on every request (`--timeout <s>`, default 15; `wait_for_focus` is cut at 5 s). A grant URL is a secret: the report never shows it, not even inside an answer that echoes it, and an invalid `--grant` is refused without being printed.

What needs the person's page cannot run over HTTP, and is reported as `SKIP`: a pin riding as `attention` until it is read, `wait_for_focus` returning a pin dropped during the wait or ending when the page closes, `then` only while the page is open, presence, Revoke pressed in the page (and a call running when it is), the mobile checks and `apc_link`. Run those in process, below.

## The whole suite, in your tests

```ts
import { test } from "node:test";
import { apcConformance } from "@tineira/apc-conformance";

for (const check of apcConformance({
  name: "My app",
  profile: "direct",
  connect: async () => ({ mcpUrl, grantId }), // a new agent with full access, no pin yet; with a bearer token add headers: { authorization: `Bearer ${token}` }
  targets: [firstTarget, secondTarget], // two things the person can point at
  probe: { tool: "list_things", args: {} }, // one of your read tools
  page: { setOpen, showView, pin, takePresence, revoke, mobile }, // your page, as your server sees it; mobile: the page on a phone
})) test(check.name, check.run);
```

`page.mobile` (`ApcMobilePage`: `agentBar`, `pinByTouch`, `unpinByTouch`) is required of an app that claims 0.6.0 or later; `@tineira/apc-web`'s README shows how to build it from `barCanCollapse` and `createTapPin`. A Dock app also gives `dock` (the stand-in hub `standInHub`, the pairing code, and from 0.10 `dock.lifecycle`). The docs have two whole adapters: a Direct app with a bearer token (https://apc.tineira.com/docs/integrate#a-complete-direct-app-with-a-bearer-token) and Orders, on both profiles (https://apc.tineira.com/docs/conformance#run-it-from-code).

`runConformance(adapter)` runs them all and returns a report; `httpConformance` / `runHttpConformance` are the HTTP checks as a library. `@tineira/apc-conformance/workers` runs a Cloudflare Durable Object on Node's SQLite with fake pages, so the suite can run against a Worker with no network.

Source and changelog: https://github.com/tineira/agent-pointed-context. MIT.
