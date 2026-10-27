# Agent Pointed Context: demo and reference implementation

| | |
|---|---|
| **Status** | Cut 1 live at https://apc.tineira.com since 2026-10-15. This document records what is built and why (section 11, Decisions); it holds no plans. Public open work: [GitHub issues](https://github.com/tineira/agent-pointed-context/issues). The maintainer's own plans are tracked privately. |
| **Paper** | T. Neira, *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen*, 2026. https://doi.org/10.5281/zenodo.23382909 |
| **Spec** | Companion record, `04-payload-specification.md`. https://doi.org/10.5281/zenodo.23383101 |
| **License** | MIT (code). The paper is CC BY 4.0. |
| **Visibility** | Public since 2026-10-15. Software DOI 10.5281/zenodo.23404049 (all versions; v0.1.0 is 10.5281/zenodo.23404050), one per release through the Zenodo GitHub integration. |
| **Hosting** | Cloudflare Workers + Durable Objects, one sandbox per visitor, at https://apc.tineira.com (also apc-demo.apc-demo.workers.dev). The same code runs locally with `pnpm dev`, no account needed. |

## 1. Why this repo exists

The paper describes APC as built into PFA, a private single-owner ledger that is not released. That leaves three gaps this repo closes:

1. **Reproducibility.** A reader can open the hosted demo or run it locally, not only read about it.
2. **Generality.** The paper's own limitation is "one application, one domain, one person". This demo is a second domain (SaaS product analytics) on a second stack, with the same wire format, used by many people at once.
3. **Measurement.** Payload bytes, model tokens against a screenshot, envelope latency, wrong-referent rate and clarification turns are hypotheses in the paper. Here every one of them is instrumented on synthetic data, with no private data anywhere.

It also makes a claim the paper only touches, and which may be the pattern's main advantage (section 3).

## 2. What the demo must show

| # | Claim | Paper | How the demo shows it |
|---|---|---|---|
| C1 | Pointers, not content: the view and the pin carry ids and keys only | §3.2, §6 | wire log; tests refuse amounts and free text |
| C2 | Delivery without model-driven polling: the pin rides on the next tool result | §3.2, §4.3 | `attention` envelope; timing log |
| C3 | The pointer leads to the data, not to the picture | §3.3 | `get_figure` returns `inputs` the agent drills into |
| C4 | Same inputs, same function, same number | §4.4 | page and server import one pure function; equality test on a fixture |
| C5 | Pointing grants no access; a restricted agent gets a trimmed answer and is told so | §6 | optional restricted agent (one region), `trimmed: { hidden_entities }` |
| C6 | Presence: the person sees which agent read or changed what | §4.2 | marks and cursor, live from the sandbox |
| **C7** | **The cross-reference happens in the agent** (new, section 3) | — | the user's private MRR file, never seen by the app; canary check |
| C8 | Any MCP client, not one vendor's | §5 | client compatibility matrix (section 9) |

## 3. The cross-reference happens in the agent (new)

The person comes to the application **with their own agent**, and that agent already knows things about the person: their files, their other tools, their memory, knowledge the person holds and does not want to give the application. An assistant embedded in the application can only know what the application knows. An external agent pointed through APC brings both halves together **on the agent's side**:

- the application contributes the referent and the facts it holds, bounded by the grant;
- the agent contributes what the person already knows;
- neither hands its half to the other. The application never receives the person's private knowledge, and the agent sees of the application only what its grant allows.

**In the demo.** The application is the analytics product of a fictional SaaS vendor. It knows customers, plans, regions, seats and activity. **It does not know revenue**, and it should not: in the real world revenue sits in the person's billing system or spreadsheet, outside this product. The person's own knowledge is represented by a file `mrr-by-customer.csv` (`customer_id, month, mrr`). The application does not provide it and never reads it; the demo only makes one so anyone can reproduce the scenario. It stands in for what a real user already has.

- **Hosted:** the visitor's browser generates the file from the sandbox's public seed, with a generator that is not part of the server bundle, and offers it as a download. The server has no MRR code and no MRR values.
- **Local:** `pnpm seed` writes it to `user-side/`, a folder no server module references.

**The scenario.** The person drags their agent's mark onto the bar "active customers, March 2026" and asks: *"how much MRR is this, and which customer has the best MRR per seat?"* The pin resolves to `get_figure`, which returns the count and `inputs.customers`, the external ids behind the bar, plus seats per customer. The agent joins those ids with the person's file and answers with the exact MRR and the ranking. No MRR value ever reaches the application.

**Design consequences.**

1. **Join keys are part of the contract.** For the join to work, `inputs` must expose identifiers that exist in the person's other systems (here `cus_0042`, the id their billing also uses), not internal surrogate keys. Each figure in the registry declares which external ids its `inputs` carry. The paper does not state this because in PFA everything lived in one system.
2. **Privacy in the other direction is checked, not assumed.** The seed makes MRR values distinctive. The sandbox records the arguments of every tool call. A canary check that runs **outside the server** (`scripts/canary.mjs`, and the harness in cut 2, both of which have the file) scans that log and asserts no MRR value appears in it, as written, with a thousands separator, or without `.00`. If an agent leaks one into an argument by accident, the report says so. **Boundary:** the log holds the arguments of calls that passed the MCP SDK's schema validation, recorded before the domain validates them (`instrument()` in `apps/demo/src/worker/sandbox.ts`), not every inbound byte. A call the SDK refuses, or a request body that is not a tool call, is not in it, so a clean canary says what reached the tools, not what reached the server.
3. **Scope of the promise.** APC guarantees only what the application learns. What the person's agent does with their own knowledge is between the person and their agent.

## 4. The demo application

**Domain:** product analytics for a fictional SaaS ("Pulse"). Synthetic, seeded, about 200 customers over 18 months, three plans, three regions.

**Data:** `customers` (`id` = external id `cus_NNNN`, name, plan, region, signup month) and `activity` (customer, month, active, seats, usage events) are rebuilt in memory from the sandbox's seed, so a sandbox stores only the seed. Its Durable Object SQLite holds `grants`, `view_state`, `agent_focus` and `events` (instrumentation).

