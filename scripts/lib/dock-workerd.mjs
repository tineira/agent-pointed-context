import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The site, Dock and Pulse Workers in workerd, and the fetch that reaches them. */
export async function startWorkerd({ connectManifestFixture = false } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const siteConfig = JSON.parse(readFileSync(join(root, "apps/site/wrangler.jsonc"), "utf8"));
  const sitePrefixes = siteConfig.routes.map(({ pattern }) => {
    if (!pattern.startsWith("apc.tineira.com/") || !pattern.endsWith("*") || pattern.slice(0, -1).includes("*")) throw new Error(`unsupported site route: ${pattern}`);
    return pattern.slice("apc.tineira.com".length, -1);
  });
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
        if (host === "apc.tineira.com") {
          const path = new URL(request.url).pathname;
          // The six zone patterns precede the Dock Custom Domain, query strings included.
          const site = ${JSON.stringify(sitePrefixes)}.some((prefix) => path.startsWith(prefix));
          return site ? env.SITE.fetch(request) : env.DOCK.fetch(request);
        }
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
    serviceBindings: { DOCK: "apc-dock", PULSE: "apc-pulse", SITE: "apc-site" },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [internet, builtWorker("apc-site", "apps/site/dist/apc_site/wrangler.json"), builtWorker("apc-dock", "apps/dock/dist/apc_dock/wrangler.json"), builtWorker("apc-pulse", "apps/demo/dist/apc_pulse/wrangler.json"), {
        // Test-only access to the real exported class and binding; never a route in the shipped Worker.
        name: "wake-budget-probe",
        modules: true,
        compatibilityDate: "2026-10-01",
        durableObjects: { WAKE_BUDGET: { className: "WakeBudget", scriptName: "apc-pulse", useSQLite: true } },
        script: `export default { async fetch(request, env) {
          const { now, count } = await request.json();
          const budget = env.WAKE_BUDGET.get(env.WAKE_BUDGET.idFromName("global"));
          let granted = 0;
          // Deliberately pass an obsolete caller timestamp: the real class must ignore it and use its own clock.
          for (let i = 0; i < count; i++) if (await budget.take(now)) granted++;
          return Response.json({ granted });
        } };`,
      }],
    }),
  );
  const runtime = {
    send: (url, init) => mf.dispatchFetch(url, init),
    stop: () => mf.dispose(),
    takeWakeSlots: async (now, count) => {
      const probe = await mf.getWorker("wake-budget-probe");
      return (await probe.fetch("https://probe.test", { method: "POST", body: JSON.stringify({ now, count }) })).json();
    },
  };
  try {
    await mf.ready;
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }
  return runtime;
}
