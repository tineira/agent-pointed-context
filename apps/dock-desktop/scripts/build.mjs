#!/usr/bin/env node
// Builds the dock for Windows as this commit's version (TIN-615), in CI and locally alike:
//
//   node scripts/build.mjs [--updater] [tauri build options] [-- cargo options]
//
// The version is 0.2.<commits on HEAD>, so every build of main is newer than the one before it (and
// than the 0.1.0 of the first builds); the commit shows next to it in the tray. Both are stamped into
// this build only, never committed: the version through a config overlay in target/, which the Tauri
// CLI merges into tauri.conf.json (the app, the exe's file version and the NSIS installer all take it),
// the commit through APC_DOCK_COMMIT (src/update.rs).
//
// --updater also makes the updater's artifacts: the installer's .sig, signed with the key in
// TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD), which only the workflow's builds of main have. Without
// it the build is unsigned and makes none, as PR builds and local builds do.
//
// In GitHub Actions, the version and the commit are also step outputs.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();

if (git("rev-parse", "--is-shallow-repository") === "true") {
  console.error("A shallow clone cannot count main's commits: fetch the whole history (actions/checkout with fetch-depth: 0).");
  process.exit(1);
}
const version = `0.2.${git("rev-list", "--count", "HEAD")}`;
const commit = git("rev-parse", "--short=7", "HEAD");

const args = process.argv.slice(2);
const updater = args[0] === "--updater";
if (updater) args.shift();

const overlay = join("target", "apc-dock-build.json");
mkdirSync(join(app, "target"), { recursive: true });
writeFileSync(join(app, overlay), JSON.stringify({ version, bundle: { createUpdaterArtifacts: updater } }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ncommit=${commit}\n`);
console.log(`Building APC dock ${version} (${commit}), ${updater ? "signed for the updater" : "unsigned"}`);

// The Tauri CLI at a release at least two weeks old, outside the pnpm workspace (it needs no package.json).
const build = spawnSync("npx", ["--yes", "@tauri-apps/cli@2.12.2", "build", "--config", overlay, ...args], {
  cwd: app,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, APC_DOCK_COMMIT: commit },
});
process.exit(build.status ?? 1);
