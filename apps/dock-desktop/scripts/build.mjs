#!/usr/bin/env node
// Builds the dock for Windows as this commit's version (TIN-615), in CI and locally alike:
//
//   node scripts/build.mjs [--updater] [tauri build options] [-- cargo options]
//
// The version:
// - a build of main in GitHub Actions (GITHUB_EVENT_NAME push or workflow_dispatch, GITHUB_REF
//   refs/heads/main) is 0.2.<commits on HEAD>, so every build of main is newer than the one before;
// - any other build (a pull request's merge commit, another branch, a build on your machine) is
//   0.1.<commits on HEAD>, below every build of main, so an installed test build is updated by the
//   next one of main, and never offered over it;
// - APC_DOCK_VERSION=<major.minor.patch> sets it outright, to try the updater locally.
// It is stamped into this build only, never committed: the version through a config overlay in
// target/, which the Tauri CLI merges into tauri.conf.json (the app, the exe's file version and the
// NSIS installer all take it), the commit through APC_DOCK_COMMIT (src/update.rs), shown in the tray.
//
// --updater also makes the updater's artifacts: the installer's .sig, signed with the key in
// TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD), which only the workflow's signing job on main has.
// Without it the build is unsigned and makes none, as PR builds and local builds do.
//
// In GitHub Actions, the version and the commit are also step outputs.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();

const { GITHUB_EVENT_NAME, GITHUB_REF, APC_DOCK_VERSION } = process.env;
const ofMain = GITHUB_REF === "refs/heads/main" && (GITHUB_EVENT_NAME === "push" || GITHUB_EVENT_NAME === "workflow_dispatch");

function stamp() {
  if (APC_DOCK_VERSION) {
    if (!/^\d+\.\d+\.\d+$/.test(APC_DOCK_VERSION)) throw new Error(`APC_DOCK_VERSION is not major.minor.patch: ${APC_DOCK_VERSION}`);
    return APC_DOCK_VERSION;
  }
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("A shallow clone cannot count main's commits: fetch the whole history (actions/checkout with fetch-depth: 0).");
  }
  return `${ofMain ? "0.2" : "0.1"}.${git("rev-list", "--count", "HEAD")}`;
}

const version = stamp();
const commit = git("rev-parse", "--short=7", "HEAD");

const args = process.argv.slice(2);
const updater = args[0] === "--updater";
if (updater) args.shift();

const overlay = join("target", "apc-dock-build.json");
mkdirSync(join(app, "target"), { recursive: true });
writeFileSync(join(app, overlay), JSON.stringify({ version, bundle: { createUpdaterArtifacts: updater } }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ncommit=${commit}\n`);
console.log(`Building APC dock ${version} (${commit}), ${ofMain ? "a build of main" : "not a build of main"}, ${updater ? "signed for the updater" : "unsigned"}`);

// The Tauri CLI at a release at least two weeks old, outside the pnpm workspace (it needs no package.json).
const build = spawnSync("npx", ["--yes", "@tauri-apps/cli@2.12.2", "build", "--config", overlay, ...args], {
  cwd: app,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, APC_DOCK_COMMIT: commit },
});
process.exit(build.status ?? 1);
