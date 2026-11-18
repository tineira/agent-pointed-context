# The APC specification

This is the contract an app, an agent and a hub share in Agent Pointed Context, at the version in the banner above. The 1.0.0 contract is frozen and changes only by [versioning and compatibility](#versioning-and-compatibility). This page is the standard. [`@tineira/apc-protocol`](https://github.com/tineira/agent-pointed-context/tree/main/packages/protocol) carries its types and constants and the readers it names (the target grammar, `apc.json`, the grant states), and the [conformance suite](/docs/conformance) checks an app against it. Neither covers all of it: rules needing the dock UI (`CODE-2`'s "never shows", `DROP-1`, `TM-1` — reference behaviour, not conformance-tested in 1.0) and agent-side tool relays are checked only by the reference hub's own tests, and [the hub's tools](#the-hubs-tools) are described, not specified. Where the package or the suite disagrees with this page, one of them has a bug, and the fix is recorded in the [changelog](/docs/changelog), like every change.

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** mean what [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) say, and only in bold capitals. Each binds the party its sentence names: an app (its server or its page), an agent, a hub, or a dock's page. A SHOULD may be left out only for a reason its implementer can state, knowing what it costs. Text without these words describes how the reference software behaves and what a reader can rely on.

How they are checked does not change what they mean. The conformance suite checks an app's MUSTs where it can reach them and a hub's app-visible pairing MUSTs ([conformance](/docs/conformance) lists which), and `@tineira/apc-protocol` refuses what its readers refuse. Hub and dock UI rules (`CODE-2`'s "never shows", `DROP-1`, `TM-1`) are **reference behaviour, not conformance-tested in 1.0** (the reference hub's own tests prove them). A MUST that nothing checks is still a MUST.

## Terms

- **App**: a web app that speaks APC: it has a page the person uses and an MCP endpoint agents call. The endpoint speaks MCP over Streamable HTTP; its `initialize` result names `protocolVersion` and `serverInfo.name`, and offers the `tools` capability.
- **Agent**: the person's own AI agent, an MCP client (Claude, ChatGPT, Cursor, Grok and others).
- **Grant**: one agent's access to one app, with its own pin and name. A grant holds per agent, never per app. How the agent proves it holds the grant is the app's binding: in the reference apps a secret MCP URL (whoever holds it holds the grant); with OAuth a bearer token on a shared URL (see [the Direct profile](#the-direct-profile)).
- **Hub**: the server side of a **dock**, the window where the person keeps their agents. In the Dock profile the hub holds the grants and relays between agents and apps. The reference hub is at `apc.tineira.com`.
- **The person's page**: the app's page, open in a browser (or a desktop or phone app).
- **Profile**: how agents reach an app: **Direct** or **Dock**. An app offers one or both.

## What 1.0 freezes

1.0 freezes the pairing contract between an app, an agent and a hub: [the core](#the-core), [the Direct profile](#the-direct-profile), [the Dock profile](#the-dock-profile) with the app's duties (M1 to M13) and the hub's duties toward apps (H1 to H10), [`apc_link`](#apc_link), [`apc.json`](#apcjson), the rules of [the hub's trust model](#the-hubs-trust-model) on which apps pair and on marking what an unverified app gives, and [reading what you do not know](#reading-what-you-do-not-know). The hub's tools for agents are **not** frozen by 1.0: its `get_current_view` with `views[]`, its one `wait_for_focus` across apps, `list_app_tools` and `call_app_tool`, the `<app>__<tool>` relay, the shape of the untrusted envelope and labels it marks an unverified app's content with (the marking itself is frozen), and the browser extension's `page_reading` focus with `page__get_reading`'s `page_text`. They stay non-normative until a later minor version states them; until then [the hub's tools](#the-hubs-tools) describes the reference hub, and any minor version may change them. An agent reads them as it reads any MCP server's tools: by their descriptions. How an app presents its agents (the pet, the cards, wording, colours, motion) is not in the contract either: it is [the UX guide](/docs/ux), non-normative.

## What 1.1 deprecates

The connection half of this standard is being **deprecated from 1.1.0**, in instalments, for a 2.0 to remove from this page. This release marks the first of them, listed below. Until then it is unchanged and still binding: a party that conforms to 1.0.0 conforms to 1.1 with no change of any kind, no rule is relaxed, no pairing ends, and the conformance suite keeps exactly the checks it had for every deprecated rule, with the same limits of reach it already had ([conformance](/docs/conformance) lists them). Deprecated says only what [versioning and compatibility](#versioning-and-compatibility) makes it say: at least one more minor version and at least 3 months pass first, and a major removes nothing this page has not marked deprecated.

This page is a standard for pointing an agent at what a person is looking at. How an agent reaches an app, and how that connection is secured, is a different problem with its own product and its own release line; the two grew into one document, and the connection half is now the larger part of a standard that is not about it. It moves, unchanged, to a Dock protocol published in its own right, and this page keeps the pointing. [DESIGN.md § 29](https://github.com/tineira/agent-pointed-context/blob/main/DESIGN.md#29-the-standard-keeps-the-interaction-half-apc-11) records the decision and what it costs.

**Deprecated.** This is what 1.1 marks. A major removes nothing that was not marked in a minor and did not see out the window [versioning and compatibility](#versioning-and-compatibility) sets; and anything marked — a duty, a definition, a code, a rule about what a reader does — is removed only once every sentence this page keeps that names it, or is stated in its terms, has itself been marked and seen out a window of its own. Naming it is the test, not a judgement about what depends on what: a kept sentence that says *handoff*, *dormant*, `M11` or `M12` holds those back until it is marked too. And a marked clause whose removal would by itself change what a kept rule does — widen what a reader covers, say — goes only together with whatever holds that behaviour where it was. A removal that would strand a kept sentence waits instead. The list is a first instalment and not a complete inventory of the connection half: the clauses under *not settled* below, and any Dock-only sentence this page has not yet put on one side or the other, are marked by a later minor once their placement is settled. Nothing is removed before it is marked.

- [**The Dock profile**](#the-dock-profile): the drop, origin-bound first pairing, consent in the app, the pairing code, `POST {hub}/apc/pair`, `POST {hub}/apc/confirm`, the give-back, the grant's states, one pending pairing, the app and the hub call, the binding, the derived secret and what secures the Dock — the app's duties **M1 to M13** and the hub's duties toward apps **H1 to H10**.
- In [**`apc.json`**](#apcjson), four clauses and no others: the `dock_connect` key; a hub's `dock: { pair, confirm }`; the rule that a reader leaves `dock` out of an `mcp.endpoints` entry on an exact path, since a Dock grant is one URL per grant; and the answer an app owes a dock agent dropped on an app that offers only Direct. The document itself, its path grammar, its matching rules and its every other key stay.
- In [**the hub's trust model**](#the-hubs-trust-model): [the warning](#the-warning) an unverified app pairs behind; [the limits](#limits) entire, the relay's ceilings as well as the pairing cap; [the blocklist and the kill switch](#the-blocklist-and-the-kill-switch) entire, which also end pairings already made; and, out of [verified and unverified apps](#verified-and-unverified-apps), the one sentence that an unverified app **MUST** use HTTPS on a domain name and that its redirects are not followed, with the `app_not_allowed` and `https_required` codes that answer it.
- In [**the error codes**](#error-codes), four tables: *an app, to its own page, on a drop or an Allow*; *a hub, to an app*; *connect and reader routes*; and *a hub, to the dock's owner, on an approval*. With them, the paragraph that fixes `/apc/reader/status` at HTTP 200 `denied` and forbids it to expose a token for such a claim. And, out of *a hub, to an agent*, the two rows its own heading keeps inside the 1.0 freeze: the relayed `pairing` and `idle` (H4), and `pairing_ended` (H5). They exist to serve those two duties and go where the duties go.

**Not deprecated, and not moving.** [The core](#the-core); [the Direct profile](#the-direct-profile); [`apc.json`](#apcjson) as a document, with its path grammar and its matching rules; [reading what you do not know](#reading-what-you-do-not-know); [versioning and compatibility](#versioning-and-compatibility); the licence; and the error codes an app answers an agent on a grant.

Two things inside the hub's trust model stay, because what they serve is the content an agent reads and not the pairing it arrived by: [untrusted marking](#untrusted-marking) entire, and the sentences of [verified and unverified apps](#verified-and-unverified-apps) that **define** a verified and an unverified app and fix an app's identity as its domain. Untrusted marking is written in those words and labels an app by its host; marking the rule and deleting its vocabulary would leave it pointing at nothing.

**Never frozen, so never removed by a major, and so not deprecated:** [the hub's tools](#the-hubs-tools) at the end of the Dock profile, and the rest of the table of what [a hub answers an agent](#error-codes) — its `app_unreachable` row, which serves [untrusted marking](#untrusted-marking) and stays with it, and its *reference* rows for the hub's own tools and an agent URL the dock no longer has. 1.0 left those outside the contract ([what 1.0 freezes](#what-10-freezes)); a later minor may change them as it likes, and a 2.0 takes nothing from them. The profile word `"dock"` is not deprecated either: a later version defines it by reference, and a reader that does not know a profile word already ignores it.

**Not settled, and so not marked.** [`apc_link`](#apc_link), [the browser extension](#the-browser-extension), and the sentences inside [the core](#the-core) and the app-to-agent error codes that speak of a Dock grant (`pairing`, `idle`, `pairing_mismatch`). Whether each of them belongs to pointing or to connecting is still open. A later minor marks whichever of them moves, with a window of its own; until one does, none may be removed.

**Describing, not binding.** [The terms](#terms), the paragraphs that open this page and [what 1.0 freezes](#what-10-freezes) describe the standard rather than bind a party. A later version restates them as the page changes, which is not a removal and needs no marking. Deprecation does not unfreeze anything 1.0 froze.

**An app, an agent or a hub does nothing for this release.** One that wants to claim 1.1 changes only `standard`, as between any two minors of one major. One that stays on 1.0.0 keeps every right it has.

**Deprecated from 1.2.0, unchanged until 2.0:** this section, as a marked move. Its rules that outlive a 2.0 are kept word for word and go, in a 2.0, under [versioning and compatibility](#versioning-and-compatibility); the rest is the record of what 1.1 marks and goes with what it lists. [What 1.2 deprecates](#what-12-deprecates) names which is which.

## What 1.2 deprecates

1.2.0 marks the second instalment of the connection half, and the last this page plans: every clause [what 1.1 deprecates](#what-11-deprecates) left *not settled*, and every sentence this page keeps that names what is marked, so that a 2.0 can remove the connection half whole. Like 1.1 it changes nothing: every marked rule is unchanged and still binding, a party that conforms to 1.1 conforms to 1.2 with no change of any kind, no rule is relaxed, no pairing ends, and the conformance suite keeps exactly the checks it had. The rules of [what 1.1 deprecates](#what-11-deprecates) hold for this list as they stand: a clause below is removed only once it has seen out a window of its own, and only together with whatever holds the behaviour it carries. A Dock-only sentence this list does not name, should one still turn up, is marked by a later minor, and what it names waits for it.

**Deprecated.** This is what 1.2 marks. Where a span sits in a sentence that stays, only the words quoted are marked; the rest of the sentence is not, and a 2.0 keeps it word for word, but for the capital, the comma or the conjunction the removal leaves it needing.

- **[`apc_link`](#apc_link) moves.** The section entire. As built it serves one agent seen through a hub and directly (`<app>__apc_link`, the agent's client named in `_meta` to verified apps only), and an app that offers only Direct never links. With it, in [the Direct profile](#the-direct-profile), the words ", presence and `apc_link`" of "(pins, views, presence and `apc_link` are keyed by it)", in whose place a 2.0 reads "and presence"; and the `link_refused` row of *an app, to an agent on a grant* in [the error codes](#error-codes).
- **The core's Dock-grant sentences move.** In [attention](#attention), the parenthetical "(on a Dock grant, only a live one: no answer in handoff or dormant carries it, see what each state answers)"; in [wait events](#wait-events-since-011), the bullet **Dock grants.**, whose **MUST NOT** stays a **MUST NOT** where it goes; in [`get_current_view`](#get_current_view), the sentence "A dormant dock grant (since 0.10) answers `{ view: null, focus: null, idle: true, note }`: see the grant's states."; in [`wait_for_focus`](#wait_for_focus-and-then), the bullet "A dormant dock grant (since 0.10) answers at once …"; and, in *an app, to an agent on a grant*, the rows `pairing`, `idle` and `pairing_mismatch`. Each speaks of a Dock grant's states, which the Dock profile defines.
- **One sentence of [the browser extension](#the-browser-extension) moves:** "On a Direct-only app that does not answer dock drops itself, the extension tells the person to connect directly." It is about a dock drop.
- **Kept sections that speak of a hub or a dock.** In [reading what you do not know](#reading-what-you-do-not-know), "and a hub's answer to `/apc/connect`, `/apc/pair` or `/apc/confirm`". In [the core](#the-core), "A hub is one more holder of a grant, so the core is the same for it."; in [revoke from the app](#revoke-from-the-app), ", Direct or Dock," and ", so it works with the hub down", and ", or a new drop with consent in the app and in the dock (Dock)"; in [mobile](#mobile), "dock window," with its comma and ", on both profiles", and "and no dock window"; in [the agent in the page](#the-agent-in-the-page), ", the pairing cards". In [the hub's tools](#the-hubs-tools), ": what the hub sends an app is the Dock profile above" and the sentence "Since 0.10 it relays the apps' `pairing` and `idle` answers as H4 says." That section stays, word for word and non-normative as before; its two spans are marked only because they name what is marked.
- **In [`apc.json`](#apcjson).** In `profiles`, "; `"hub"` alone for a hub, which then also gives `dock: { pair, confirm }`" (whose `dock` key 1.1 marked) and the sentence "Since 0.10 an app lists `"dock"` only while it can pair, and the file is computed per request or cached 60 seconds at most (M8)." In `mcp.path`, the three words "a hub pairs" and nothing else of that sentence: a 2.0 states this rule for every reader, as "a reader covers, apart from the shared URL the next sentence allows,"; nothing changes until then. In [`mcp.endpoints`](#mcpendpoints-011), "a hub, " among the readers before 0.11; "and `dock`" and " (an app that is not pairing right now, M8)" in the rule on profile words; " or `dock`; a hub pairing a Dock app checks `dock`" in matching, which leaves "(`direct`)"; the sentence "A file that narrows does not end pairings already made; the app revokes them."; and the vectors whose profile is `dock`. A 2.0 re-keys to `direct` the `dock` vectors that test the matching rules themselves (among them the `{secret}` shape, URL normalization and encoded traversal, and the `path-only` row), with their files' profiles, so this page keeps the coverage; the Dock protocol keeps those that test `dock` itself, the refusal of a shared URL among them.
- **In [versioning and compatibility](#versioning-and-compatibility).** ", as an app takes the binding only when the hub's acknowledgement declares `binding` (0.12)"; "A hub or " and the sentence "A hub tells majors apart by the major version of that field."; the bullets **Apps on 0.x when 1.0 ships** and **The previous major** entire, whose promises to apps go to the Dock protocol with the hubs they bind; and, in **The conformance suite**, ", and keeps checking existing-pairing claims from 0.10 up, labelled "pre-1.0"" and the sentence "Dock first-pairing conformance has a floor of 0.13." The deprecation rule itself is not marked.
- **[What 1.1 deprecates](#what-11-deprecates), as a marked move.** It names what it marks (*handoff*, *dormant*, `M11`, `M12` and the Dock clauses), so by its own test it cannot stay whole; it is also the only home of rules that outlive a 2.0. Kept word for word, and placed by a 2.0 under [versioning and compatibility](#versioning-and-compatibility) beside the deprecation rule: out of its **Deprecated.** paragraph, the sentence that begins "A major removes nothing that was not marked in a minor" and ends "seen out a window of its own"; the words "Naming it is the test, not a judgement about what depends on what"; the sentence that begins "And a marked clause whose removal would by itself change what a kept rule does" and ends "where it was"; "A removal that would strand a kept sentence waits instead."; and "Nothing is removed before it is marked."; and **Describing, not binding.** entire. They are not moved now. The rest of that section, the example after the colon and the *first instalment* sentences included, is the record of what 1.1 marks and goes with what it lists; the [changelog](/docs/changelog) keeps that record.
- **In [the error codes](#error-codes), two headings that stay.** The words ", both profiles" of *an app, to an agent on a grant* (the core, both profiles), and ", except H4 and H5" of *a hub, to an agent* (outside the 1.0 freeze, except H4 and H5). They name what is marked.
- **The record of the marking.** This section, [what 1.1 deprecates](#what-11-deprecates) and every deprecation notice under a heading of this page (each paragraph that opens "Deprecated from 1.1.0" or "Deprecated from 1.2.0") are the record of the marking. They name what they mark, so they are marked with what they list, and a 2.0 removes or moves each with what it lists; the [changelog](/docs/changelog) keeps the record. The one exception is the rules of [what 1.1 deprecates](#what-11-deprecates) named in the item on what 1.1 deprecates, which a 2.0 keeps word for word under versioning and compatibility.

**Not deprecated, and not moving.** Whatever [what 1.1 deprecates](#what-11-deprecates) keeps stays kept, and every sentence of a kept section that is not quoted above stays word for word. On purpose, too: [untrusted marking](#untrusted-marking) entire, with the shapes under it and the `app_unreachable` row; the sentences of [verified and unverified apps](#verified-and-unverified-apps) that define a verified and an unverified app and fix an app's identity as its domain; [the hub's tools](#the-hubs-tools), but for its two spans above; the first four sentences of [the browser extension](#the-browser-extension), with the page reading, `untrusted: true` and what it never reads; `data-apc-mark`; the profile word `"dock"`; and the deprecation rule. [The terms](#terms) keep "hub" and "dock", which kept sentences use; a later version restates them, as describing text.

**An app, an agent or a hub does nothing for this release.** One that wants to claim 1.2 changes only `standard`, as between any two minors of one major. One that stays on 1.1 or 1.0.0 keeps every right it has.

## Reading what you do not know

So that a minor version can add without breaking anyone, every reader **MUST** ignore what it does not know:

- **A key.** In `apc.json`, a target, a view, a focus, a `PresenceEvent` or `PresenceWaitEvent`, a tool result, a tool error, and a hub's answer to `/apc/connect`, `/apc/pair` or `/apc/confirm`, a key the reader does not know is read as if it were not there, and the rest is read as usual.
- **A word of an open list.** A word of `profiles` it does not know (at the top level of `apc.json` and in an `mcp.endpoints` entry, where it is left out one by one and the entry stays), a presence message of a `kind` it does not know (the whole message is ignored), and a tool it was not told of.
- **An error code.** A code it does not know reads as the request's failure or refusal, by its status and shape (HTTP 400, `isError: true`, a JSON-RPC error), never as success. [The error codes](#error-codes) lists those this version names.

Ignoring never widens. Where this page says to drop something whole (an `mcp.endpoints` entry with a key the reader does not know, or a path it does not understand), the reader drops it and uses no part of it: that is the one place an unknown key is not ignored. And a writer never relies on an older reader understanding what it added: what an older reader does is always what it does when it ignores it. A `standard` newer than the reader's own is read by the same rule: see [versioning and compatibility](#versioning-and-compatibility).

**Deprecated from 1.2.0, unchanged until 2.0:** in the first item, the words "and a hub's answer to `/apc/connect`, `/apc/pair` or `/apc/confirm`". The rest of this section stays. See [what 1.2 deprecates](#what-12-deprecates).

## The core

What every APC app implements, per grant, whichever way agents reach it. A hub is one more holder of a grant, so the core is the same for it.

**Deprecated from 1.2.0, unchanged until 2.0:** the sentence just above that a hub is one more holder of a grant, and, below, the sentences of the core that speak of a Dock grant or a dock: in [attention](#attention), the parenthetical on a Dock grant; in [wait events](#wait-events-since-011), the bullet **Dock grants.**; in [`get_current_view`](#get_current_view), its last sentence, on a dormant dock grant; in [`wait_for_focus`](#wait_for_focus-and-then), the bullet on a dormant dock grant; in [revoke from the app](#revoke-from-the-app), ", Direct or Dock,", ", so it works with the hub down" and ", or a new drop with consent in the app and in the dock (Dock)"; in [mobile](#mobile), "dock window," with its comma, ", on both profiles" and "and no dock window"; and in [the agent in the page](#the-agent-in-the-page), ", the pairing cards". Every other sentence of the core stays word for word. See [what 1.2 deprecates](#what-12-deprecates).

### The view

The screen the person is on, as identifiers, trimmed to what the calling grant may see (`ViewPayload`):

| Field | |
|---|---|
| `screen` | the screen's name |
| `params` | key-only params: the period, filters |
| `selection` | at most one selected row, `{ kind, id }`, or null |
| `app_url` | where it is |
| `updated_at`, `age_seconds`, `stale` | when the page last reported it |
| `next` | the tool that reads the screen, or null |

### The pin and the focus format

The person drops the agent's mark on a **target**: `{ kind, id, part, params }`. A target names a row (`id`), a computation (`params`), or both, and **MUST** have one of the two: an `id`, or `params` with at least one key (since 0.12 a target with no `id` and `params: {}` is refused, as one with neither).

- `kind` and every param key match `[a-z][a-z0-9_]{0,31}`; `id` matches `[A-Za-z0-9_.:-]{1,80}`.
- `part` names a piece of the target (`total`, `step:new`): a word, optionally followed by `:` and a token.
- `params` **MUST** carry keys only: string tokens, or lists of at most 20, in at most 1 KB. A bare number is an amount, never a key, and is refused (a month such as `2026-03` passes). Free text never travels.
- In the page, a pointable element carries `data-focus="kind:id"`, with `data-focus-part` and `data-focus-params` (JSON) when needed (`focusAttrs` in `@tineira/apc-protocol`).

The app keeps **one pin per grant**: a new drop replaces it, unread. Every drop makes a new pin with a new `pinned_at`, so a drop on the target already pinned, and read, makes it unread again. It is **unread** while it was dropped after the last read that returned it. What the agent receives is the **focus** (`FocusPayload`): the target plus `app_url`, `pinned_at`, and `next` and `next_args`, the exact tool call that reads it. It may carry `part_note`, `trimmed` (what the grant may not see was left out) and `gone` (the row no longer exists).

**Trimmed per grant** means: anything a grant may not see is left out of its view, its focus and its tool results, and a focus that lost something to that carries `trimmed: true`. A grant never learns from an answer what it may not see.

### Attention

While a grant's pin is unread, every tool result on that grant that serves app data carries `attention: { focus, note }` (on a Dock grant, only a live one: no answer in handoff or dormant carries it, see [what each state answers](#the-grants-states)), as a top-level key of the structured result **and** of the JSON text, so a model that sees only text sees it too. It points at `get_current_view`; it never instructs.

### Presence

After each successful tool call, the app publishes a `PresenceEvent` to the person's page: `{ v: 1, grant_id, at, tool, kind, targets, count }`, ids only, `kind` being `read` or `write`, at most 20 `targets` of `{ kind, id }`. A read of a target that has an `id` **MUST** name it in `targets` as `{ kind, id }`. A read of a computation (a target with `params` and no `id`) names nothing there, since presence carries ids only. `count` is how many distinct targets the call touched: at least the length of `targets`, more when the call touched over 20, and it may count a computation that `targets` cannot name. It is for display (`presenceEvent` in `@tineira/apc-server` counts the distinct targets it was given, before the cap). How a page shows what the agent read is in [the UX guide](/docs/ux#presence-feedback).

#### Wait events (since 0.11)

The page shows that an agent is listening (a drop reaches it now) from a second kind of presence message, never by guessing from recent calls: `PresenceWaitEvent`, `{ v: 1, grant_id, at, kind: "wait", state }`, `state` being `open` or `closed`, ids only, with no targets. It travels on the same channel, with the same rule: only the grant's owner reads it.

- **Optional, and only with an atomic place.** An app **MAY** send wait events, and only if it can tell takeovers and releases atomically (below); an app that cannot **MUST NOT** send them. A page that gets none shows no "waiting". An app that sends any **MUST** follow every rule in this section.
- An app that sends them **MUST** send `open` when a `wait_for_focus` claims the grant's one place for a wait, and `closed` when the wait gives it up: on return (a pin, a timeout, a closed page), on cancel, and when the grant is revoked or deleted during it. A wait refused (within `WAIT_CLAIM_GAP_S`, or on a revoked grant) sends nothing.
- **Atomic: what "can tell" means.** Its place for a wait says, in the step that takes it, whether another wait held it, and, in the step that gives it up, whether this wait held it (a compare-and-swap and a compare-and-delete on a store row). An app that can only check and then release, in two steps, **MUST NOT** send wait events: a claim between the two would end the page on `closed` while a wait runs, and no "waiting" beats a wrong one.
- **A takeover** sends the old wait's `closed`, then the new wait's `open`, both when the new wait claims the place. The old wait sends nothing when it later finds it was taken over. So a grant's last wait event always says whether a wait holds its place now.
- **The ceiling a page counts on.** A page needs the app's ceiling for `timeout_s` (its longest wait). A page the app ships itself knows it from the app's own code (`ceilingS` in `@tineira/apc-web`'s `waitOpen`, `waitOpenLimitMs(ceilingS)`); a page that does not know it counts on `WAIT_CEILING_DEFAULT_S` (50 s). So an app whose wait events a page it did not write reads **SHOULD** keep its ceiling at 50 s or less, or a wait longer than that shows closed early there.
- **A `closed` that never comes.** A worker can die before it sends `closed`. A page **MUST** treat an `open` as closed once it is older than the app's ceiling as the page knows it (50 s, `WAIT_CEILING_DEFAULT_S`, when it does not) plus `WAIT_EVENT_MARGIN_S` (10 s), counted on the page's clock from when the event arrived, never from `at`. A live wait overruns its timeout by at most one poll and its last checks, which the margin covers; a lost `closed` leaves the page "waiting" for a minute at most. An app **SHOULD** tell a page that connects during a wait about it (Pulse and Signals send the open event first), and leave out one past the same limit. An `open` for a wait the page already has open keeps the first arrival, so a replay never restarts its clock; a page that first hears of a wait from a replay counts from then, so there a lost `closed` can show for up to twice the limit.
- **Dock grants.** A Dock agent waits on the hub, not on the app: the waits an app sees on a dock grant are the hub's relays. A page **MUST NOT** show a dock grant as waiting, whatever its wait events say.
- A page that reads the channel ignores a message it does not know, so a page before 0.11 is not affected (`flashTargets` ignores wait events). A page reads the five keys strictly and drops a key it does not know (the event only drives a display); an app sends exactly the five.

`announceWaits` in `@tineira/apc-server` sends the events from a grant's place for a wait, only from an `AtomicWaitSlot` such as `MemoryWaitSlots` (`registerApcTools` does it when given `waitPresence`); `foldWaitEvent` and `waitOpen` in `@tineira/apc-web` turn them into "a wait is open now", with the rule above.

### `get_current_view`

Takes no arguments. Returns `{ view, focus }`: the view (or null) and the focus (or null). Returning the focus marks it seen, once the result is final (see [seen once delivered](#seen-once-delivered)).

When the app cannot answer just now, it still answers in this shape, `{ view: null, focus: null, note }`, never a tool error or a shape of its own. A check on one item of the answer that cannot run hides that item and the rest answers; only a failure of the grant itself (its auth) fails the read. A dormant dock grant (since 0.10) answers `{ view: null, focus: null, idle: true, note }`: see [the grant's states](#the-grants-states).

### `wait_for_focus` and `then`

`wait_for_focus({ timeout_s })` holds the call until the person pins the agent, or `timeout_s` passes (a whole number from 1 to the app's ceiling; optional, 25 by default in `@tineira/apc-server`). A `timeout_s` that is not a whole number in that range **MUST** be refused as invalid arguments (a JSON-RPC error, or a tool error with `isError: true`, as the MCP SDK refuses input its schema does not take), never clamped or replaced by the default: the agent learns the range from the tool's input schema.

- A pin dropped during the wait is returned, marked seen: `{ focus, timed_out: false }`.
- With none, it returns `focus: null` with a `note`, and `timed_out: true` at the timeout, or `timed_out: false, page_open: false` as soon as the app knows the person's page is closed. `page_open` is left out while the person does not share their view (an app without that switch always shares).
- A dormant dock grant (since 0.10) answers at once `{ focus: null, timed_out: false, page_open: false, idle: true, note }`. An answer without `idle` (an app before 0.10) reads as page closed or unavailable, as before.
- **One wait per grant.** At most one wait of a grant delivers. A new wait takes over: the one it replaces ends at its next check with `focus: null, timed_out: false` and a note, and delivers and marks nothing. A new wait within 2 seconds of one still running (`WAIT_CLAIM_GAP_S`) is refused instead, with `focus: null, timed_out: false, retry_after_s` and a note. A wait whose request the client cancels stops and frees its place at once: MCP's `notifications/cancelled` (to a stateless server it comes in a POST of its own, so the app keeps its calls in flight per grant to find the one it names: `InflightCalls`), and an HTTP abort where the host reports one.
- **"At once" and "at its next check"** mean within one poll of the wait (2 s in `@tineira/apc-server`) and its last checks. The conformance suite allows 8.7 s after a pin, a revoke or a takeover, and 4 s past `timeout_s`.

`then` is the loop hint: a key on a result, placed like `attention`, present while a page of the person's is open (and they share their view) **and** the grant was pinned in the last 30 minutes, read or unread (`THEN_PIN_WINDOW_MIN`; an app may set its own window). An open page with no recent pin gives no `then`, so an agent does not wait after every answer. It tells the agent to call `wait_for_focus` after answering, in the background if its client can, and otherwise to keep the wait short and never chain waits. It **MUST NOT** be on a `wait_for_focus` result that came back with no focus, whatever ended the wait (a timeout, a closed page, a takeover, a refusal or a cancel): that result ends the loop. There is no other loop: an agent waits only while `then` says so, attended or not, and goes back to the person when a wait returns no focus.

### Seen once delivered

Checking for a pin, or polling for one, never marks it seen: only returning it does. An app marks a pin seen only once the result that carries it is final (in a wait, after the wait gave its place up and checked once more that its request was not cancelled), and marks that exact pin, by its `pinned_at`, never a newer one dropped meanwhile. It returns the result whether or not the mark succeeds. So a pin may be delivered twice, and is never lost to a wait that was taken over or cancelled, or to a newer pin. MCP has no acknowledgement: a result lost after the app sent it, with no abort the app could see, cannot be told apart, and that pin is marked seen.

### Revoke from the app

Every agent in the app's agent bar, Direct or Dock, has Revoke. It holds in the app alone and at once: the app calls nobody, so it works with the hub down.

- From then on every request with the grant **MUST** be answered with `{ error: "revoked", revoked_by, revoked_at, message }` (`RevokedAnswer`), `revoked_by` being the app's host and `message` a non-empty string. That holds whatever the request is: `initialize`, `ping`, `tools/list`, `tools/call`, any other method, a notification, a `GET` or a `DELETE`, and a body that does not parse. The HTTP status is the binding's: 403 with a secret URL, 401 with `WWW-Authenticate: Bearer error="invalid_token"` with a bearer token.
- An unknown or expired grant answers without a `RevokedAnswer`, so a holder can tell "taken back" from "gone": 404 with a secret URL; a plain 401 with `WWW-Authenticate: Bearer error="invalid_token"` with a bearer token.
- A call already running when the grant is revoked **MUST** end as a tool error (`isError: true`) whose `content[0].text` is the `RevokedAnswer` as JSON, with no app data. The app **MAY** put the same `RevokedAnswer` in `structuredContent`. Whether a grant was revoked is told by the grant itself (its secret, and the hash the app keeps of it), never by a grant id a later grant may reuse.
- A revoked grant never works again. The person lets the agent back with a new grant: a new MCP URL (Direct), or a new drop with consent in the app and in the dock (Dock).

### Mobile

On a phone there is no dock window, extension or desktop pet to drag from, so the agent in the app's page is the only way to point it. In a viewport that matches `(pointer: coarse), (max-width: 640px)` (`APC_MOBILE_MEDIA`), on both profiles:

- The app shows all its agents in the page, each mark visible and usable for pinning. The agent bar is never collapsed or hidden there.
- A finger can pin without a mouse drag (phones do no HTML5 drag and drop): tap the agent's mark, then the target, or drag the mark with pointer events. It makes the same pin. While an agent is armed the page **SHOULD** show that it is and give a way to cancel, so a stray tap pins nothing. Unpin and Revoke work by touch.

The reference viewport is 375 × 812 (`APC_MOBILE_VIEWPORT`). An app that claims 0.6.0 or later **MUST** give the conformance suite its page on a phone.

This is interoperability, not presentation: with no mouse and no dock window, a page that hides the agents or cannot be tapped leaves the person with no way to point, so the conformance suite checks it (`page.mobile`). Where the bar sits on a phone, that it stays reachable while the page scrolls without covering content, how "tap to pin" looks, and how large a finger target is, are [the UX guide's](/docs/ux#phones), not the contract's; that an armed agent shows it is armed and can be cancelled is the **SHOULD** above.

### The agent in the page

How an app shows each connected agent inside its page is the app's own choice. [The UX guide](/docs/ux) describes the reference pattern (the pet, the header, the pin badge, the states, motion, colour, phones, the pairing cards); it is non-normative, nothing in it is required to interoperate, and `@tineira/apc-web` is its reference implementation. Whatever an app draws, these bind it:

- **Marks.** A pet, a pin badge and the agent bar's mark **MUST** carry `data-apc-mark` and `data-grant`, so the person drags them (or taps them, then a target) to point the agent. The browser extension finds an APC app by them and steps back from its marks, so an app that leaves them off is treated as a page without APC.
- **States are not guessed.** A page **SHOULD NOT** show an agent's state that the app's data does not give, and **SHOULD NOT** guess one from timing. In particular it **SHOULD** show an agent as waiting only from the page-readable wait signal ([wait events](#wait-events-since-011)), never from how recently the agent called. A page that infers waiting from grant use (a call heard in the last seconds, or a `wait_for_focus` call) shows "waiting" when no wait runs, and **SHOULD** move to wait events.
- **A logo is not a verification.** A badge **MUST NOT** suggest that an agent is verified: it says which agent is connected. A page **MUST NOT** draw or animate a vendor's mascot; brands only.
- **Revoke is in the bar.** The app's agent bar **MUST** offer Revoke for every agent it shows (see [Revoke from the app](#revoke-from-the-app)).
- **The bar for a Direct agent.** The agent bar **MUST NOT** be collapsed or hidden while it shows a Direct agent, on any viewport: the app's page is the only place the person sees and points one (see also [Mobile](#mobile)).

## The Direct profile

The agent connects to the app's own MCP endpoint.

**Deprecated from 1.2.0, unchanged until 2.0:** in the first item, the words ", presence and `apc_link`", in whose place a 2.0 reads "and presence". The rest of this section stays. See [what 1.2 deprecates](#what-12-deprecates).

- **A grant per agent, whatever the auth.** The standard does not fix how the agent authenticates. A grant **MUST** have a stable id per agent connection (pins, views, presence and `apc_link` are keyed by it), be revocable from the app alone (ending everything that could bring it back without the person: with OAuth, its refresh tokens and authorization too) and checked before and after each tool call, tell revoked apart from expired or unknown, and be trimmed per grant (`GrantRequirement`). Any binding that meets that will do.
- **The secret URL** (the reference apps): the person makes an agent in the app's page; the app makes a grant with a secret of 128 random bits, which is the last segment of the agent's MCP URL (`newDirectGrant` in `@tineira/apc-server`).
- **A bearer token** (OAuth 2.1, or a token the app issues): every grant shares one MCP URL, and the token names the grant. A revoked token answers 401 with the `RevokedAnswer` body, so the client does not just authorize again. The grant's id is random and stays the same for the grant's whole life; it is never derived from the token. [A complete Direct app with a bearer token](/docs/integrate#a-complete-direct-app-with-a-bearer-token) shows one.
- **Hosts with no long-lived process** (stateless functions and a database) still bound `wait_for_focus` by their function's time limit (their own ceiling for `timeout_s`), tell a closed page from a heartbeat the page sends, and check the grant before and after each tool call.
- **The agent list**: where the person makes and names agents and copies the URL, or a prompt that asks the agent to add it (`<apc-direct-agents>` in `@tineira/apc-web`). An agent names itself on `initialize` (`clientInfo.name`) until the person renames it.
- **The agent bar** **MUST NOT** be collapsed or hidden while it shows a Direct agent, on any viewport: the app's page is the only place the person sees and points one ([the agent in the page](#the-agent-in-the-page); the reference bar is in [the UX guide](/docs/ux#the-agent-in-the-page)).

## The Dock profile

The agent connects once, to a hub. The person drags it from the dock onto any app they paired.

**Deprecated from 1.1.0, unchanged until 2.0.** This section moves to a separate Dock protocol, M1 to M13 and H1 to H10 included — all but [the hub's tools](#the-hubs-tools) at its end, which 1.0 left outside the contract and a major therefore takes nothing from. Nothing here changes before a 2.0 removes it, and an app or a hub that conforms to it today goes on conforming: see [what 1.1 deprecates](#what-11-deprecates).

### The drop

The dock puts the agent on a drag with the type `application/x-apc-agent` and the payload `{ v: 1, agent, hub, ticket }`: a public handle, the hub's bare origin, and a ticket. The dock **MUST NOT** put a secret or an MCP URL in the payload: any page the agent is dropped on can read it. The **ticket** is single use, lives 240 seconds (since 0.9; 60 before), is bound to that agent, and opens a connect request or a confirmation and nothing else; it cannot pair. The reference dock refreshes a ticket once it has less than 180 seconds left (it checks every 10), so a drag carries one with about three minutes left, and the app's two-minute consent fits in it.

### Origin-bound first pairing: `POST {hub}/apc/connect`

Since 0.13, a first drop requests a connection, before app consent. The app sends `{ticket, agent, app:{origin}}` server to server, with the same M1 to M4 guards as `/apc/pair` (`requestConnect`). The origin is a bare HTTPS origin (loopback HTTP only in development). Success is HTTP 200 `{ok:true, status:"connect_requested"}`; a refusal is HTTP 400 `{ok:false, error}`. A drop ticket cannot start `/apc/pair` (H9).

The hub checks, in order: body and origin; a live drop ticket bound to the agent and an existing agent, without spending it; limits; the origin verdict (blocklist, verified origins, kill switch); the app's `apc.json`, which must offer `dock` and a same-origin fragment-free `dock_connect`; then, in one synchronous step, rechecks the ticket, spends it and inserts the request. A failure before that step leaves the drop ticket usable. A connect ticket used here is `ticket_not_for_pairing` and is not spent.

The reference hub holds a request for `CONNECT_REQUEST_TTL_MS` (120 seconds), replaces one for the same (agent, app origin), allows at most three origins per agent, twenty requests per dock, and three app attempts per drop ticket (each reads `apc.json`, failed or in flight; `too_many_requests`). The owner may also create one by `POST /api/d/:did/connects {agent,host}` (a bare host or HTTPS URL, normalized by `new URL`, ports only in development). It answers `{ok:true,request}`. Connect and Deny are owner-authenticated, same-origin POSTs to `/api/d/:did/connects/:cr/approve` and `/deny`. An approve checks the agent and the current verdict again, without an outbound fetch, and only then consumes the request, in the same synchronous step. A refusal the owner can answer (`warning_required`, a refused verdict) leaves the request pending; a second approve after a successful one is `not_found`.

For an unverified origin, the owner acknowledges the warning at Connect with `{action:"approve_unverified"}`. The request's acknowledgement passes through the connect ticket to the pending pairing; the code step does not warn again. The domain's `unverified_ok` is committed only on the code's approval. Deny of a connect request changes no earlier domain approval.

The approve answers `{ok:true,url}`: the app's `dock_connect`, built with `new URL` and setting `hash` to `#apc_connect=` followed by base64url JSON `{v:1,hub,agent,ticket}`. A connect ticket has at least 128 random bits, lasts `TICKET_TTL_MS` (240 seconds), is single use, and is bound to the requested origin and agent. It is never a drop ticket; the reference hub keeps the same `${did}.${hex32}` format and distinguishes the tables. The dock opens the URL with `window.open(url,"_blank","noopener")`. On popup refusal it offers an explicit link with `target="_blank" rel="noopener"`.

**Reader reference behaviour.** An allowed extension calls `/apc/connect {ticket,agent,reader:true,label?}`. It gets `{ok:true,status:"connect_requested",claim,check}`: a private 128-bit claim `${did}.${hex32}` and a four-digit check shown by both the extension and the dock. The reader origin is checked before the ticket; manifest lookup and the app-origin verdict are skipped. Up to three pending requests per (agent, extension origin) coexist; a request never replaces another. `/apc/reader/status {claim}` answers `{ok:true,status:"pending"}` while that claim waits. Connect deletes the request and every earlier reader and pointer for this agent and extension, cleans superseded claims, creates the paired reader, and answers `{ok:true}` with no URL or connect ticket. Status then answers `{ok:true,status:"paired",token,agent}` once, to that extension origin and claim holder; later it is `denied`. The old `/apc/reader` is a hard-cut HTTP 400 `ticket_not_for_pairing` stub, spending nothing. Removing an agent, rotating its secrets, resetting, expiry and the alarm purge connect requests and tickets.

### Consent in the app

Consent is the app's server's to check, never its page's alone. The page sends every dock drop to its server; a first drop calls `/apc/connect` and says to confirm in the dock. Consent begins on `dock_connect`, in the person's own app session, after Connect in the dock. For an agent it holds no grant for (never paired, revoked, or one the dock no longer confirms), the server answers `consent_required` with a nonce; the page shows its consent with that nonce, and the Allow sends it back. The consent **SHOULD** name the hub's host from the drop (the one the app will call), the host the person has to check before the Allow; its other words are the app's own ([the UX guide](/docs/ux#pairing-and-consent-cards) gives an example). The server **MUST** make a grant only for a request that brings back the nonce of a consent it gave for that dock and that agent, and **MUST** accept each nonce only once. In the reference apps (`DockConsent` in `@tineira/apc-server`) the nonce has 128 random bits, works once, for the same dock and agent, for two minutes. One drop of an agent is answered at a time: a second request while the first waits on the hub answers `pairing_in_progress` (see [one pending pairing](#one-pending-pairing)).

Since 0.9 the consent shows a [pairing code](#the-pairing-code), and the server answers `consent_required` with both: `{ consent, pairing_code }`. The reference apps hold the code on the page and show it only after the Allow, in the handoff card that takes the consent's place ([the UX guide](/docs/ux#the-handoff-card)). That is how the reference apps do it, not a rule: the rules are in the next section.

### The pairing code

A drag can be put on any page, and anyone who runs a dock can make tickets for their own agent. Without a code, someone could lure an app's owner into dropping their agent and clicking Allow, and approve the pairing in their own dock. The code closes that: only the app's owner sees it, and the dock's Allow needs it.

- The app **MUST** make a new code with every consent: 6 characters of Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 30 bits; `newPairingCode` in `@tineira/apc-server`), shown only on the app owner's page. After the Allow it sends the code, raw (`K7M4P2`), in `pairing_code` of `/apc/pair`, and nowhere else: not over MCP, not in a URL, not to `/apc/confirm`.
- The hub keeps it with the pending pairing and **MUST NOT** show it: not in the dock's state, not in what it sends the dock's pages, not in any answer. The dock owner types it to approve; the hub compares it in constant time with what the app sent, ignoring case, spaces and dashes (O reads as 0, I and L as 1). A missing or malformed code is refused and not counted. A wrong one counts (`wrong_pairing_code`, with `attempts_left`); the fifth removes the request and gives the grant back (`pairing_code_refused`). A request with a code that nobody approves goes after two minutes, its grant given back. A match clears the code. Deny and unpair need no code.
- The app **MUST** keep the grant only when the hub acknowledges the code (below), and delete it, before it answers its page, on any other answer: a hub that does not check codes never holds a grant.
- The reference hub requires the code: it refuses a pairing without one (`pairing_code_required`). Other hubs **SHOULD** require it too.
- Where an app shows the code it **SHOULD** tell the person to type it only in their own dock and never give it to anyone, and to Cancel if their dock does not ask for it: the code's resistance to phishing lives in the person having read that. The reference apps keep the code on the page, with a Cancel (the app's revoke), until the hub connects (its first `initialize` on the grant) or the grant goes; the card's wording is in [the UX guide](/docs/ux#the-handoff-card).

### Pairing: `POST {hub}/apc/pair`

With the person's yes, the app's server makes a grant and hands it to the hub, server to server:

```json
POST https://apc.tineira.com/apc/pair
{ "ticket": "…", "agent": "ag_…", "app": { "name": "Orders", "origin": "https://orders.example" }, "mcp_url": "https://orders.example/mcp/…", "pairing_code": "K7M4P2" }
```

The ticket here is the origin-bound connect ticket from the owner-approved URL, never the drop ticket. The hub refuses a drop ticket as `ticket_not_for_pairing`, and a connect ticket for another origin or agent as `ticket_origin_mismatch`, without spending either. The hub checks the body before it spends the matching connect ticket: a `pairing_code` that is present but not a code (`null`, `""`, a number) is `invalid_pairing_code`, so a malformed request leaves the ticket good. Then it checks the ticket, the app's origin and its [`apc.json`](#apcjson) (it **MUST** refuse the pairing when the file is missing, redirected, invalid, names another origin, does not list `"dock"`, or does not cover `mcp_url`), and answers HTTP 200 with `{ ok: true, pairing_id, status: "pending", agent: { name, icon }, pairing_code: "required" }`, or HTTP 400 with `{ ok: false, error }`. `pairing_code: "required"` is the acknowledgement: the hub keeps the code and will ask for it. The pairing counts only when the person has also said yes in the dock, with the code. The app links the grant to the agent only once the hub took it, and pins it.

Since 0.12 the acknowledgement also carries `binding: "pairing_id"`: the hub names this pairing on every `initialize` it sends to the grant ([the binding](#the-binding)). An app accepts only that value: an acknowledgement with any other `binding`, or with `binding: "pairing_id"` and a `pairing_id` that is not 22 to 64 of `A–Z a–z 0–9 _ -`, is a refusal, and the app deletes the grant before it answers its page. An acknowledgement without `binding` is a hub before 0.12.

The app **MUST** treat any other answer as a refusal and delete the grant: a redirect (never followed: [M2](#the-app-and-the-hub-call)), any status but 200 and 400, a 200 without the acknowledgement (`hub_ignores_pairing_code`), no answer within its time limit. `pairWithHub` in `@tineira/apc-server` does exactly that. Since 0.10 the call also follows [the app's rules on the hub call](#the-app-and-the-hub-call) (M1 to M9), and the grant is [in flight](#the-grants-states) until the acknowledgement. Only an absent `pairing_code` is a pairing without a code, from an app before 0.9: the reference hub refuses it with `pairing_code_required`, and other hubs **SHOULD**.

### Every drop: `POST {hub}/apc/confirm`

On a drop of an agent it already holds a grant for, the app asks the hub whether that pairing still stands: `{ ticket, agent, mcp_url }`. HTTP 200 with `{ ok: true, status }` (`"pending"` or `"paired"`) pins it; while it is pending the reference apps show the pairing code again. The answer never carries the code. `{ ok: false, error: "not_paired" }` means the dock no longer pairs it: the app drops the grant and asks the person again (the ticket is still good). A hub never confirms a revoked or blocked pairing. Since 0.10 the hub expires overdue requests before it answers (H2) and answers `not_paired` for a pairing it holds as ended; what the app does with a grant still in handoff is in [one pending pairing](#one-pending-pairing).

An app **MUST** ignore fields it does not know in a hub's answer to `/apc/connect`, `/apc/pair` or `/apc/confirm`: a later version may add some, and none of them changes what the app stored for a grant (since 0.12, its [binding](#the-binding) is written only from the acknowledgement of its own `/apc/pair`).

### The hub gives a grant back: `POST {app}/apc/revoke`

When the person unpairs an app in the dock, denies its request, types the fifth wrong code, lets the request expire, or drops the agent again before approving (H3), the hub sends `{ mcp_url }` to the app's `/apc/revoke`, and the app ends that grant and deletes its pin. This is the hub's side; the app's own Revoke is core and needs no hub. The reference hub tries a give-back the app did not take again, a few times over half a day, and gives every grant back before a dock's data is deleted.

Since 0.10 (M7) `/apc/revoke` is public and **MUST** answer the same HTTP 200 to any input, with its body capped. It ends a grant whose secret hash matches and that is in any state but revoked or ended, in flight included; that grant then answers 404. On a revoked or already ended grant it does nothing: revoked stays revoked.

### The grant's states

Since 0.10 a dock grant has a state in the app, and the state says what the grant answers (`DockGrantState` and `dockGrantAnswer` in `@tineira/apc-protocol`). The states, in order of precedence, are **revoked > ended > in flight > handoff > dormant > live**: the first that applies is the one used.

| State | Begins | Ends |
|---|---|---|
| **in flight** | the Allow | the hub's acknowledgement of `/apc/pair`; on a failure the grant ends before the page hears back. A grant still in flight `T_ack` after the Allow **MUST** end, whatever happened to the call |
| **handoff** | the acknowledgement | the first `initialize` whose connection is committed |
| **live** | the committed `initialize` | dormancy, revoke or end |
| **dormant** (SHOULD) | `T_idle` after the last wake action (live grants only) | the next wake action |
| **ended** | `T_connect` after the acknowledgement with no committed `initialize` (**MUST**); a give-back (`/apc/revoke`); long dormancy | never |
| **revoked** | the owner's Revoke, or Cancel | never |

The time limits (`T_ACK_MAX_MS`, `T_CONNECT_MAX_MS` and the recommended times in `@tineira/apc-protocol`):

- `T_ack` **MUST** be longer than the app's own deadline for the hub call (M3, at most 10 seconds), so an answer that comes in time is kept, and **MUST** be at most 30 seconds (`T_ACK_MAX_MS`).
- `T_connect` is at most 10 minutes.
- `T_idle` is the app's; 30 minutes is recommended. Long dormancy is the app's; 30 days is recommended.

**What each state answers** (**MUST** wherever the app implements the state):

| Method | in flight | handoff | live | dormant | ended | revoked |
|---|---|---|---|---|---|---|
| any request | HTTP 404, state unchanged | (rows below) | (rows below) | (rows below) | HTTP 404 | 403 `RevokedAnswer` |
| `initialize` | 404 | served, commits the connection; since 0.12 only if it holds the [binding](#the-binding), else 404, state unchanged | served if it holds the binding, else 404 | served if it holds the binding (does not wake), else 404 | 404 | `RevokedAnswer` |
| `ping`, `tools/list` | 404 | served | served | served | 404 | `RevokedAnswer` |
| `tools/call` | 404 | tool error `pairing` | app data | core tools: the idle shapes; other tools: tool error `idle` | 404 | `RevokedAnswer` |
| other methods (`resources/*`, `prompts/*`) | 404 | JSON-RPC -32000, `data: { error: "pairing", message }` | as the app serves them | JSON-RPC -32000, `data: { error: "idle", message }` | 404 | `RevokedAnswer` |
| notifications | 404 | ignored (202) | served (202) | served (202), does not wake | 404 | `RevokedAnswer` |

The first row covers every request to the grant's URL, whatever its method, including a `GET`, a `DELETE` or a body that does not parse. A 404 leaves the state unchanged. `RevokedAnswer` is 403 with the secret URL, as in [revoke from the app](#revoke-from-the-app). No answer in handoff or dormant carries `attention`, `then`, an `apc_link` offer or a presence event.

**The tool errors** are `{ error: "pairing", message }` (the person has not finished pairing) and `{ error: "idle", message }` (the person is away from the app), carried in both `structuredContent` and `content[0].text` (as JSON), with `isError: true` (`DockGrantErrorAnswer`).

**The idle shapes** are **MUST** for an app that sleeps:

- `get_current_view` answers `{ view: null, focus: null, idle: true, note }` (`idleCurrentView`).
- `wait_for_focus` answers `{ focus: null, timed_out: false, page_open: false, idle: true, note }` at once (`idleWaitForFocus`).
- An answer without `idle` (an app before 0.10) reads as unavailable or page closed, as before. Dormant returns no data, and is distinct from revoked, unavailable and page closed.

**The transitions:**

- **`initialize` fails closed.** It **MUST NOT** return a result unless the move out of handoff has committed. On a persistence failure it answers JSON-RPC -32603 or HTTP 500, so the hub's introduction fails where the person sees it.
- **The commit out of handoff is conditional.** It happens only if the grant is neither revoked nor ended, in the same atomic step. If Cancel or an end won the race, `initialize` answers by the state that won: `RevokedAnswer` or 404.
- **The acknowledgement's move is conditional too.** The move from in flight to handoff happens only if the grant is neither ended (by a give-back or `T_ack`) nor revoked, in the same atomic step.
- **A served call** is a `tools/call` that returned app data in the live state. `ping`, `tools/list`, `initialize` and the `pairing` and `idle` errors are not served calls.
- **Wake actions** are authenticated actions of the grant's own user on the app's page: a page heartbeat, which **MUST** be sent at least every `T_idle / 2` while the page is open, or a confirmed drop. Agent traffic (`initialize`, `ping`, `tools/list`, `tools/call`) never wakes a grant and never extends it.
- **Cancel revokes.** Cancel, on the waiting card, is allowed only in handoff, before any served call; afterwards the grant answers `RevokedAnswer`. The check and the revoke are one atomic step, so Cancel never revokes a live grant or one that has served a call, and every tool handler re-checks revoke after its work and before it returns data ([revoke from the app](#revoke-from-the-app)).

A Dock grant serves app data only while live: after the acknowledgement **and** a committed `initialize`, and while not dormant, ended or revoked.

### One pending pairing

There is one pending pairing per (user, hub, agent), at the app and at the hub (H3).

- **Before the acknowledgement**, a new drop may replace the pending consent, with a new nonce and a new code. The stale Allow fails closed (`consent_expired`). A second Allow while the first waits on the hub gets `pairing_in_progress`.
- **After the acknowledgement and before the committed `initialize`**, a drop calls `/apc/confirm`. On `pending` with the app's own stored expiry still ahead, the page shows the **same** code and the time left: no new consent and no new code. The drop's target replaces the pending pin.
- On `not_paired`, or once the stored expiry has passed, the app ends the grant and requests a fresh Connect through `/apc/connect`. A hub answers `not_paired` for a pairing it holds as ended, too.
- The app cannot tell "waiting for the code" from "the code was accepted and the hub is introducing": both answer `pending`, and the app shows the same code for both. While the hub is introducing, the dock's own page says it is connecting and takes no code; a code typed then does not count against the five wrong codes.
- On `paired` before the app has seen `initialize`, the grant stays in handoff. The page hides the code and says it is connecting, and the drop's target is pinned once the grant is live. Only `initialize` moves the state, never a `confirm` answer.
- **The page treats its stored expiry as the truth.** It stops showing the code past it (the countdown and what the page says then are [the UX guide's](/docs/ux#the-handoff-card)).

### The app and the hub call

What an app that implements the Dock profile or still serves any Dock grant **MUST** do around the drop and the hub call (`DockAppRequirement`, M1 to M13):

- **M1. Allowlist.** Parse the drop's `hub` with `new URL`. Refuse anything unparsable, not `https:` (except a declared local-dev origin), or carrying userinfo, a path other than `/`, a query or a fragment. Compare `url.origin` for exact equality with a constant allowlist, on the drop **and** again on the Allow. Otherwise answer `hub_not_allowed`, with no consent and no grant.
- **M2. Redirects.** Never follow a redirect. Call the hub with `redirect: "manual"` (or `"error"` where the runtime implements it: Cloudflare Workers does not, and throws a `TypeError` before sending anything), and refuse any 3xx, an `opaqueredirect` or `response.redirected`.
- **M3. Time limit.** One deadline, at most 10 seconds (`HUB_CALL_DEADLINE_MS`), covers the headers and the whole body.
- **M4. Byte cap**, at most 8 KiB (`HUB_ANSWER_MAX_BYTES`). A `content-length` that is present must be ASCII digits only (`/^\d+$/`) and at most the cap, or the answer is refused before it is read. The decoded stream is cut at the cap. An absent `content-length` is not refused. The declared and decoded lengths are never compared, because of `gzip`.
- **M5. No lock across the call.** No database transaction or row lock is held across the hub call. One drop, Allow or confirm runs at a time per (user, hub, agent), across instances (an advisory lock and a partial unique index will do).
- **M6. Owner-session endpoints** (the drop, the Connect consent and its Allow, the heartbeat, Cancel) need the owner's authenticated session, and every state change is a `POST` with the media type `application/json`. A request that carries `Origin` is refused unless it equals the app's **configured** public origin (behind a proxy, the deployment configures its external origin; the app never derives it from the request URL). A request whose `Sec-Fetch-Site` is `cross-site` or `same-site` is refused. A request with neither header comes from a client that is not a browser (Pulse for Windows, say) and is taken on the session alone: a browser always sends `Origin` on a cross-origin `POST`, so a hostile page cannot strip it, and `application/json` across origins needs a CORS preflight the app never grants. A heartbeat may be a WebSocket; its handshake follows the same `Origin` rule.
- **M7. `/apc/revoke`**, as [above](#the-hub-gives-a-grant-back-post-appapcrevoke).
- **M8. `apc.json`** lists `dock` only when the app can pair right now (its configuration is present), computed per request or cached 60 seconds at most (a `max-age` of 60 or less).
- **M9.** The app sends hub requests to the parsed `url.origin` of M1, never to the raw `hub` string.
- **M10, M11, M12** (since 0.12): [the binding](#the-binding), for apps implementing Dock or still serving any Dock grant; M12 covers every non-Dock grant, including Direct grants, regardless of current pairability.
- **M13** (since 0.13). An app offering Dock **MUST** publish a fragment-free `dock_connect` on its own origin. Its GET **MUST** answer 200, never a 3xx, with `Referrer-Policy: no-referrer`, and load no third-party script. A synchronous same-origin `<head>` script, or an inline one, **MUST** read `#apc_connect` and clear it with `history.replaceState` before any other script or redirect. It **MUST** keep the ticket only in `sessionStorage` before sending the person to log in. Its consent **SHOULD** show the signed-in account. A drop with no link **MUST** call `/apc/connect`, never `/apc/pair` with a drop ticket against a 0.13 hub. The temporary 0.12 fallback was permitted only on HTTP 404 from `/apc/connect`, with the same M1 to M4 guards, until one release after the hub cut; that permission ends at 1.0.0. An expired connect link says: “This link expired. Drop the agent again, or use Connect an app in your dock.”
### The hub's duties

What a hub **MUST** do (`DockHubRequirement`; the reference hub follows them). `@tineira/apc-conformance` (`hubConformance`) checks the app-visible hub MUSTs (`apc.json` and `H7`, malformed-body ticket preservation, `PAIR-2` and `CODE-2` never-echoed / normalized / codeless when required, `H1`–`H3` excluding pairing-cap accounting, `H5` HTTP 404 tombstone and re-pair, and redirect refusal) in process against an `ApcHubAdapter` (`apps/dock/test/hub-conformance.test.ts` runs it against the reference hub, including `exerciseAgent` and `requiresPairingCode`). Rules that need the dock UI (`CODE-2`'s "never shows" in dock state/sockets, `DROP-1` no secret in the drag, and `TM-1` trust warnings and markings for unverified apps), pairing-cap accounting in `H3`/`H5`, and agent-tool relays (`H4`, `H5`'s `relay()`, `H6`, plus `exerciseAgent` hooks if omitted by another hub) are **reference behaviour, not conformance-tested in 1.0** and are proven by the reference hub's own tests (`apps/dock/test`). All of these MUSTs bind every hub all the same. The sentences of H4 about the hub's own `views[]` and `wait_for_focus` describe [the hub's tools](#the-hubs-tools), which 1.0 does not freeze; what a hub does with an app's `pairing` and `idle` answers is frozen.

- **H1.** The hub sends `initialize` on a grant's MCP URL only after the dock owner approved the pairing with the code, and sends no `initialize`, `tools/list` or `tools/call` before that. While approving, the dock takes no code.
- **H2.** `/apc/confirm` expires overdue pending requests before it answers, so an expired request answers `not_paired`.
- **H3.** `/apc/pair` replaces an unapproved pending request for the same agent and app origin rather than keeping two. Unapproved means no correct code has been accepted yet: H3 never replaces an approving or paired one. The replaced request does not count toward the hub's pairing cap. The hub gives its URL back (`/apc/revoke`) after answering `/apc/pair`, asynchronously, and only when that URL differs from the new request's. The new request's wrong-code count starts at 0, since it carries a new code from a fresh consent.
- **H4.** The hub relays `{ error: "pairing" }` and `{ error: "idle" }` as tool errors: verbatim for verified apps, inside the untrusted envelope for unverified ones. It carries `idle: true` per app in `get_current_view`'s `views[]`. It keeps an idle flag per app, unverified apps included, cleared by the next answer that lacks `idle`. An app's idle answer never ends the hub's wait early and never reads as page closed. When every app is idle, `wait_for_focus` answers `{ focus: null, timed_out: false, page_open: false, idle: true, note }`, saying the apps are asleep and wake when the person opens them, not that the person left. With a mixed fleet, the answer names the apps that are asleep, and the hub waits as usual.
- **H5.** A 404 from a pairing that was introduced, or is in handoff, is reported as `pairing_ended` ("drop the agent on the app again"), never as `app_unreachable`. The hub keeps an `ended` tombstone, like `revoked`: outside the cap, deleted on a re-pair, and `relay()` and `decide()` on it answer `pairing_ended`, not `unknown_app` or `unknown_pairing`.
- **H6.** The hub's instructions and `guide` say what the errors mean. `idle`: the person is away from that app; tell them, and do not retry. `pairing`: the person has not finished pairing yet; wait, or tell them.
- **H7.** The copy of an app's `apc.json` used for a pairing decision is at most 60 seconds old: the hub fetches it fresh on `/apc/pair`, or honours a `max-age` of 60 or less. A 5xx or unreachable `apc.json` never falls back to a stale copy that lists `dock`: the pairing is refused (`apc_json_unreachable`).
- **H8** (since 0.12). [The binding](#the-binding): every `initialize` names the pairing and its agent.
- **H9** (since 0.13). `/apc/pair` **MUST** accept only a connect ticket minted for this app origin and agent by an owner-approved connect request. A drop ticket is `ticket_not_for_pairing`; a connect ticket for another origin or agent is `ticket_origin_mismatch`. Neither refusal spends the ticket.
- **H10** (since 0.13). A connect ticket **MUST** be minted only by an owner-authenticated approve of a connect request, and returned only in that response, inside the `dock_connect` URL. No unauthenticated route and no state broadcast exposes it.

### The binding

Since 0.12. The pairing code proves that the dock's owner read a code. The binding proves that the grant the hub introduces itself to is the one this app handed to this pairing, for this agent: a URL the app did not hand to that pairing (a Direct grant, another pairing's grant, a copied URL) never goes live at an app implementing Dock or still serving any Dock grant under 0.12 or later.

- **H8.** The hub **MUST**, on every `initialize` it sends to a grant (the introduction, its retries, and every later one), put in `params._meta` the pairing's `pairing_id` under `apc.tineira.com/pairing_id` (`APC_PAIRING_ID_META`) and its agent's handle under `apc.tineira.com/agent` (`APC_AGENT_META`), for every app, verified or not, and **MUST** answer `/apc/pair` with `binding: "pairing_id"`. A `pairing_id` is 22 to 64 of `A–Z a–z 0–9 _ -`, holds at least 128 random bits, is unique across every dock the hub runs, never changes while its pairing exists, and authorizes nothing at the hub. Neither value is a secret: the agent handle is public (it is in the drag), and the app had the `pairing_id` already, from its own acknowledgement. What makes the check hold is that the app compares them with what it stored from its own call, which nobody else can write.
- **M10.** Whether a grant is a Dock grant **MUST** come from the app's own record of how it made the grant, written when it made it: never from its URL, the request, its client or the keys above. On the acknowledgement, in the same atomic step as the move out of in flight, the app **MUST** store with the grant the hub's origin, the agent, the `pairing_id`, and whether `binding` was declared. They never change. The hub's origin is context (which hub the binding came from), not a check: the `initialize` names no hub. The app reads the keys from the same parsed body it gates on, never from a later parse or an SDK handler.
- **M11.** On a Dock grant in handoff, live or dormant, an `initialize` **MUST** get HTTP 404, its state unchanged, when its `apc.tineira.com/pairing_id` or `apc.tineira.com/agent` is present and is not exactly what the app stored for the grant (a value of another type or form included), or, on a grant whose `binding` was declared, when it is in handoff and carries no `pairing_id`. A missing value is otherwise served: a grant from before 0.12, a hub before 0.12 and a hub rolled back keep working. An app that allows more than one hub **SHOULD** also refuse a missing `pairing_id` on a declared grant in every state. Every `initialize` in a request counts: in a batch, or without an `id`. Revoked, ended and in flight answer first, as before.
- **M12.** At an app that implements the Dock profile or still serves any Dock grant, on every non-Dock grant, including a Direct grant, a request carrying an `initialize` with either key, whatever its value, **MUST** get HTTP 404 before any other answer, revoked included, and the grant is unchanged. This duty applies even while `dock` is absent from the app's `apc.json` under M8 and during a hub's 60-second cache window; it never depends on current pairability. Only an app that does not implement Dock and holds no Dock grant owes no M12 refusal; it **MAY** refuse anyway.
- At an app implementing Dock or still serving any Dock grant, the 404s of M11 and M12 **SHOULD** carry `{ "error": "pairing_mismatch" }`; a hub reads only that exact token. The app never shows the keys to its page or puts them in an answer, and **SHOULD NOT** log them.
- A grant whose record holds no `pairing_id` (made before the app implemented 0.12) is checked on its agent alone.
- Apps on 0.10 to 0.12 retain confirming and relaying **existing** pairings for at least six months after 1.0. A **new** Dock first pairing needs 0.13, including origin-bound Connect. Older apps ignore the binding keys where their version permits; an app that validates `params._meta` strictly must accept the two keys.

### The derived secret (optional)

An app may derive a dock grant's secret instead of storing a random one. The recipe is optional; what holds either way is that the hash and salt the app stores cannot rebuild the secret.

- **Inputs:** K, at least 32 random bytes; `<app>`, a fixed lowercase tag without `|`, never changed (changing it equals rotating K); a salt of 16 random bytes, base64url; the grant id, without `|`.
- **The secret** is `base64url_unpadded(HMAC-SHA256(K, "<app>-dock-v1|<grantId>|<salt>")[0..16])`: 22 characters, 128 bits.
- **Storage:** keep `SHA-256(ascii(secret))` and the salt, and look a grant up by a unique index on that hash (a hash-index lookup is acceptable). Never compare the secret in plaintext; a comparison in memory compares digests in constant time.
- **Rotation:** rotating K silently ends every Dock grant at its next confirm (`not_paired`, then a new consent), and direct calls get 404. It is a mass end: not a kill switch, and not routine. To rotate without that, keep a key id per grant and derive with that grant's key.

### What secures the Dock

The Dock's security is the 0.9 pairing code plus a secret URL over TLS. There is no end-to-end encryption, and the hub sees what it relays.

The pairing code gates the honest hub's approval, and that hub's `initialize` is the owner's yes (H1). The code never gates the app's data path. Against a hub that breaks H1, or against someone holding the URL, the URL is the credential, as in 0.9. No app can detect a breach of H1: hub conformance and the operator's allowlist are the controls.

Since 0.12 [the binding](#the-binding) ties the hub's `initialize` to the app's own `/apc/pair` call for that agent. Since 0.13 the origin-bound Connect step closes the relay of a victim's drop ticket through a real app account: the drop only asks, and the dock opens the app's declared page in the dock owner's own session with a new connect ticket. The pairing code still guards against the reverse case, an attacker-owned dock luring an app owner. The dock **MUST** show the app's host on every request. The person types a code only from their own account and never reads it out to someone else.

The page never sees the MCP URL or the secret, and the code is shown only on the owner's page and sent only in `/apc/pair`. APC covers pointing only: confirmations and approvals of what an agent does are outside the standard.

### The hub's tools

**Not normative in 1.0.** This section describes the reference hub's tools for agents; 1.0 does not freeze them (see [what 1.0 freezes](#what-10-freezes)), and their shapes live in the hub's code, not in `@tineira/apc-protocol`. A later minor version will state them. An app relies on none of it: what the hub sends an app is the Dock profile above.

A hub exposes to the agent its own `get_current_view` (the focus, now with `app: { id, name, origin }`, and a `views` list, one per paired app), one `wait_for_focus` across all apps, `list_app_tools`, and `call_app_tool({ app, tool, args })`. Each app's other tools are relayed as `<app>__<tool>` (at most 64 characters). The hub rewrites `next` and `next_args` to its own tool names, removes the apps' `attention` and `then`, and adds its own. Since 0.10 it relays the apps' `pairing` and `idle` answers as [H4](#the-hubs-duties) says. A browser extension is one more app of the hub, with id `page`; a page reading is the focus kind `page_reading`, read with `page__get_reading`.

**Deprecated from 1.2.0, unchanged until 2.0:** two spans of this section and no more, because they name what is marked: ": what the hub sends an app is the Dock profile above", and the sentence "Since 0.10 it relays the apps' `pairing` and `idle` answers as H4 says." The section stays, non-normative as before. See [what 1.2 deprecates](#what-12-deprecates).

## `apc_link`

An app that offers both profiles shows the same agent on both paths as one.

**Deprecated from 1.2.0, unchanged until 2.0.** This section moves to the Dock protocol, entire, with the `link_refused` code. As built it serves one agent seen through a hub and directly, and an app that offers only Direct never links. Nothing here changes before a 2.0 removes it: see [what 1.2 deprecates](#what-12-deprecates).

- **The offer.** When a connection arrives (`initialize`) with the same MCP client as one already connected on the opposite path, the app puts `apc_link: { code, expires_in, note }` on a result of the new connection, placed like `attention`, at most once per MCP session. On the Dock path it rides on one of the app's own tools, never a core tool.
- **The answer.** The agent calls `apc_link({ code })` on its other connection: directly, or through the dock as `<app>__apc_link`. The app answers `{ linked: true, note }` or the tool error `{ error: "link_refused", reason, message }`.
- **The code** has at least 96 random bits, works once, for 120 seconds, only on a different connection on the opposite path that it was offered to. Otherwise the reason is `unknown_code`, `expired`, `used`, `same_connection`, `same_path`, `not_offered` or `already_linked`. The app keeps only its hash.
- **Linking grants nothing.** Each path keeps its grant, trimming and pin; the agent bar shows one agent. Revoke on it cuts both grants; the person can unlink.
- **Which client.** On Direct, `clientInfo.name` of the agent's `initialize`. On Dock the hub initializes the app as itself, so it names the agent's own client in `params._meta["apc.tineira.com/agent_client"]`, to verified apps only.

## `apc.json`

Every APC origin **MUST** say what it is at `GET {origin}/.well-known/apc.json`, from that origin, as JSON of at most 16 KiB:

```json
{ "name": "Orders", "standard": "0.11.0", "origin": "https://orders.example",
  "profiles": ["direct", "dock"], "mcp": { "path": "/mcp/" },
  "direct": { "connect": "https://orders.example/agents" } }
```

- `standard`: the version of this standard it implements.
- `dock_connect` (with Dock, since 0.13): the app's same-origin URL for first pairing, without any `#` fragment; HTTPS outside loopback development. This is an app field; a hub's `dock:{pair,confirm}` is unchanged.
- `origin`: exactly the origin it is served from; a file that names another is refused.
- `profiles`: `"direct"`, `"dock"` or both for an app; `"hub"` alone for a hub, which then also gives `dock: { pair, confirm }`. A writer **SHOULD** use profile words that match `[a-z][a-z0-9_-]{0,31}` and **SHOULD** list at most 8, both here and in each `mcp.endpoints` entry. A reader ignores words and keys it does not know. These are writer recommendations; nothing a reader does changes in 1.x. Since 0.10 an app lists `"dock"` only while it can pair, and the file is computed per request or cached 60 seconds at most (M8).
- `mcp.path`: a path that starts and ends with `/`. It is a prefix: every grant's MCP URL on the origin starts with `origin + path`. Unless `mcp.endpoints` is present (below), a hub pairs only an MCP URL under it, with no encoded `/`, `\`, `.` or `%` and no `.` or `..` segment after it. A Direct app whose grants share one URL (a bearer token names the grant) may serve it at `mcp.path` itself, or without its last `/` (`/api/mcp` for `"/api/mcp/"`): a Direct app whose agents all use one URL `/mcp` with a bearer token declares `"/mcp/"`.
- `mcp.endpoints` (0.11, optional): the exact MCP endpoints of the origin and the profiles each serves; when present, only they cover a URL ([below](#mcpendpoints-011)).
- `direct.connect` (with `"direct"`): the page on the same origin where the person connects an agent directly.
- `direct.auth` and `direct.resource_metadata` (optional, information only): how agents authenticate (`"url"`, `"oauth"`) and, with OAuth, the protected-resource metadata URL on the origin. A reader never requires them.

**Deprecated from 1.1.0, unchanged until 2.0**, four clauses of this section and no others: `dock_connect`; a hub's `dock: { pair, confirm }`; the rule below that a reader leaves `dock` out of an `mcp.endpoints` entry on an exact path; and the answer an app owes a dock agent dropped on an app that offers only Direct. The document, its path grammar and its matching rules stay, and so does the word `"dock"` in `profiles` — only its definition moves ([what 1.1 deprecates](#what-11-deprecates)).

**Deprecated from 1.2.0, unchanged until 2.0**, in the list above: in `profiles`, "; `"hub"` alone for a hub, which then also gives `dock: { pair, confirm }`" and the sentence "Since 0.10 an app lists `"dock"` only while it can pair, and the file is computed per request or cached 60 seconds at most (M8)."; and in `mcp.path`, `a hub pairs`: deprecated. 2.0 states this rule for every reader, as `a reader covers, apart from the shared URL the next sentence allows,`. Nothing changes until then. The rest of that sentence, and the next one, stay word for word. See [what 1.2 deprecates](#what-12-deprecates).

A dock agent dropped on an app that offers only Direct is answered, never lost: the page tells the person that it connects agents directly and links its connect page (`direct.connect`), and pairs nothing (the reference sentence, `directOnlyNote`, is in [the UX guide](/docs/ux#notes-when-a-drop-cannot-pair)). A page that cannot read its own `apc.json` pairs nothing either.

### `mcp.endpoints` (0.11)

An origin that serves several MCP endpoints, some of them not APC, declares the APC ones exactly:

```json
"mcp": { "path": "/mcp/",
         "endpoints": [ { "path": "/mcp", "profiles": ["direct"] },
                        { "path": "/mcp/{secret}", "profiles": ["dock"] } ] }
```

Each entry is a `path` and the `profiles` it serves. A path is exact. `{secret}` as its last segment stands for one grant's secret. When `mcp.endpoints` is present, a reader of 0.11 or later **MUST** cover an MCP URL only by an entry of it, never by `mcp.path`: anything else on the origin is not APC. `mcp.path` may stay beside it for readers before 0.11, which still cover all of it. An app keeps it while any such reader exists (a hub, the browser extension, its own bundled `@tineira/apc-web`); one that wants the narrower rule for every reader leaves it out and accepts that older readers refuse the file.

**Reading the file.** A reader **MUST** treat the file as invalid when:

- `mcp` has neither `path` nor `endpoints`, or has a `path` that fails the rule above (with or without `endpoints`);
- `endpoints` is there and is not a list, or has more than 16 entries;
- an entry is not an object; its `path` is not a string of at most 200 characters that starts with `/`, or holds `%`, `?`, `#`, `\`, whitespace, a control character or a format character (Unicode `White_Space`, `Cc`, `Cf`), or a `.` or `..` segment; its `profiles` is not a list of at most 8 strings; or two entries have the same `path`;
- `mcp.path` is there and a usable entry lies outside it: `P/{secret}` needs `P/` to start with `mcp.path`; an exact path needs to start with `mcp.path` or to equal it without its last `/`.

A reader **MUST** drop, whole, an entry it does not fully understand, and never use part of it: an entry with any key but `path` and `profiles`, or a path outside the 0.11 grammar (fixed segments of `A-Z a-z 0-9 . _ ~ ! $ & ' ( ) * + , ; = : @ -`, then at most one final `/{secret}` after at least one fixed segment; so no trailing `/`, no empty segment, no other `{…}`). A dropped entry covers nothing, but still names its path (below). Profile words other than `direct` and `dock` are left out of an entry one by one, and so is `dock` on an exact path: a Dock grant is one URL per grant. An entry may list a profile the top-level `profiles` does not (an app that is not pairing right now, M8); it covers nothing for that profile. A file left with no usable entry still parses, and covers nothing.

**Matching.** A reader **MUST** cover an MCP URL for a profile R (`direct` or `dock`; a hub pairing a Dock app checks `dock`) only when all of these hold:

1. It is an absolute `http`/`https` URL on the file's origin, with no user or password.
2. The string holds no `?`, `#` or `%`, and is exactly `origin + path` as a URL parser writes it back: no dot segment, backslash, upper-case host, written default port or encoding.
3. The top-level `profiles` and a usable entry both list R, and either:
   - the entry is exact, the path equals it (case-sensitive), and the grants share the URL (a bearer token names the grant); or
   - the entry is `P/{secret}`, the path is `P/s` where `s` is 16 to 128 of `A-Z a-z 0-9 _ -`, and no entry's path equals it, usable or dropped, or begins with it followed by `/`, compared without ASCII case (exact wins: a sibling an entry names, or the fixed parent of a deeper entry, is never a secret).

An app **MUST NOT** serve anything but its grants on a child of `P` that fits the secret, other than the exact entries it declares: `P/{secret}` claims every such child. A child that fits the secret and names no grant is an unknown grant, and answers as one: 404. Keep fixed routes out of a `{secret}` parent. A file that narrows does not end pairings already made; the app revokes them. `declaresMcpUrl(manifest, url, { profile, shared })` and `mcpUrlCoverage` in `@tineira/apc-protocol` implement this, and these vectors are its tests (`packages/protocol/test/mcp-endpoint-vectors.json`):

<!-- mcp-endpoint-vectors:start -->
```json
{
  "shared-urls": {"name":"Example","standard":"0.11.0","origin":"https://www.cars.example","profiles":["direct"],"mcp":{"path":"/api/","endpoints":[{"path":"/api/mcp","profiles":["direct"]},{"path":"/api/ops/mcp","profiles":["direct"]}]},"direct":{"connect":"https://www.cars.example/connect"}},
  "split": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct","dock"],"mcp":{"path":"/mcp/","endpoints":[{"path":"/mcp","profiles":["direct"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ledger.example/connect"}},
  "split-not-pairing": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct"],"mcp":{"path":"/mcp/","endpoints":[{"path":"/mcp","profiles":["direct"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ledger.example/connect"}},
  "named-siblings": {"name":"Example","standard":"0.11.0","origin":"https://ops.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/operations-console","profiles":["direct"]},{"path":"/mcp/tenant-admin-console/mcp","profiles":["direct"]},{"path":"/mcp/future-console-entry/","profiles":["direct"]},{"path":"/mcp/later-feature-route","profiles":["direct"],"methods":["POST"]},{"path":"/mcp/{secret}","profiles":["dock"]}]},"direct":{"connect":"https://ops.example/connect"}},
  "direct-template": {"name":"Example","standard":"0.11.0","origin":"https://orders.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/{secret}","profiles":["direct"]}]},"direct":{"connect":"https://orders.example/connect"}},
  "unknown-key": {"name":"Example","standard":"0.11.0","origin":"https://orders.example","profiles":["direct","dock"],"mcp":{"endpoints":[{"path":"/mcp/{secret}","profiles":["dock"],"requires":"pairing_code"}]},"direct":{"connect":"https://orders.example/connect"}},
  "path-only": {"name":"Example","standard":"0.11.0","origin":"https://ledger.example","profiles":["direct","dock"],"mcp":{"path":"/mcp/"},"direct":{"connect":"https://ledger.example/connect"}}
}
```

| File | URL | Profile | Shared | Covered | Why |
|---|---|---|---|---|---|
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | **yes** | a grant's secret under the dock template |
| `split` | `https://ledger.example/mcp` | direct | yes | **yes** | the shared Direct URL, with a bearer |
| `split` | `https://ledger.example/mcp` | direct | no | no | an exact endpoint covers a shared URL only |
| `split` | `https://ledger.example/mcp` | dock | no | no | the hub never pairs a shared URL |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | direct | no | no | the template serves dock only |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | (none) | no | no | no profile given covers nothing |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/x` | dock | no | no | a secret is one segment |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnO` | dock | no | no | 15 characters is too short for a secret |
| `split` | `https://ledger.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | dock | no | no | 129 characters is too long for a secret |
| `split` | `https://ledger.example/mcp/abcdefgh.ijklmnop` | dock | no | no | no dot in a secret |
| `split` | `https://ledger.example/mcp/abcdefgh~ijklmnop` | dock | no | no | no tilde in a secret |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?` | dock | no | no | an empty query |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv#` | dock | no | no | an empty fragment |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?a=1` | dock | no | no | a query |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/` | dock | no | no | a trailing slash |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv;x=1` | dock | no | no | a matrix parameter |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv\|` | dock | no | no | a pipe |
| `split` | `https://ledger.example//mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a double slash |
| `split` | `https://ledger.example/mcp/./AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a dot segment |
| `split` | `https://ledger.example/mcp/%41AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | any percent-encoding |
| `split` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv/..%2f` | dock | no | no | encoded traversal |
| `split` | `https://ledger.example/mcp/%2e%2e%2fadminabcdefghij` | dock | no | no | encoded dots and slash |
| `split` | `https://ledger.example/mcp\AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a backslash |
| `split` | `https://ledger.example/Mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | the path is case-sensitive |
| `split` | `https://LEDGER.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | an upper-case host is not written as parsed |
| `split` | `https://ledger.example:443/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a written default port |
| `split` | `https://u:p@ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | credentials |
| `split` | `blob:https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | a blob: URL has the origin, not the scheme |
| `split` | `https://evil.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | another origin |
| `split` | `not a url` | dock | no | no | not a URL |
| `split-not-pairing` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | the top level does not list dock: not pairing right now |
| `split-not-pairing` | `https://ledger.example/mcp` | direct | yes | **yes** | Direct still covered |
| `shared-urls` | `https://www.cars.example/api/mcp` | direct | yes | **yes** | the personal endpoint |
| `shared-urls` | `https://www.cars.example/api/ops/mcp` | direct | yes | **yes** | the ops endpoint |
| `shared-urls` | `https://www.cars.example/api/mcp/public` | direct | yes | no | not declared, although mcp.path /api/ holds it |
| `shared-urls` | `https://www.cars.example/api/mcp/` | direct | yes | no | a trailing slash is another URL |
| `shared-urls` | `https://www.cars.example/API/mcp` | direct | yes | no | the path is case-sensitive |
| `shared-urls` | `https://www.cars.example/api/mcp?x=1` | direct | yes | no | a query |
| `shared-urls` | `https://www.cars.example/api//mcp` | direct | yes | no | a double slash |
| `shared-urls` | `https://www.cars.example/api/mcp;x` | direct | yes | no | a matrix parameter |
| `shared-urls` | `https://www.cars.example/api/mcp` | direct | no | no | an exact endpoint covers a shared URL only |
| `shared-urls` | `https://www.cars.example/api/mcp` | dock | no | no | the app does not offer dock |
| `named-siblings` | `https://ops.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | **yes** | a grant's secret |
| `named-siblings` | `https://ops.example/mcp/operations-console` | dock | no | no | exact wins: a sibling the file names |
| `named-siblings` | `https://ops.example/mcp/Operations-Console` | dock | no | no | exact wins without ASCII case |
| `named-siblings` | `https://ops.example/mcp/tenant-admin-console` | dock | no | no | exact wins: the fixed parent of a deeper entry |
| `named-siblings` | `https://ops.example/mcp/future-console-entry` | dock | no | no | exact wins: named by an entry this reader drops (trailing slash) |
| `named-siblings` | `https://ops.example/mcp/later-feature-route` | dock | no | no | exact wins: named by an entry this reader drops (unknown key) |
| `named-siblings` | `https://ops.example/mcp/operations-console` | direct | yes | **yes** | the exact endpoint itself |
| `named-siblings` | `https://ops.example/mcp/later-feature-route` | direct | yes | no | an entry with an unknown key covers nothing |
| `named-siblings` | `https://ops.example/mcp/future-console-entry/` | direct | yes | no | an exact path ending in / is not understood in 0.11 |
| `direct-template` | `https://orders.example/mcp/0123456789abcdef0123456789abcdef` | direct | no | **yes** | a Direct secret URL |
| `direct-template` | `https://orders.example/mcp/0123456789abcdef0123456789abcdef` | dock | no | no | a Direct-only template never pairs |
| `unknown-key` | `https://orders.example/mcp/AbCdEfGhIjKlMnOpQrStUv` | dock | no | no | an entry with an unknown key is dropped whole |
| `path-only` | `https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv?a=1` | dock | no | **yes** | no endpoints: the 0.10 rule under mcp.path, unchanged |
| `path-only` | `https://ledger.example/mcp` | direct | yes | **yes** | no endpoints: the 0.8 shared allowance, unchanged |
<!-- mcp-endpoint-vectors:end -->

**Deprecated from 1.2.0, unchanged until 2.0**, in this section: "a hub, " among the readers before 0.11; "and `dock`" and " (an app that is not pairing right now, M8)" in the rule on profile words; " or `dock`; a hub pairing a Dock app checks `dock`" in matching, which leaves "(`direct`)"; the sentence "A file that narrows does not end pairings already made; the app revokes them."; and the vectors whose profile is `dock`. A 2.0 re-keys to `direct` the `dock` vectors that test the matching rules themselves (among them the `{secret}` shape, URL normalization and encoded traversal, and the `path-only` row), with their files' profiles, so this page keeps the coverage; the Dock protocol keeps those that test `dock` itself. The grammar, the reading rules and the matching rules stay. See [what 1.2 deprecates](#what-12-deprecates).

## The hub's trust model

What a hub does about apps it does not know. The rules below are the reference hub's; a hub that follows them protects agents the same way.

**Deprecated from 1.1.0, unchanged until 2.0:** [the warning](#the-warning), [the limits](#limits) and [the blocklist and the kill switch](#the-blocklist-and-the-kill-switch), each entire, and the sentence just below that an unverified app **MUST** use HTTPS on a domain name and that its redirects are not followed. **Not** marked, because what they serve is the content an agent reads: [untrusted marking](#untrusted-marking) entire, and the sentences just below that define a verified and an unverified app and fix an app's identity as its domain, which untrusted marking is written in and could not be read without. See [what 1.1 deprecates](#what-11-deprecates).

### Verified and unverified apps

A hub's **verified** apps are the ones its operator lists. Any other app is **unverified**. Its identity is its domain: its id, and so its tool prefix, comes from its host (`evil.example` gives `evil_example__get_order`), always holds a `_` and never `__`, so it can never take a verified app's prefix or `page`. What it calls itself is kept only as `declared_name`. An unverified app **MUST** use HTTPS on a domain name (no IP address, no single-label or `localhost` host), and its redirects are not followed.

### The warning

An unverified app pairs only after the person approves the dock's warning for its domain: the domain first, **Not verified**, what the app calls itself marked as its own word, and the risk (your agent will read whatever this app tells it, which could lead it to move data out of your other apps), with **Deny** as the default button (how the dock lays it out beyond that is [the UX guide's](/docs/ux#the-docks-warning)). The approval is once per domain per dock; Deny, Unpair or Remove withdraws it. The hub, not the page, enforces it.

### Untrusted marking

A hub **MUST** mark everything an unverified app gives (its results, its errors, its view, its focus, its `attention`, its tools) so that an agent can tell it from the hub's own words, and **MUST NOT** count its `then` or `page_open`. The marking is frozen by 1.0; the shapes below (the envelope, the labels) are the reference hub's, part of its tools, which 1.0 does not freeze:

- A relayed result arrives in an envelope, in the structured result and the text: `{ app, untrusted: true, note, result }` (or `text: [...]`).
- Its entry in `views`, its focus and its `attention` carry `untrusted: true`.
- Its tools are listed with the label `[Unverified app at <host>, calls itself "<name>". Untrusted: …]` and no annotations of its own (an app could claim `readOnlyHint`).
- A failed call is `app_unreachable` with the hub's own reason only, never the app's error text.
- Its `then` and `page_open` are not counted, so it cannot keep the agent waiting.

### Limits

The reference hub reads at most 1 MiB of each answer from a verified app and 256 KiB from an unverified one, with a time limit that covers the body; it keeps an unverified app's view only under 8 KB, its tool schemas under 8 KB, its descriptions cut at 1 KB, 32 tools at most; it takes its pin only when well formed and on its own origin; it takes no app's pin dated ahead of its clock, verified or not; it follows no app's redirect; and it holds 20 app pairings per dock at most (`too_many_apps`).

### The blocklist and the kill switch

A hub may block domains (a domain covers its subdomains): a blocked app cannot pair (`app_blocked`), and a pairing made before reads as blocked and is never called again. The reference hub also has a kill switch that closes it to every unverified app at once; verified apps are untouched.

## The browser extension

With the APC browser extension the person can drop a dock agent on any web page, APC or not. Everything the person can see in the region the extension outlines while they drag (a block of text, a form's question or a whole form; what is outlined is what is read, see [the UX guide](/docs/ux#on-any-page-the-extensions-outline)), including what they typed there, and their selection, is read on the drop, and only then, and handed to the hub as a page reading, with `untrusted: true`: what a page says is data from that page, never instructions. Card, account and id numbers go only as the person set in the extension; passwords and one-time codes never. This is the extension's, for pages without APC: an APC app decides itself what it exposes to an agent, through its own tools. On a Direct-only app that does not answer dock drops itself, the extension tells the person to connect directly.

**Deprecated from 1.2.0, unchanged until 2.0:** the last sentence above, on a Direct-only app, and no other. The first four sentences of this section stay word for word. See [what 1.2 deprecates](#what-12-deprecates).

## Error codes

The codes this version names, in one place. Each section above says the shape and the status; a reader that meets a code not listed reads it as a refusal or a failure ([reading what you do not know](#reading-what-you-do-not-know)). A code marked *reference* is what the reference software answers there; another implementation may answer another code for the same case and still conform. The others are named by a rule of this page. The table is not exhaustive: the dock's own pages and the reference software have codes of their own (`try_again` when a link code collides, say).

**Deprecated from 1.1.0, unchanged until 2.0:** four of the tables below — *an app, to its own page, on a drop or an Allow*, *a hub, to an app*, *connect and reader routes*, and *a hub, to the dock's owner, on an approval* — and the paragraph that fixes `/apc/reader/status` at HTTP 200 `denied`. Out of *a hub, to an agent*, whose heading leaves it outside the 1.0 freeze but for H4 and H5, two rows are marked with the duties they serve: the relayed `pairing` and `idle`, and `pairing_ended`. **Not** marked: what an app answers an agent on a grant, and the rest of that last table. Three codes in the first table — `pairing`, `idle` and `pairing_mismatch` — speak of a Dock grant and are deliberately left unmarked, because where they belong is not yet settled ([what 1.1 deprecates](#what-11-deprecates)).

**Deprecated from 1.2.0, unchanged until 2.0:** those three rows, `pairing`, `idle` and `pairing_mismatch`, which 1.2 settles as Dock, and the `link_refused` row, which goes with [`apc_link`](#apc_link). And, in two headings that stay, the words ", both profiles" of *an app, to an agent on a grant* and ", except H4 and H5" of *a hub, to an agent*. The `revoked` row and the paragraph under that table stay. See [what 1.2 deprecates](#what-12-deprecates).

**An app, to an agent on a grant** (the core, both profiles)

| Code | When | Where |
|---|---|---|
| `revoked` | every request on a revoked grant (`RevokedAnswer`: 403 with a secret URL, 401 with a bearer token) | [revoke from the app](#revoke-from-the-app) |
| `pairing` | a tool call (tool error) or another method (JSON-RPC -32000) on a Dock grant in handoff | [the grant's states](#the-grants-states) |
| `idle` | a tool other than a core tool, or another method, on a dormant Dock grant | [the grant's states](#the-grants-states) |
| `pairing_mismatch` | at an app implementing Dock or still serving any Dock grant, the body (**SHOULD**) of the HTTP 404 an `initialize` gets when it does not hold the grant's binding (M11), or carries either binding key on a grant that is not a Dock grant (M12) | [the binding](#the-binding) |
| `link_refused` | `apc_link` refused, with a `reason`: `unknown_code`, `expired`, `used`, `same_connection`, `same_path`, `not_offered` or `already_linked` | [`apc_link`](#apc_link) |

An unknown or ended grant carries no `RevokedAnswer`: it is a 404 (a secret URL) or a plain 401 (a bearer token). A code in its body is optional; the reference apps answer `{ "error": "unknown_grant" }`. An app whose configuration of its profiles is wrong answers its agent paths HTTP 503 with `profiles_misconfigured` (*reference*, `profilesRefusal` in `@tineira/apc-server`).

**An app, to its own page, on a drop or an Allow** (Dock)

| Code | When | Where |
|---|---|---|
| `consent_required` | not an error: the agent needs the person's consent, with its nonce and pairing code | [consent in the app](#consent-in-the-app) |
| `hub_not_allowed` | the drop's `hub` fails the allowlist (M1) | [the app and the hub call](#the-app-and-the-hub-call) |
| `consent_expired` | an Allow whose consent a newer drop replaced, or that ran out | [one pending pairing](#one-pending-pairing) |
| `pairing_in_progress` | an Allow while another Allow of that agent waits on the hub | [one pending pairing](#one-pending-pairing) |
| `hub_ignores_pairing_code` | the hub answered 200 without the code's acknowledgement; the grant is deleted | [pairing](#pairing-post-hubapcpair) |
| `hub_unreachable`, `hub_refused` | *reference* (`pairWithHub`, `confirmWithHub`): no answer in time; any answer that is not an acknowledgement | [the app and the hub call](#the-app-and-the-hub-call) |
| `invalid_drop` | *reference* (`parseDockDrop`): a drop that is not `{ v: 1, agent, hub, ticket }` | [the drop](#the-drop) |

**A hub, to an app** (HTTP 400 with `{ ok: false, error }`, on `/apc/pair` and `/apc/confirm`)

| Code | When | Where |
|---|---|---|
| `invalid_pairing_code` | `pairing_code` is present and not a code; the ticket is not spent | [pairing](#pairing-post-hubapcpair) |
| `pairing_code_required` | `/apc/pair` without `pairing_code` (an app before 0.9) | [the pairing code](#the-pairing-code) |
| `ticket_expired` | *reference*: the ticket is unknown, spent, out of time, or another agent's | [the drop](#the-drop) |
| `invalid` | *reference*: the body lacks `ticket`, `agent` or `mcp_url` | |
| `dock_expired` | *reference*: the ticket's dock is gone | |
| `app_not_allowed` | *reference*: the MCP URL is not on the app's origin, the hub is closed to unverified apps, or the host is not a domain name | [verified and unverified apps](#verified-and-unverified-apps) |
| `https_required` | *reference*: an unverified app over `http:` | [verified and unverified apps](#verified-and-unverified-apps) |
| `app_blocked` | the app's domain is blocked (on `/apc/confirm` too) | [the blocklist](#the-blocklist-and-the-kill-switch) |
| `app_host_too_long`, `app_id_taken` | *reference*: an unverified app's host gives no usable tool prefix | [verified and unverified apps](#verified-and-unverified-apps) |
| `too_many_apps` | the dock already holds as many pairings as it takes | [limits](#limits) |
| `apc_json_missing`, `apc_json_redirected`, `apc_json_unreachable`, `apc_json_invalid`, `apc_json_wrong_origin` | the app's `apc.json` is missing, redirected, out of reach (H7), unreadable, or names another origin (`ApcJsonRefusal`) | [`apc.json`](#apcjson) |
| `dock_not_offered` | the app's `apc.json` does not list `"dock"` | [`apc.json`](#apcjson) |
| `mcp_url_not_declared` | the app's `apc.json` does not cover `mcp_url` for `dock` | [`mcp.endpoints`](#mcpendpoints-011) |
| `not_paired` | `/apc/confirm`: the dock no longer pairs this agent with this grant, or holds the pairing as ended | [every drop](#every-drop-post-hubapcconfirm) |

**Connect and reader routes** (HTTP 400 `{ok:false,error}` on every refusal below; owner authentication retains the existing middleware's 403/404)

| Code | Routes and meaning |
|---|---|
| `invalid` | `/apc/connect`: malformed body (an app body without `app.origin` included); owner create: empty or malformed host or agent |
| `dock_expired` | `/apc/connect`, `/apc/pair`: dock no longer exists |
| `ticket_expired` | `/apc/connect`, `/apc/pair`: absent, expired, consumed ticket or removed agent (an expired connect ticket included, on `/apc/connect` and `/apc/confirm` too); `/apc/connect` also refuses an agent mismatch |
| `ticket_not_for_pairing` | drop ticket on `/apc/pair`; live connect ticket on `/apc/connect` or `/apc/confirm`; every call to the obsolete `/apc/reader`; no ticket is spent on these refusals |
| `ticket_origin_mismatch` | `/apc/pair`: connect ticket bound to a different origin or agent, unspent |
| `too_many_requests` | `/apc/connect`, owner create: request limits or the per-ticket attempt cap reached, drop ticket unspent |
| `reader_not_allowed` | reader `/apc/connect`, `/apc/reader/status`, owner reader approve: extension origin not allowed |
| `app_not_allowed`, `https_required`, `app_blocked` | app `/apc/connect`, owner create/approve: origin verdict refused |
| `apc_json_missing`, `apc_json_redirected`, `apc_json_unreachable`, `apc_json_invalid`, `apc_json_wrong_origin`, `dock_not_offered` | app `/apc/connect`, owner create: manifest refusal; missing `dock_connect` is `apc_json_invalid` |
| `not_found` | owner approve/deny: absent, expired, denied or already consumed connect request |
| `warning_required`, `invalid_action`, `unknown_agent` | owner connect actions: unacknowledged warning, unknown action, or agent removed |
| `forbidden` | owner routes: absent/wrong owner cookie or cross-origin/site request (HTTP 403) |
| `dock_expired` | owner routes: cookie no longer opens a live dock (HTTP 404) |

`/apc/reader/status` returns HTTP 200 `denied` for a malformed, unknown, expired, consumed or other-origin claim. It never exposes a token for one of these claims.

**A hub, to the dock's owner, on an approval** (the dock's page)

| Code | When | Where |
|---|---|---|
| `pairing_code_required`, `invalid_pairing_code` | *reference*: Allow with no code, or with one that is not a code; neither counts as a wrong code | [the pairing code](#the-pairing-code) |
| `wrong_pairing_code` | a wrong code, with `attempts_left` | [the pairing code](#the-pairing-code) |
| `pairing_code_refused` | the fifth wrong code: the request goes and its grant is given back | [the pairing code](#the-pairing-code) |
| `warning_required` | *reference*: an unverified app approved before its warning was | [the warning](#the-warning) |
| `unknown_pairing` | *reference*: the request is gone (expired, replaced or decided meanwhile) | [one pending pairing](#one-pending-pairing) |

**A hub, to an agent** (outside the 1.0 freeze, except H4 and H5)

| Code | When | Where |
|---|---|---|
| `pairing`, `idle` | an app's answer, relayed (H4) | [the hub's duties](#the-hubs-duties) |
| `pairing_ended` | a pairing the hub introduced answered 404 (H5) | [the hub's duties](#the-hubs-duties) |
| `app_unreachable` | *reference*: an app did not answer; for an unverified app, in the hub's own words only | [untrusted marking](#untrusted-marking) |
| `unknown_app`, `unknown_tool`, `invalid_arguments`, `no_reading` | *reference*: the hub's own tools | [the hub's tools](#the-hubs-tools) |
| `unknown_agent` | *reference*: HTTP 404 on an agent's MCP URL the dock no longer has (removed, or rotated when a computer left) | |

## Versioning and compatibility

The standard has its own [semver](https://semver.org), `APC_STANDARD_VERSION` in `@tineira/apc-protocol`, separate from the software release. Every change to the contract adds an entry to the [changelog](/docs/changelog) and bumps it. The packages' TypeScript APIs, presentation (how a page draws its agents) and a hub's internals are not the contract. Why the policy is what it is: [DESIGN.md § 27](https://github.com/tineira/agent-pointed-context/blob/main/DESIGN.md#27-versioning-and-compatibility-from-10-tin-913).

**Deprecated from 1.2.0, unchanged until 2.0**, in the list below: ", as an app takes the binding only when the hub's acknowledgement declares `binding` (0.12)"; "A hub or " and the sentence "A hub tells majors apart by the major version of that field."; the bullets **Apps on 0.x when 1.0 ships** and **The previous major**, entire; and, in **The conformance suite**, ", and keeps checking existing-pairing claims from 0.10 up, labelled "pre-1.0"" and the sentence "Dock first-pairing conformance has a floor of 0.13." **Not** marked: the deprecation rule. See [what 1.2 deprecates](#what-12-deprecates).

- **Before 1.0: the draft releases.** Any 0.x minor release could change the contract, compatible or not; the changelog records what changed and what an app had to do. A patch (0.7.0 to 0.7.1) never changed the contract.
- **From 1.0: what breaks.** A change that can make a party that conforms to N.x fail at N.y, or misbehave against a peer at N.y, is breaking and needs a new major version: a key made required; a tool, route or event removed or renamed; an input narrowed or a result widened; a new MUST on an existing party; a code changed; a state transition changed. A minor version only adds what every reader already ignores ([reading what you do not know](#reading-what-you-do-not-know)): an optional key, a tool, an event, a profile, an error code, a SHOULD. Two additions are not that, and need a major version or a gate: a key inside an `mcp.endpoints` entry, or a path form outside the 0.11 grammar, since an older reader drops the whole entry and stops covering its URLs (a minor may add one only beside an entry older readers understand, which keeps covering them); and anything that narrows what a party may do. An older reader ignores a restricting key, so a narrowing is enforced only where the older party declares that it takes it, as an app takes the binding only when the hub's acknowledgement declares `binding` (0.12); without such a declaration it is a major version. A patch only clarifies the wording, fixes the reference software, or makes the conformance suite check a rule this page already states.
- **`standard` in `apc.json`** is the highest version whose rules the app meets. A hub or an agent **MUST NOT** refuse an app because its `standard` is an older minor version of the same major: it uses what that version defines. A `standard` that is a newer minor version of the reader's major is read by the rules the reader knows, ignoring the rest. A hub tells majors apart by the major version of that field.
- **Apps on 0.x when 1.0 ships.** 1.0 is 0.13 frozen under that number: an app on 0.13 claims 1.0 by changing only `standard`, once it has removed the temporary 0.12 fallback, which this release ends. A 1.x hub **MUST** keep confirming and relaying **existing** pairings of apps that claim 0.10 to 0.12 for at least six months after 1.0. A **new** Dock first pairing requires 0.13; the hard cut is enforced regardless of the app's claimed version. The reference hub counts each app's claimed `standard`. A 1.0 hub does not support apps below 0.10.
- **The previous major.** When a new major version ships, the reference hub keeps serving apps of the previous one for at least 12 months.
- **Deprecation (normative from 1.0).** Something to be removed or changed incompatibly **MUST** first be marked deprecated in a minor release, in the changelog and on this page, and keep working for at least one more minor release **and** at least 3 months, whichever is longer, before a major release removes it. A security fix may shorten that window; the changelog then says why, and the conformance suite gets its check in the same release.
- **The conformance suite.** At 0.x it checks a claim from 0.5.0 up to its own, passes a newer patch of its own minor with a note, and fails a newer minor. From 1.0, the suite at N.y checks a claim of any N.x up to N.y, passes a claim of a newer minor of N with a note (checking it by N.y's rules), fails a claim of another major and names the suite to use, and keeps checking existing-pairing claims from 0.10 up, labelled "pre-1.0". Dock first-pairing conformance has a floor of 0.13.

Comments on this policy, and any proposal to change the contract, go in a [contract change issue](https://github.com/tineira/agent-pointed-context/issues/new?template=contract-change.md).

## Licence

The text of this specification and of these docs is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), like the paper: you may share and adapt it with credit to "Agent Pointed Context, apc.tineira.com". The code (`@tineira/apc-*`, the examples, the reference apps) is [MIT](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE). See [LICENSE-spec](https://github.com/tineira/agent-pointed-context/blob/main/LICENSE-spec).
