# Proposal: the APC standard's site, desktop redesign (lane A, round 3)

## Summary

- **Verdict:** keep the stage as the centerpiece and make it behave exactly as the reference apps do: the pet lives in the agent bar, a drop leaves a pin badge on the bar, and the thing that travels (and fades to black) is the focus message, not the agent.
- **The main change:** after the visitor's second pin, a large panel opens inside the stage, "Now use your own agent", with Pulse's MCP address; once an agent is connected the next drop goes to it, on the same page, and Try it opens with Pulse already connected.
- **What stays:** Pulse's real data and answers in the demo, both themes and the moving field, "Works with", "Inside a point.", "Your agent. Your permission.", the Build it page, "Free, open and versioned", every remaining locked link, the strict CSP.
- **The biggest risk:** the hero becomes a second front end for Pulse (its data now, its sandbox and connect flow later), so it can drift from the real app unless it is built from Pulse's own code and `@tineira/apc-web`'s own agent bar and badge.
- **Open questions:** where the visitor's Pulse sandbox lives and how the stage learns an agent connected; whether the self-play stays; where Autio and the Dock return, now that "In use" is out; whether the theme choice is remembered; the real Pulse and Signals glyphs.

## Goals and non-goals

**Goals**

1. A first-time visitor understands "drag your agent onto something and ask about this" within ten seconds, without reading, and can do it themselves within thirty.
2. The visitor sees what a pin is: the bar wears the agent's badge, a small message leaves for the agent, and the answer holds facts that are not on the screen. The site's pet and badge behave as the ones in the apps do.
3. The step from watching to doing happens in place: after two pins the stage itself offers "Now use your own agent", and the connection carries over to Try it.
4. The two audiences part ways directly after the hero. Build it is one calm page: a short list beside the real payload.
5. The site reads well in light and in dark, follows the system, and keeps the field behind the content in both.
6. Everything is buildable from first-party files under the existing CSP.

**Non-goals**

- Phones and tablets (the layout is fixed at 1200 px and up).
- A design system, tokens file or component library.
- Any change to the docs pages, to `/v1/`, to the demo apps or to the standard.
- Pricing, sign-up, accounts, new adopters, testimonials.
- A working connection in the prototype: "Use your own agent" is a mock, and says so.

## IA map

```
/            Landing
             ├─ Nav: Try it · Build it · Docs · Spec · GitHub     [theme] [Add APC to your app] [Try the demo]
             ├─ Hero: headline, lede, two CTAs, full video link  |  the stage
             │        demo (default) → after two pins: "Now use your own agent" → connected (mock)
             ├─ Works with: Claude · ChatGPT · Cursor · Grok · any agent that accepts a remote MCP server
             ├─ Two paths: Try it (→ /try) · Build it (→ /build)
             ├─ How it works, "Inside a point.": View · Pin · Presence
             ├─ Access and privacy, "Your agent. Your permission.": three rows
             ├─ The standard: spec · code · conformance · paper
             ├─ Closing CTA
             └─ Footer: Start · Standard · Research and code
/try         Try it (starts with Pulse connected, if the visitor connected in the hero)
             ├─ Title, lede, one CTA (Open Pulse and connect your agent)
             ├─ Four steps  |  Pulse — your agent — Signals
             ├─ The starter question (two moves)
             └─ Revoke note
/build       Build it (reworked)
             ├─ "Try the demo first", title, lede, CTAs (Integration guide, Spec)
             ├─ What to implement (four rows)  |  What the agent receives (the real payload)
             ├─ Packages
             └─ Guide links and the license line
```

Routes, titles and redirects are unchanged from `site-pages.ts`. In the prototype the three pages are views of one `index.html` (`#/`, `#/try`, `#/build`), switched from the nav, the CTAs or the small "proto" bar.

## Section-by-section spec

Widths: content column `min(1240px, 100vw − 80px)`; designed at 1440, checked at 1280.