**Screens:**
- **Overview:** active customers per month (bar chart), the customer bridge for a month (start, new, reactivated, churned, end), seats per month.
- **Plans:** plan × month matrix of active customers.
- **Customers:** a table of rows, and a customer detail pane (plan, seats, usage, status).
- **How to** (the landing page): a six-step walkthrough with the visitor's own URL and file in it: connect, point, ask what it sees or let it wait, a simple example, the MRR example, and what your agents did.
- **Agents:** one MCP URL per agent, "add another agent", "add a restricted agent", the compatibility matrix, the switches (share view, show agent activity) and the event log.
- Every MCP URL shown (Agents, the how-to's connect steps) has its QR beside it; while no agent of the sandbox has connected, Overview and Customers open with a dismissible connect panel (URL, QR, Claude Code command).

**Pin kinds:**

| kind | id | part / params | `next` |
|---|---|---|---|
| `customer` | `cus_NNNN` | `plan`, `seats`, `usage`, `status` | `get_customer` |
| `figure` | — | `{ key: active_customers, month, plan?, region? }` | `get_figure` |
| `figure` | — | `{ key: customer_bridge, month }`, part `step:<start\|new\|reactivated\|churned\|end>` | `get_figure` |
| `figure` | — | `{ key: plan_matrix, month }`, part `cell:<plan>\|<month>` | `get_figure` |
| `figure` | — | `{ key: seats, month }` | `get_figure` |

**Per-kind allowlist (v0.2.0).** The protocol's `parseTarget` checks the grammar only: any token-shaped params pass it, on any kind. The host narrows it per kind in `checkPin` (`apps/demo/src/worker/domain.ts`). A `customer` pin is named by its id and part alone and carries no params: anything but absent or `null` is `invalid_target`, so a value like `{"note":"SECRET-1234.57"}` is never stored, logged or handed to an agent in `focus.params`. A `figure` pin keeps only the keys its figure's `parse` reads (`only()` in `apps/demo/src/model/figures.ts`); any other key is `invalid_target`. A protocol test documents that the parser alone does not do this, so the host check stays.

## 5. Sandboxes and connection

**One sandbox per visitor.** Opening the demo creates a sandbox: one Durable Object with a random id, kept in a cookie, seeded with its own synthetic data. It holds that visitor's pins, presence and event log, and expires after a few hours of inactivity (alarm, then delete). Visitors never share state: a URL leads to exactly one Durable Object.

**One secret MCP URL per agent grant.** By default a sandbox has one grant with full access, shown on Connect as a URL to paste as a connector in any MCP client (`https://<demo>/mcp/<sandbox>/<grant-secret>`). No login: the secret in the URL is the grant. "Add a restricted agent" creates a second grant limited to one region, with its own URL, to show C5. Each grant gets its own mark on screen.

**Rate limits** per sandbox and per IP keep the hosted demo cheap and stop one visitor from affecting another.

## 6. Wire format

The same as `04-payload-specification.md` (view result, focus payload, `attention` envelope, `wait_for_focus`, presence message, switches). Differences:

| PFA | Demo | Why |
|---|---|---|
| Postgres + RLS | Durable Object SQLite per sandbox; grant checks in one module | isolation by construction, no accounts |
| Supabase Realtime Broadcast | WebSocket from the sandbox's Durable Object to its page | one place holds the state and the channel |
| `wait_for_focus` ceiling 50 s (host limit) | configurable, default 50 | keep the paper's number, allow a measurement without it |
| OAuth 2.1 + PKCE | secret capability URL per grant | any MCP client connects by pasting a URL; OAuth can come later |
| `attention` as a top-level key of the structured result | the same, **and** mirrored in the text content | some clients show the model only the text content |
| bank-text hashing (`h:<16 hex>`) | not needed: no free-text keys in this domain | kept in the library, unused here |

**Waiting after answering (TIN-95, 2026-10-17).** The stance moves from "a timed-out wait is the exception" to "wait after every answer while the person is on the page, gated by presence". Agents answered and stopped, so the person had to ask whether a pin had arrived. Now `APC_INSTRUCTIONS` and the tool descriptions say to call `wait_for_focus` after answering. While the sandbox holds at least one open page WebSocket (`pageOpen()` in the host context), every tool result carries a model-visible `then` key next to `attention`, placed the same way (structured result and text, never `_meta`). With no page open the key is absent, and `wait_for_focus` returns at once with `{ focus: null, timed_out: false, page_open: false, note }`. It checks the pin row and presence on every poll, every 2 s (`pollMs`), and returns that same result early when the page closes; "at once" means at its next check, so within 2 s of the close the sandbox sees. A timeout returns `{ focus: null, timed_out: true, page_open, note }` without `then`, so the loop ends there. The default timeout is 25 s, and the server stays passive: no push, no session, no new storage. **Ceiling, measured** (`scripts/wait-ceiling.mjs`: a fresh sandbox, its page socket held open, no pin). The local Workers runtime (`pnpm dev` with the ceiling raised to 600 for the probe) held waits of 30, 50, 60, 90, 120, 180 and 300 s to within 0.1 s. The 600 s probe was cut at 304.5 s by the probing client's own 300 s header timeout (Node's fetch), not by the runtime. On production (apc.tineira.com, deployed ceiling 50), 30 s and 50 s held (30.3 s, 50.3 s). Cloudflare documents no wall-time limit on a Durable Object request while the caller stays connected. The ceiling stays at 50 s anyway, because the client is what limits it: the MCP TypeScript SDK's default request timeout is 60 s, and in the end-to-end run Claude Code 2.1.302 cut a 300 s wait at about 60 s. Adoption is measured per agent as `waits_after_answer` in the compatibility matrix: a `wait_for_focus` that starts within 30 s after the grant's last call ended, when that call was not itself a wait. **Known gap:** under `pnpm dev`, closing a Chrome tab did not reach the Durable Object through the Vite dev proxy. The socket stayed open there, so `then` kept coming and the agent waited once more, which the timeout bounds. A scripted page socket that is closed, or whose process is killed, is seen as closed at once. A page heartbeat would close the gap. **Closed by the heartbeat (TIN-95 follow-up):** the page sends `"ping"` every 30 s on its WebSocket, and the sandbox answers `"pong"` through the hibernation API's auto-response, which does not wake the object and never reaches the log or the presence channel. `pageOpen()` counts a socket only while it is OPEN and was answered, or accepted, within 75 s (two heartbeats plus slack for throttled background tabs; `apps/demo/src/worker/page.ts`). The 75 s window is the fallback for a proxy that never reports a closed socket: where the close does arrive (a scripted socket that is closed or killed), the socket stops counting at its next check. Under `pnpm dev`, a closed Chrome tab now reads as closed 67 s after the close.

**With view sharing off, attendance is hidden too (v0.2.0).** With `share_view` off the person has asked not to be observed. Until v0.1.0 the view went dark but `then` and `page_open` still told every grant, a restricted one included, that a page was open and when it closed: the paper's Table 2 now lists that as a channel with no switch. Now the switch covers it. The sandbox's `pageOpen` callback returns `null` while sharing is off (`attendance()` in `apps/demo/src/worker/page.ts`), so no result carries `then` (`then_bytes` logs 0), and `wait_for_focus` waits for a pin for its full timeout and returns the pin when one arrives, but reports no `page_open` at all, neither true nor false, and does not end early when the page closes (`packages/server/src/tools.ts` already omits the key and skips the early return when the callback yields `null`). Pointing still works with sharing off; only attendance is hidden. The tool description, `APC_INSTRUCTIONS` and the manual say that `page_open` is reported only while the person shares their view. With sharing on, nothing changed.

**The manual, opt-in (TIN-96).** Beyond what the server tells every agent, the full manual exists in two opt-in forms with one text, both loaded by an explicit gesture of the person: the MCP prompt `guide` (a slash command or a menu item in the client) and the installable skill `skills/pulse-agent`. Whether a grant loaded the prompt is a column of the compatibility matrix.

## 7. Architecture

A pnpm monorepo with three reusable packages and one app, so the pattern can be adopted, not only watched:

- `packages/protocol` (`@apc/protocol`): the wire types and the target grammar (kinds, parts, key-only params, canonical keys, `data-focus` attributes), shared by both sides.
- `packages/server` (`@apc/server`): runtime-agnostic TypeScript. The `attention` envelope (structured result and text), the `get_current_view` and `wait_for_focus` tools over a host-supplied context, the presence event builder. The view allowlist and the figure registry are the host's (here `apps/demo/src/worker/domain.ts` and `apps/demo/src/model/figures.ts`).
- `packages/web` (`@apc/web`): framework-agnostic DOM. `data-focus` attributes and their parser, drag-to-pin with the innermost-target rule, a hit-test registry for canvas or SVG surfaces, agent marks and the presence cursor, view reporting (debounced, visible tab only).
- `apps/demo`: Pulse. A Cloudflare Worker (Hono) routes to the sandbox Durable Object, which serves MCP over Streamable HTTP (official SDK), the browser API and the WebSocket. The front end is Vite + React, served as Worker static assets. The figure functions live in `apps/demo/src/model/` and are imported by both the page and the Durable Object: that is what C4 tests.

## 8. Instrumentation

Every event goes to the sandbox's `events` table, exportable as JSONL:

- `tool_call`: grant, client name, tool, arguments bytes, result bytes, envelope bytes (0 when none), server latency.
- `tool_call` also logs `then_bytes`: what the loop hint added (0 when no page was open, or when the person does not share their view). The two are measured apart. `envelope_bytes` is the compact JSON of the `attention` object alone (`{"focus":…,"note":…}`), without the key or the delimiter around it. `then_bytes` is the text `,"then":"…"` that the hint adds to a result's text, key and delimiter included. **Payload:** on apc.tineira.com the envelope for a pin on a monthly bar of `active_customers` is 571 bytes (its `part_note` is the longer one), and 539 for the `churned` step of `customer_bridge` (it moves by a few bytes with the step name and the origin's length). While a page is open and the view is shared, `then` adds 117 bytes to every result's text and the same to its structured result.
- `pin`, `envelope_delivered`, `seen`, and `next_read` (the first call to `focus.next` with `focus.next_args`).
- `inbound`: the arguments of every tool call that passed the SDK's schema validation, recorded before domain validation, for the canary check (section 3, which states the boundary).

Derived metrics, shown on a sandbox metrics page and exported for the paper: focus and envelope payload bytes; pin → envelope → seen → next-read times; the share of pins read through the envelope vs `get_current_view` vs `wait_for_focus`; canary hits (expected 0). The hosted demo also keeps anonymous aggregate counters (sandboxes, pins, clients) and nothing else.

## 9. Tests and verification

