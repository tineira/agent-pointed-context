import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const buildScript = fileURLToPath(new URL("../build.mjs", import.meta.url));

function runBuild(out: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [buildScript, "--out", out], { env: { ...process.env, ...env }, timeout: 120_000 }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code ?? 1) : 0, output: stdout + stderr });
    });
  });
}

test("a failed build leaves the previous one in place and loadable; a good one replaces it whole", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "apc-extbuild-"));
  try {
    const out = join(dir, "dist");
    mkdirSync(out);
    const previous = '{ "manifest_version": 3, "version": "0.2.1" }\n';
    writeFileSync(join(out, "manifest.json"), previous);
    writeFileSync(join(out, "content.js"), "// the previous build\n");

    const failed = await runBuild(out, { APC_EXTENSION_BUILD_FAIL_AFTER: "1" });
    assert.notEqual(failed.code, 0, failed.output);
    assert.match(failed.output, /is unchanged/);
    assert.equal(readFileSync(join(out, "manifest.json"), "utf8"), previous, "the old manifest is still there");
    assert.equal(readFileSync(join(out, "content.js"), "utf8"), "// the previous build\n", "the old content script was not emptied");
    assert.deepEqual(readdirSync(dir), ["dist"], "no half-built folder is left beside it");

    const built = await runBuild(out);
    assert.equal(built.code, 0, built.output);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.match(manifest.version, /^0\.2\.\d+$/);
    assert.match(manifest.version_name, /^0\.2\.\d+ \(/);
    for (const file of ["dock-presence.js", "content.js", "worker.js", "popup.js", "welcome.js", "popup.html", "welcome.html", "icon-32.png", "icon-128.png"]) assert.ok(existsSync(join(out, file)), file);
    assert.notEqual(readFileSync(join(out, "content.js"), "utf8"), "// the previous build\n");
    assert.deepEqual(readdirSync(dir), ["dist"], "the old build and the work folder are gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
