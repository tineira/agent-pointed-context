// The root `prepare` script (pnpm install runs it): points git at the repo's hooks in .githooks
// (`git config core.hooksPath .githooks`), which rebuild apps/extension/dist after a pull that changes the
// extension (in the main worktree only; linked worktrees skip). Only inside a git work tree; it never fails, so
// CI, a copy without .git and an install without git are not broken.
// It sets nothing when someone already has hooks of their own: a core.hooksPath other than .githooks, or any hook
// in the repository's hooks folder (<git common dir>/hooks) that is not a `.sample`, which core.hooksPath would
// silently turn off. Then it prints how to opt in.
// Turn the hooks off with `git config --unset core.hooksPath`; to keep a later install from turning them on again,
// also `git config apc.hooks off`.
//   node scripts/git-hooks.mjs [root]
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const get = (key) => {
  try {
    return git("config", "--get", key);
  } catch {
    return "";
  }
};

/** The hooks someone installed in the repository's own hooks folder (not git's .sample files). */
function ownHooks() {
  try {
    const common = resolve(root, git("rev-parse", "--git-common-dir"));
    return readdirSync(join(common, "hooks")).filter((f) => !f.endsWith(".sample"));
  } catch {
    return [];
  }
}

try {
  if (git("rev-parse", "--is-inside-work-tree") === "true") {
    const current = get("core.hooksPath");
    if (get("apc.hooks") === "off" || current === ".githooks") {
      // Turned off for good, or already on.
    } else if (current) {
      console.log(`git hooks: core.hooksPath is ${current}, left as it is (the repo's hooks are in .githooks)`);
    } else {
      const own = ownHooks();
      if (own.length) {
        console.log(`git hooks: not turned on, since .git/hooks has hooks of its own (${own.join(", ")}) that core.hooksPath would turn off. To use the repo's hooks (they rebuild the APC extension after a pull), run: git config core.hooksPath .githooks`);
      } else {
        git("config", "core.hooksPath", ".githooks");
        console.log("git hooks: core.hooksPath is .githooks (rebuilds the APC extension after a pull, in the main worktree; off: git config --unset core.hooksPath)");
      }
    }
  }
} catch {
  // Not a git work tree, or no git: nothing to set.
}
