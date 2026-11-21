# Agent Pointed Context

Agent Pointed Context (APC) is an open standard for pointing your own AI agent at what you see in an app, a chart, a row or a paragraph, and asking about "this", without sharing your screen. The app tells the agent *what* you pointed at, as identifiers; the agent reads it through the app's own tools, under the access you gave it. No screenshots, no pixels, no free text travel.

## The idea in three channels

An app that speaks APC gives every agent connected to it over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) three small channels. They carry identifiers and keys only, never content:

- **The view**: the screen you are on, as identifiers (a screen name, the period and filters, at most one selected row).
- **The pin**: you drag your agent's mark onto something on the page. The app keeps that pin for the agent and gives it, with the exact tool call that reads it (`next` and `next_args`), on the agent's next tool result, or at once to an agent waiting for it.
- **Presence**: your agent is a mark on the page, and the things it reads light up, so you see what it looked at.

Because it is your own agent, it already knows what the app does not: your files, your other tools, your memory. It joins them in your conversation; the app never sees them.

## How an agent connects

Your agent connects to each app's own MCP address, one per app, and you point it by dragging its mark from the app's agent bar. The data goes from the app straight to your agent: nothing sits in between. An app makes one address per agent, lists your agents in its own page, and cuts one off at once when you revoke it there.

On a phone there is nothing to drag from, so every app shows its agents in its own page, and a finger pins with a tap.

`apc.json` names the ways an app accepts agents in `profiles`, an open list. APC defines `"direct"`, the one above. A profile it does not define, such as the Dock's `"dock"`, is specified by whoever defines it, in a document of its own.

You can try it at [apc.tineira.com](/try): connect your agent to Pulse and Signals, the two demo apps.

## Who it is for

- **App makers** who want people to bring their own agent to their product, without building a chat or shipping their data to a model. The [integration guide](/docs/integrate) gets an app working in an afternoon with four small packages, and the [conformance suite](/docs/conformance) checks it.
- **Agent and client makers**: an APC app is an ordinary remote MCP server with two extra tools and a few keys on results. [For agents](/docs/agents) says what an agent sees.
- **People who use agents**: you keep your agent, your subscription and your context; each app gives it only what you point at, and you can cut it off from the app at any time.

## Where to read next

- [The spec](/docs/spec): the core, how agents connect, `apc.json`, untrusted marking, and how versions work.
- [Integrate your app in an afternoon](/docs/integrate): with code that compiles against the packages.
- [The UX guide](/docs/ux): how the reference software shows agents in a page (the pet, the pin badge). Non-normative.
- [Conformance](/docs/conformance): what the suite checks, and how to run it.
- [For agents](/docs/agents): instructions, tools, `then`, `attention`, and untrusted marking.
- [The standard's changelog](/docs/changelog): every change to the contract, version by version.

## A frozen standard, in the open

The standard is frozen and changes only by the [versioning and compatibility policy](/docs/spec#versioning-and-compatibility), and these docs name the version they describe. 2.0 is the interaction standard alone: the connection half that 1.1 to 1.3 marked moved, word for word, to the Dock protocol, which binds every party that implements the Dock. The code is at [github.com/tineira/agent-pointed-context](https://github.com/tineira/agent-pointed-context) (MIT); these docs and the spec are CC BY 4.0. To propose a change to the contract, open a [contract change issue](https://github.com/tineira/agent-pointed-context/issues/new?template=contract-change.md).

APC started with a paper, *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen* ([doi:10.5281/zenodo.23382909](https://doi.org/10.5281/zenodo.23382909)), with its [design records and payload specification](https://doi.org/10.5281/zenodo.23383101). The demo it describes is kept as it was, as [version 1](/v1/).