**Automated (the tests the paper describes, done here):**
- **Registry completeness, both directions:** a static scan of every `data-focus` usage in the app against the figure registry. Every key and part used is registered, and every registered key is used.
- **Equality:** on a fixed fixture, `get_figure` returns the same values the page's model computes, for every figure key.
- **Envelope:** present only while `pinned_at > seen_at`; gone after the acknowledging read; a new pin replaces an unread one; mirrored in the text content.
- **Grants:** a restricted grant cannot be pinned outside its region; figures are cut and counted; a by-id screen outside the grant is `view: null`.
- **Isolation:** one sandbox's URL never reads, pins or hears another's.
- **Content-free channels:** the presence message type has no content field; the view and pin refuse amounts and free text.
- **C7:** no server module references `user-side/` or the MRR generator; the canary is 0 after the scripted scenario.

**Client compatibility matrix (C8).** Recorded automatically per agent from the event log (`apps/demo/src/worker/compat.ts`, shown on the How to and Agents pages and served as `compat.json`): client name, version and user agent from `initialize`, tool list, pins, envelopes, how each pin was read (`get_current_view` or `wait_for_focus`, and whether after an envelope), whether the pin's `next` call was made, and the median time from pin to read. One URL per agent keeps each client apart. Run by hand over every MCP client available to the author (Claude, Codex, Cursor, Grok, Grok bot, AGY, others as they come), one row each: connects to the remote URL (directly or through `mcp-remote`); the model sees the envelope; the model calls `get_current_view` on "this"; the pin resolves through `next`; the MRR join is answered. Published with each release.

## 9b. Capacity (measured 2026-10-15, production)

Each visitor is its own Durable Object, so concurrency is not shared: nothing serialises one visitor behind another. What bounds the hosted demo is the Cloudflare plan's quotas and its CPU limit per request.

**Load test** (`scripts/loadtest.mjs`, one client in Santiago): every simulated visitor opens a sandbox, reads its state, reports a view, connects an agent over MCP (initialize, tools/list), pins a figure, makes an unrelated call that carries the envelope, reads the view and follows `next`, and reads the matrix.

| Visitors at once | Requests | Errors | p50 per request | p95 per request |
|---|---|---|---|---|
| 20 | 220 | 0 | 240 to 630 ms | up to 2.1 s |
| 75 | 1,650 | 0 | 230 to 570 ms | up to 1.5 s |
| 150 | 3,300 | 0 | 240 to 650 ms | 0.9 to 3.6 s |

The p50 is mostly network (Chile to the edge to the sandbox): inside the Durable Object an MCP call took about 24 ms of wall time. The 150-at-once p95 coincides with 150 sandboxes created in the same seconds.

**CPU per invocation** (from `wrangler tail`, sampled): median 1 ms on almost every route, p95 about 10 ms, maximum 17 ms; 2.8% of invocations were over 10 ms, the Free plan's limit, and none failed. The heaviest were downloading the dataset (since removed: the page rebuilds it from the seed with the same function) and MCP calls, which build the SDK server per request (7 to 11 ms).

**Changes from the test:** the compatibility matrix reloads on the sandbox's WebSocket announcements instead of polling every 5 s (one open how-to tab went from about 1,440 Durable Object requests an hour to a handful); the page rebuilds the data from the seed; the WebSocket reconnects with backoff; rate limits of 10 new sandboxes a minute per IP and 300 calls a minute per sandbox (page and agents together; per sandbox, not per IP, because hosted agents share egress IPs). Cloudflare's limiter is approximate: in a test it started answering 429 after about 30 creations in a minute.

**Remaining:** MCP calls rebuild the SDK server per request; caching it per grant would cut their CPU. On the Free plan the daily quota (100,000 Worker and 100,000 Durable Object requests) is the ceiling, roughly 1,000 visits a day; the Paid plan removes it for a few cents per thousand visits.

## 10. Cuts

1. **Cut 1, the demo runs end to end**, hosted and local: sandboxes, view, pin, envelope, `wait_for_focus`, presence, the four figures, the MRR join scenario, instrumentation, the tests and the client matrix in section 9. README with a two-minute walkthrough.
2. **Cut 2, the evaluation harness:** a scripted agent over the Claude API on one fixed question set, four referent conditions (describe in words, paste the deep link, screenshot plus the same tools, APC) × with and without the user's file, same tools and grant in every condition. Measures: input and output tokens, clarification turns, wrong-referent rate, answer correctness against seeded ground truth, payload bytes reported apart from tokens.
3. **Cut 3, release:** repo public, first Zenodo software DOI, paper v2 citing the release for its measurements, adding C7 and the client matrix.

## 11. Decisions

| Decision | Choice | Date |
|---|---|---|
| Domain | SaaS product analytics without revenue; the user's MRR file as their own knowledge | 2026-10-15 |
| Visibility and license | private until cut 1, then public; MIT; Zenodo DOI per release | 2026-10-15 |
| Front end | Vite + React | 2026-10-15 |
| Hosting | Cloudflare Workers + Durable Objects, one sandbox per visitor | 2026-10-15 |
| Agent connection | secret MCP URL per grant; one full grant by default, an optional restricted one | 2026-10-15 |
| Clients | any MCP client; cut 1 verified as a compatibility matrix over the author's clients | 2026-10-15 |
| Pin params | per-kind allowlist in the host: a customer pin carries none, a figure pin only its spec's keys | 2026-10-19 |
| Attendance | `then` and `page_open` follow the view-sharing switch; the mark's pulse follows the activity switch | 2026-10-19 |
| v2 topology | attention hub: the agent connects once, to the dock's hub, which watches each paired app with v1 `wait_for_focus` and relays its tools as `<app>__<tool>` (or `call_app_tool`); one focus per agent, newest pin wins | 2026-10-25 |
| v2 pairing | the drag carries a public handle and a single-use 60 s ticket, never a grant; the app hands its grant to the hub over a back channel after consent in the app and in the dock; MCP authorization (OAuth 2.1 + PKCE) replaces the secret URL later | 2026-10-25 |
| v2 dock host | a web window at v2.apc.tineira.com with a Durable Object hub first (TIN-370), against a Pulse under apc-v2; a browser extension with a local hub next; package changes additive and opt-in, v1 stays on 0.2 | 2026-10-25 |
| v2 prototype (TIN-370) | Pulse for the dock is `apps/demo` deployed again inside apc-v2 with a v2 flag; the hub exposes only `call_app_tool`; newest pin wins; pairing needs consent in the app and in the dock | 2026-10-25 |
| Browser extension (TIN-395) | the extension only receives: the dock and Float stay the drag source; on an APC app the app takes the drop; on any other page the extension pushes a bounded **page reading** (untrusted data, not a pin) to the dropped agent's hub, after a per-site grant; it pairs on the first drop with the drag's ticket, confirmed in the dock, from an allowlisted extension origin | 2026-10-26 |

## 12. APC v2: one agent across apps (TIN-371)

**The idea.** A window on the desktop, the dock, holds the person's agents, already connected. The person drags one onto anything in any APC app, in any window, and it is Pulse again: the agent is pointed at that thing and reads it with its own access.

**Two options.**

| | (a) Dock as launcher | (b) Dock as attention hub |
|---|---|---|
| Agent connects to | every app, one MCP URL each | the hub, once |
| Waits | one `wait_for_focus` per app | one, across all apps |
| Data path | agent to app, direct | agent to hub to app (relayed) |
| New on the wire | nothing | hub tools, an app reference on the focus |
| Dock knows where an agent points | no | yes |

**Choice: (b), the attention hub.** Three reasons.

1. A drop cannot hand an agent a URL. MCP clients add servers by configuration; whether any lets a connection be added mid-conversation must be verified. So (a) is v1 with one paste per app, which we already have.
2. A tool call blocks the agent's turn, so it holds one wait at a time. With N apps, a pin in another app reaches it only on its next call there.
3. The dock must show and revoke where each agent is pointed (12.5). Only a dock in the path can.

The cost of (b): app results pass through the hub, so a real hub runs where the person already trusts (their machine or their own account). The hosted prototype is fine because Pulse is synthetic. The hub stores no results and logs sizes and presence only.

### 12.1 Pairing without secrets in the drag

The drag carries a public handle and a short-lived ticket, never a grant:

```ts
// dataTransfer type "application/x-apc-agent" (APC_AGENT_TYPE), set on dragstart in the dock.
// TIN-369 shipped { v: 1, agent }; hub and ticket join it with pairing (TIN-370), and the parser ignores keys it does not know.
interface AgentDrag {
  v: 1;
  hub: string;      // the hub's origin, e.g. "https://v2.apc.tineira.com"
  agent: string;    // public handle, "ag_7f3k…"; safe for any page to read
  ticket: string;   // single use, 60 s, bound to this agent; opens a pairing request, nothing else
}
```

