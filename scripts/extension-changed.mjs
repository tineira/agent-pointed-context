// What the git hooks in .githooks do after HEAD moves from <old> to <new> (a pull, a merge, a branch checkout, a
// rebase): prints one word on stdout and always exits 0, so it can never block git.
//   none             nothing the extension is built from changed (or git could not say)
//   rebuild          rebuild apps/extension/dist (node build.mjs)
//   install-rebuild  pnpm-lock.yaml changed too: pnpm install --frozen-lockfile first
// The inputs are EXTENSION_INPUTS (scripts/lib/extension-version.mjs), the paths .github/workflows/extension.yml
// rebuilds the published zip on.
//   node scripts/extension-changed.mjs <old> <new> [repo root, default this repo]
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionRebuildPlan } from "./lib/extension-version.mjs";

const [from, to, rootArg] = process.argv.slice(2);
const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
let answer = "none";
try {
  if (from && to && !/^0+$/.test(from) && from !== to) {
    const files = execFileSync("git", ["-C", root, "diff", "--name-only", from, to], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    const plan = extensionRebuildPlan(files);
    answer = plan.install ? "install-rebuild" : plan.rebuild ? "rebuild" : "none";
  }
} catch {
  answer = "none";
}
console.log(answer);
