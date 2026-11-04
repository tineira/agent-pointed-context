# @tineira/apc-web

Agent Pointed Context (APC) for an app's page, in the browser: the person drags their agent's mark onto anything marked with `data-focus` (or taps it, on a phone) and the agent gets that as its focus. With the agent bar `<apc-agents>` (Revoke, Unlink, paths), the pin badge `<apc-pin>`, presence flashes, view reporting and the Direct agents list `<apc-direct-agents>`. Browser code with no Node imports; ESM for any bundler. Docs: https://apc.tineira.com/docs

## Install

```sh
npm i @tineira/apc-web@next @tineira/apc-protocol@next
```

Pre-releases go out on the `next` tag while the standard is 0.x.

## Example

Mark what can be pointed at, and let the person pin their agent to it:

```tsx
import { focusAttrs } from "@tineira/apc-protocol";
import { defineAgentBar, enablePinning } from "@tineira/apc-web";

<tr {...focusAttrs({ kind: "customer", id: "cus_0042" })}>…</tr>
<g {...focusAttrs({ kind: "figure", params: { key: "active_customers", month: "2026-03" } })}>…</g>

defineAgentBar(); // <apc-agents> shows the person's agents, with Revoke
const stop = enablePinning({ onPin: (grantId, target) => savePin(grantId, target) });
```

`onPin` gets the agent's grant and a `FocusTarget` (`{ kind, id, part, params }`); your server keeps it as that grant's pin and gives it to the agent ([`@tineira/apc-server`](https://www.npmjs.com/package/@tineira/apc-server)).

Source, the worked examples (Pulse and Signals) and the changelog: https://github.com/tineira/agent-pointed-context. MIT.
