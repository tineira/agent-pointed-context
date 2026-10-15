# Agent Pointed Context: demo and reference implementation

| | |
|---|---|
| **Status** | Design draft, 2026-10-15. Nothing built. |
| **Paper** | T. Neira, *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen*, 2026. https://doi.org/10.5281/zenodo.23382909 |
| **Spec** | Companion record, `04-payload-specification.md`. https://doi.org/10.5281/zenodo.23383101 |
| **License** | MIT (code). The paper is CC BY 4.0. |
| **Visibility** | Private until cut 1 runs end to end; then public, with a Zenodo software DOI per release (GitHub integration). |
| **Hosting** | A light hosted demo on Cloudflare Workers + Durable Objects, one sandbox per visitor. The same code runs locally with `wrangler dev`, no account needed. |

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
2. **Privacy in the other direction is checked, not assumed.** The seed makes MRR values distinctive. The sandbox records every inbound tool argument and request body. A canary check that runs **outside the server** (a script, and the harness in cut 2, both of which have the file) scans that log and asserts no MRR value appears in it. If an agent leaks one into an argument by accident, the report says so.
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

**Pin kinds:**

| kind | id | part / params | `next` |
|---|---|---|---|
| `customer` | `cus_NNNN` | `plan`, `seats`, `usage`, `status` | `get_customer` |
| `figure` | — | `{ key: active_customers, month, plan?, region? }` | `get_figure` |
| `figure` | — | `{ key: customer_bridge, month }`, part `step:<start\|new\|reactivated\|churned\|end>` | `get_figure` |
| `figure` | — | `{ key: plan_matrix, month }`, part `cell:<plan>\|<month>` | `get_figure` |
| `figure` | — | `{ key: seats, month }` | `get_figure` |

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

## 7. Architecture

A pnpm monorepo with three reusable packages and one app, so the pattern can be adopted, not only watched:

- `packages/protocol` (`@apc/protocol`): the wire types and the target grammar (kinds, parts, key-only params, canonical keys, `data-focus` attributes), shared by both sides.
- `packages/server` (`@apc/server`): runtime-agnostic TypeScript. The `attention` envelope (structured result and text), the `get_current_view` and `wait_for_focus` tools over a host-supplied context, the presence event builder. The view allowlist and the figure registry are the host's (here `apps/demo/src/worker/domain.ts` and `apps/demo/src/model/figures.ts`).
- `packages/web` (`@apc/web`): framework-agnostic DOM. `data-focus` attributes and their parser, drag-to-pin with the innermost-target rule, a hit-test registry for canvas or SVG surfaces, agent marks and the presence cursor, view reporting (debounced, visible tab only).
- `apps/demo`: Pulse. A Cloudflare Worker (Hono) routes to the sandbox Durable Object, which serves MCP over Streamable HTTP (official SDK), the browser API and the WebSocket. The front end is Vite + React, served as Worker static assets. The figure functions live in `apps/demo/src/model/` and are imported by both the page and the Durable Object: that is what C4 tests.

## 8. Instrumentation

Every event goes to the sandbox's `events` table, exportable as JSONL:

- `tool_call`: grant, client name, tool, arguments bytes, result bytes, envelope bytes (0 when none), server latency.
- `pin`, `envelope_delivered`, `seen`, and `next_read` (the first call to `focus.next` with `focus.next_args`).
- `inbound`: every tool argument and request body, for the canary check (section 3).

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
