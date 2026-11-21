// The site stands alone: the Dock apps left this repo (TIN-1010), and the site must not depend on Pulse's sources.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
test("site runtime sources import neither the demo app nor a Dock app", () => {
  const src = resolve(root, "apps", "site", "src");
  const files = readdirSync(src, { recursive: true }).filter((file) => /\.(ts|tsx|css)$/.test(file));
  assert.ok(files.length > 10, "site");
  for (const file of files) {
    const path = resolve(src, file);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(path), match[1]);
      for (const forbidden of ["dock", "extension", "dock-desktop", "demo"]) {
        const directory = resolve(root, "apps", forbidden);
        assert.ok(!target.startsWith(directory + "/") && !target.startsWith(directory + "\\"), `site/${file} imports ${forbidden}: ${match[1]}`);
      }
    }
  }
});

test("the site owns exactly six wildcard routes", () => {
  // apc-dock (tineira/agent-dock) keeps the Custom Domain apc.tineira.com and binds this Worker as SITE; the
  // zone routes below take precedence over the Custom Domain for these paths.
  const site = JSON.parse(readFileSync(resolve(root, "apps/site/wrangler.jsonc"), "utf8"));
  assert.equal(site.name, "apc-site");
  assert.equal(site.workers_dev, false, "the site needs the Dock origin's public assets and APIs");
  assert.deepEqual(site.routes, ["/docs*", "/build*", "/try*", "/llms.txt*", "/site-assets/*", "/media/*"].map((path) => ({ pattern: `apc.tineira.com${path}`, zone_name: "tineira.com" })));
  assert.ok(site.assets.run_worker_first.includes("/media*"));
});

test("site tests do not read Dock files", () => {
  const directory = resolve(root, "apps/site/test");
  for (const file of readdirSync(directory).filter((file) => /\.test\.ts$/.test(file))) {
    assert.doesNotMatch(readFileSync(resolve(directory, file), "utf8"), /apps\/dock\/|(?:\.\.\/)+dock\//, file);
  }
});

test("modules copied for the extraction stay in sync between Pulse and the site", () => {
  const groups = [
    ["demo", "site"].map((app) => `apps/${app}/src/model/products.ts`),
    ...["agent-brands.ts", "agent-icon.tsx", "agent-logos.ts"].map((file) => ["demo", "site"].map((app) => `apps/${app}/src/web/${file}`)),
  ];
  const source = (file) => readFileSync(resolve(root, file), "utf8").replace(/^\/\/ Copied from[^\n]*\n/, "");
  for (const [original, ...copies] of groups) for (const file of copies) assert.equal(source(file), source(original), `${file} drifted from ${original}`);
});

test("the extraction preserves the docs heading weight", () => {
  const docs = readFileSync(resolve(root, "apps/site/src/web/styles/docs.css"), "utf8");
  assert.match(docs, /\.docs-body h2\s*\{[^}]*font-weight:\s*600[;}]/);
});

test("rollback instructions remove the site routes before retiring the binding target", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.match(readme, /After a revert or a Dock rollback,[^\n]+remove the six `apc-site` zone routes/);
  assert.match(readme, /or redeploy `apc-site` without them:[^\n]+frozen copy/);
  assert.match(readme, /Restore Dock first; never delete the `apc-site` Worker while `apc-dock` still binds it/);
});
