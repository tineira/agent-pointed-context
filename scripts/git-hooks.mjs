// The root `prepare` script (pnpm install runs it): points git at the repo's hooks in .githooks
// (`git config core.hooksPath .githooks`), which rebuild apps/extension/dist after a pull that changes the
// extension. Only inside a git work tree; it never fails, so CI, a copy without .git and an install without git
// are not broken. Turn the hooks off with `git config --unset core.hooksPath`; to keep a later install from turning
// them on again, also `git config apc.hooks off`. A different hooksPath someone chose is left alone.
//   node scripts/git-hooks.mjs [root]
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
try {
  if (git("rev-parse", "--is-inside-work-tree") === "true") {
    const get = (key) => {
      try {
        return git("config", "--get", key);
      } catch {
        return "";
      }
    };
    const current = get("core.hooksPath");
    if (get("apc.hooks") === "off") {
      // The person turned them off for good.
    } else if (!current) {
      git("config", "core.hooksPath", ".githooks");
      console.log("git hooks: core.hooksPath is .githooks (rebuilds the APC extension after a pull; off: git config --unset core.hooksPath)");
    } else if (current !== ".githooks") {
      console.log(`git hooks: core.hooksPath is ${current}, left as it is (the repo's hooks are in .githooks)`);
    }
  }
} catch {
  // Not a git work tree, or no git: nothing to set.
}
