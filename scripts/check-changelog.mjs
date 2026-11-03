// CI check for the changelog rule. Usage: node scripts/check-changelog.mjs <base-ref> [labels-json]
// Diffs origin/<base-ref>...HEAD; the labels come as a JSON array (CI passes the PR event's labels) or the LABELS
// environment variable. Exits 1 when the PR changes more than docs and updates no changelog.
import { execFileSync } from "node:child_process";
import { checkChangelog } from "./lib/changelog.mjs";

const base = process.argv[2]?.replace(/^origin\//, "");
if (!base) {
  console.error("usage: node scripts/check-changelog.mjs <base-ref> [labels-json]");
  process.exit(2);
}
let labels;
try {
  labels = JSON.parse(process.argv[3] ?? process.env.LABELS ?? "[]");
  if (!Array.isArray(labels)) throw new Error("not an array");
} catch (error) {
  console.error(`labels must be a JSON array: ${error.message}`);
  process.exit(2);
}
let diff;
try {
  diff = execFileSync("git", ["diff", "--name-only", `origin/${base}...HEAD`, "--"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  const detail = String(error.stderr ?? error.message).trim();
  console.error(`could not diff origin/${base}...HEAD (is the base fetched? checkout needs fetch-depth: 0): ${detail}`);
  process.exit(2);
}
const files = diff.split("\n").filter(Boolean);
const names = labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
const result = checkChangelog({ files, labels: names });
console.log(files.join("\n"));
console.log(result.ok ? `ok: ${result.reason}` : `FAIL: ${result.reason}`);
process.exit(result.ok ? 0 : 1);
