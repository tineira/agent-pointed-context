// Checks the published packages before a release (TIN-612): one version for all four, matching
// APC_STANDARD_VERSION, and each manifest fit to publish. With --tag <tag>, the release tag must be
// apc-v<version>. With --dist, every file the published manifests point at must exist (run after
// scripts/build-packages.mjs; it is each package's prepack, so a pack without a build stops here).
//   node scripts/check-packages.mjs [--tag apc-v0.7.0] [--dist]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PACKAGES, checkManifest, checkVersions, distTargets, standardVersionOf } from "./lib/packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { tag: { type: "string" }, dist: { type: "boolean", default: false } } });

const manifests = PACKAGES.map((name) => JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")));
const standard = standardVersionOf(readFileSync(join(root, "packages", "protocol", "src", "version.ts"), "utf8"));
const versions = checkVersions({ manifests, standard, ...(values.tag !== undefined ? { tag: values.tag } : {}) });
const problems = [...versions.problems, ...manifests.flatMap(checkManifest)];
// As prepack: only pnpm turns workspace:^ into a version range and publishConfig into the published entry points;
// npm would pack the workspace manifest (exports to src/, which is not in the tarball).
const agent = process.env.npm_config_user_agent ?? "";
if (process.env.npm_lifecycle_event === "prepack" && !agent.startsWith("pnpm/")) problems.push(`pack and publish with pnpm, not ${agent.split(" ")[0] || "this tool"}: pnpm writes the published manifest (workspace:^, publishConfig)`);
if (values.dist) {
  manifests.forEach((m, i) => {
    for (const target of distTargets(m)) if (!existsSync(join(root, "packages", PACKAGES[i], target))) problems.push(`${m.name}: ${target} is missing: run node scripts/build-packages.mjs`);
  });
}
if (problems.length) {
  for (const p of problems) console.error(`check-packages: ${p}`);
  process.exit(1);
}
console.log(`check-packages: ${manifests.map((m) => m.name).join(", ")} at ${versions.version} (standard ${standard})${values.tag ? `, tag ${values.tag}` : ""}${values.dist ? ", dist built" : ""}`);
