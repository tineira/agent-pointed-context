# Changelog

This is the changelog of the software. The APC standard (the contract an app and an agent share) is versioned apart, with its own [changelog](packages/protocol/CHANGELOG.md). Every PR that changes behavior adds an entry under `## Unreleased`; see `AGENTS.md`.

## Unreleased

Everything that merged after `v0.2.0` (PRs #16 to #109) and has not been tagged yet. APC v2 (the dock, Signals, the extension and the desktop apps) was built in this stretch; v1 at apc.tineira.com keeps working as in 0.2.0.

### Dock

- **The dock retries when the network is back after sleep.** A laptop that wakes with no connection no longer leaves the dock stuck on an error; it tries again when the network returns. (#109, `apps/dock/src/web/hub.tsx`)
- **The extension's readings are listed in the dock.** Each agent's page shows the log of its last 50 readings, with the site, time and size only, and a **Clear** button. (#107, `apps/dock/src/web/agent-page.tsx`, `apps/dock/src/worker/reading.ts`)
- **The dock's footer controls and the platform downloads are back** after the checklist change. (#103, `apps/dock/src/web/downloads.tsx`)
- **A checklist beside your agent replaces the first-run wizard.** It checks itself as you try each feature (connect, Pulse, Signals, the extension), in any order. (#101, `apps/dock/src/onboarding.ts`)
- **The APC pet: one animated character for every agent,** its logo as a badge. (#97, `apps/dock/src/web/apc-pet.tsx`)
- **Float shows a pairing request as a notice;** a click opens it at full size. (#94, `apps/dock/src/web/float-size.ts`)
- **A page reading wakes `wait_for_focus`,** so an agent waiting on the dock hears about a drop on a web page. (#71, `apps/dock/src/worker/hub.ts`)
- **The dock records each agent's connection in Analytics Engine,** like Pulse v1: client name and version, label, user agent and two keyed hashes, never the IP or the agent's secret. (#62, `apps/dock/src/worker/hub.ts`)
- **A page per agent shows what it did.** The last 300 calls through the dock (tool, app, time, the pin it read, errors; never arguments or results), the agent's apps with Unpair, and its connection folded. (#61, `apps/dock/src/web/agent-page.tsx`)
- **APC v2 has a landing page at `/`;** the dock moves to `/dock`. (#60, `apps/dock/src/web/landing.tsx`)
- **An agent can be removed from the dock.** (#59, `apps/dock/src/worker/hub.ts`)
- **Float wraps the agents to the window's width,** with no scrollbars. (#58, `apps/dock/src/web/dock.css`)
- **Float shows pairing requests,** and Signals gets its own agent bar without Dock buttons. (#56, `apps/dock/src/web/hub.tsx`)
- **Start over in the dock,** in Pulse v2 and in Signals. (#54, `apps/dock/src/worker/hub.ts`)
- **The dock draws the agent's mark during the first run too.** (#52, `apps/dock/src/web/hub.tsx`)
- **A not-yet-connected agent can be dragged into an agent's chat to connect it.** (#51, `apps/dock/src/web/setup.tsx`)
- **First run, one app per step,** with Pulse opened in the browser or for Windows. (#49, `apps/dock/src/web/setup.tsx`)
- **First run folds the instructions once the agent is connected** and names the agent by product. (#48, `apps/dock/src/web/setup.tsx`)
- **The dock's first run, and the desktop bridge as a waterfall.** A QR code connects an agent. (#47, `apps/dock/src/web/setup.tsx`)
- **Apps confirm a dock pairing on every drop,** and the agent's mark has no frame. (#40, `apps/dock/src/worker/hub.ts`)
- **The agent's mark travels to every app,** and unpairing an app revokes its grant. (#39, `apps/dock/src/worker/hub.ts`)
- **The dock installs as an app (PWA),** compact, with the agent's logo large. (#42, `apps/dock/public/manifest.webmanifest`)
- **The attention hub: one agent connection across apps.** A Durable Object per dock with `get_current_view`, `wait_for_focus`, `call_app_tool` and `list_app_tools`; apps pair with it and it relays their tools. (#36, `apps/dock/src/worker/hub.ts`)
- **A dock window that drags Pulse's agents onto Pulse,** over postMessage. (#35, `apps/dock/src/web/hub.tsx`)
- **`apps/dock` is set up as APC v2's own Worker and deploy** (v2.apc.tineira.com), so apc.tineira.com is never touched. (#31, `apps/dock/wrangler.jsonc`, `.github/workflows/ci.yml`)

### Pulse

- **`GET /api/health` is public** on Pulse and on the dock, for uptime probes. (#104, `apps/demo/src/worker/index.ts`, `apps/dock/src/worker/index.ts`)
- **A public chooser for the two APC connection models.** (#100, `apps/demo/src/web/landing/chooser.tsx`)
- **Pulse recognises Z.ai's ZCode as Z.ai.** (#57, `apps/demo/src/model/products.ts`)
- **"Start over" links to the other sites** and has a visible button; Pulse for desktop gets it too. (#55, `apps/demo/src/web/start-over.tsx`)
- **Pulse v2: agents are managed in the dock.** Settings only, no leftover direct agents. (#53, `apps/demo/src/web/connect.tsx`)
- **An agent not connected yet shows an unplugged plug.** (#50, `apps/demo/src/web/agent-icon.tsx`)
- **Pulse v2 takes agents only from a dock.** (#46, `apps/demo/src/worker/sandbox.ts`)
- **Pulse and Signals are independent apps,** opened by the dock on one world. (#43, `apps/demo/src/web/dock-bridge.ts`)
- **Favicon: the Pulse mark.** (#30, `apps/demo/public/favicon.svg`)
- **The Grok bot has one base logo.** (#29, `apps/demo/src/web/agent-logos.ts`)
- **Gemini is recognised by its user agent,** and its logo is drawn in color. (#28, `apps/demo/src/web/agent-brands.ts`)
- **A guided first run,** from connect to bring what you know. (#27, `apps/demo/src/web/tour.tsx`)
- **Pulse warns when a second agent uses an agent's URL** and offers it its own. (#26, `apps/demo/src/worker/sandbox.ts`)
- **Agent names come from the client, the agent itself, or the person.** (#25, `apps/demo/src/worker/names.ts`)
- **The Agents page folds a connected agent's URL and QR.** (#24, `apps/demo/src/web/connect.tsx`)
- **How-to: one connect flow for every agent.** (#23, `apps/demo/src/web/howto.tsx`)
- **A whole chart can be pinned,** not only one of its bars. (#22, `apps/demo/src/model/figures.ts`, `apps/demo/src/web/charts.tsx`)
- **A pin moves by dragging its badge to another target.** (#21, `apps/demo/src/web/pin-badges.tsx`)
- **The pin badge sits on the bar's corner** and drops the green ring. (#20, `apps/demo/src/web/pin-badges.tsx`)
- **A pinned agent's icon stays on its target until you unpin it.** (#19, `apps/demo/src/web/pin-badges.tsx`)
- **Agent logos keep full color when the agent is idle.** (#18, `apps/demo/src/web/styles.css`)
- **Agent icons: official logos per MCP client,** animated by state. (#17, `apps/demo/src/web/agent-icon.tsx`)
- **MCP sessions are weighed by their smallest sample interval** when counted. (#16, `scripts/lib/mcp-sessions.mjs`)
- **Distinct MCP agent sessions are counted in Analytics Engine,** and `node scripts/mcp-sessions.mjs` lists them. (b43bbb1, `apps/demo/src/worker/sessions.ts`)

### Signals

- **Signals has a realistic social feed look.** (#38, `apps/signals/src/web/styles.css`)
- **Signals, the second APC v2 app,** and prefixed tools (`<app>__<tool>`) in the hub. (#37, `apps/signals/`)

### Extension

- **Wikipedia formulas are read once,** not once as MathML and once as the image beside it. (#108, `apps/extension/src/content.ts`)
- **Readings list with Clear; tables and alt text are read.** A table cell gives its column header and row label; images and formulas give their alternative text. (#107, `apps/extension/src/read.ts`)
- **The extension answers `link` last,** so a page that refuses drags cannot make the browser refuse the agent. (#105, `apps/extension/src/content.ts`)
- **A downloadable extension and an illustrated install guide** at v2.apc.tineira.com/extension, built by a workflow. (#102, `.github/workflows/extension.yml`, `apps/dock/src/web/extension.tsx`)
- **Sensitive sites are matched by domain only,** and **Always ask** can be set per site. (#79, `apps/extension/src/drop.ts`)
- **The extension does nothing on APC apps,** so Pulse and Signals keep one pin. (#78, `apps/extension/src/content.ts`)
- **Open dock and Float from the extension,** with keyboard shortcuts; the dock floats on `?float=1`. (#77, `apps/extension/src/open-dock.ts`)
- **Pages of divs, such as X, take the agent** and can be pointed at. (#76, `apps/extension/src/content.ts`)
- **Drag the pin to another paragraph** to move the agent's focus. (#75, `apps/extension/src/content.ts`)
- **The pin looks like Pulse's** and never covers the first words. (#74, `apps/extension/src/content.ts`)
- **A read pin still turns grey** when a newer drop replaces it. (#73, `apps/extension/src/content.ts`)
- **The agent's mark stays pinned on the paragraph.** (#72, `apps/extension/src/content.ts`)
- **One grant for any page, consent on drop, and Never ask.** (#70, `apps/extension/src/worker.ts`)
- **Open tabs on a granted site take the drop without a reload.** (#69, `apps/extension/src/worker.ts`)
- **Extension phase 1: pages receive the agent** from the dock and Float; the dock keeps the last reading for 10 minutes. (#65, `apps/extension/`, `apps/dock/src/worker/reading.ts`)

### Desktop

- **The Windows dock's pet moves by a grip shown on hover;** dragging the body only points. (#99, `apps/dock-desktop/src/pets.rs`)
- **The pet shows no stray title bar** after it is clicked or dropped. (#98, `apps/dock-desktop/src/pets.rs`)
- **Dock for Windows: Float as desktop pets,** one frameless agent per window, each draggable onto an app. (#96, `apps/dock-desktop/src/pets.rs`)
- **Dock for Windows: the installer is published** from `main` as the `dock-desktop` prerelease, and the web dock offers it on Windows. (#91, `.github/workflows/dock-desktop.yml`)
- **Dock for Windows: links out of the dock open in the browser again.** (#90, `apps/dock-desktop/src/main.rs`)
- **Dock for Windows (Tauri): always on top, a global shortcut and a tray.** (#89, `apps/dock-desktop/`)
- **Pulse for desktop: fix the crash on redraw,** and pin the light theme. (#45, `apps/desktop/MainWindow.cs`)
- **Pulse for desktop, a Windows app that takes the dock's agent** (Avalonia, .NET 8), built by `desktop.yml`. (#44, `apps/desktop/`)

### Packages

- **`<apc-pin>`, a standard pin badge in `@apc/web`:** drag a pinned agent on in every APC app. (#95, `packages/web/src/pin-badge.ts`)
- **`<apc-agents>`, the standard agent bar in `@apc/web`,** used by Pulse v2 and Signals. (#41, `packages/web/src/agents-bar.ts`)
- **`enablePinning` accepts native drops of an agent** dragged from another window, opt in. (#32, `packages/web/src/pinning.ts`)

### Docs and tooling

- **The e2e script's step 8 is fixed,** DESIGN 13.2 corrected and the lockfile updated. (#106, `scripts/extension-e2e.mjs`)
- **CI: a workflow change alone no longer redeploys v1.** (#92, `.github/workflows/ci.yml`)
- **DESIGN.md's not-built work points to public GitHub issues.** (#88, `DESIGN.md`)
- **DESIGN.md records what is built;** plans move to issues. (7b76fd9, `DESIGN.md`, `AGENTS.md`)
- **`extension-e2e` can run against production (`--prod`),** hold the browser (`--hold`) and try ungranted sites. (#67, `scripts/extension-e2e.mjs`)
- **AGENTS.md links the Notion page** in the profile. (#68, `AGENTS.md`)
- **AGENTS.md added** with the agentic-os profile. (#66, `AGENTS.md`)
- **DESIGN.md section 13, a browser extension:** the extension only receives drops. (#64, #63, `DESIGN.md`)
- **DESIGN.md settles the TIN-370 prototype's open questions.** (#34, `DESIGN.md`)
- **DESIGN.md: APC v2, one agent across apps.** (#33, `DESIGN.md`)
- **Two changelogs and a version for the standard.** `APC_STANDARD_VERSION` in `@apc/protocol`, `packages/protocol/CHANGELOG.md` with its 0.1.0 entry, and a `changelog` CI job (`scripts/check-changelog.mjs`) that fails a PR which changes more than docs and updates neither changelog, unless it has the `no-changelog` label. (TIN-603, `packages/protocol/`, `scripts/check-changelog.mjs`, `.github/workflows/ci.yml`, `AGENTS.md`)

## 0.2.0 (2026-10-19)

- **A customer pin carries no params; a figure pin only the keys its figure reads.** A pin like `{"kind":"customer","id":"cus_0001","params":{"note":"SECRET-1234.57"}}` was stored, logged and handed to the agent; it is now refused with `invalid_target`, and so is a figure pin with an extra key. (`apps/demo/src/worker/domain.ts`)
- **The activity switch also stops the pulse on an agent's mark**, as it already stopped the flash on what the agent read. Marks and pins stay visible. (`apps/demo/src/web/App.tsx`, `apps/demo/src/web/presence.ts`)
- **With view sharing off, agents no longer learn whether the page is open.** No result carries `then`, and `wait_for_focus` waits its full timeout without reporting `page_open` or ending early when the page closes; it still returns a pin dropped during the wait. Nothing changes with sharing on. (`apps/demo/src/worker/sandbox.ts`, `apps/demo/src/worker/page.ts`, `packages/server/src/tools.ts`, `packages/server/src/prompts.ts`, `skills/pulse-agent/SKILL.md`)
- **Canary check:** `node scripts/canary.mjs <events.jsonl> <mrr-by-customer.csv>` reports whether any of the person's MRR values appear in a sandbox's event log, and exits 1 if one does. (`scripts/canary.mjs`, `scripts/lib/canary.mjs`)
- **DESIGN.md corrections:** the envelope for a pin on a monthly bar is 571 bytes, not 401; what `envelope_bytes` and `then_bytes` measure; the 2 s poll and the 75 s fallback window of `wait_for_focus`; the sharing-off behavior; the log's boundary for the canary; the customer-pin allowlist. (`DESIGN.md`)