### Nav (sticky, 64 px)
Brand, five links, a 36 px theme toggle (moon in dark, sun in light), two buttons. Translucent, with a backdrop blur.

### Hero (two columns, 430 px + rest)
- **Left:** mono eyebrow, the headline at 66 px with "what you see." in the accent, the lede (unchanged), "Try the demo", "Add APC to your app", a text link to the full video. "Works with" moved out, to its own strip.
- **Right, the stage:** a framed pair of windows, 520 px tall.

**The app window (paper), "pulse · overview".** A bar chart of **active customers per month**, October 2025 to May 2026, the figure `active_customers`. Bar heights are `values.active` from Pulse over a fixed scale of 140, from a zero baseline; two dashed lines mark 50 and 100. No value is printed on the chart. Under it, the app's agent bar with the mark's resting slot.

**The agent window (ink).** In the demo state it is the visitor's agent's chat. Its title bar carries the quiet control "Use your own agent".

**The pet, the badge and presence (as in `@tineira/apc-web`).**
- *The pet lives in the agent bar.* It is only a mark: the visitor drags it onto a bar, or presses a bar (the tap path, and the keyboard path).
- *On the drop the pet goes back to the bar*, and the bar wears a **pin badge** that floats over its top: the agent's logo in a small disc, with a dashed, breathing ring while the agent has not read the pin, and a green check once it has. A × on hover unpins.
- *The badge is a mark too:* dragging it onto another bar moves the pin; dropped anywhere else it returns to its bar.
- *Presence:* the bar the agent reads pulses.
The mark never fades and never leaves. Round 2's "mark fades to black" and its "away" state are gone.

**The focus message.** In reality the focus travels underneath and nobody sees it; the demo shows it once per pin. About half a second after the drop a small dark card with the focus (kind, month, `next`) lifts off the pinned bar, floats to the agent window and, as it crosses the window's edge, **fades to black and disappears**. The window's border flashes once. Then the window shows what happened.

