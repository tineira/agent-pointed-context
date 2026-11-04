# Changelog

This is the changelog of the software. The APC standard (the contract an app and an agent share) is versioned apart, with its own [changelog](packages/protocol/CHANGELOG.md). Every PR that changes behavior adds an entry under `## Unreleased`; see `AGENTS.md`.

## Unreleased

Everything that merged after `v0.2.0` (PRs #16 to #109) and has not been tagged yet. APC v2 (the dock, Signals, the extension and the desktop apps) was built in this stretch; v1 at apc.tineira.com keeps working as in 0.2.0.

### Open pairing, with a warning in the dock (2026-11-04, TIN-581)

- **Any APC app can pair with the dock, after the person approves a warning in the dock.** `OPEN_PAIRING` is gone: an app outside `APP_ORIGINS` asks like any other, and its request becomes a pairing only through the warning's Approve (`approve_unverified`; a plain approve is refused as `warning_required`, so an older dock page cannot skip it). The warning shows the domain first and big, **Not verified**, what the app calls itself only as its own word, and the risk ("Your agent will read whatever this app tells it, and that could lead your agent to move data out of your other apps."), with Deny first and focused; it shows once per domain per dock, and a deny takes the domain's approval back. Verified apps keep their consent flow. (`apps/dock/src/worker/hub.ts`, `apps/dock/src/worker/trust.ts`, `apps/dock/src/web/unverified.tsx`, `apps/dock/src/web/hub.tsx`, `apps/dock/src/web/agent-page.tsx`, `apps/dock/src/web/pet.tsx`, `apps/dock/src/web/dock.css`)
- **A pending pairing nobody decides goes after 10 minutes and frees its place under the cap.** The app gets its grant back, as on a deny; the hub's alarm ends it on time. (`apps/dock/src/worker/hub.ts`, `apps/dock/src/worker/trust.ts`)
- **A kill switch for emergencies.** `UNVERIFIED_PAIRING=closed` refuses new unverified apps and holds every unverified pairing as blocked (never called, shown as **Paused**) until it is `open` again; the blocklist still wins over any approval. Unverified apps carry a **Not verified** badge on the dock's tiles, requests, Float, the pets and the agent's page. (`apps/dock/wrangler.jsonc`, `apps/dock/src/worker/hub.ts`, `apps/dock/test/open-pairing.test.ts`, `apps/dock/test/hostile-world.ts`, `README.md`, `DESIGN.md`)

### Discovery with `apc.json`, and an answer to a drop an app cannot take (2026-11-03, TIN-579)

- **Pulse, Signals and the dock say what they are at `/.well-known/apc.json` (APC 0.5).** Each app's file names it, the standard, its origin, the profiles it serves (from `APC_PROFILES`), where its MCP URLs live and its connect page (Pulse's Agents screen, Signals' Connect panel); the dock's says it is a hub, with its pairing endpoints. `@apc/server` builds an app's in one call. (`packages/protocol/src/manifest.ts`, `packages/server/src/apc-json.ts`, `apps/demo/src/worker/index.ts`, `apps/signals/src/worker/index.ts`, `apps/dock/src/worker/index.ts`)
- **The dock pairs an app only after reading its `apc.json`.** It refuses a file that is missing, invalid, names another origin, lists no Dock profile or does not cover the MCP URL the app sent (encoded traversal such as `%2e%2e%2f` included), each with its own error code; it keeps the copy for 10 minutes, refuses a redirect for the file (`apc_json_redirected`, any app), and lets a verified app pair while its file is briefly unreachable, still holding its MCP URL to `/mcp/`. (`apps/dock/src/worker/hub.ts`, `apps/dock/src/worker/app-client.ts`, `apps/dock/test/apc-json.test.ts`)
- **A dock agent dropped on a Direct-only app is answered, not lost.** The page says the app connects agents directly and links its connect page (Signals opens its Connect panel, Pulse its Agents screen), through `@apc/web`'s `enablePinning`, which reads the profiles from the page's own apc.json (3 s, 16 KiB, no redirect) and holds a drop made before it has, answering "could not check" rather than pairing when it cannot read it; the browser extension answers a Direct-only app that does not take the drop itself, even a drop made while it is still reading the app's apc.json, on a card that names the domain first and the app only as what the page says it is. A repeated drop replaces the note or card instead of stacking them. (`packages/web/src/pinning.ts`, `apps/signals/src/web/app.tsx`, `apps/demo/src/web/App.tsx`, `apps/extension/src/content.ts`, `apps/extension/src/drop.ts`, `apps/signals/test/direct-only.test.ts`)
- **Pulse reads the profiles it serves from one place.** Its `apc.json`, its page and its own checks all use `servedProfiles` (`APC_PROFILES`, with Dock only on the standard's deploy), so the page never says what the file contradicts. (`apps/demo/src/worker/sandbox.ts`, `apps/demo/src/worker/index.ts`)
- **The conformance suite checks `apc.json`**: its shape, origin and standard, and that its profiles and MCP path match what the app serves; Pulse and Signals pass. (`packages/conformance/src/index.ts`, `apps/demo/test/conformance.test.ts`, `apps/signals/test/conformance.test.ts`)
- **CI deploys Pulse and Signals before the dock**, so the dock never asks for an `apc.json` the apps do not serve yet. (`.github/workflows/ci.yml`)

### The Direct profile packaged, and `apc_link` (2026-11-03, TIN-578)

- **Pulse and Signals take agents both ways.** Each declares its profiles in one place, `APC_PROFILES` ("direct,dock"), instead of `APC_V2` hiding Direct; on the standard's deploy Pulse's Agents screen lists "Agents connected directly", and Signals has a Connect panel and opens a world of its own for a visitor with no dock. (`apps/demo/wrangler.jsonc`, `apps/signals/wrangler.jsonc`, `apps/demo/src/worker/sandbox.ts`, `apps/signals/src/worker/feed.ts`, `apps/signals/src/web/app.tsx`)
- **The Direct profile is packaged.** `@apc/server` makes a grant per agent and its MCP URL and reads what a connection says (`direct.ts`); `@apc/web` has the agent list where the person makes and names agents, with the URL and the prompt to copy (`<apc-direct-agents>`). (`packages/server/src/direct.ts`, `packages/web/src/direct-agents.ts`)
- **The same agent both ways shows as one (`apc_link`, APC 0.4).** The app offers a one-time code on the new connection, the agent sends it back on the other, and the bar shows one agent with both paths; it grants nothing, Revoke cuts both grants, and the person can unlink. The dock names the agent's client to a verified app when it introduces it, never to an unverified one. (`packages/server/src/links.ts`, `apps/dock/src/worker/app-client.ts`)
- **The agent bar shows each agent's path and follows the bar rule.** Always in full with a Direct agent; with only dock agents it can collapse to who is reading, never hidden; a quiet, dismissible hint offers the dock to a Direct user. (`packages/web/src/agents-bar.ts`)
- **"Connect app by app" on the landing opens Signals' Connect panel**, beside "Open your dock". (`apps/dock/src/web/landing.tsx`)
- **The conformance suite checks `apc_link`**, and a test links one agent through the real hub and Pulse both ways round. (`packages/conformance/src/index.ts`, `apps/dock/test/apc-link.test.ts`)

### The APC standard at apc.tineira.com (2026-11-03, TIN-605)

- **The APC standard moves to its own home and loses its "v2".** The dock is Worker `apc-dock` on apc.tineira.com, Pulse is `apc-pulse` on pulse.apc.tineira.com and Signals is `apc-signals` on signals.apc.tineira.com, all with fresh Durable Objects and rate-limit namespaces (1007 to 1010). Every allow-list, the extension's host permissions, the desktop apps, the e2e script and the tests use the new hosts. The old Workers and the `v2.` hosts are removed by hand after a production check. (`apps/*/wrangler.jsonc`, `apps/extension`, `apps/dock-desktop`, `apps/desktop`, `scripts/extension-e2e.mjs`)
- **The landing page presents only the standard**, with "Connect once" (Dock) and "Connect app by app" (Direct) side by side and a footer link "Version 1, as described in the paper" to `/v1/`. "v2", "prototype" and the V1/V2 chooser are gone from every page a person sees; Pulse opens its sandbox at `/`. (`apps/dock/src/web/landing.tsx`, `apps/demo/src/web/App.tsx`)
- **V1 keeps only `apc.tineira.com/v1` and `/v1/*`** as zone routes of the `apc-demo` Worker (a route runs before the Custom Domain of the same host), and its temporary `GET /` redirect is gone. (`apps/v1/wrangler.jsonc`, `apps/v1/src/worker/index.ts`)
- **`/v1` is matched with a wildcard and guarded in the dock.** The zone route is `apc.tineira.com/v1*` (a route without a wildcard misses `/v1?x=1`), and the dock answers `/v1` with a redirect to `/v1/` and `/v1/*` with a 404 if a request still reaches it. (`apps/v1/wrangler.jsonc`, `apps/dock/src/worker/index.ts`)
- **The extension treats only the dock's own paths as the dock** (`/`, `/dock*`, `/extension*`), never `/v1/`, in the popup, the content-script exclusions and the presence script. (`apps/extension/src/drop.ts`, `worker.ts`, `popup.ts`, `manifest.json`)
- **The old bridge dock is gone** (`/bridge`, `dock-bridge.ts`, `dock-protocol.ts` and the "click Dock" text), as nothing opens it any more. (`apps/dock`, `apps/demo`)
- **CI deploys "the APC standard"** (dock, Pulse, Signals) after the V1 job when both run. (`.github/workflows/ci.yml`)

### Dock

- **The hub is hardened for apps it does not know, before any can pair.** An app outside `APP_ORIGINS` is unverified and still cannot pair (`OPEN_PAIRING` is unset in every deploy), but every protection for it exists and is tested against simulated hostile apps: its id and tool prefix come from its domain, never from the name it declares (an app calling itself "Pulse" from `evil.example` is `evil_example`); HTTPS on a domain name only, no redirects; a byte cap on every answer the hub reads from any app (1 MiB verified, 256 KiB unverified) and a time limit covering the body; at most 20 app pairings per dock; its results, views, pin and tool descriptions reach the agent marked `untrusted`, with no tool annotations, and its errors carry only the hub's own words; its `then` and `page_open` never count, so it cannot keep the agent waiting; and `BLOCKED_APPS`, a blocklist we operate (empty), refuses a domain (Unicode or punycode) at pairing and stops a pairing with it, shown as **Blocked** on the agent's page and holding no place under the cap. Pulse and Signals pair and work as before, as verified apps. (TIN-580, `apps/dock/src/worker/trust.ts`, `apps/dock/src/worker/hub.ts`, `apps/dock/src/worker/app-client.ts`, `apps/dock/src/web/agent-page.tsx`, `apps/dock/wrangler.jsonc`, `apps/dock/test/hostile-app.test.ts`)
- **The dock says when an app revoked an agent.** The hub learns it on its next call to the app (403 `revoked`): the pairing shows **Revoked by** the app's host on the agent's page and its tile, the hub stops relaying to it and drops the view and pin it took from it, never confirms it on a drop, and a new pairing with that app replaces the line. (TIN-577, `apps/dock/src/worker/hub.ts`, `apps/dock/src/worker/app-client.ts`, `apps/dock/src/web/agent-page.tsx`)
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

- **Revoke an agent from Pulse itself, even one from a dock.** Every agent in Pulse's agent bar has Revoke (⊘, then **Revoke?**): its grant, pin and dock link go at once, with no call to the dock, so it holds with the dock down; its MCP URL answers 403 `revoked` from then on, a call already running ends the same way, and the next drop asks again in Pulse and in the dock. Only a hash of a revoked grant's secret is kept, to answer `revoked`. (TIN-577, `apps/demo/src/worker/sandbox.ts`, `apps/demo/src/worker/index.ts`, `apps/demo/src/web/App.tsx`)
- **V1 is frozen at apc.tineira.com/v1, in an app of its own.** The paper describes V1, so it no longer shares code with anything else: `apps/v1` is today's V1 build of Pulse with a copy of the `@apc/protocol`, `@apc/server` and `@apc/web` source it uses (and their tests) inside the app, no `@apc/*` workspace dependency, and the v2-only code left out. It runs on the same Worker (`apc-demo`, same Durable Objects, secret and analytics dataset) and serves everything under `/v1`: the page, `/v1/api/*`, the MCP URLs `/v1/mcp/<sandbox>/<secret>` and every `app_url` an agent gets. `/` redirects to `/v1/` until phase 0c; the old root URLs are gone. CI deploys V1 only when `apps/v1/` changes; `apps/demo` is now Pulse for the standard only (its former env `v2` is its top-level config) and the `pulse-agent` skill is generated from, and drift-tested against, V1's copy of the manual. (#112, `apps/v1`, `apps/demo/wrangler.jsonc`, `apps/demo/src/worker/guide.ts`, `scripts/build-skill.mjs`, `package.json`, `.github/workflows/ci.yml`)
- **V1 is served under `/v1` without `assets.base_path`,** which Cloudflare refused on the first deploy (code 100343). The page's files now sit in a `v1/` folder of the assets directory, so every URL stays the same; the Worker gets the `ASSETS` binding and itself answers an app route under `/v1/` with `v1/index.html`, while a missing file stays a 404 and nothing outside `/v1` ever gets the page. (`apps/v1/vite.config.ts`, `apps/v1/v1/index.html`, `apps/v1/public/v1/`, `apps/v1/wrangler.jsonc`, `apps/v1/src/worker/index.ts`)
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

- **Revoke an agent from Signals itself,** as in Pulse, with no call to the dock. Signals now also publishes presence (`get_post` names the post) and, like Pulse, sends no `then` on a `wait_for_focus` that came back empty; its page ignores presence for now, so nothing else changes on screen. (TIN-577, `apps/signals/src/worker/feed.ts`, `apps/signals/src/web/app.tsx`)
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

- **The APC standard 0.2.0: the core written down, and a conformance suite.** `@apc/protocol` names the core every app implements on either profile (Direct or Dock) and revoke from the app (`RevokedAnswer`); `@apc/server` gives the revoked answer (`revokedResponse`, `revokedToolResult`); `<apc-agents>` gets Revoke (event `apc-revoke`); and the new `@apc/conformance` checks any APC app through its MCP endpoint and a small page adapter, with `@apc/conformance/workers` to run a Durable Object on Node. Pulse (both profiles) and Signals pass it in `pnpm test`. (TIN-577, `packages/protocol/src/core.ts`, `packages/server/src/revoke.ts`, `packages/web/src/agents-bar.ts`, `packages/conformance`)
- **`<apc-pin>`, a standard pin badge in `@apc/web`:** drag a pinned agent on in every APC app. (#95, `packages/web/src/pin-badge.ts`)
- **`<apc-agents>`, the standard agent bar in `@apc/web`,** used by Pulse v2 and Signals. (#41, `packages/web/src/agents-bar.ts`)
- **`enablePinning` accepts native drops of an agent** dragged from another window, opt in. (#32, `packages/web/src/pinning.ts`)

### Docs and tooling

- **The changelog check routes contract changes to the standard's changelog.** A change under `packages/protocol/src/` needs an entry in `packages/protocol/CHANGELOG.md`, other code needs one in `CHANGELOG.md` (each changelog alone is not enough for the other), a git failure now exits 2 with a clear message, and the standard's changelog must open with its version, not an Unreleased section. (TIN-603, `scripts/lib/changelog.mjs`, `scripts/check-changelog.mjs`, `packages/protocol/test/version.test.ts`)
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
