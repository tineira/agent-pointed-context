# Round 3 for lane A: the founder's notes on round 2

Everything in `PROMPT.md` and `REV2.md` still holds, except where this file changes it. **Write only inside `C:\Users\tinei\bakeoff\apc-site-desktop\apc-site-desktop-a`.** Before you start, copy your round-2 file to `prototype-v2\index.html` (new folder) and leave it untouched; rework `prototype\index.html` in place, and update `proposal.md` (keep `## Summary` with exactly 5 bullets).

## 1. The fade to black is the message's, not the agent's

The founder was misunderstood in round 2. **The agent mark never fades out.** It must behave exactly as the real reference apps behave today (from the UX guide in `@tineira/apc-web`, which Pulse uses):

- **The pet lives in the agent bar.** It is only a mark: the person drags it (or taps it, then a target) onto something.
- **On the drop, the pet goes back to the bar**, and the item it was dropped on wears a **pin badge**: the agent's logo in a small disc, with **a dashed, breathing ring while the agent has not read the pin, and a check once it has**, plus × to unpin. In Pulse the badge floats over its target.
- **Presence:** what the agent reads lights up.
- The badge is a mark too: dragging it onto another bar moves the pin.

What fades to black is **the focus message that travels** from the app to the agent. In reality that message goes underneath and the person never sees it. So: after the drop, show the focus payload (the small JSON) lifting off the pinned bar and floating toward the agent window; as it crosses, it fades to black and disappears. The agent window then shows what happened, as in your round 2 answer.

Remove round 2's "mark fades to black and leaves" and its "away" state entirely.

## 2. After two pins, a big "Use your own agent"

Today the "Use your own agent" control is a small button in the agent window's title bar that is barely seen. Change the flow:

1. The person pins a bar. The page simulates the message floating with the focus, which fades to black (§ 1). Then the explanation and the agent's answer appear (keep round 2's real-data answer).
2. The person pins a second time (another bar, or the same one again). Same sequence.
3. **After the second pin's answer**, a large, unmistakable panel appears right there in the hero stage, not in a corner: "Now use your own agent", with Pulse's MCP address (placeholder, marked), Copy, the copy-a-prompt alternative, and a line saying the next drop goes to their agent. It invites the person to pin *right there*, with their own agent, without leaving the page.
4. The proto-only "Simulate: Claude connected" stays, inside that panel, so the founder can see the connected state: the pet in the bar becomes Claude's (logo badge), and a drop pins with Claude's badge, the message travels and fades to black, and the stage says "Sent to Claude. Now ask it: what is this?" with the simulated calls arriving and the badge turning from dashed ring to check once `get_figure` is read. No answer is shown on the page in that state.

The small title-bar control may stay as a quiet shortcut, but the big panel after two pins is the main path. The self-play on load may stay only if it does not count as one of the person's two pins.

## 3. Try it starts with Pulse already connected

When the person connected their own agent in the hero (in the prototype: after "Simulate: Claude connected"), the **Try it** view must show **Pulse as already connected**: a check beside Pulse, "Claude connected" (or the agent's name), and the Connect step for Pulse marked done, so the walk starts at the next step (point in Signals, then join). Without a connection in the hero, Try it stays as it is. In the real site this works because the hero is the same Pulse (the same sandbox, in the same browser). Keep that state across the view switch inside the prototype (and across a reload if simple, with `sessionStorage`).

## 4. Remove the "Running in a real product" section

Take out the whole "In use / Running in a real product" section (Autio and the Dock line in it) for now. Keep "Free, open and versioned". No other mention of Autio or the Dock anywhere on the page.

## 5. When you finish

Your final message is your report (what changed, what you checked, anything you could not do). Do not write `report.md` or `analysis.md`.
