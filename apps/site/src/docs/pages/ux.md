# The APC UX guide (non-normative)

How the reference software shows agents in a page, and why: the pet, the header, the pin badge, the states, motion, colour, phones and the pairing cards. Nothing here is checked by the [conformance suite](/docs/conformance) or required to interoperate: the words **MUST** and **SHOULD** do not bind in this guide, and an app that draws its agents another way is as conformant as one that follows it. [`@tineira/apc-web`](https://github.com/tineira/agent-pointed-context/tree/main/packages/web) is the reference implementation of every pattern below (`<apc-pets>`, `<apc-pet>`, `<apc-pin>`, `<apc-handoff>`, `enablePinning`), so most of this guide is what the package already does for an app that uses it. [Integrate](/docs/integrate) shows it wired into a page.

## What this guide is

Presentation moved out of [the spec](/docs/spec) so that the contract holds only what interoperability and security depend on. Some presentation rules stayed in the spec, with their force words, because something else relies on them. Whatever you draw, [the spec](/docs/spec#the-agent-in-the-page) binds you to these:

- **Marks carry `data-apc-mark` and `data-grant`.** A pet, a pin badge and the bar's mark are what the person drags (or taps, then a target) to point an agent, `enablePinning` finds them by those attributes, and the browser extension steps back from an APC app by them.
- **A state is shown only when the app's data says so.** Never guessed from timing, and `waiting` only from the wait signal ([states](#states)).
- **A logo says which agent is connected, never that it is verified.** No vendor's mascot is drawn ([logos](#logos)).
- **Revoke is in the agent bar, and the bar is never collapsed or hidden while it shows a Direct agent.**
- **On a phone the agents are in the page and a finger can pin and unpin.** Mobile is interoperability, not presentation: the conformance suite checks it ([phones](#phones), [Mobile](/docs/spec#mobile)). A desktop-only app says `"mobile": false` in its `apc.json` instead (since 1.4).

The pairing rules that look like screen rules but are security rules (the code is shown only on the app owner's page, the dock names the app's host on a request, the consent names the hub's host, an unverified app's warning names the domain first and defaults to Deny, what an unverified app gives is marked untrusted) are in the spec too, in [the Dock profile](/docs/spec#the-dock-profile) and [the hub's trust model](/docs/spec#the-hubs-trust-model).

## The agent in the page

How an app shows each connected agent inside its page. An app may keep its own mark for agents; one that shows a pet is better off showing this one, the character the dock draws, so a person sees the same agent everywhere.

- **The pet.** One character for every agent: a soft blob with two eyes, with the agent's logo as a badge at its bottom right. It is APC's own, drawn in SVG; no vendor's character is drawn or animated, so the character is the same for every agent and only the logo says whose it is.
- **The header.** The pets sit in the app's header, next to the person's account, up to 3 of them, then one button: "+N" for the rest, or a list button when all show.
- **The popover.** That button opens a popover with every agent: what it is doing, where its pin is (a click goes there) and whether it read it. A pet whose pin is on another page wears a dot. The app's own links ("Manage agents") go at its foot.
- **A pet is only a mark.** A click, a tap or Enter on a pet is pinning's (it arms the agent), never the popover's, so the popover never covers the target the person is about to tap. That is why only the list button opens it.

<!-- include orders-page.ts#pets -->

`<apc-pets>` is a custom element in light DOM, so the app's fonts and theme apply, and it is framework-agnostic: set `agents`, listen for `apc-open`. A lone pet anywhere else is `createPet({ state, badge, label })` or `<apc-pet>`.

## Pin badges

Where an agent is pinned, the element wears the agent's logo, with × to unpin: `<apc-pin>`. It shows a dashed, breathing ring while the agent has not read the pin and a check once it has, with the agent's name as its tooltip. Where it goes is the app's: Pulse floats badges over their targets, Signals puts them inline.

<!-- include ux-snippets.ts#pin -->

- **Several agents on one element each keep a badge**, side by side, so every × stays reachable. `pinStackIndex` gives each badge its place and `PIN_STACK_STEP` (30 px), or `PIN_STACK_STEP_TOUCH` (72 px) on touch, is the step.
- **On touch the × sits beside the mark, never over it**, so a tap on the mark never unpins.
- **The badge is a mark** (`data-apc-mark`, `data-grant`), so dragging it onto another target moves the pin with no code in the app. It dims while dragged, until the drop or Esc.
- **An armed mark** (the person tapped it, and now taps a target) wears `data-armed="true"` and `aria-pressed="true"`, on every mark of that agent: a pet, a badge and a bar mark. Style it with `[data-armed]`.

## States

A pet has 8 states. The app drives each one from data it has, and shows a state only when that data says so; **nothing is guessed from timing**. A pet that shows what the page cannot know is worse than one that shows nothing.

| State | What drives it in an app |
|---|---|
| `dragging` | the person is dragging this agent's mark, in this page |
| `pairing` | a pairing request of this agent waits on the person |
| `offline` | no agent client is connected on the grant, or the grant was revoked |
| `pinned` | the agent's pin is unread |
| `calling` | a call is in flight, or the page just heard one (presence) |
| `read` | the agent just read its pin (shown for 6 s, `READ_HOLD_MS`) |
| `waiting` | a `wait_for_focus` of this agent is open, as the page-readable wait signal says. Never inferred from how recently the agent called |
| `idle` | connected, and none of the above |

The first state that holds, top to bottom, is shown (`petState`). A field you leave out of `petState` stays at its default, so a pet never shows a wait your page cannot see. Pass `waiting` only once your page reads the wait events: `foldWaitEvent` and `waitOpen` turn them into "a wait is open now", and an `open` runs out at the app's ceiling plus `WAIT_EVENT_MARGIN_S` if its `closed` never comes ([wait events](/docs/spec#wait-events-since-011) hold the rule). A dock agent waits on the hub, not on the app, so a page never shows one as waiting; the dock shows its own agents' waits itself, from the hub's place for each.

`READ_HOLD_MS` exists because an app keeps a read pin until a new one comes: without a hold, the pet would stay on "read" for as long as the pin.

## Motion

One `requestAnimationFrame` loop per window drives every pet in it, with no render per frame. It stops while the page is hidden, and slows down (20 frames a second) once every pet has kept its state for 10 s. With `prefers-reduced-motion: reduce`, each pet is a still pose of its state: no hopping, orbiting, breathing or wobble. This is energy and accessibility guidance; the package does it for you.

## Colour and theming

The pet follows the page's colour scheme.

- On a light page, the light pet: a dark body with a white outline and eyes.
- On a dark page, the inverse pet: a near-white body (not pure white), a dark outline and eyes, and a shine tuned to the light body.
- The badge's white disc keeps a thin outline in the inverse pet, so it reads on both bodies. The orange ring, the "!" and the other state marks do not change.
- `scheme = "light" | "dark" | "auto"`: `auto` follows `prefers-color-scheme`; an app with its own theme switch passes its theme. An app with a strict palette tints the body and the line (`tint`, `{ body, line }` in hex, or `--apc-pet-body` and `--apc-pet-line`).
- **Size.** `--apc-pets-size` (36 px by default) sizes the pets, each of which stays a 44 px target; a lone pet takes `size` or `--apc-pet-size`.
- The popover, the badge and the cards take the app's colours from `--apc-chip`, `--apc-line`, `--apc-ink`, `--apc-muted` and `--apc-accent`.

### Logos

A badge is the brand's logo (`brandFor` the client's declared name), else the icon the client sent, else a neutral mark in a colour of the agent's own: `agentBadge({ clientName, icon, key })` does it. Brands only: never a vendor's mascot. A logo says which agent is connected, never that it is verified; the client's name is the client's own claim.

## Phones

The rule that matters is the spec's [Mobile](/docs/spec#mobile): the agents are in the page, never collapsed or hidden, and a finger can pin, unpin and Revoke. The rest is how the reference does it, and what to check in your own layout at `APC_MOBILE_VIEWPORT` (375 × 812):

- **The header.** Under `APC_MOBILE_MEDIA` the pets stay in the header, side by side with no overlap.
- **Targets.** Every tap target (a pet, the list button, ×, the popover's links) is at least 44 px. That is one implementation of "finger-sized".
- **The bar.** `<apc-agents>` stays in the page, uncollapsed, at the bottom of the viewport: reachable while the page scrolls, without covering the content a person is about to point at.
- **Tap to pin.** Tap the agent's mark, then the target. Say what to do while an agent is armed ("Tap what you want Claude to look at") and give a way to cancel. `createTapPin` is the same state machine without the note, for a page that draws its own.

<!-- include ux-snippets.ts#tap -->

Check the page with touch emulation, as `scripts/mobile-e2e.mjs` does for Pulse and Signals, or give the suite's `page.mobile` adapter ([conformance](/docs/conformance#run-it-from-code)).

**A desktop-only app** (`"mobile": false` with a claim of 1.4.0 or later) skips all of this. Opened on a phone anyway, it says so in one line beside the bar, for example "Pointing an agent needs a larger screen.". The bar itself stays: while it shows a Direct agent it is never collapsed or hidden, whatever the width, and Revoke stays in it.

## Pairing and consent cards

What the person sees from the drop to the dock's yes. The mechanics (the nonce, the code, the hub call) are the spec's, in [the Dock profile](/docs/spec#the-dock-profile); this is how the reference apps present them.

### The consent card

The page shows the consent when the server answers `consent_required`: "Let your agent from the dock at *host* read *Orders*?" The host is the hub origin from the drag payload, which is the hub the app will call, so the person sees which dock is asking (the spec's [consent](/docs/spec#consent-in-the-app) says the consent should name it). Before the Allow it says only that the dock will ask for a code: "After Allow, your dock will ask for a code." The code is not shown yet. These are example words; the app's own are as good.

### The handoff card

After the Allow, the code is the one thing the person carries to another window, so the reference shows it in a card that takes the consent's place (`<apc-handoff>`):

- the code **large**, in a monospaced face, formatted `K7M-4P2` (`formatPairingCode`), with a **copy** button;
- the time left, as `m:ss`;
- **Cancel**, which takes the access back (the app's revoke);
- under the code, the sentence the spec's [pairing code](/docs/spec#the-pairing-code) asks for, in the reference's words: "Type it only in your own dock; never give it to anyone. Whoever types it gets this access." (`HandoffStrings.typeItOnlyInYourDock`; the rule is the spec's, only the words are the guide's);
- and "If your dock doesn't ask for this code, the agent wasn't yours: Cancel."

<!-- include ux-snippets.ts#handoff -->

The card follows the **app's stored expiry**: the countdown stops at zero, the code goes, and it says the dock did not finish in time. It offers no "New code": a new code needs a new consent, so it asks the person to drop the agent again. Once the dock took the code and is connecting, it says so and hides the code (set `pairing` to `null`). A page that holds a code before it knows when it ends shows no countdown, never a guessed one.

### The dock's warning

An unverified app's request shows the dock's own warning, which an app's page cannot draw (the dock is the hub's page). The spec fixes what it says ([the warning](/docs/spec#the-warning)): the **domain first**, **Not verified**, what the app calls itself as its own word ("calls itself *Orders*"), the risk (your agent will read whatever this app tells it, which could lead it to move data out of your other apps), and **Deny** as the default button. Only placement and weight are layout, and they are the dock's choice.

### Notes when a drop cannot pair

A dock agent dropped on a page that offers Direct only is answered, never lost: the page says it connects agents directly, with its connect page. The protocol exports the reference sentence (`directOnlyNote(appName)`), and `couldNotCheckNote` for a page that could not read its own `apc.json` (it pairs nothing). Pass `directOnlyNote` and `couldNotCheckNote` in `PinningStrings` for your own words, or handle `onDockUnsupported` yourself.

## Presence feedback

The page lights up what the agent read. `flashTargets(event, initials)` marks each element a presence event named with `data-apc-presence` (`read`, dotted; `write`, solid) and the agent's initials, for four seconds, and ignores a wait event. The page's event stream carries the revoke too: both reference apps broadcast an event when a grant ends, so every tab and device drops the agent's mark without a reload. The waiting indicator comes from the wait events, never from `flashTargets`.

<!-- include orders-page.ts#events -->

## On any page: the extension's outline

With the APC browser extension the person can drop a dock agent on any web page. While they drag, the extension outlines what the drop would read: a block of text, a form's question or a whole form. What is inside the outline, with the person's selection, is what the agent gets, and only on the drop ([the spec](/docs/spec#the-browser-extension)). Once sent, the agent's mark stays pinned beside the paragraph with a pin badge like the one above.

## Words and localization

`@tineira/apc-web` draws words, and every one is a key an app can pass, so no fork is needed. Each component takes one `strings` object (`BarStrings`, `PetsStrings`, `PinStrings`, `DirectStrings`, `PinningStrings`, `HandoffStrings`); a key you leave out stays English. Names, counts and labels are functions, so no sentence is built from English fragments and the plural forms are yours; tooltips and `aria-label`s are strings too. [Integrate](/docs/integrate#localize-the-page) has the whole list and a Spanish example. The symbols (×, ⊘, ‹, !, ✓) and what the app passes in stay as they are. Localizing changes no protocol text, the tools or conformance.

## Accessibility

- **Marks announce their state.** An armed mark wears `aria-pressed="true"`, so a screen reader says the agent is selected; the popover's list button is a real button.
- **Focus.** A pet takes Enter to arm the agent (never to open the popover); the popover updates in place, so focus and a press inside it survive the app setting `agents` again on every presence event. The handoff card can move focus into itself when it appears (`autoFocus`), to the copy button or to Cancel once there is no code, as a dialog needs.
- **Contrast.** A tinted pet keeps its outline and eyes readable on the app's background: check `tint` on both schemes you ship.
- **Targets.** Finger-sized, 44 px, wherever the page may be touched.
- **Motion.** `prefers-reduced-motion: reduce` gives still poses ([motion](#motion)).
