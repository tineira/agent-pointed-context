---
name: Contract change
about: Propose a change to the APC standard (the contract between apps, agents and docks)
title: "Contract change: "
---

<!--
The contract is what apc.tineira.com/docs/spec describes and @apc/protocol types: the view, the pin and the focus
format, presence, the tools, the drag payload, pairing, apc_link, apc.json, revoke. The standard is a 0.x draft:
changes are welcome, and each one gets an entry in packages/protocol/CHANGELOG.md and a new version.
-->

## What changes

<!-- The change to the contract, as precisely as you can: fields, tools, endpoints, error codes, rules. -->

## Why

<!-- The problem it solves, for whom (app makers, agents, docks, the person), and what happens today. -->

## Which profile

- [ ] The core (every app)
- [ ] Direct
- [ ] Dock (apps and hubs)
- [ ] `apc_link`
- [ ] `apc.json`
- [ ] The hub's trust model

## Compatibility

<!--
Does an app, agent or hub built on the current version keep working? If not, what breaks and how they migrate.
Should it be optional at first (a new key a reader may ignore), deprecated first, or a breaking change?
See "Versioning and deprecation" at apc.tineira.com/docs/spec.
-->

## Test plan

<!-- How the conformance suite (@apc/conformance) or the reference apps would show it holds: new or changed checks. -->
