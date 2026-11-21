# Round 2 for lane A: your prototype won; here is what the founder wants next

Your lane (A) won the bake-off. Everything in `PROMPT.md` still holds (the hard limits, the locked facts, desktop only, no network, no invented facts), except where this file adds to it. **Write only inside `C:\Users\tinei\bakeoff\apc-site-desktop\apc-site-desktop-a`.**

Your first version is saved at `prototype-v1\index.html`; do not touch it. Rework `prototype\index.html` in place, and update `proposal.md` (keep its first section `## Summary` with exactly 5 bullets, rewritten for round 2).

## 1. What the founder valued most in your version (keep it)

- **The working demo in the hero** ("by far the best implementation of all; it makes everything easier"). Keep it the centerpiece.
- **Your dark colors and background.** They become the dark theme (see § 3).

## 2. Changes to the demo

1. **The agent leaves the page when the focus travels.** Once the pin is made and the focus goes to the agent, the agent mark on the chart fades to black and disappears, so the visitor sees that it went to their agent. The bar stays marked as pinned. The agent comes back to its resting place (fading in) when the visitor resets or drags again.
2. **The answer says what the chart does not show.** The agent's answer below must give facts that are *not* visible in the chart: how many active customers, how many seats in total, the mix by plan and by region, the customer with the most seats (and the runner-up), and the change against the previous month. Use **only** the real data in `context\pulse\pulse-hero-data.json`. It was computed with Pulse's own code from the demo's one shared world, for each month from 2025-10 to 2026-05: the focus payload (`focus`), what `get_figure` returns (`get_figure`), and a `summary`.
   - Every bar now has its **real** focus payload and answer from that file. Drop the "March with the month swapped" shortcut. March's focus is identical to `FOCUS_EXAMPLE`.
   - The chart is **active customers per month** (the figure `active_customers`). Make the bar heights follow the real `values.active` of each month, and label the chart accordingly. Do not print revenue or any figure the file does not contain.
   - Write the answer as an agent would after reading `get_figure`, plainly. For example, for March: 123 active customers, 4,009 seats; 51 on Team, 48 on Starter, 24 on Business; LATAM 51, North America 45, EMEA 27; the most seats is Lumen Delta Systems (229, Business, LATAM), then Open Pine Foods (225); up from 113 customers in February. Check every number against the file.
3. **A second state of the hero: "Use your own agent" (mocked).** The real site will later make this hero a real Pulse: the visitor connects their own agent to Pulse with Pulse's MCP address, and the drop sends a real pin to *their* agent. Mock it now, clearly as a prototype:
   - A quiet control in the stage, "Use your own agent", switches the stage from the self-playing demo to a **connect** state: Pulse's MCP address for this visitor (a placeholder such as `https://pulse.apc.tineira.com/mcp/…`, marked as such), a Copy button, and the alternative "copy a prompt that asks your agent to add it".
   - A proto-only button, "Simulate: Claude connected", moves to the **connected** state: the mark becomes the visitor's agent (Claude's logo from `agent-logos.ts`, and its name).
   - In the connected state, dropping the mark on a bar fades it out as in § 2.1. The panel does **not** show an answer, because the answer appears in the visitor's own chat. It shows "Sent to Claude. Now ask it: what is this?", then (simulated) the real calls arriving as the agent reads: `get_current_view`, then `get_figure` with that month's `next_args`, the bar lighting up as presence. Make clear in the panel that the answer is in their agent, not on this page.
   - The self-playing demo stays the default. Nothing in the connect state may suggest an account, a sign-up or a price.

## 3. Take these from another lane (lane D)

The founder liked these parts of lane D. Its prototype and proposal are in `context\lane-d\` (read-only). Read them for these pieces only; do not copy its overall layout or replace your direction.

1. **The light theme.** Add a light theme based on lane D's palette and typography feel, and keep your dark colors and background as the dark theme. Follow the visitor's system setting by default, with a small toggle in the header. Both themes must keep your moving background, adapted to each (contrast stays readable).
2. **"Works with".** Lane D's strip of compatible agents (Claude, ChatGPT, Cursor, Grok, "and any agent that accepts a remote MCP server"), with the logos.
3. **"Inside a point."** Lane D's simple three-channel section (View, Pin, Presence), each with a small diagram and one or two sentences: the complexity stays hidden in how it is implemented. Use it for your "How it works" (you may keep your scroll-driven diagram only if it stays this simple; simplicity wins).
4. **"Your agent. Your permission."** Lane D's simple access section: three short rows (only the item you point at; one connection per app; revoke in the app).
5. **Lane D's approach to Build it:** a short list of what to implement next to the real payload from Pulse, a clear and calm page. Rework your Build it view in that spirit.

## 4. When you finish

Your final message is your report (what changed, what you checked, anything you could not do). Do not write `report.md` or `analysis.md`; the coordinator saves the report.
