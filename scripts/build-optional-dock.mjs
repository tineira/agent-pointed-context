// Dock and the extension still build together here while the extension imports Dock's reading code.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (existsSync(new URL("../apps/dock/package.json", import.meta.url))) {
  for (const [app, args] of [
    [new URL("../apps/dock/", import.meta.url), ["node_modules/vite/bin/vite.js", "build"]],
    [new URL("../apps/extension/", import.meta.url), ["build.mjs"]],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(app), stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} else {
  console.log("Dock and extension builds skipped: apps/dock not in this repo");
}
