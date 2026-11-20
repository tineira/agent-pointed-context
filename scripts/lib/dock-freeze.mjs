// The Dock freeze rule (AGENTS.md "Freezes", TIN-1010): the Dock apps moved to tineira/agent-dock, which alone
// deploys apc-dock, builds the extension zip and builds and signs Dock for Windows. A diff may only delete files
// under the frozen paths (the removal PR does); adding or modifying one fails, a rename out of them included.
// Pure logic; scripts/check-dock-freeze.mjs feeds it the git diff.

export const FROZEN_PATHS = [
  "apps/dock/",
  "apps/extension/",
  "apps/dock-desktop/",
  ".github/workflows/dock-desktop.yml",
  ".github/workflows/extension.yml",
];

export const DOCK_HOME = "tineira/agent-dock";

const norm = (file) => file.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/** A path under one of the frozen folders, or one of the frozen workflow files. */
export function isFrozenDockPath(file) {
  const path = norm(file);
  if (!path) return false;
  return FROZEN_PATHS.some((frozen) => (frozen.endsWith("/") ? path.startsWith(frozen) : path === frozen));
}

/**
 * One line of `git diff --name-status`: the status (A, D, M, R100, C75, T…) and the paths it names — two for a
 * rename or copy. Returns null for a line it cannot read.
 * @param {string} line
 * @returns {{ status: string; paths: string[] } | null}
 */
export function parseNameStatus(line) {
  const fields = String(line).split("\t").map((field) => field.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const [raw, ...paths] = fields;
  if (!/^[ADCMRTUXB]\d*$/.test(raw)) return null;
  return { status: raw[0], paths: paths.map(norm) };
}

/**
 * The freeze: diff entries from parseNameStatus. A deletion passes; every other change that touches a frozen
 * path fails, including a rename whose old or new path is frozen (moving Dock code into this repo's live tree is
 * a change here, not a deletion).
 * @param {{ entries: Array<{ status: string; paths: string[] }> }} input
 * @returns {{ ok: boolean; violations: string[]; reason: string }}
 */
export function checkDockFreeze({ entries }) {
  const violations = [];
  for (const { status, paths } of entries) {
    if (status === "D") continue;
    for (const path of paths) {
      if (isFrozenDockPath(path)) violations.push(`${status}\t${path}`);
    }
  }
  if (violations.length === 0) {
    return { ok: true, violations, reason: "No frozen Dock path was added or modified." };
  }
  return {
    ok: false,
    violations,
    reason:
      `the diff adds or modifies frozen Dock paths: ${violations.join(", ")}. ` +
      `The Dock lives in ${DOCK_HOME} since TIN-1010; this repo only deletes these files (a later PR does), ` +
      `and never builds or signs Dock for Windows here again.`,
  };
}
