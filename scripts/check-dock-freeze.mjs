// CI check for the Dock freeze (AGENTS.md "Freezes", TIN-1010). Usage:
//   node scripts/check-dock-freeze.mjs --pull-request <base-ref>   diffs origin/<base-ref>...HEAD (a pull request)
//   node scripts/check-dock-freeze.mjs --push <before-sha>         diffs <before-sha>..HEAD (a push to main)
// Exits 1 when the diff adds or modifies a file under the frozen Dock paths (deletions pass, the removal PR
// deletes them). A push whose before SHA is missing (a created or rewritten main) cannot prove the freeze: fail.
import { execFileSync } from "node:child_process";
import { checkDockFreeze, parseNameStatus } from "./lib/dock-freeze.mjs";

const [mode, ref] = process.argv.slice(2);
if (!((mode === "--pull-request" || mode === "--push") && ref)) {
  console.error("usage: node scripts/check-dock-freeze.mjs --pull-request <base-ref> | --push <before-sha>");
  process.exit(2);
}

let range;
if (mode === "--pull-request") {
  range = [`origin/${ref.replace(/^origin\//, "")}...HEAD`];
} else {
  if (/^0+$/.test(ref)) {
    console.error("FAIL: the push carries no before SHA (a created or rewritten main), so the Dock freeze cannot be proven.");
    process.exit(1);
  }
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    console.error(`FAIL: the push's before SHA ${ref} is not in the clone (fetch-depth: 0?), so the Dock freeze cannot be proven.`);
    process.exit(1);
  }
  range = [ref, "HEAD"];
}

let diff;
try {
  diff = execFileSync("git", ["diff", "--name-status", ...range, "--"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  const detail = String(error.stderr ?? error.message).trim();
  console.error(`could not diff ${range.join(" ")} (is the base fetched? checkout needs fetch-depth: 0): ${detail}`);
  process.exit(2);
}

const entries = diff.split("\n").filter(Boolean).map(parseNameStatus).filter(Boolean);
const result = checkDockFreeze({ entries });
if (diff.trim()) console.log(diff.trim());
console.log(result.ok ? `ok: ${result.reason}` : `FAIL: ${result.reason}`);
process.exit(result.ok ? 0 : 1);
