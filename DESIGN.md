# Agent Pointed Context: demo and reference implementation

| | |
|---|---|
| **Status** | Cut 1 live at https://apc.tineira.com since 2026-10-15. Open work in GitHub issues. |
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

Later, an optional doorbell cuts latency and held requests: after a pin, the app's server sends `POST {hub}/apc/ring { app, agent }` with a token from pairing. It carries no target; the hub reads the focus as before.

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

- **Web window** (or PWA) at v2.apc.tineira.com, hub in a Durable Object per dock. No install; needs apps that accept native drops (TIN-369); cannot float on top (Document Picture-in-Picture might; dragging out of it must be verified).
- **Browser extension** (side panel). A content script can add drop handling to any page; native messaging reaches a local hub. Whether a drag can start in the side panel and land in a tab must be verified. Costs an install, store review, one build per browser.
- **Desktop app** (Tauri or Electron). A natural home for a local hub, the heaviest to build. OS drags into browsers may keep only `text/plain` and `text/uri-list` (to verify).

**Order:** web window first, extension second, desktop app only if the extension cannot start drags.

### 12.7 Changes to the packages

Everything below is **additive and opt-in**, so v1 stays on 0.2.

- `@apc/protocol`: `AppRef`; optional `app` on `FocusPayload` and `PresenceEvent`; `appToolName(app, tool)`.
- `@apc/server`: `registerHubTools(server, hubCtx)` next to `registerApcTools`; `APC_HUB_INSTRUCTIONS`; `combineAttendance(values: (boolean | null)[])` (true if any is true, null if all are null, else false); `detachKeys(result, ["attention", "then"])`.
- `@apc/web`: **shipped in TIN-369**: `enablePinning({ acceptNativeDrops, resolveAgent })`, reusing `targetAt` and `canTarget`, with `APC_AGENT_TYPE`, `agentDragPayload` and `parseAgentDragPayload`. They move to `@apc/protocol` once the hub needs them too. Next: `startAgentDrag(element, drag)` for the dock.

**Breaking, and avoided:** prefixing tool names inside apps, keying `FocusRow` by app, or requiring OAuth instead of the secret URL. Any of these would make it APC 0.3.

### 12.8 Phases

1. **TIN-369 (shipped 2026-10-25):** native drops in `@apc/web`, opt-in. Pulse turns them on only when opened with `?apc=v2`, so v1 is unchanged.
2. **TIN-370:** the web-window dock and a hub Durable Object in `apps/dock`. One agent connects to the hub. The first drags can land on apc.tineira.com with `?apc=v2` (drops only, onto agents of that sandbox); pairing (`/apc/pair`) runs only on a Pulse under apc-v2, never on apc.tineira.com. That Pulse is `apps/demo` deployed a second time inside apc-v2 with a v2 flag (drops and `/apc/pair` on), not imported into `apps/dock`, so v2 does not depend on v1's internals. The hub watches with v1 `wait_for_focus`; it exposes only `call_app_tool` (prefixed tools wait for phase 3), and `next` uses it. Newest pin wins, and a pairing needs both yeses, as above.

   **Built in two steps (2026-10-25).** TIN-370: the dock window and the drag, fed by Pulse over postMessage (now at v2.apc.tineira.com/bridge, opened from apc.tineira.com with `?apc=v2`). TIN-382: the hub, a Durable Object per dock in `apps/dock`, and Pulse's v2 deploy (`apps/demo`, wrangler env `v2`: Worker apc-v2-pulse at pulse.v2.apc.tineira.com, `APC_V2=1`). What the prototype settled, beyond the sections above:
   - The hub's tools are `get_current_view` (focus plus `views`), `wait_for_focus`, `call_app_tool` and `list_app_tools` (each app's tools with their input schemas, since the agent never sees them in its own list).
   - The hub has no running watcher. It asks the apps when the agent calls: `get_current_view` on each paired app before its own `get_current_view`, `call_app_tool` and `list_app_tools`, so a new pin rides as `attention` on any call; one `wait_for_focus` per app, in parallel, during its own. So an app's `seen_at` is the moment the hub took the pin, which is when the agent's call is running.
   - `then` rides on hub results while the dock window is open (its WebSocket heartbeat) and the last word from a paired app said the person is on its page.
   - In `@apc/web`: `parseAgentDrag` (hub and ticket, each dropped if malformed), `agentDragPayload(handle, { hub, ticket })` and `onUnknownAgent` on `enablePinning`. The dock keeps one fresh ticket per agent, since `dragstart` cannot wait for the network.
   - Pulse pairs only with the hubs in `HUB_ORIGINS`, the hub only with the apps in `APP_ORIGINS` (and only an MCP URL on the app's own origin), so neither fetches an address a page chose. Pulse's guided first run is off on the v2 deploy: it teaches the v1 top-bar mark.
3. A second small APC app on its own origin, so pairing really crosses origins. Prefixed tools after `list_changed`, and the dock's revoke. New compatibility-matrix columns: `list_changed` honoured, and waits through the hub.
4. The extension with a local hub, OAuth pairing and the ring doorbell.
