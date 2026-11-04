import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

/** A dist from an earlier build, with a file the new build does not have. */
function previousBuild(dir: string): { out: string; manifest: string } {
  const out = join(dir, "dist");
  mkdirSync(out);
  const manifest = '{ "manifest_version": 3, "version": "0.2.1" }\n';
  writeFileSync(join(out, "manifest.json"), manifest);
  writeFileSync(join(out, "content.js"), "// the previous build\n");
  writeFileSync(join(out, "stale.js"), "// gone from the new build\n");
  return { out, manifest };
}

test("when dist cannot be swapped, it is overwritten file by file, manifest.json last, and leftovers removed", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "apc-extbuild-"));
  try {
    const { out } = previousBuild(dir);
    const built = await runBuild(out, { APC_EXTENSION_BUILD_NO_RENAME: "1" });
    assert.equal(built.code, 0, built.output);
    assert.match(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).version, /^0\.2\.\d+$/);
    assert.notEqual(readFileSync(join(out, "content.js"), "utf8"), "// the previous build\n");
    assert.equal(existsSync(join(out, "stale.js")), false, "a file the new build does not have is removed");
    assert.deepEqual(readdirSync(dir), ["dist"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copy that fails midway says dist was only partly updated, exits 2, and never writes the new manifest", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "apc-extbuild-"));
  try {
    const { out, manifest } = previousBuild(dir);
    const built = await runBuild(out, { APC_EXTENSION_BUILD_NO_RENAME: "1", APC_EXTENSION_BUILD_FAIL_COPY: "popup.js" });
    assert.equal(built.code, 2, built.output);
    assert.match(built.output, /was only partly updated: close what holds it and run node apps\/extension\/build\.mjs again/);
    assert.equal(readFileSync(join(out, "manifest.json"), "utf8"), manifest, "manifest.json is written last, so it is still the old one");
    assert.deepEqual(readdirSync(dir), ["dist"], "no work folder left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file in dist held open with no sharing (Windows): the build says so and exits 2", { timeout: 240_000, skip: process.platform !== "win32" && "only Windows holds a file against rename and write" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "apc-extbuild-"));
  const { out, manifest } = previousBuild(dir);
  const locked = join(out, "content.js").replace(/'/g, "''");
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f = [IO.File]::Open('${locked}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Seconds 120`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((done, fail) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("locked")) done();
      });
      holder.on("exit", () => fail(new Error("the lock holder exited")));
    });
    const built = await runBuild(out);
    assert.equal(built.code, 2, built.output);
    assert.match(built.output, /was only partly updated/);
    assert.equal(readFileSync(join(out, "manifest.json"), "utf8"), manifest, "the new manifest is never written over the old scripts");
  } finally {
    holder.kill();
    await new Promise((done) => (holder.exitCode !== null ? done(null) : holder.on("exit", done)));
    rmSync(dir, { recursive: true, force: true });
  }
});
