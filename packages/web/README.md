# @tineira/apc-web

Agent Pointed Context (APC) for an app's page, in the browser: the person drags their agent's mark onto anything marked with `data-focus` (or taps it, on a phone) and the agent gets that as its focus. With the agent bar `<apc-agents>` (Revoke, Unlink, paths), the pin badge `<apc-pin>`, presence flashes, view reporting, the Direct agents list `<apc-direct-agents>`, and the agent in the page: the APC pet (`createPet`, `<apc-pet>`), the header pets `<apc-pets>` and the brand logos. Browser code with no Node imports; ESM for any bundler. Docs: https://apc.tineira.com/docs

## Install

```sh
npm i @tineira/apc-web @tineira/apc-protocol
```

Its minor version is the standard's: 0.N.x ships APC 0.N (`APC_STANDARD_VERSION`), and a patch never changes the contract. Install the `@tineira/apc-*` packages at the same version.

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

## On a phone, and `page.mobile` in the conformance adapter

On a phone (APC 0.6, the reference viewport `APC_MOBILE_VIEWPORT`, 375 x 812) `<apc-agents>` stays in the page, uncollapsed, at the bottom of the viewport, and `enablePinning` turns a tap on a mark, then a tap on a target, into a pin. Two pieces of that are exported, so an app's own test can model its phone page with the same rules: `barCanCollapse(agents, mobile)` (false on a phone, always) and `createTapPin({ onPin })` (the tap-to-pin controller `enablePinning` runs: `toggle(grantId)` arms an agent, `tap({ element, target })` pins it and answers `"pinned"`).

[`@tineira/apc-conformance`](https://www.npmjs.com/package/@tineira/apc-conformance) checks the mobile rule through the adapter's `page.mobile` (`ApcMobilePage`), required of an app that claims 0.6.0 or later. With these two pieces, and your server's own pin routes:

```ts
import { barCanCollapse, createTapPin, type BarAgent } from "@tineira/apc-web";

const mobile = {
  // Which agents' marks the page shows, and whether the person could collapse the bar there.
  async agentBar() {
    const bar: BarAgent[] = (await myAgents()).map((a) => ({ id: a.grantId, name: a.name, state: "idle" }));
    return { visible: bar.map((a) => a.id), collapsible: barCanCollapse(bar, true) };
  },
  // A finger: tap the agent's mark, then the target. True once your server took the pin.
  async pinByTouch(grantId, target) {
    let saved: Promise<boolean> = Promise.resolve(false);
    const tap = createTapPin({ onPin: (id, t) => void (saved = savePin(id, t)) });
    tap.toggle(grantId);
    return tap.tap({ element: document.body, target }) === "pinned" && (await saved);
  },
  // The × beside the agent in the bar.
  unpinByTouch: (grantId) => removePin(grantId),
};
// apcConformance({ …, page: { setOpen, showView, pin, takePresence, revoke, mobile } })
```

It exercises the package's rules on a model of your bar, not your real page: a browser with touch emulation at 375 x 812 is the real check. The docs' complete Direct app (https://apc.tineira.com/docs/integrate#a-complete-direct-app-with-a-bearer-token) shows it in a whole adapter.

## Localize

Every string it draws can be passed by your app (`strings` on each component; see "Localize the page" in the docs), with the English as default.

Source, the worked examples (Pulse and Signals) and the changelog: https://github.com/tineira/agent-pointed-context. MIT.