A page sees only the types during `dragover` and the data on `drop`, enough to light up targets. Whether custom types survive a drag between browser windows, or from a native window, must be verified per browser and OS.

On drop, the app looks up `(hub, agent)`:

- **Paired:** it stores a v1 pin for the grant it gave that agent. Nothing else changes.
- **Not paired:** the app asks for consent on its own page ("Let *agent* from *hub* read Pulse? Full or one region?"). On yes, it creates a grant (v1 `addAgentGrant` or `addRestrictedGrant`) and sends the grant to the hub over a back channel, server to server: `POST {hub}/apc/pair { ticket, app: { id, name, origin, icon }, mcp_url }`. The hub then asks in the dock: "*app at origin* wants to be read by *agent*. Allow?" The pairing counts only when both sides have said yes. The dock shows the origin of `mcp_url`, because that is where the tools come from.

A local hub (extension, desktop app) cannot take that POST; the app's page would hand the grant to the extension, and how a page reaches an extension it does not know must be verified (`externally_connectable` takes a static list of sites). The long-term answer is MCP's own authorization, OAuth 2.1 with PKCE, with the hub as client and the ticket only starting the flow. v1 deferred OAuth (section 6); v2 brings it in.

### 12.2 Focus from app to hub

v2 reuses the v1 pin as it is. Each `(agent, app)` pair is one v1 grant held by the hub, so the app stores `FocusRow` per grant, resolves `FocusPayload` and trims it to that grant exactly as today. C5 holds per app.

The hub learns about pins with v1's own tool. While the dock is open, the hub keeps one `wait_for_focus` running against each paired app, so the hub does the N waits and the agent does one. A wait that returns `page_open: false` comes back at once, so the hub backs off for that app (one retry every 15 s) instead of spinning. Once the dock closes, the hub stops watching.

The app's `seen_at` now means "the hub received it"; the hub logs the agent's own `seen`.

Not built: an optional doorbell would cut latency and held requests. After a pin, the app's server would send `POST {hub}/apc/ring { app, agent }` with a token from pairing. It would carry no target; the hub would read the focus as before.

### 12.3 Tool names and the app on the focus

The hub exposes its own `get_current_view` and `wait_for_focus`. It hides each app's two, and relays the app's other tools as `<app>__<tool>` (`pulse__get_figure`). The app id is `[a-z0-9]{1,16}` and unique per hub, chosen at pairing, with a suffix on collision. The total stays within 64 characters, because client name limits vary and must be verified.

A new app changes the tool list: the hub sends `notifications/tools/list_changed` and sees whether the client lists again. Until then `call_app_tool({ app, tool, args })` always works.

The focus says where it came from:

```ts
interface AppRef { id: string; name: string; origin: string }
// FocusPayload gains (optional): app?: AppRef
// next / next_args are rewritten by the hub:
//   "pulse__get_figure", { … }                                          when the client has the prefixed tool
//   "call_app_tool", { app: "pulse", tool: "get_figure", args: { … } }  otherwise
```

Relayed results arrive with the app's own `attention` and `then` keys, which point at tools the agent cannot see. The hub strips them and attaches its own. The hub's `get_current_view` returns the focus plus `views: Array<{ app: AppRef; view: ViewPayload | null }>`, newest first.

### 12.4 Presence and attention: per hub

An agent has one mark, so one focus: the newest pin across apps wins, as in v1. Older pins stay drawn in their apps; the hub no longer surfaces them.

`attention` rides on every hub result while the hub's focus is unread. `then` is per hub: it is present when the dock is open and at least one paired app reports `page_open: true`. If every app reports `null` (none shares its view), `then` is absent and `page_open` is not reported, as in v1. The dock is the drag source, so with the dock closed nobody can point.

Presence events keep `v: 1` and gain an optional `app`. The app's own presence works unchanged: the relayed call reaches it under that agent's grant.

### 12.5 Security: a dropped agent points, it never grants

What a hostile page can do with a dropped agent:

- read the handle and an unexpired ticket, and ask to pair; the person sees the request in the dock and can say no;
- once paired by the person, pin keys (checked by `parseTarget` and the app's allowlist) and offer tools whose descriptions and results may try injection, as any MCP server the person adds can; the hub never merges an app's `instructions` into its own;
- pull the agent's attention; the hub rate-limits pins per app (v1's 300 a minute) and the dock shows each one.

What it cannot do: get the hub's URL or any grant, see another app's view or focus, call its tools, or receive what the hub relays for it. The agent may still carry data from app A into arguments to app B: the C7 boundary (section 3), now between apps. Presence in the dock makes it visible, not impossible.

**The dock shows**, per agent, where it points now (app, origin, `kind:id`, part), its paired apps with last activity, and pending pairings. **It revokes**: clear the pointer, or unpair an app. Unpairing is authoritative at the hub: it deletes the grant, stops relaying and drops the app's pins. Revoking the app's side needs an endpoint (OAuth revocation, later).

### 12.6 Where the dock lives

- **Web window** (or PWA) at v2.apc.tineira.com/dock (since TIN-420; / is the APC v2 landing, and the Worker sends a visitor whose cookie holds a dock on to /dock with the query kept), hub in a Durable Object per dock. No install; needs apps that accept native drops (TIN-369); cannot float on top (Document Picture-in-Picture might; dragging out of it must be verified). Each agent has its own page at /dock/agents/<id> (TIN-419): what it did (a log of its last 300 calls through the hub: tool, app, time, the pin it read, error code; never argument values or results), its apps with Unpair and pending requests, its connection folded, and Remove.
- **Browser extension.** A content script can add drop handling to any page; native messaging reaches a local hub. Section 13 settled that the extension only receives drags, from the dock and Float. Costs an install, store review, one build per browser.
- **Desktop app** (Tauri or Electron). A natural home for a local hub, the heaviest to build. OS drags into browsers may keep only `text/plain` and `text/uri-list` (to verify).

**Order:** web window first, extension second, desktop app only if the extension cannot start drags.

### 12.7 Changes to the packages

Everything below is **additive and opt-in**, so v1 stays on 0.2.

- `@apc/protocol`: `AppRef`; optional `app` on `FocusPayload` and `PresenceEvent`; `appToolName(app, tool)`.
- `@apc/server`: `registerHubTools(server, hubCtx)` next to `registerApcTools`; `APC_HUB_INSTRUCTIONS`; `combineAttendance(values: (boolean | null)[])` (true if any is true, null if all are null, else false); `detachKeys(result, ["attention", "then"])`.
- `@apc/web`: **shipped in TIN-369**: `enablePinning({ acceptNativeDrops, resolveAgent })`, reusing `targetAt` and `canTarget`, with `APC_AGENT_TYPE`, `agentDragPayload` and `parseAgentDragPayload`. They move to `@apc/protocol` once the hub needs them too. Next: `startAgentDrag(element, drag)` for the dock.

**Breaking, and avoided:** prefixing tool names inside apps, keying `FocusRow` by app, or requiring OAuth instead of the secret URL. Any of these would make it APC 0.3.

### 12.8 What's built

