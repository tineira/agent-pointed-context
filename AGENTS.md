# AGENTS.md — agent-pointed-context

Shared agent rules live in [agentic-os](https://github.com/tineira/agentic-os) (read its `README.md` first); this file holds only this repo's profile and rules.

## Profile (agentic-os)

Agent rules: https://github.com/tineira/agentic-os (read `README.md` first). This profile overrides its defaults.

| Key | Value |
|---|---|
| Product copy language | en (UI strings in `apps/*`, README, the `pulse-agent` skill) |
| Working language (docs, code, commits) | English |
| Adversarial review | on (default) — default pairs: see agentic-os `models/routing.md`. Tomas can override |
| Backlog / status | Linear project "Agent Pointed Context" (team Tineria) |
| Specs and decisions | [`DESIGN.md`](DESIGN.md) (§ 11 Decisions, § 12 APC v2, § 13 extension) · Notion page: [Agent Pointed Context](https://app.notion.com/p/3faa554c3c4081739e7fdf8cd114b687) |
| Deploy | Cloudflare Workers via GitHub Actions (`.github/workflows/ci.yml`): every push to `main` that passes the `check` job deploys. v1 (Worker `apc-demo`, apc.tineira.com) when anything outside `apps/dock`, `apps/signals`, `apps/desktop*`, `apps/extension` changes; v2 (Workers `apc-v2`, `apc-v2-pulse`, `apc-v2-signals` at v2 / pulse.v2 / signals.v2.apc.tineira.com) when `apps/dock`, `apps/signals`, `apps/demo` or `packages/` change. `PulseDesktop.exe` is published to the `pulse-desktop` prerelease by `.github/workflows/desktop.yml` on `main` (paths `apps/desktop*`). So a push to `main` is a production deploy |
| Database | None external. One Durable Object (SQLite) per visitor sandbox, synthetic data, deleted after 6 h idle; Analytics Engine dataset `apc_mcp_sessions`. Localhost (`pnpm dev`) uses the local Workers runtime, not prod data |
| Migration commands | None. Durable Object migrations are `migrations` in `apps/*/wrangler.jsonc`, applied by `wrangler deploy` |
| Local gate before push | `pnpm typecheck` + `pnpm test` + `pnpm build` (what the CI `check` job runs) |
| CI | GitHub Actions: `ci.yml` on push to `main` and on every PR (`check`: install, typecheck, test, build; then `deploy` / `deploy-v2` on `main` only); `desktop.yml` on push/PR touching `apps/desktop*` (Windows `dotnet test` + build) and `workflow_dispatch`. Deploy secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` are repo secrets |
| Freezes | None |
| Run scope (if a run is active) | None |

## This repo

- pnpm monorepo (Node ≥ 24, pnpm via corepack): `packages/protocol`, `packages/server`, `packages/web`; `apps/demo` (Pulse: Cloudflare Worker + Durable Objects, Vite + React), `apps/dock`, `apps/signals`, `apps/extension`, `apps/desktop` (Avalonia, .NET 8). Layout and run steps: [`README.md`](README.md).
- Design and decisions: [`DESIGN.md`](DESIGN.md). The `pulse-agent` skill is generated (`node scripts/build-skill.mjs`); a test fails if it drifts from `apcGuide()` / `guide.ts`.
- v2 must never touch apc.tineira.com: what v2 needs from `@apc/*` goes in as additive, opt-in options (README § APC v2).
