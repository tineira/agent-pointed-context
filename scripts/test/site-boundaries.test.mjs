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
  assert.equal(site.workers_dev, false, "the site needs the Dock origin's public assets and APIs");
  assert.deepEqual(site.routes, ["/docs*", "/build*", "/try*", "/llms.txt*", "/site-assets/*", "/media/*"].map((path) => ({ pattern: `apc.tineira.com${path}`, zone_name: "tineira.com" })));
  assert.ok(site.assets.run_worker_first.includes("/media*"));
  const dock = readFileSync(resolve(root, "apps/dock/wrangler.jsonc"), "utf8");
  assert.match(dock, /"binding": "SITE", "service": "apc-site"/);
  assert.match(dock, /"pattern": "apc.tineira.com", "custom_domain": true/);
  assert.match(dock, /"run_worker_first": \["\/", "\/v1", "\/v1\/\*"/);
});

test("site tests do not read Dock files", () => {
  const directory = resolve(root, "apps/site/test");
  for (const file of readdirSync(directory).filter((file) => /\.test\.ts$/.test(file))) {
    assert.doesNotMatch(readFileSync(resolve(directory, file), "utf8"), /apps\/dock\/|(?:\.\.\/)+dock\//, file);
  }
});

test("modules copied for the extraction stay in sync until Dock leaves", () => {
  const groups = [
    ["demo", "dock", "site"].map((app) => `apps/${app}/src/model/products.ts`),
    ...["agent-brands.ts", "agent-icon.tsx", "agent-logos.ts"].map((file) => ["demo", "dock", "site"].map((app) => `apps/${app}/src/web/${file}`)),
    ...["client-icon.ts", "page.ts", "sessions.ts"].map((file) => ["demo", "dock"].map((app) => `apps/${app}/src/worker/${file}`)),
    ...["qr.tsx", "start-over.tsx"].map((file) => ["demo", "dock"].map((app) => `apps/${app}/src/web/${file}`)),
  ];
  const source = (file) => readFileSync(resolve(root, file), "utf8").replace(/^\/\/ Copied from[^\n]*\n/, "");
  for (const [original, ...copies] of groups) for (const file of copies) assert.equal(source(file), source(original), `${file} drifted from ${original}`);
});

test("the extraction preserves shared Dock note sizes and docs heading weight", () => {
  const css = readFileSync(resolve(root, "apps/dock/src/web/dock.css"), "utf8");
  const note = [...css.matchAll(/(?:^|\n)\.small-note\s*\{([^}]+)\}/g)].map((match) => match[1]).join(";");
  const lastValue = (property) => [...note.matchAll(new RegExp(`${property}:\\s*([^;]+)`, "g"))].at(-1)?.[1].trim();
  assert.equal(lastValue("font-size"), "13px");
  assert.equal(lastValue("margin-top"), "10px");
  const site = readFileSync(resolve(root, "apps/site/src/web/site.css"), "utf8");
  assert.match(site, /\.docs-body h2\s*\{[^}]*font-weight:\s*600[;}]/);
});

test("rollback instructions remove the site routes before retiring the binding target", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.match(readme, /After a revert or a Dock rollback,[^\n]+remove the six `apc-site` zone routes/);
  assert.match(readme, /or redeploy `apc-site` without them:[^\n]+frozen copy/);
  assert.match(readme, /Restore Dock first; never delete the `apc-site` Worker while `apc-dock` still binds it/);
});