1. **TIN-369 (shipped 2026-10-25):** native drops in `@apc/web`, opt-in. Pulse turns them on only when opened with `?apc=v2`, so v1 is unchanged.
2. **TIN-370:** the web-window dock and a hub Durable Object in `apps/dock`. One agent connects to the hub. The first drags can land on apc.tineira.com with `?apc=v2` (drops only, onto agents of that sandbox); pairing (`/apc/pair`) runs only on a Pulse under apc-v2, never on apc.tineira.com. That Pulse is `apps/demo` deployed a second time inside apc-v2 with a v2 flag (drops and `/apc/pair` on), not imported into `apps/dock`, so v2 does not depend on v1's internals. The hub watches with v1 `wait_for_focus`; it exposes only `call_app_tool` (prefixed tools wait for phase 3), and `next` uses it. Newest pin wins, and a pairing needs both yeses, as above.

   **Built in two steps (2026-10-25).** TIN-370: the dock window and the drag, fed by Pulse over postMessage (now at v2.apc.tineira.com/bridge, opened from apc.tineira.com with `?apc=v2`). TIN-382: the hub, a Durable Object per dock in `apps/dock`, and Pulse's v2 deploy (`apps/demo`, wrangler env `v2`: Worker apc-v2-pulse at pulse.v2.apc.tineira.com, `APC_V2=1`). What the prototype settled, beyond the sections above:
   - The hub's tools are `get_current_view` (focus plus `views`), `wait_for_focus`, `call_app_tool` and `list_app_tools` (each app's tools with their input schemas, since the agent never sees them in its own list).
   - The hub has no running watcher. It asks the apps when the agent calls: `get_current_view` on each paired app before its own `get_current_view`, `call_app_tool` and `list_app_tools`, so a new pin rides as `attention` on any call; one `wait_for_focus` per app, in parallel, during its own. So an app's `seen_at` is the moment the hub took the pin, which is when the agent's call is running.
   - `then` rides on hub results while the dock window is open (its WebSocket heartbeat) and the last word from a paired app said the person is on its page.
   - In `@apc/web`: `parseAgentDrag` (hub and ticket, each dropped if malformed), `agentDragPayload(handle, { hub, ticket })` and `onUnknownAgent` on `enablePinning`. The dock keeps one fresh ticket per agent, since `dragstart` cannot wait for the network.
   - Pulse pairs only with the hubs in `HUB_ORIGINS`, the hub only with the apps in `APP_ORIGINS` (and only an MCP URL on the app's own origin), so neither fetches an address a page chose. Pulse's guided first run is off on the v2 deploy: it teaches the v1 top-bar mark.
3. A second small APC app on its own origin, so pairing really crosses origins. Prefixed tools after `list_changed`, and the dock's revoke. New compatibility-matrix columns: `list_changed` honoured, and waits through the hub.

   **Built (TIN-384, 2026-10-25): Signals**, a market feed at signals.v2.apc.tineira.com (`apps/signals`). Its posts come from `model/market.ts`, deterministic from a seed (since TIN-393, the dock's: each app is its own page and the dock opens both on the same world): competitor offers aimed at a segment (region, plan) the month before that segment's worst churn, plus offers that explain nothing, and our ads, each with a promo code that some of that month's signups used (`signup_code`, shown and filterable only on Pulse's v2 deploy). Nothing ties a person to an ad they saw: the offer joins churn by segment and month, the code joins signups customer by customer, and the agent does the joining; neither app sees the other's data. A post, or its `offer`, `audience`, `code` or `text`, is a target (kind `post`, read with `get_post`).
   - The hub lists each paired app's tools as `<app>__<tool>` with the app's own description and JSON Schema (a low-level MCP `Server`, since `McpServer` takes zod shapes). It declares `tools.listChanged` but, stateless, cannot send the notification, so it records when the client lists tools: once a client has listed after an app was paired, that app's focus comes with `next` set to the prefixed tool and the app's own `next_args`; before, `call_app_tool`.
   - New columns, per agent in the dock: tools re-listed after a pairing, prefixed calls, `call_app_tool` calls, waits through the hub.

   **Two rules from testing it (TIN-388, 2026-10-25).**
   - **The agent's mark.** An agent is drawn by its mark, a name and a small raster icon (PNG, at most 16 KB, the MCP `clientInfo.icons` rule), on every pin and every mark of every APC app: a pin is the agent's logo, not text. Through a dock, the dock page draws the agent's logo (the curated one, or the icon its client sent) as a 64 px PNG and gives it to the hub. The hub carries it as `clientInfo.title` ("Claude via dock") and `clientInfo.icons` when it initializes with an app, initializes again when it changes, and returns it as `agent: { name, icon }` in its answer to `/apc/pair`, so the app's first pin already shows it. An app keeps only a raster data URI, never SVG or a remote URL.
   - **Revocation.** Whoever holds a grant can give it back: `POST {app origin}/apc/revoke { mcp_url }`, the grant's own MCP URL as the proof. The hub calls it when the person unpairs an app or denies a pairing in the dock. The app deletes the grant, its pins and its dock link, so the next drop of that agent asks the person again. An app without the endpoint answers 404 and its grant simply stops being used.
   - **Confirm on every drop (TIN-389).** An app cannot tell on its own that a hub dropped a pairing (revocation missed it, or the dock's storage expired). So a dock agent's drop always goes to the app's server with the drag's ticket; when the app already holds a grant for that agent, it asks `POST {hub}/apc/confirm { ticket, agent, mcp_url }`. The hub answers yes with the agent's mark (and spends the ticket), or `not_paired` (keeping the ticket), and the app then drops its grant and asks the person, pairing with that same ticket.
   - **The badge** is the logo itself on a transparent background, no frame; a monochrome mark is inked mid grey so it reads on light and dark pages.

   **The agent bar (TIN-394).** Every APC app shows the agents present in it the same way: `<apc-agents>` from `@apc/web`, a custom element at the top right of the app (in Signals, at the top of the sidebar on desktop and in the top bar on a phone). For each agent, connected directly or through a dock:
   - its mark, 32 px with the logo at 22 px, the name as tooltip; outlined when the agent sees only part of the app;
   - its state on the mark: grey and faded before it connects, floating while it waits (`wait_for_focus`), pulsing while it calls, a short bounce when it reads a pin; still under reduced motion;
   - where it points: a dot, accent while unread and green once read, ringed when the target is on another screen (click: go there), and × to remove the pin;
   - a ! when something needs the person (TIN-358: another product uses this agent's URL).

   Dragging a mark from the bar onto a target points the agent within the page (the marks carry `data-apc-mark` and `data-grant`, which `enablePinning` drags). The element renders in light DOM, so `enablePinning` sees the marks and the app's fonts apply, and is themed through `--apc-*` properties; an app draws the logos itself with `renderIcon`, or gives each agent an image (`icon`). Events: `apc-open`, `apc-unpin`, `apc-warning`. The bar is the agent in this page; the dock is the agent across pages, and where a pairing starts. The apps are independent (TIN-393): no app links to another. The dock holds the demo world's seed and opens each app on it (`?seed=`); Pulse's v2 deploy takes it when it makes a sandbox, or moves an existing sandbox to it (its pins and view go, its agents and pairings stay), and apc.tineira.com ignores it. Pulse's v2 deploy and Signals use it; apc.tineira.com keeps its own marks, the same in look.

   **The dock as an installed app (TIN-392).** The dock is APC v2's main app: a web app manifest, a service worker (network only, since the dock is live state, with an offline note) and its own icon make Chrome and Edge install it as a window of its own; the first launch sizes it to a narrow strip. Each agent is a large tile, its logo at 64 px, which is what the person drags; its connection, paired apps and counters fold under it. Under the agents, the apps it opens, each as its own page. A PWA window cannot stay on top of other windows, so **Float** opens the agents in a Document Picture-in-Picture window (Chrome and Edge on desktop), each logo draggable as in the dock; a drag out of it lands in a tab (verified in Chrome 156 and Edge 156 on 2026-10-26, section 13.1).
   **Apps take agents only from a dock (TIN-402).** On Pulse's v2 deploy an app is a place the person points their agent at; the agent lives in the dock. So Pulse v2 has no agent of its own and no way to connect one: a new sandbox has no grant, the routes that make one answer 404 (`dock_only`), and a conflict cannot split off a new URL. Its How-to is four steps through the dock, Overview says to drag the agent from the dock, and there is no Dock button (the person comes from the dock). The agents are managed in the dock, not in each app (TIN-410): Pulse v2's Agents tab is **Settings**, with only its own switches (share my view, show agent activity) and the event log, and an agent's access to Pulse is taken back with **Unpair** in the dock, which gives the grant back. A grant with no dock link (the default agent of a sandbox made before) is dropped when the sandbox loads. The hub also drops a pairing whose app answers 404 (the app's data expired, or the app took the grant back), so the dock stops listing it and a new drop asks again. apc.tineira.com keeps its own agents, How-to and connect panel.

   **The dock's first run (TIN-403).** Dock first, then the world: the agent connects to the dock, not to the apps, and the world lives in the dock. A new dock shows its first run and nothing else: *your dock* (what it is, and Install); *connect your agent* (the MCP URL, the prompt to paste into an agent that does not know how, the QR, and the step ticks itself when the agent connects; it can be skipped); *create your world* (a random seed the person can keep or change, and why: the apps invent the same reality from it, share nothing, and only the agent joins them). **Next** saves the world (`POST /api/d/:did/world`) and ends the first run (a dock already paired with an app skips it). Then one step per app (TIN-406), each a plain link, since a browser blocks a second window opened from the same click: *open Pulse*, in the browser or as Pulse for desktop (a download, the `PulseDesktop.exe` the Desktop workflow publishes on main to the fixed `pulse-desktop` prerelease, with the Pulse link on the world to paste into it; macOS and Linux will be a line each), then *open Signals*. **Change world** runs the same steps from the world on, warning that each app's pins and view go while agents and pairings stay. The connect panel that was Pulse's (`qr.tsx`: the QR and the prompt, shared) is what each agent's tile shows under **Connect this agent**.

   **An agent not connected yet drags as its connect prompt (TIN-408).** Until a client connects to it, an agent in the dock (its tile, its Float logo, the plug in the first run) drags as `text/plain` only: the prompt asking an agent to connect the MCP server, with its URL. Dropped into an agent's chat box, it is pasted as typed text. It carries no APC payload, so it cannot pair or point. Once connected, the drag is the APC payload again, which never carries a URL. This is the one place a drag carries a secret, the agent's MCP URL, and only before that agent is connected (so before the dock is paired with any app), readable by whatever page the person drops it on. The demo accepts that: its data is synthetic, the URL is also shown, copied and put in a QR on the same screen, and a dock expires. With OAuth the prompt would carry only the server's public address, and the gesture would hold no secret.

   **Start over (TIN-411).** To test from zero, the dock, Pulse's v2 deploy and Signals each have **Start over** (the dock's footer, Pulse's Settings, Signals' sidebar), behind a dialog that says what goes. Each site can wipe only its own data, since its session cookie is its own and httpOnly: the server deletes the Durable Object's storage, as when it expires, and the cookie; the page clears its local storage, service worker and caches and reloads. The dock first gives every grant back, so each paired app drops it. The dialog names the other two sites to start over in, and gives a prompt asking the agent to remove the "APC" server, whose URL stops working.

   **Pulse for desktop (TIN-396).** An installed app takes the dock's agent too: `apps/desktop`, Pulse's figures in Avalonia (.NET 8), built for Windows by the Desktop workflow as one self-contained `PulseDesktop.exe`. It is a client of Pulse's v2 deploy, not a second Pulse: it opens a sandbox the way the page does (on the dock's world when given the dock's Pulse link or seed), reads the data from `/api/s/:sid/dataset` (v2 deploy only) and computes the figures as `figures.ts` does, keeps the page's WebSocket heartbeat (so the person counts as on Pulse and the app hears every pin and read), and pairs and pins through the same `/hub/pair`, after the same consent. Each bridge step, each month bar, the whole chart and each customer row is a target, with the page's target names, so the agent cannot tell the app from the page.
   - **Reading the drag.** A browser does not hand a custom type to another app under its own name: Chrome and Edge pack every custom type of a drag into one OLE clipboard format, `Chromium Web Custom MIME Data Format` (a Chromium pickle: a uint32 size, a uint32 count, then UTF-16 type and data pairs, each padded to four bytes). The app reads `application/x-apc-agent` out of it, or takes the type directly from a native source. Its tests hold a pickle captured from a real Chromium drag.
   - **Linux and macOS** (not built: [#86](https://github.com/tineira/agent-pointed-context/issues/86), [#85](https://github.com/tineira/agent-pointed-context/issues/85)). Chromium gives the same pickle on X11 as `chromium/x-web-custom-data`, and the app already reads it, but Avalonia 11's X11 backend takes no drops from other apps (tested under Xvfb: the drag reaches the window, no drag event fires). The Linux app needs another drop path.

   **The dock for Windows ([#84](https://github.com/tineira/agent-pointed-context/issues/84)).** What the installed web dock and Float cannot do: stay on top without Picture-in-Picture, show with a global shortcut, live in the tray. `apps/dock-desktop` is a Tauri v2 app (Rust, the system's WebView2) around the dock page itself, so the hub, pairing and the drag are the web dock's. It opens the dock's window (`/dock`, marked by a script the app runs on every load, so it holds through Start over: it hides Install and Float, names the shortcut instead, and takes `/` back to `/dock`) and Float as desktop pets (TIN-479): each agent its own small frameless, transparent window (`/dock?view=pet&agent=<id>`), always on top and out of the taskbar; Alt+Shift+Space or the tray shows and hides them all, closing a window hides it, Quit is in the tray. Links out of the dock (Pulse, Signals, downloads) open in the person's browser.
   - **Tauri, not Electron or .NET.** The issue asked for the most code shared with macOS and Linux (#85, #86) without Electron's size: one Rust shell around the same page on all three. Avalonia would have meant rewriting the dock's UI natively.
   - **The drag survives.** WebView2 is Chromium, so a drag out of a pet (the strip before it) carries `application/x-apc-agent` in the same `Chromium Web Custom MIME Data Format` a browser drag does (verified on 2026-10-26: the type arrives in Chrome 156 and Edge 156, and a drop on Pulse pairs and points the agent). macOS's WKWebView and Linux's WebKitGTK will not write Chromium's format, so there the drag will have to start natively.
   - **Its own dock.** The app keeps its own cookies, so it is a dock of its own, with its own first run, as a dock installed in another browser would be; bringing a browser's dock into it is not built. The pets open beside the dock's window and ask `POST /api/dock` with `{ resume: true }`, which never makes a dock (404 without one), so a first run cannot make two.
   - **Pets (TIN-479).** A pet is dragged as the strip's logos were: dropped on an APC app that takes it, it points the agent. A drop nothing took (`dropEffect` "none" at `dragend`) moves the pet there instead: the page tells the app, which reads the cursor itself (`GetCursorPos`, physical pixels, so mixed DPI needs no conversion; the event's `screenX` is in Chromium's per-display DIPs) and moves the window with the held point under it. Not when the cursor is still on the pet (a short drag) or the button is still down (a drag cancelled with Esc ends while it is held). Each pet's spot is kept per agent in the app's config folder (`pets.json`, written whole and renamed into place), and the pet is placed on a visible monitor's work area on start, on every drop and when the displays change, without saving that clamp, so a pet goes back to a monitor that returns; a pet is shown without taking the focus (`SW_SHOWNOACTIVATE`); a new agent's pet goes down from the top right. The pets' pages tell the app the dock's agents on every change, so pets come and go with them; an empty dock shows one hint pet that opens the dock. A pairing request shows as a bubble beside its pet, above it or below, towards the middle of the screen; the window grows for it and shrinks after. Each pet window's region is its logo and bubble, so the transparent rest of it does not catch clicks. The page is remote, so these four commands are the only ones it may call: a capability the app adds at start, for `pet-*` windows and the dock's origin only (in a release build always v2.apc.tineira.com, whatever `APC_DOCK_ORIGIN` says). The app's builds before the pets opened `/dock?view=strip`, which still works for them.
     Verified on 2026-10-27 on one 125 % monitor with real drags (spike, TIN-479): `dragend` reports `link` for a drop an APC page took (Chrome) and `none` elsewhere; `screenX` and the cursor agree there. Not verified: two monitors of different scales, and Edge as the drop target (the same Chromium code).
   - **The extension** takes drags from it as from the browser's dock (the hub is v2.apc.tineira.com), pairing again since it is another dock; the extension's Open dock still opens the browser's.
   - CI (`.github/workflows/dock-desktop.yml`) builds the NSIS installer on `windows-latest`, kept as the run's artifact. Each build of `main` replaces it, as `APCDockSetup.exe` (the bundle's own name has a space), on the fixed `dock-desktop` prerelease, as Pulse for desktop is on `pulse-desktop`, so the link never changes and `releases/latest` stays the APC release. The web dock offers it on Windows only, and never inside the app itself: "Get the dock for Windows" in the first run's first step, and "Dock for Windows" in the dock's footer. It is unsigned, so SmartScreen asks once (More info, then Run anyway).
4. The first plan here (an extension with a local hub, OAuth pairing and a ring doorbell) was **redesigned in section 13 (TIN-395):** the extension only receives drags from the dock and Float, on the dock's cloud hub.

## 13. A browser extension: the agent on any page (TIN-395)

**The idea.** Most pages the person reads will never implement APC. The person keeps dragging their agent from where they already do: the dock window or **Float**. A browser extension makes every page able to **receive** that drag. On an APC app, the extension stays out of the way and the app takes the drop as it does today. On any other page, the extension reads what the person pointed at and hands it to the agent through the dock's hub. The extension is not a drag source: it has no side panel and no agents of its own.

### 13.1 What the spikes settled (2026-10-26)

The spikes are throwaway: an MV3 extension (a content script on every page, a service worker) and a fake hub, a Durable Object under `wrangler dev`. The first round ran in Chromium 134, because Chrome 156 ignores `--load-extension` (branded Chrome dropped the flag) and Edge 156 ignored it once it had signed the scratch profile in to sync. The later rounds ran in Chrome 156 and Edge 156 on fresh profiles, with the extension loaded over the DevTools Protocol: `Extensions.loadUnpacked`, which needs `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`. Phase 1's automated tests can load it the same way.

**From the dock and from Float (Chrome 156 and Edge 156).** The dock was the real one at v2.apc.tineira.com/dock, in its own window, with a test agent connected so its tile dragged the APC payload. The extension marked a drag that started in the dock's own document, which tells a drag from the dock window apart from one from Float, a separate document.

| Drag from | onto a plain page | onto Wikipedia | onto an APC app |
|---|---|---|---|
| the dock window | received | received | the app took it, the extension stood back |
| Float (Document Picture-in-Picture) | received | received | the app took it (Edge) |

The payload arrived whole, with the real hub (`https://v2.apc.tineira.com`). So Float's open question in 12.8, whether a drag out of it lands in a tab, is answered: it does.

**Match the dock's drop effect.** The dock drags a connected agent with `effectAllowed = "link"`, and `@apc/web` answers `dropEffect = "link"`. A content script that answers `copy` makes the browser refuse the drop: the person sees the not-allowed cursor over the page, and `drop` never fires. That was the spike's first run. The extension answers `link`, as the apps do. The not-allowed cursor over the dock itself, where a drag starts, is expected, since the dock takes no drops.

**Earlier rounds** dragged from a test side panel, before the extension stopped being a drag source. What they showed still holds:

- **Feedback is required.** With nothing drawn on `dragover` or `drop`, drops that landed looked like failures. So the content script highlights the target while an agent is over the page and confirms the drop.
- **No `text/plain` on a connected agent's drag.** With it, a drop on the tab strip made the browser search Google for that text. The dock's connected drag already carries none. The only `text/plain` drag stays the not-yet-connected agent's connect prompt (TIN-408).
- **An APC app keeps its drop.** The content script listens on `window` in the bubble phase. When the page has handled the drop (`defaultPrevented`), the extension does nothing.
- **Other windows and other browsers.** A drag landed in a torn-off window of the same browser, and across browsers (Chrome into Edge and back), each drop carrying its own hub.
- **The drop point needs choosing.** A drop on a margin fell back to `<html>`, `<body>` or a whole `<section>`. A reading comes from the nearest block element, and a drop not on one reads only the title and address (13.2).
- **The service worker cannot hold a channel.** It stopped after exactly 30 s with no traffic, closing its WebSocket with 1001, in all three browsers. With a hub ping every 20 s it stayed up for more than 5 minutes. So the extension holds no channel at all: a drop wakes the service worker, which pushes the reading and is done.

Not verified: drags from the dock or Float on macOS and Linux.

### 13.2 Two kinds of target

- **An APC app** handles the drop itself: `enablePinning` calls `preventDefault()`, then pairs and pins as in section 12. On an APC app (a page with APC targets `data-focus`, the agent bar `apc-agents` or agent marks `data-apc-mark`, checked at each drag since these apps render their targets after load) the extension does nothing at all: no outline, no reading, no pin. It first stepped back only when the app had taken the drop, and moving Pulse's own pin left a second pin from the extension (TIN-476). Other pages that take drags for their own sake (X does, for attaching files) are not APC apps: stepping back there refused the agent (TIN-472), so the extension takes the agent's drop and answers `link` whatever the page did.
- **Any other page** gets a **page reading**: what the person pointed at, taken by the extension and delivered as data. It is a different trust model from a pin. A pin names a target that the agent then reads through the app's own tools, with the access the app granted. A reading is the text the extension saw, nothing more, with no tools behind it. So the dock and the agent's results call it a reading, not a pin, and draw it differently.

A reading holds:

- the page's origin and path (no query string or fragment, which often carry tokens) and its title;
- the nearest block element at the drop point (a paragraph, list item, cell, heading, quote, link, button or label; on pages built of divs and spans, such as X, the nearest box with text that is not most of the page, TIN-472): its role, accessible name and visible text (up to 2 KB), and the nearest h1 to h3 above it. Math and images give their alternative text (`alttext`, `alt`), not their rendered glyphs;
- the person's selection, if any (up to 2 KB);
- in a table cell, the column header and the row's first cell.

A drop that is not on a block element reads only the title and address. Never in a reading: form field values, password or hidden inputs, anything outside the element's visible text, cookies or storage, other tabs, or a screenshot.

On the wire, the extension is one more app of the hub, with id `page` and name "This browser". The hub exposes `page__get_reading`. The focus has kind `page_reading`, with `app: { id: "page", name: "This browser", origin }` (the page's origin) and `next: "page__get_reading"`. A reading lives at the hub until the next drop replaces it or it is 10 minutes old, so the agent can read it again while it answers; reading it marks the focus seen.

### 13.3 Consent

A drop is always the gesture: nothing leaves a page unless the person drops their agent on it. What the extension asks on top of that changed after the first real use (TIN-465). A grant per site made the list long fast, and it hid in the collapsed popup. Worse, a drop on a site without a grant could not be noticed at all: without host access the extension has nothing on the page, so the person only saw the not-allowed cursor.

- **One browser grant, once.** On install the extension opens a welcome page that explains it and asks for access to any page (`https://*/*`, `http://*/*`, still `optional_host_permissions`, so it can be refused or revoked). With it, the content script is on every page and notices every drop. A person who refuses can still grant one site at a time from the popup, as in TIN-421.
- **Consent per site, in the page, on the first drop.** The extension keeps its own choices per site, not Chrome. On a site with no choice yet, the drop shows a card where it landed: "Send this to your agent? **Just this once** · **Always on this site** · **Not here**". Just this once sends and asks again next time. Always sends now and later. Not here sends nothing now or later, and says so on each drop. A site granted by itself from the popup counts as Always, since the person picked it. The popup lists the Always and Not here sites, each with Remove.
- **Sensitive sites always ask.** On a sensitive site the card offers only **Send** and **Not now**, never Always. A site is sensitive by its domain alone: a government domain (a `gov`, `gob` or `mil` label, as in `sii.gob.cl` or `gov.uk`) or the restricted `.bank` and `.insurance` TLDs, which only verified institutions can register. Nothing is guessed from a site's name (TIN-478): the first rule did, with a few mail hosts and words like "bank" or "salud", and missed most real banks and payment sites (santander.cl, bci.cl, paypal.com, sii.cl…); no list could keep that promise, so the extension makes none. Instead the person sets any site to **Always ask** from the popup, and removes it from the popup's list.
- **"Never ask", opt-in.** Off by default, switched on in the welcome page or the popup after a warning that says what it means: every drop is sent at once, on any site, sensitive ones included. It removes the questions, not the drop.
- **The card lives in the page**, in a closed shadow root, and its buttons take trusted clicks only. A page could still try to trick the person into Send or Always. What it gets is its own text going to the person's agent, which arrives marked untrusted anyway (13.4), and Always on that site, which still needs the person's drop each time.
- **Every reading is visible.** The popup and the agent's page in the dock (TIN-419) will list each reading sent (site, time and size) with Clear. Not built yet ([#81](https://github.com/tineira/agent-pointed-context/issues/81)).

### 13.4 Injection

Page text is untrusted data: any page can carry instructions aimed at an agent. The hub returns a reading under `page_text` with `untrusted: true`, and `HUB_INSTRUCTIONS` says that page text is data to read, never instructions to follow. The hub never builds `next` or `next_args` from page text. A reading is capped at 6 KB. As between apps (12.5, the C7 boundary), the agent can still be fooled by what it reads. Showing every reading in the dock makes that visible, not impossible.

### 13.5 Where the hub lives, and pairing on the first drop

**On the dock's cloud hub.** The extension is a client of the dock whose agent was dropped, not a hub of its own. It needs no pairing step of its own and no `externally_connectable`: the drag already carries `hub`, `agent` and a single-use 60 s `ticket` (12.1).

- **The first drop of an agent from a hub this browser has not paired with** sends `POST {hub}/apc/reader { ticket, agent, label }` from the service worker. `label` is "Chrome on Windows" or similar. The dock then asks: "*Chrome on Windows* wants to send page readings to *agent*. Allow?" The extension holds that first reading for up to 60 s and asks the hub again. On yes, the hub answers with a reader token, and the held reading goes out. On no or timeout, the reading is dropped and the popup says so.
- **A page cannot forge a drop or redirect it.** The content script acts only on trusted drop events (`isTrusted`), and the extension talks only to the docks it knows (`HUB_ORIGINS` in `apps/extension/src/drop.ts`). A drag that names another hub is refused in the page, so no page text goes to an address a page chose.
- **Only the extension can pair as a reader.** A page also sees the ticket on drop (12.1), so a hostile page could try to pair as a reader and feed the agent made-up readings. The hub accepts `/apc/reader` and readings only from an `Origin` in `READER_ORIGINS`: the extension's published ids (`chrome-extension://<id>`, one per store). A page cannot forge that header. This is the same rule as `HUB_ORIGINS` and `APP_ORIGINS`.
- **Later drops** push the reading with the token for that hub (`chrome.storage.local`, one per hub), with no channel held open. A drop from another browser's dock pairs with that dock, after the person allows it there.
- **Unpairing** happens in the dock (the agent's page lists "This browser" as an app, with Unpair, as in TIN-410) or in the popup. Either side drops the token.

**The cost:** the text of real pages now passes through Cloudflare. Until now only Pulse's synthetic data did. So the per-site consent says so, the README's "What the hosted demo stores" adds readings (their content kept at most 10 minutes; the log keeps site, time and size), and the hub never logs a reading's text.

**Presence.** The extension reports no presence: on pages without APC there is no `then` or `page_open`, so nobody learns which sites the person visits. A new reading reaches the agent as `attention` on its next hub call, as an unread pin does.

**A local hub** (native messaging to a process on the person's machine) is not built. It would come only if keeping page text on the person's machine turns out to matter to them, and would need a desktop component like Pulse for desktop (TIN-396).

### 13.6 Dock, Float and the extension

**The pin (TIN-469).** Once a reading is sent, the agent's mark stays pinned where it was dropped, as a pinned agent's icon stays on its target in an APC app (TIN-355). It sits in the left margin at the paragraph's first line; with no room there, past its right edge, or inside its top right corner as Pulse places a badge on a row, so it never covers the first words; and it follows the paragraph through layout changes. It looks like Pulse's pin badge (`pin-badges.tsx`): a rounded square with a dashed, breathing outline until the agent reads the reading, then a green check, and × in its corner. It shows the agent's logo (the PNG badge the dock drew, TIN-388, which `/apc/reading` now returns with the agent's name) and the agent's name as its tooltip. Its ring says what the agent did, as the agent bar does (TIN-394): accent while the agent has not read the reading, green once it called `page__get_reading` (the hub records `read_at`), grey once a newer drop elsewhere replaced the reading at the dock. A page has one pin per agent, so a new drop moves it. Dragging the pin by its mark to another paragraph of the page moves the agent's focus there (TIN-471), as dragging a pin's badge does in Pulse (TIN-354): the extension reads that paragraph and sends it with the browser's reader token, with no ticket, no dock Allow and no consent card, since the person consented when they dropped the agent on that page. Esc, or a drop off any paragraph, puts it back. Finding the paragraph under a point skips the extension's own pins, which otherwise hid the paragraph under a pin just released. **×** clears the reading and the agent's focus at the dock (`POST /apc/reading/clear`). The content script asks for the state (`POST /apc/reading/state`) every 3 s until the reading is read, then every 10 s until it is replaced, so a read pin still turns grey (first built to stop once read, which left read pins green; found against production). A reload or a navigation drops the pin: finding the same paragraph again is unreliable on pages that change.

**Opening the dock and Float from the extension (TIN-473).** The popup has **Open dock** and **Float**, also as shortcuts (Alt+Shift+A, Alt+Shift+F, changeable at `chrome://extensions/shortcuts`). Open dock brings the dock to the front if a tab or window has it, found by the start of its address (a match pattern takes no port, and a local dock has one), or opens it in a narrow window like the installed app's strip. The dock is the one this browser sends readings to, or v2.apc.tineira.com. Chrome opens Document Picture-in-Picture only from a click in the dock's own page, so Float opens the dock with `?float=1`, where a prompt takes that one click and stays until Float opens; ✕ or Esc dismisses it.

The dock window and Float stay the only places an agent is dragged from, in every browser. The extension adds no UI to drag from. It only makes pages take the drop and keeps its settings in the toolbar popup. Without the extension, everything in section 12 works as before; drops on pages without APC simply do nothing.

### 13.7 What's built

1. **Receive and read (TIN-421).** The content script answers `link`, highlights and confirms, and leaves APC apps alone. Per-site grants come from the popup. Pairing happens on the first drop, with `/apc/reader`, the dock's Allow and `READER_ORIGINS`. The reading (13.2) is pushed on drop, and the hub's `page` app serves `page__get_reading`. Automated tests load the extension over the DevTools Protocol.

   **Built (TIN-421, 2026-10-26).**
   - **The extension** is `apps/extension`: a content script (one IIFE, since content scripts cannot be modules), a service worker and a toolbar popup, built with Vite by `build.mjs`. Its manifest carries a fixed public `key`, so the unpacked build's id, and so its `Origin`, is always `chrome-extension://lhmcidpijocjiifjmoldencfocchonoj`. That id is the dock's `READER_ORIGINS`; the store builds' ids would join it once published ([#82](https://github.com/tineira/agent-pointed-context/issues/82)). A `--dev` build also talks to a dock on `localhost` and takes drops on `127.0.0.1`, for test pages.
   - **The hub** keeps readers in their own table, `readers`, apart from app pairings, so nothing that calls an app's MCP server (`look`, `waitApps`, revocation) ever sees one. The dock lists a reader with its agent's apps (`kind: "reader"`), with Allow, Deny and Unpair, in the dock, on the agent's page and in Float. The routes are `POST /apc/reader` (the ticket), `POST /apc/reader/status` (the claim, polled every 2 s for up to 60 s; the token is handed out once) and `POST /apc/reading` (the bearer token). Ticket, claim and token all start with the dock's id, as the ticket did, so the Worker routes them to the right hub.
   - **A reading is the focus**, kind `page_reading`, with the page's host as its id, so the dock shows "This browser: en.wikipedia.org". The newest wins against app pins, as pins do. A reading ends a `wait_for_focus` in flight, as an app's pin does: the hub's wait watches the paired apps and the browser's readings together. Until a fix the same day it watched the apps only, so an agent with only a browser paired heard "no app paired" at once (found by a real agent on Wordle). With a browser paired the wait reports no `page_open`, since the extension reports no presence (13.5).
   - **Tabs already open on a granted site get the content script injected** by the service worker, when the site is granted and when the extension is installed or updated: a registered content script reaches only pages loaded after it, and Chrome's permission prompt closes the popup, so the popup could not inject it (found in the first try in a real browser, where every drop showed the not-allowed cursor until the page was reloaded). A copy left from before an update has lost its extension (`chrome.runtime.id` is gone) and stands back, so it never takes the drop from the fresh one.
   - **Consent moved to the drop (TIN-465, 2026-10-26).** The welcome page, the card in the page, Never ask and the built-in sensitive list are 13.3. A site granted by itself counts as Always by scheme and host, whatever the port, as Chrome's match patterns do. `scripts/extension-e2e.mjs --consent` clicks the card with real mouse events through its closed shadow root: Just this once, Always, Not here, a sensitive site (`bank.localhost`) and Never ask; it passed in Chrome 156 and Edge 156 against v2.apc.tineira.com.
   - **The extension sends a reading once more** on a network error or a 5xx; the same reading again only replaces it. The dock's dev server on Windows fails a request now and then before it reaches the Worker (vite answers 500, "fetch failed"), and without the retry a drop was sometimes lost.
   - **`scripts/extension-e2e.mjs`** runs the whole path in a real Chrome or Edge, with the drags sent through the DevTools Protocol (`Input.dispatchDragEvent`, so the page sees trusted events): the first drop asks the dock and delivers the reading after Allow, the next goes straight through, a page that takes the drop keeps it, a drag naming an unknown hub sends nothing, a page's `Origin` cannot ask for a reader, and after Unpair the next drop asks again. It passed in Chrome 156 and Edge 156 against the local dock.

Not built yet, each tracked in its own GitHub issue: the lists of readings with Clear and a complete reading ([#81](https://github.com/tineira/agent-pointed-context/issues/81)); a preview of what will be sent, and the Chrome Web Store and Edge Add-ons listings ([#82](https://github.com/tineira/agent-pointed-context/issues/82)); Firefox ([#83](https://github.com/tineira/agent-pointed-context/issues/83)). A local hub over native messaging, and OAuth pairing, would come only if keeping page text on the person's machine turns out to matter.
