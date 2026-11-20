import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Mount just the built Workers and fixtures a workerd check needs. */
export async function startWorkerd({ pairing = false, site = false, dock = false, wakeBudget = false } = {}) {
  if (pairing && dock) throw new Error("startWorkerd requires a choice between the stand-in hub and Dock");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const siteRoutes = site ? JSON.parse(readFileSync(join(root, "apps/site/wrangler.jsonc"), "utf8")).routes : [];
  const sitePrefixes = siteRoutes.map(({ pattern }) => {
    if (!pattern.startsWith("apc.tineira.com/") || !pattern.endsWith("*") || pattern.slice(0, -1).includes("*")) throw new Error(`unsupported site route: ${pattern}`);
    return pattern.slice("apc.tineira.com".length, -1);
  });
  // Use Pulse's Wrangler and its Miniflare, the same versions as Pulse's build.
  const wranglerPath = createRequire(join(root, "apps/demo/package.json")).resolve("wrangler");
  const fromWrangler = createRequire(wranglerPath);
  const { unstable_getMiniflareWorkerOptions } = await import(pathToFileURL(wranglerPath).href);
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(fromWrangler.resolve("miniflare")).href);
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
  const workers = [];
  const services = {};
  const mount = (binding, worker) => {
    workers.push(worker);
    services[binding] = worker.name;
  };
  if (site) mount("SITE", builtWorker("apc-site", "apps/site/dist/apc_site/wrangler.json"));
  if (pairing || wakeBudget) mount("PULSE", builtWorker("apc-pulse", "apps/demo/dist/apc_pulse/wrangler.json"));
  if (pairing) {
    mount("SIGNALS", builtWorker("apc-signals", "apps/signals/dist/apc_signals/wrangler.json"));
    const { build } = fromWrangler("esbuild");
    const { outputFiles: [bundle] } = await build({
      entryPoints: [join(root, "apps/demo/test/workerd/stand-in-hub.mjs")],
      bundle: true,
      write: false,
      format: "esm",
      external: ["cloudflare:workers"],
    });
    mount("HUB", {
      name: "stand-in-hub",
      modules: true,
      compatibilityDate: "2026-10-01",
      script: bundle.text,
      durableObjects: { HUB: { className: "Hub", useSQLite: true } },
      outboundService: "internet",
    });
  }
  if (dock) mount("HUB", builtWorker("apc-dock", "apps/dock/dist/apc_dock/wrangler.json"));

  const internet = {
    name: "internet",
    modules: true,
    compatibilityDate: "2026-10-01",
    script: `export default {
      async fetch(request, env) {
        const { hostname, pathname } = new URL(request.url);
        if (hostname === "apc.tineira.com") {
          // The six zone patterns precede the Dock Custom Domain, query strings included.
          const site = ${JSON.stringify(sitePrefixes)}.some((prefix) => pathname.startsWith(prefix));
          const service = site ? env.SITE : env.HUB ?? env.SITE;
          if (service) {
            const response = await service.fetch(request);
            if (!env.SITE || !request.headers.has("x-workerd-report-fetch-mode")) return response;
            // Record the mode workerd actually saw; asset routes can return the same HTML in both modes.
            const result = new Response(response.body, response);
            result.headers.set("x-workerd-fetch-mode", request.headers.get("sec-fetch-mode") ?? "absent");
            return result;
          }
        }
        if (hostname === "pulse.apc.tineira.com" && env.PULSE) return env.PULSE.fetch(request);
        if (hostname === "signals.apc.tineira.com" && env.SIGNALS) return env.SIGNALS.fetch(request);
        return new Response("no network in this test: " + hostname, { status: 502 });
      },
    };`,
    serviceBindings: services,
  };
  if (wakeBudget) workers.push({
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
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [internet, ...workers] }));
  const runtime = {
    send: (url, init) => mf.dispatchFetch(url, init),
    stop: () => mf.dispose(),
    takeWakeSlots: async (now, count) => {
      const probe = await mf.getWorker("wake-budget-probe");
      return (await probe.fetch("https://probe.test", { method: "POST", body: JSON.stringify({ now, count }), signal: AbortSignal.timeout(20_000) })).json();
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
