// A temporary folder that goes away with the process (TIN-613): scripts/publish-local.mjs packs the tarballs into
// one and must not leave it behind after a dry run, a publish or a failure. It is removed on the process's `exit`
// event, which runs on a normal end and on every process.exit() (the script's stop() included), and Ctrl+C is
// turned into an exit so it runs then too.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Makes `<os temp>/<prefix>XXXXXX` and removes it, with everything in it, when the process exits.
 * @param {string} prefix
 * @returns {string} the folder
 */
export function tempFolderUntilExit(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) if (process.listenerCount(signal) === 0) process.once(signal, () => process.exit(130));
  return dir;
}
