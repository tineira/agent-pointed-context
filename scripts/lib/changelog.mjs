// The changelog rule (AGENTS.md): a PR that changes anything beyond docs adds an entry to CHANGELOG.md or
// packages/protocol/CHANGELOG.md, unless it carries the no-changelog label. Pure logic; scripts/check-changelog.mjs
// feeds it the changed files and the labels.

export const CHANGELOGS = ["CHANGELOG.md", "packages/protocol/CHANGELOG.md"];
export const SKIP_LABEL = "no-changelog";

const norm = (file) => file.trim().replace(/\\/g, "/").replace(/^\.\//, "");

export function isChangelog(file) {
  return CHANGELOGS.includes(norm(file));
}

/** Docs-only: Markdown other than the changelogs, the docs folder, the licence and the citation file. */
export function isDocs(file) {
  const path = norm(file);
  if (isChangelog(path)) return false;
  return /\.md$/i.test(path) || path.startsWith("docs/") || path === "LICENSE" || path === "CITATION.cff";
}

export const STANDARD_CHANGELOG = "packages/protocol/CHANGELOG.md";
export const ROOT_CHANGELOG = "CHANGELOG.md";

/** The APC contract lives in packages/protocol/src. */
export function isContract(file) {
  return norm(file).startsWith("packages/protocol/src/");
}

/**
 * A change to the contract needs an entry in the standard's changelog; any other change beyond docs needs one in the
 * root changelog; a PR with both needs both. The no-changelog label skips the rule.
 * @param {{ files: string[]; labels: string[] }} input changed paths (repo-relative) and the PR's label names
 * @returns {{ ok: boolean; reason: string }}
 */
export function checkChangelog({ files, labels }) {
  const changed = files.map(norm).filter(Boolean);
  if (changed.length === 0) return { ok: true, reason: "No files changed." };
  if (labels.includes(SKIP_LABEL)) return { ok: true, reason: `The PR has the ${SKIP_LABEL} label.` };
  const code = changed.filter((file) => !isDocs(file) && !isChangelog(file));
  if (code.length === 0) return { ok: true, reason: "The PR changes docs and changelogs only." };
  const contract = code.filter(isContract);
  const other = code.filter((file) => !isContract(file));
  const problems = [];
  if (contract.length > 0 && !changed.includes(STANDARD_CHANGELOG)) {
    problems.push(`it changes the APC contract (${list(contract)}) but adds no entry to ${STANDARD_CHANGELOG}, and APC_STANDARD_VERSION must be bumped`);
  }
  if (other.length > 0 && !changed.includes(ROOT_CHANGELOG)) {
    problems.push(`it changes ${list(other)} but adds no entry under "Unreleased" in ${ROOT_CHANGELOG}`);
  }
  if (problems.length === 0) return { ok: true, reason: "The PR updates the changelog it needs." };
  return { ok: false, reason: `The PR fails the changelog rule: ${problems.join("; ")}. Add the entry, or add the ${SKIP_LABEL} label if nobody can see the change.` };
}

function list(files) {
  return files.slice(0, 5).join(", ") + (files.length > 5 ? `, and ${files.length - 5} more` : "");
}
