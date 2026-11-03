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

/**
 * @param {{ files: string[]; labels: string[] }} input changed paths (repo-relative) and the PR's label names
 * @returns {{ ok: boolean; reason: string }}
 */
export function checkChangelog({ files, labels }) {
  const changed = files.map(norm).filter(Boolean);
  if (changed.length === 0) return { ok: true, reason: "No files changed." };
  if (changed.some(isChangelog)) return { ok: true, reason: "The PR updates a changelog." };
  if (labels.includes(SKIP_LABEL)) return { ok: true, reason: `The PR has the ${SKIP_LABEL} label.` };
  const code = changed.filter((file) => !isDocs(file));
  if (code.length === 0) return { ok: true, reason: "The PR changes docs only." };
  const shown = code.slice(0, 5).join(", ") + (code.length > 5 ? `, and ${code.length - 5} more` : "");
  return {
    ok: false,
    reason: `The PR changes ${shown} but adds no entry under "Unreleased" in CHANGELOG.md (and none in packages/protocol/CHANGELOG.md for a change to the APC contract). Add one, or add the ${SKIP_LABEL} label if nobody can see the change.`,
  };
}
