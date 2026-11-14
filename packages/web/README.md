# @tineira/apc-web

Agent Pointed Context (APC) for an app's page, in the browser: the person drags their agent's mark onto anything marked with `data-focus` (or taps it, on a phone) and the agent gets that as its focus. With the agent bar `<apc-agents>` (Revoke, Unlink, paths), the pin badge `<apc-pin>`, presence flashes, view reporting, the Direct agents list `<apc-direct-agents>`, and the agent in the page: the APC pet (`createPet`, `<apc-pet>`), the header pets `<apc-pets>` and the brand logos. Browser code with no Node imports; ESM for any bundler. Docs: https://apc.tineira.com/docs

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

Whether an agent is listening now (APC 0.11): fold each presence message into `foldWaitEvent(openWaits, message)`, and ask `waitOpen(openWaits, grantId, { path })`. It is true only between a wait's `open` and `closed`, stops after the app's ceiling plus 10 s if a `closed` never came, and is never true for a dock grant.

Every string it draws can be passed by your app (`strings` on each component; see "Localize the page" in the docs), with the English as default.

Source, the worked examples (Pulse and Signals) and the changelog: https://github.com/tineira/agent-pointed-context. MIT.
