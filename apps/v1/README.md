# V1, frozen

This is V1 of Agent Pointed Context: Pulse as the paper describes it ([doi:10.5281/zenodo.23382909](https://doi.org/10.5281/zenodo.23382909)), served at [apc.tineira.com/v1](https://apc.tineira.com/v1/).

**It is frozen.** It changes only to keep it running (a security fix, a runtime or dependency update the host forces). New features, refactors and the APC standard go elsewhere: `packages/*` and `apps/demo` are free to change, and nothing they do reaches V1.

Why it stands alone (TIN-604, DESIGN.md § 11):

- It has its own copy of the `@apc/protocol`, `@apc/server` and `@apc/web` source it uses, in `src/apc/`, with its tests in `test/apc-*.test.ts`. `package.json` has no `@apc/*` workspace dependency, and nothing in `src/` imports one.
- Nothing else in the repo imports from `apps/v1`, except `scripts/build-skill.mjs`, which generates the published `pulse-agent` skill from this copy of the manual (`src/apc/server/prompts.ts` and `src/worker/guide.ts`); `test/guide.test.ts` fails if the skill drifts.
- It runs on the same Worker as before the move (`apc-demo`), so its Durable Objects, the `ANALYTICS_SALT` secret and the `apc_mcp_sessions` dataset carry over. CI deploys it only when a file under `apps/v1/` changes.
- Everything lives under `/v1` (`src/base.ts`): the page, `/v1/api/*`, the MCP URLs `/v1/mcp/<sandbox>/<secret>` and every link it hands out. Until phase 0c puts the standard's landing at the root, the Worker answers `/` with a redirect to `/v1/`; no other root path is served.
- The page's files sit in a `v1/` folder, so each URL is its file's path and no `assets.base_path` is needed (it is not enabled on every account): the HTML is `v1/index.html`, the public files are in `public/v1/`, and the build writes the bundles to `v1/assets/` (`vite.config.ts`). The built assets directory, `dist/client/`, holds nothing outside `v1/`. A request that matches no file reaches the Worker, which answers an app route under `/v1/` (`/v1/how-to`) with `v1/index.html` and anything else with a 404.
- Code that existed only for APC v2 (dock pairing, `HUB_ORIGINS`, the dock bridge, the `APC_V2` branches, signup codes) is left out.

Run it locally (from the repo root, after `pnpm install`):

```sh
pnpm --dir apps/v1 dev                 # Vite + the local Workers runtime; open /v1/
pnpm --dir apps/v1 build               # then:
cd apps/v1 && npx wrangler dev         # the built Worker on the local runtime, at http://localhost:8787/v1/
```
