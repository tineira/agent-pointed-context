// The one-time bootstrap publish (TIN-612), from a maintainer's machine: npm's trusted publishing can only be set
// up on a package that exists, so the first version of each of the four packages goes out by hand, once. After
// that, .github/workflows/publish.yml publishes every apc-v<version> tag through OIDC, with no token.
//
//   npm login                                       # once; npm asks for 2FA in the browser or terminal
//   node scripts/publish-local.mjs --dry-run         # everything but the upload
//   node scripts/publish-local.mjs                   # npm publish per package, 2FA prompt each time
//
// It refuses to run on a working tree with changes, or when the four versions do not match each other and
// APC_STANDARD_VERSION. It builds dist/, packs each package with pnpm (which rewrites workspace:^ and
// publishConfig) into a temporary folder, and runs `npm publish <tarball> --tag next --access public` per tarball,
// @tineira/apc-protocol first, stopping at the first failure.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PACKAGES, checkManifest, checkVersions, npmPublishArgs, standardVersionOf, tarballName } from "./lib/packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = values["dry-run"];

const quote = (a) => (/^[A-Za-z0-9_./:=@^-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
/** Runs a command found on PATH (npm, pnpm, git), with the terminal attached when `interactive`. */
function run(cmd, args, { interactive = false } = {}) {
  const stdio = interactive ? "inherit" : ["ignore", "pipe", "pipe"];
  const r =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map(quote).join(" ")}"`], { cwd: root, stdio, windowsVerbatimArguments: true, encoding: "utf8" })
      : spawnSync(cmd, args, { cwd: root, stdio, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trimEnd(), err: (r.stderr ?? "").trim() };
}
function stop(message) {
  console.error(`publish-local: ${message}`);
  process.exit(1);
}

// 1. A clean tree: what goes out is a commit, not local edits.
const status = run("git", ["status", "--porcelain"]);
if (!status.ok) stop(`git status failed: ${status.err}`);
if (status.out) stop(`the working tree has changes; commit or stash them first:\n${status.out}`);
const head = run("git", ["rev-parse", "HEAD"]).out;

// 2. One version for all four, matching the standard, and manifests fit to publish.
const manifests = PACKAGES.map((name) => JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")));
const standard = standardVersionOf(readFileSync(join(root, "packages", "protocol", "src", "version.ts"), "utf8"));
const versions = checkVersions({ manifests, standard });
const problems = [...versions.problems, ...manifests.flatMap(checkManifest)];
if (problems.length || !versions.version) stop(`not publishable:\n- ${problems.join("\n- ")}`);
const version = versions.version;

// 3. Signed in to npm (a dry run needs no account).
if (!dryRun) {
  const who = run("npm", ["whoami"]);
  if (!who.ok) stop("not signed in to npm: run `npm login` first");
  console.log(`publish-local: signed in to npm as ${who.out.trim()}`);
}

// 4. Build, check, pack with pnpm.
for (const [cmd, args] of [
  [process.execPath, [join(root, "scripts", "build-packages.mjs")]],
  [process.execPath, [join(root, "scripts", "check-packages.mjs"), "--dist"]],
]) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) stop(`${args[0]} failed`);
}
const out = mkdtempSync(join(tmpdir(), "apc-publish-"));
const packed = run("pnpm", ["-r", "--filter", "./packages/*", "pack", "--pack-destination", out]);
if (!packed.ok) stop(`pnpm pack failed:\n${packed.err || packed.out}`);
const tarballs = PACKAGES.map((dir) => join(out, tarballName(dir, version)));
for (const t of tarballs) if (!existsSync(t)) stop(`pnpm pack made no ${t}`);
console.log(`publish-local: ${version} at ${head.slice(0, 12)}, packed into ${out}${dryRun ? " (dry run)" : ""}`);

// 5. npm publish per tarball, protocol first; npm asks for 2FA each time.
const done = [];
for (const [i, t] of tarballs.entries()) {
  const name = `@tineira/apc-${PACKAGES[i]}@${version}`;
  console.log(`\npublish-local: npm ${npmPublishArgs(t, { dryRun }).join(" ")}`);
  if (!run("npm", npmPublishArgs(t, { dryRun }), { interactive: true }).ok) stop(`npm publish failed for ${name}${done.length ? `; already published: ${done.join(", ")}` : ""}`);
  done.push(name);
}
console.log(`\npublish-local: ${dryRun ? "dry run of" : "published"} ${done.join(", ")} on the "next" tag.`);
if (!dryRun) {
  console.log(
    "Next, on npmjs.com, for each of the four packages: Settings > Trusted Publisher > GitHub Actions, organization or user `tineira`, repository `agent-pointed-context`, workflow filename `publish.yml`, no environment. From then on a tag apc-v<version> publishes through .github/workflows/publish.yml.",
  );
}