**Demo state, after the message arrives:** the question "What's behind this bar?" types in → `get_current_view` → the focus card (that month's real payload; four keys shown, six behind a toggle, `next` and `next_args` highlighted) → `get_figure` → the bar pulses and the badge turns from dashed ring to check → the answer, as in round 2: active customers and total seats, the mix by plan and by region, the customer with the most seats and the runner-up, the change against the month before. All of it from `context/pulse/pulse-hero-data.json`; nothing the file does not hold.

**After two pins: "Now use your own agent".** The page counts the visitor's own pins (drag, click or keyboard; another bar or the same one). The self-play on load does not count. After the second pin's answer, a large panel opens **inside the stage frame, across its full width**, under the two windows (the windows shrink from 520 to 440 px and the View · Pin · Presence rail gives way, so the hero still fits a 900 px screen):
- left: "Your turn", the heading "Now use your own agent." and one sentence: add Pulse to your agent as a remote MCP server; the next drop goes to your agent, right here;
- right: "Pulse's MCP address, for you · a placeholder" (`https://pulse.apc.tineira.com/mcp/…`) with Copy; "Or copy a prompt that asks your agent to add it"; "Waiting for an agent to connect"; and the dashed, proto-only "Simulate: Claude connected".
The demo keeps working while the panel is open. The small "Use your own agent" control in the agent window's title bar stays as a shortcut that opens the same panel. No account, no sign-up, no price, no form field.

**Connected state (mock).** The pet in the agent bar becomes Claude's (its logo on a light disc), the bar reads "Claude, connected to Pulse", and the panel shrinks to one line: a check, "Claude is connected to Pulse. The next drop goes to Claude.", "Go on with Signals →" (to Try it) and Revoke. A drop pins the bar with **Claude's badge** (dashed ring), the message travels and fades to black, and the agent window (now "pulse · agents") shows: "Sent to Claude. Now ask it: What is this?"; the focus that was sent; under "Claude is reading · simulated", `get_current_view`, then `get_figure` with that month's `next_args`; the bar pulses and the badge turns to a check when `get_figure` is read; and last, "The answer is in Claude, in your own chat. It never appears on this page." No answer is shown.

**Kept across views and a reload.** The connected state (the agent's name, and whether it has pinned) is one `sessionStorage` entry. Revoke, or "Clear it" on Try it, removes it.

**Under the stage:** the View · Pin · Presence rail, each lighting at its moment, and one line: "Pulse's demo data: one made-up world. Nothing leaves this page." with Unpin and Replay. In the mock the line says it is a mock.

**First load:** after 1.3 s the pet drags itself to March once and returns to the bar; the badge, the message and the answer follow. Any interaction cancels the self-play.

### Works with (from lane D)
A ruled strip across the content column: the mono label, the four logos with names (Claude, ChatGPT, Cursor, Grok), and at the right, behind a rule, "and any agent that accepts a remote MCP server".

### Two paths
Unchanged: two equal cards, who each is for, a 44 px title, one paragraph, a text CTA; Pulse and Signals chips on one, the four packages on the other.

### How it works: "Inside a point." (from lane D)
A heading on the left and one sentence on the right, then one card in three columns: **View**, **Pin**, **Presence**. Each has a small line diagram (a window that emits "ids"; a bar with a dashed outline, the mark above it and a "next call" tag; three rows with the middle one lit and the mark beside it), a 26 px title and one or two sentences. An accent rule draws across the top of each column on reveal. This replaces round 1's sticky, scroll-driven App → wire → Agent scene: the wire format now shows only in the stage's focus card and on Build it.

### Access and privacy: "Your agent. Your permission." (from lane D)
A full-width band (graphite in light, a raised ink panel in dark): the heading on the left, three ruled rows on the right: only the item you point at; one connection per app; revoke in the app. This replaces round 1's four-cell bento and its Revoke toy.

### The standard, closing, footer
The "In use / Running in a real product" section is removed, with the Autio card and the Dock line; neither is named anywhere on the page now. "Free, open and versioned" (spec, code, conformance, paper) follows the access band directly. The closing mark and CTAs and the three-column footer are unchanged.

### Try it
Without a connection in the hero it is as in round 2: one CTA to Pulse's agents page, the four steps, Pulse — your agent — Signals, the starter question, the Revoke note.

When the visitor connected their agent in the hero (in the prototype: after "Simulate: Claude connected"), the same view opens **with Pulse already connected**, because the hero is the same Pulse in the same browser:
- the lede says the agent is already connected to Pulse and what comes next; the CTA becomes "Connect Claude to Signals" (Signals' connect panel), beside "Open your Pulse";
- the Pulse card has a green border, a check and "Claude connected", and its second link becomes "Your agents, and Revoke"; the Signals card says "not connected yet";
- steps 1 (Open Pulse) and 2 (Connect your agent) are checked and dimmed, "done in the hero"; step 3 (Point and ask) too, once the agent has pinned in the hero; the first open step is marked "start here", so the walk starts at Signals and the join;
- a small proto line says where the state came from, with "Clear it".

### Build it (lane D's approach)
Title "Make your app pointable.", a three-sentence lede, CTAs to the integration guide and the spec. Then two columns: on the left **What to implement**, four numbered, ruled rows (serve an MCP endpoint; make things pointable; publish `apc.json` and offer Revoke; pass the conformance suite), two sentences each; on the right, sticky, an ink card **What the agent receives**: the real focus from Pulse, pretty-printed, with one line saying what it is. Below: the four packages in a row, a row of guide links (Integration guide, Conformance suite, Docs, Spec, Payload specification, Paper, GitHub) and the license line. Round 1's four cards, hover notes, "How agents connect" list and the marked placeholder are gone.

## Motion spec

| What moves | How | Timing | Cost | Reduced motion |
|---|---|---|---|---|
| **Dot field** (fixed canvas) | A 30 px grid of dots drawn once to an offscreen canvas and blitted each frame; dots near the pointer or one slow wandering light are redrawn brighter. One palette per theme: white dots and amber glow on ink; graphite dots and burnt-orange glow on paper. Shifts by 25 % of scroll. | Continuous `requestAnimationFrame`; pointer glow fades 4 s after the last move. | One `drawImage` plus about 150 small `fillRect` per frame; DPR capped at 2; paused when the tab is hidden; redrawn once on a theme change. | Drawn once, static. |
| **Identifier tags** (in the field) | Every 2–4 s a dot in the outer 16 % of either side gets a ring and a faint mono label. | 5.2 s sine fade. | A few `fillText` per frame. | Off. |
| **Haze** | Two large radial gradients, `transform` only: amber and violet in dark; peach and warm yellow in light. | 46 s and 58 s, alternate. | Two composited layers. | Static. |
| **Hero self-play** | The pet follows a curve to March, returns to the bar, then the pin sequence runs. Not counted as one of the visitor's pins. | 1.3 s delay, 1.5 s drag, about 7 s sequence. | `transform` only. | No drag: the page opens pinned on March, badge checked, with the exchange shown. |
| **Hero drag** | Pointer capture; the mark follows; the hovered bar gets a dashed outline; a spring snap on drop. | Snap 0.5 s. | `transform` only. | Works; snap is instant. |
| **The pet returns; the badge** | On a drop the pet springs back to the agent bar and the badge pops in over the bar. Its dashed ring breathes (scale 1 to 1.14, opacity 1 to 0.4) until the read, then a check pops in. A dragged badge follows the pointer and springs to its bar. | Spring 0.5 s; pop 0.4 s; ring 2.2 s loop. | `transform` and `opacity` on two small elements. | No spring, no pop; the ring is still. |
| **The focus message** | One small card: rises 34 px and fades in over the bar, holds, glides to the agent window's edge, then brightness to 0 and opacity to 0 as it enters. The window's border flashes once. | 2.1 s in all (Web Animations API, one animation); starts 0.5 s after the drop. | `transform`, `opacity`, `filter` on one 196 px element, removed when done; a timer backs it so a hidden tab never stalls the sequence. | Not shown; the window shows the result at once. |
| **"Now use your own agent"** | The panel rises 16 px and fades in; the two windows above it shrink once, without animation. | 0.7 s. | One layout change, on the visitor's own action. | Appears at once. |
| **Chat messages, tool spinners, typed question** | Fade and 8 px rise; 16 ms per typed character. | 0.35 s each. | Trivial. | Appear at once. |
| **Presence pulse** | Expanding `box-shadow` ring on the bar being read. | 2.2 s loop. | One element. | Static orange bar. |
| **Scroll reveals** | Opacity and a 22 px rise, once, via `IntersectionObserver`. | 0.7 s. | Trivial. | Off; content is visible. |
| **Channel rules and ring** | An accent rule draws across each of the three columns on reveal; the lit row in the Presence diagram has a slow ring. | 0.7 s, staggered 150 ms; ring 2.4 s. | Three pseudo-elements, one SVG rect. | Rules drawn; ring still. |
| **Theme change** | Background and text colors cross-fade. | 0.3 s. | A repaint. | Instant. |
| **Cards and buttons** | Hover lift, color wash, arrow nudge, chip slide. | 0.2–0.45 s. | Trivial. | Off. |

Rules: only `transform`, `opacity`, `filter` on the message card, `box-shadow` rings and the canvas are animated; no animated layout. No text depends on motion to be readable, and none is hidden by it. Under `prefers-reduced-motion: reduce` all CSS animation and transition is off and the canvas loop does not start.

## Copy deck (intent only)

| Place | This line must say |
|---|---|
| Hero eyebrow, headline, lede, CTAs | As in round 1: an open standard on MCP; you point your own agent at what you see; the gesture, the access it already has, no screen sharing; one CTA per audience. |
| Chart title | It is active customers, per month. |
| Agent bar, at rest / pinned / read | Invite the drag; name the pinned month; say the agent has read it. |
| The message card | That it is the focus: the kind, the month and the call to make. Three short lines, no prose. |
| Stage empty state | Invite the drag, and say the agent is told what you pointed at, not what the screen looks like. |
| Stage answer | The month's count and seats, the mix by plan and by region, the top customer and the runner-up, the change against the month before; then one small line that it was read with `get_figure` and is not drawn on the chart. |
| "Now use your own agent" panel | That it is the visitor's turn; add Pulse to your agent as a remote MCP server; the next drop goes to your agent, right here. The address is yours (and, in the prototype, a placeholder). A prompt can do the adding. Nothing about accounts. |
| Connected line | The named agent is connected to Pulse; the next drop goes to it; where to go on (Signals); Revoke. |
| Connected, idle | Drag the agent's mark onto a bar; you ask in your own chat. |
| Connected, after a drop | It was sent to the named agent; what to ask it; what the agent then read; that the answer is in the agent and not on this page. |
| Try it, connected | The agent is already connected to Pulse, because it is the same Pulse; next is Signals, then one question across the two. Done steps say they were done in the hero. |
| Stage note | The data is Pulse's demo data, made up; nothing leaves the page. In the mock: this is a mock, and what the real site does. |
| Works with | The four agents, and any agent that accepts a remote MCP server. |
| Inside a point | View: the app names what you see with identifiers, no pixels. Pin: a drop gives the agent the exact call that reads the item. Presence: the agent is a mark on the page and what it reads lights up. |
| Your agent. Your permission. | Only the item you point at, read with the access you gave, no screen or screenshots. One connection per app; each app keeps its data; the agent does the joining in your conversation. Revoke in the app, at once. |
| Paths, The standard, Closing | As in round 1. |
| Build it lede | An APC app serves its own MCP endpoint; the person connects an agent to it; the agent reads through your existing tools; your app keeps its data. |
| Build steps | The four things every app implements, with their real identifiers, two sentences each. |
| Payload card | It is real output from Pulse, for a pin on March in the chart of active customers: ids and keys, and the call that reads it. |

## Visual notes

- **Two themes, one layout.** The theme follows `prefers-color-scheme` and the header toggle overrides it. The prototype does not remember the choice across reloads, so it always shows "follows the system" first; production should store it.
- **Dark (lane A):** ink `#080a0f`, text `#eef1f6`, muted `#a3adbf`, accent `#ff9f1c`, violet and amber haze. Unchanged from round 1.
- **Light (lane D's palette and type feel):** paper `#faf9f5`, graphite `#24251f`, muted `#5c5e53`, burnt orange `#c4501d` (text accent `#a9451c`), warm rules. The primary button is graphite with cream text, as in lane D. Headings are lighter (weight 580) and tighter, and the emphasized words in headings switch to Georgia italic, as in lane D. The access band and the code card are lane D's dark graphite `#292c24`.
- **The app is paper and the agent is ink in both themes.** In light the agent window, the code card and the access band are the only dark surfaces, so the eye lands on them; in dark the app window is the only light surface.
- **Why orange and the mark stay:** they are the product's UI. The mark on the site is the mark people drag in the apps, and orange is the color of a pin.
- **Contrast over the field:** body text never sits directly on a bright dot: in both themes the brightest dots are squares under 4 px at the pointer, and tags appear only in the outer gutters. Muted text is about 8.5:1 on ink and about 6:1 on paper.
- **Type:** system sans; system monospace for anything that is an identifier, a label or a thing that travels. Georgia is a system font, so no font file is needed.
- **The badge** is a 34 px light disc with the agent's logo, a dashed ring in the pin's orange and a green check; it sits half over the top edge of its bar, as Pulse's floats over its target.
- **Claude's mark** in the connected mock uses the path and color from `agent-logos.ts` (`#D97757` on `#FAFAF8`).

## How it fits the strict CSP

Nothing in the design needs an inline script, an inline style, a third-party origin, an embed or a CDN font.

- **Scripts:** the prototype inlines two scripts for convenience (a one-line theme setter in the head, and the page script). In production both are first-party files; the theme setter is a tiny blocking script from the site's own origin so the first paint has the right theme. No `eval`, no workers.
- **Styles:** all CSS moves to `site.css`; both themes are custom properties on `:root` and `:root[data-theme="light"]`. Bar heights, stagger delays and the mark's position are set through the CSSOM (`el.style…`), which `style-src 'self'` allows; the few `style=""` attributes in the prototype become classes.
- **State:** the connected state is one `sessionStorage` entry on the site's own origin; no cookie.
- **Motion:** the message uses the Web Animations API from first-party script; it needs no inline style or keyframes injected at run time.
- **Data:** the hero's table (eight months) ships in the first-party bundle, generated at build time from Pulse's own `resolveFocus` and `figureAnswer`, with a test like the one that guards `landing-example.ts`.
- **"Use your own agent", for real:** the stage would talk to Pulse on `pulse.apc.tineira.com`, another origin. Under the current policy that needs either a same-origin route on the site that proxies the visitor's sandbox, or one added `connect-src` entry for Pulse. This is the only place the round-2 design touches the policy, and it is a decision, not an assumption (see Open questions).
- **SVG, canvas, fonts, media, links:** as in round 1: inline same-document SVG, a 2D canvas with no images drawn into it, system fonts, the YouTube video as a link, `rel="noopener"` on links out. The prototype makes no network request.

## Open questions

1. **The real "Use your own agent".** Where does the visitor's Pulse sandbox live (the site's origin or Pulse's), and how does the stage learn that an agent connected and what it called: polling, a stream, or a Pulse page inside the site? This decides the CSP change above, and whether Try it can truly open "already connected" (it needs the same sandbox in the same browser). The prototype only mocks it.
2. **Use the real components.** The pet, the agent bar and the badge are redrawn here from REV3's description of the UX guide; the guide itself is not in the snapshot. Production should mount `@tineira/apc-web`'s own `<apc-agents>` in the stage, so the site cannot drift from the apps. Details to check against it: where the badge sits on a bar, the ring's rhythm, the × and the tap-then-target path (the prototype has click-a-bar instead).
3. **The message is a teaching device.** The real focus is never visible; the demo shows it once per pin so the fade to black has something to act on. If it reads as "the app shows this", shorten it or show it on the first pin only.
4. **Two pins.** The count is of the visitor's own pins, in the demo state, and the self-play does not count. A visitor who only watches never sees the big panel; the title-bar shortcut is their only way in. Should the panel also open after the self-play plus one pin?
5. **Self-play.** One automatic drag on load. If unrequested motion in the hero is unwanted, start pinned on March (the reduced-motion state) for everyone.
6. **Which agent the mock shows.** The simulate button connects Claude; on the real site the logo and name come from the agent that connected.
7. **`What is this?` versus `What's behind this bar?`.** The demo types the second; the connected state suggests the first, as REV2 and REV3 word it.
8. **The view call in the connected log.** It shows `get_current_view` then `get_figure`. If a real agent receives the pin through `wait_for_focus`, the log should show what it really called.
9. **Top customers come from the file's `summary`.** `get_figure` returns ids, plans, regions and seats, not names; a real agent would need one more call to name them.
10. **Autio and the Dock.** Both are off the page with the "In use" section. Where do they return: a later "In use" section, the docs, or the footer?
11. **Theme memory.** Store the visitor's choice or always follow the system?
12. **Pulse and Signals glyphs.** "P" and "S" squares are placeholders.
13. **The clip.** Keep it as the no-JS and social-card asset, or retire it?
