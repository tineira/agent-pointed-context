# Agent Pointed Context

Agent Pointed Context (APC) is an open standard for pointing your own AI agent at what you see in an app, a chart, a row or a paragraph, and asking about "this", without sharing your screen. The app tells the agent *what* you pointed at, as identifiers; the agent reads it through the app's own tools, under the access you gave it. No screenshots, no pixels, no free text travel.

## The idea in three channels

An app that speaks APC gives every agent connected to it over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) three small channels. They carry identifiers and keys only, never content:

- **The view**: the screen you are on, as identifiers (a screen name, the period and filters, at most one selected row).
- **The pin**: you drag your agent's mark onto something on the page. The app keeps that pin for the agent and gives it, with the exact tool call that reads it (`next` and `next_args`), on the agent's next tool result, or at once to an agent waiting for it.
- **Presence**: your agent is a mark on the page, and the things it reads light up, so you see what it looked at.

Because it is your own agent, it already knows what the app does not: your files, your other tools, your memory. It joins them in your conversation; the app never sees them.

## Two ways to connect

An app offers one profile or both. The core (the three channels, the two APC tools, revoke) is the same on each.

| | Direct | Dock |
|---|---|---|
| Your agent connects to | the app's own MCP URL, one per app | your agent dock, once |
| You point it by | dragging its mark from the app's agent bar | dragging it from your dock onto any app you paired |
| The data goes | from the app to your agent | from the app through your dock to your agent |
| Good for | one app, no third party in the path | one agent that follows you across apps |

On a phone there is nothing to drag from, so every app shows its agents in its own page, and a finger pins with a tap.

You can try both at [apc.tineira.com](/): open your [dock](/dock), or connect directly to Signals, one of the two demo apps.

## Who it is for

- **App makers** who want people to bring their own agent to their product, without building a chat or shipping their data to a model. The [integration guide](/docs/integrate) gets an app working in an afternoon with three small packages, and the [conformance suite](/docs/conformance) checks it.
- **Agent and client makers**: an APC app is an ordinary remote MCP server with two extra tools and a few keys on results. [For agents](/docs/agents) says what an agent sees.
- **People who use agents**: you keep your agent, your subscription and your context; each app gives it only what you point at, and you can cut it off from the app at any time.

## Where to read next

- [The spec](/docs/spec): the core, the two profiles, `apc_link`, `apc.json`, the hub's trust model, and how versions work.
- [Integrate your app in an afternoon](/docs/integrate): Direct first, then Dock, with code that compiles against the packages.
- [Conformance](/docs/conformance): what the suite checks, and how to run it.
- [For agents](/docs/agents): instructions, tools, `then`, `attention`, and untrusted marking.
- [The standard's changelog](/docs/changelog): every change to the contract, version by version.

## A draft, in the open

The standard is a 0.x draft: anything may still change, and 1.0 will freeze the contract. The code is at [github.com/tineira/agent-pointed-context](https://github.com/tineira/agent-pointed-context) (MIT); these docs and the spec are CC BY 4.0. To propose a change to the contract, open a [contract change issue](https://github.com/tineira/agent-pointed-context/issues/new?template=contract-change.md).

APC started with a paper, *Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen* ([doi:10.5281/zenodo.23382909](https://doi.org/10.5281/zenodo.23382909)), with its [design records and payload specification](https://doi.org/10.5281/zenodo.23383101). The demo it describes is kept as it was, as [version 1](/v1/).
