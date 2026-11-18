// The site must survive moving Dock out of this repo; Dock must build without the demo app.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
test("site and Dock runtime sources respect the extraction boundaries", () => {
  for (const app of ["site", "dock"]) {
    const src = resolve(root, "apps", app, "src");
    const files = readdirSync(src, { recursive: true }).filter((file) => /\.(ts|tsx|css)$/.test(file));
    assert.ok(files.length > 10, app);
    for (const file of files) {
      const path = resolve(src, file);
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(path), match[1]);
        // The extension stays with Dock; only site/Dock/demo source dependencies prevent this split.
        for (const forbidden of app === "site" ? ["dock", "demo"] : ["site", "demo"]) {
          const directory = resolve(root, "apps", forbidden);
          assert.ok(!target.startsWith(directory + "/") && !target.startsWith(directory + "\\"), `${app}/${file} imports ${forbidden}: ${match[1]}`);
        }
      }
    }
  }
});

test("the site owns exactly six wildcard routes and Dock keeps the Custom Domain and V1 guards", () => {
  const site = JSON.parse(readFileSync(resolve(root, "apps/site/wrangler.jsonc"), "utf8"));
  assert.equal(site.name, "apc-site");
  assert.deepEqual(site.routes, ["/docs*", "/build*", "/try*", "/llms.txt*", "/site-assets/*", "/media/*"].map((path) => ({ pattern: `apc.tineira.com${path}`, zone_name: "tineira.com" })));
  assert.ok(site.assets.run_worker_first.includes("/media*"));
  const dock = readFileSync(resolve(root, "apps/dock/wrangler.jsonc"), "utf8");
  assert.match(dock, /"binding": "SITE", "service": "apc-site"/);
  assert.match(dock, /"pattern": "apc.tineira.com", "custom_domain": true/);
  assert.match(dock, /"run_worker_first": \["\/", "\/v1", "\/v1\/\*"/);
});
