// The Dock freeze rule (AGENTS.md "Freezes", TIN-1010): the Dock apps moved to tineira/agent-dock, which alone
// deploys apc-dock, builds the extension zip and builds and signs Dock for Windows; the removal PR deleted them
// here. The guard stays so they never come back: a diff may only delete files under the frozen paths; adding or
// modifying one fails, a rename into or out of them included. Pure logic; scripts/check-dock-freeze.mjs feeds it
// the git diff.

export const FROZEN_PATHS = [
  "apps/dock/",
  "apps/extension/",
  "apps/dock-desktop/",
  // The two workflow files were deleted by the PR that introduced this guard and the three folders by the removal
  // PR (TIN-1010): a re-added dock-desktop.yml could again be dispatched to sign a Dock for Windows build with the
  // old key, which every bridged install rejects, and a re-added extension.yml would publish the extension from
  // here. Every path stays listed so adding any of them back fails the freeze.
  ".github/workflows/dock-desktop.yml",
  ".github/workflows/extension.yml",
];

export const DOCK_HOME = "tineira/agent-dock";

const norm = (file) => file.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * A path under one of the frozen folders, or one of the frozen workflow files. Case-insensitive (TIN-1036): on
 * Windows and macOS checkouts `apps/Dock/` is the same folder as `apps/dock/`, so it must not slip past the freeze.
 * Windows also drops a name's trailing dots and spaces (`apps/dock./x` is `apps/dock/x` there), so they go too.
 */
export function isFrozenDockPath(file) {
  const path = norm(file)
    .toLowerCase()
    .split("/")
    .map((segment) => segment.replace(/[. ]+$/, ""))
    .join("/");
  if (!path) return false;
  return FROZEN_PATHS.some((frozen) => (frozen.endsWith("/") ? path.startsWith(frozen) : path === frozen));
}

/**
 * One record of `git diff -z --name-status`: the whole NUL-separated stream, each record a status field
 * (A, D, M, R100, C75, T…) followed by one path, two for a rename, copy or broken pair. With -z git writes
 * paths verbatim — never the core.quotePath quoting of the tab-separated format — so a non-ASCII, tabbed or
 * quoted name arrives whole; that is why the freeze reads -z output only. Throws on a field that is not a
 * status or a record without its path(s): the stream is desynced and the freeze can prove nothing.
 * @param {string | Buffer} input
 * @returns {Array<{ status: string; raw: string; paths: string[] }>}
 */
export function parseNameStatusZ(input) {
  const fields = (Buffer.isBuffer(input) ? input.toString("utf8") : String(input)).split("\0");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i];
    if (!raw) continue; // the trailing NUL after the last record; nothing real is ever empty
    if (!/^[ADCMRTUXB]\d*$/.test(raw)) throw new Error(`cannot read a diff record at field ${i}: ${JSON.stringify(raw)}`);
    const two = /^[RCBX]/.test(raw) ? 2 : 1; // a rename, copy or broken pair carries two paths
    const paths = fields.slice(i + 1, i + 1 + two).map(norm);
    if (paths.length < two || paths.some((path) => !path)) throw new Error(`diff record ${raw} is missing its path(s)`);
    entries.push({ status: raw[0], raw, paths });
    i += two;
  }
  return entries;
}

/**
 * The freeze: diff entries from parseNameStatusZ. A deletion passes; every other change that touches a frozen
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
      `The Dock lives in ${DOCK_HOME} since TIN-1010 and was removed from this repo: these paths must not come back, ` +
      `and this repo never builds or signs Dock for Windows again.`,
  };
}
