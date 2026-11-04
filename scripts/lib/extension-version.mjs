// The browser extension's version (APC 0.7.1): one number that moves with every build of main that changes the
// extension, read from git, so an installed build can say how old it is. The extension's build writes it into
// manifest.json (apps/extension/build.mjs) and the dock's build bakes in the same value as the latest one
// (apps/dock/vite.config.ts), so /dock and /extension can tell a person their extension is out of date.
//
// The version is `0.2.<n>`, where n counts the commits up to and including the last one that changed the
// extension's inputs (EXTENSION_INPUTS: the paths .github/workflows/extension.yml rebuilds the zip on). On main
// (linear, squash merges) n only grows, and a commit that leaves the extension alone keeps the version, so the
// dock built at a later commit names the same version as the zip on the release. Chrome takes 1 to 4 integers
// of 0 to 65535; builds before this one said 0.1.0 and report no version at all.
import { execFileSync } from "node:child_process";

/** What the extension is built from: a change under any of these is a new zip and a new version. */
export const EXTENSION_INPUTS = ["apps/extension", "apps/dock/src/worker/reading.ts", "packages/web", "packages/protocol", "pnpm-lock.yaml"];

/** Whether a changed file (a repo-relative path, / or \ separated) is one of the extension's inputs. */
export function isExtensionInput(file) {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return EXTENSION_INPUTS.some((p) => f === p || f.startsWith(`${p}/`));
}

/**
 * What the git hooks (.githooks) do after a change of HEAD, from the files that changed: rebuild the extension
 * when an input changed, and install first when the lockfile did.
 * @param {string[]} files
 * @returns {{ rebuild: boolean; install: boolean }}
 */
export function extensionRebuildPlan(files) {
  const rebuild = files.some(isExtensionInput);
  return { rebuild, install: rebuild && files.some((f) => f.replace(/\\/g, "/") === "pnpm-lock.yaml") };
}

/** The version a build has when git cannot say (a copy of the sources without .git): older than any real build. */
export const UNKNOWN_EXTENSION_VERSION = "0.2.0";

/** `0.2.<count>` for the number of commits up to the extension's last change. */
export function extensionVersionFor(count) {
  if (!Number.isInteger(count) || count < 1 || count > 65535) throw new Error(`extension version: ${count} is not a commit count Chrome can take (1 to 65535)`);
  return `0.2.${count}`;
}

/**
 * The extension's version from git in `root`: `{ version, commit }` (commit: the short hash of the extension's
 * last change), or `{ version: UNKNOWN_EXTENSION_VERSION, commit: null }` with a warning when root is not a git
 * checkout. A shallow clone throws: its count would be wrong (CI checks out with fetch-depth: 0).
 * @param {string} root the repository root
 * @returns {{ version: string; commit: string | null }}
 */
export function readExtensionVersion(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let shallow;
  try {
    shallow = git("rev-parse", "--is-shallow-repository");
  } catch {
    console.warn(`extension version: ${root} is not a git checkout; using ${UNKNOWN_EXTENSION_VERSION}`);
    return { version: UNKNOWN_EXTENSION_VERSION, commit: null };
  }
  if (shallow === "true") throw new Error("extension version: this is a shallow clone, so the commit count would be wrong. Fetch the full history (actions/checkout with fetch-depth: 0, or git fetch --unshallow).");
  const [full, short] = git("log", "-1", "--format=%H %h", "--", ...EXTENSION_INPUTS).split(" ");
  if (!full || !short) throw new Error(`extension version: no commit changed ${EXTENSION_INPUTS.join(", ")}`);
  return { version: extensionVersionFor(Number(git("rev-list", "--count", full))), commit: short };
}
