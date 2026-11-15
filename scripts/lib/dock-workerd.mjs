import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The two Workers in workerd, and the fetch that reaches them. */
export async function startWorkerd({ connectManifestFixture = false } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  // wrangler is the dock's devDependency, and Miniflare is wrangler's: the versions `vite dev` and `wrangler deploy` use.
  const wranglerPath = createRequire(join(root, "apps/dock/package.json")).resolve("wrangler");
  const fileUrl = (p) => new URL(`file:///${p.replaceAll("\\", "/")}`).href;
  const { unstable_getMiniflareWorkerOptions } = await import(fileUrl(wranglerPath));
  const { Miniflare, convertV4MiniflareOptions } = await import(fileUrl(createRequire(wranglerPath).resolve("miniflare")));
  if (typeof unstable_getMiniflareWorkerOptions !== "function" || typeof convertV4MiniflareOptions !== "function" || typeof Miniflare !== "function") {
    throw new Error("wrangler no longer exports unstable_getMiniflareWorkerOptions, or Miniflare convertV4MiniflareOptions: update scripts/dock-pairing.mjs for the new wrangler");
  }

  /** A built Worker as Miniflare runs it: its options from its wrangler.json, its bundle beside it. */
  const builtWorker = (name, configPath) => {
    const path = join(root, configPath);
    if (!existsSync(path)) throw new Error(`${configPath} is missing: run pnpm build first`);
    // The rules wrangler gives are the default ones (ESModule for .js and .mjs); Miniflare 5 takes the modules listed instead.
    const { workerOptions: { modulesRules: _rules, ...workerOptions }, main } = unstable_getMiniflareWorkerOptions(path);
    const dir = dirname(path);
    // Every module of the bundle, entry first, as wrangler deploy uploads them (no_bundle, the ESModule rule): the
    // entry imports its chunks (assets/*.js), some dynamically, which Miniflare would not find by itself.
    const entry = resolve(dir, main ?? "index.js");
    const chunks = readdirSync(dir, { recursive: true })
      .map((f) => resolve(dir, String(f)))
      .filter((f) => /\.m?js$/.test(f) && f !== entry);
    return { ...workerOptions, name, modules: [entry, ...chunks].map((p) => ({ type: "ESModule", path: p })), modulesRoot: dir, outboundService: "internet" };
  };
  const internet = {
    name: "internet",
    modules: true,
    compatibilityDate: "2026-10-01",
    script: `export default {
      async fetch(request, env) {
        const host = new URL(request.url).hostname;
        if (host === "apc.tineira.com") return env.DOCK.fetch(request);
        if (host === "pulse.apc.tineira.com") {
          const response = await env.PULSE.fetch(request);
          // Hub-only 0.13 tests provide the app manifest declaration; app pages ship in the separate app branch.
          if (${connectManifestFixture} && new URL(request.url).pathname === "/.well-known/apc.json" && response.ok) {
            const manifest = await response.json();
            return Response.json({ ...manifest, dock_connect: manifest.dock_connect ?? "https://pulse.apc.tineira.com/connect/dock" });
          }
          return response;
        }
        return new Response("no network in this test: " + host, { status: 502 });
      },
    };`,
    serviceBindings: { DOCK: "apc-dock", PULSE: "apc-pulse" },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [internet, builtWorker("apc-dock", "apps/dock/dist/apc_dock/wrangler.json"), builtWorker("apc-pulse", "apps/demo/dist/apc_pulse/wrangler.json")],
    }),
  );
  const runtime = { send: (url, init) => mf.dispatchFetch(url, init), stop: () => mf.dispose() };
  try {
    await mf.ready;
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }
  return runtime;
}
