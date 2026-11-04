// Builds the published packages (TIN-612): ESM JavaScript and .d.ts in packages/<name>/dist, with tsc in
// build mode (tsconfig.build.json; the others reference @apc/protocol's). The apps and the tests keep using
// the TypeScript sources (package.json "exports"); only what pnpm publishes points at dist ("publishConfig").
//   node scripts/build-packages.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, rewriteDeclaration } from "./lib/packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

for (const name of PACKAGES) rmSync(join(root, "packages", name, "dist"), { recursive: true, force: true });

const configs = PACKAGES.map((name) => join(root, "packages", name, "tsconfig.build.json"));
const built = spawnSync(process.execPath, [tsc, "-b", ...configs], { cwd: root, stdio: "inherit" });
if (built.status !== 0) {
  console.error("build-packages: tsc failed");
  process.exit(built.status ?? 1);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const name of PACKAGES) {
  const dist = join(root, "packages", name, "dist");
  for (const file of walk(dist)) {
    if (file.endsWith(".tsbuildinfo")) rmSync(file);
    else if (file.endsWith(".d.ts")) writeFileSync(file, rewriteDeclaration(readFileSync(file, "utf8")));
  }
}
console.log(`build-packages: built ${PACKAGES.map((n) => `@apc/${n}`).join(", ")} into packages/*/dist`);
