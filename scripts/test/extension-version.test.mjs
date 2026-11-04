// The browser extension's version from git (APC 0.7.1), the hooks that rebuild apps/extension/dist after a pull,
// and the prepare script that turns them on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTENSION_INPUTS, UNKNOWN_EXTENSION_VERSION, extensionRebuildPlan, extensionVersionFor, isExtensionInput, readExtensionVersion } from "../lib/extension-version.mjs";

const repo = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const node = (script, args, cwd) => execFileSync(process.execPath, [repo(script), ...args], { cwd, encoding: "utf8" }).trim();

/** A throwaway git repository; `commit(files)` writes the files and commits them, returning the commit. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "apc-extversion-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", Object.keys(files).join(" "));
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the extension's inputs are the paths extension.yml rebuilds the zip on", () => {
  const workflow = readFileSync(repo(".github/workflows/extension.yml"), "utf8");
  const lists = [...workflow.matchAll(/paths: \[([^\]]*)\]/g)].map((m) => JSON.parse(`[${m[1]}]`));
  assert.equal(lists.length, 2, "push and pull_request");
  const expected = [...EXTENSION_INPUTS.map((p) => (p.includes(".") ? p : `${p}/**`)), ".github/workflows/extension.yml"].sort();
  for (const list of lists) assert.deepEqual([...list].sort(), expected, "a new input must be both a zip trigger and a version input");
});

test("a change to the extension redeploys the dock, which bakes in the latest version", () => {
  const ci = readFileSync(repo(".github/workflows/ci.yml"), "utf8");
  const pattern = new RegExp(/echo "standard=\$\(echo "\$files" \| grep -qE '([^']+)'/.exec(ci)[1]);
  for (const input of EXTENSION_INPUTS) assert.ok(pattern.test(input.includes(".") ? input : `${input}/src/x.ts`), `${input} redeploys the standard`);
  for (const [file, job] of [[".github/workflows/ci.yml", "check:"], [".github/workflows/ci.yml", "deploy-standard:"], [".github/workflows/extension.yml", "build:"], [".github/workflows/publish.yml", "dry-run:"], [".github/workflows/publish.yml", "publish:"]]) {
    const text = readFileSync(repo(file), "utf8");
    const start = text.indexOf(`\n  ${job}`);
    assert.ok(start > 0, `${file} has ${job}`);
    assert.match(text.slice(start, text.indexOf("- run:", start)), /fetch-depth: 0/, `${file} ${job} checks out the full history: a shallow clone has no commit count`);
  }
});

test("which changed files are the extension's inputs, and when the hooks install first", () => {
  for (const f of ["apps/extension/src/popup.ts", "apps/extension/manifest.json", "apps/dock/src/worker/reading.ts", "packages/web/src/pinning.ts", "packages/protocol/package.json", "pnpm-lock.yaml", "apps\\extension\\build.mjs"]) assert.ok(isExtensionInput(f), f);
  for (const f of ["apps/dock/src/web/hub.tsx", "apps/extension-old/x", "packages/server/src/index.ts", "packages/webby/x", "README.md", "apps/dock/src/worker/reading.test.ts"]) assert.ok(!isExtensionInput(f), f);
  assert.deepEqual(extensionRebuildPlan(["README.md"]), { rebuild: false, install: false });
  assert.deepEqual(extensionRebuildPlan(["README.md", "apps/extension/src/popup.ts"]), { rebuild: true, install: false });
  assert.deepEqual(extensionRebuildPlan(["pnpm-lock.yaml"]), { rebuild: true, install: true });
  assert.deepEqual(extensionRebuildPlan([]), { rebuild: false, install: false });
});

test("Chrome takes the version: 0.2.<count>, within 65535", () => {
  assert.equal(extensionVersionFor(131), "0.2.131");
  for (const bad of [0, -1, 1.5, 65536, Number.NaN]) assert.throws(() => extensionVersionFor(bad), String(bad));
  assert.equal(UNKNOWN_EXTENSION_VERSION, "0.2.0");
});

test("the version moves only with a change to the extension, and only up; a shallow clone refuses", () => {
  const r = scratchRepo();
  try {
    r.commit({ "README.md": "a" });
    assert.throws(() => readExtensionVersion(r.dir), /no commit changed/);
    r.commit({ "apps/extension/manifest.json": "{}" });
    const first = readExtensionVersion(r.dir);
    assert.equal(first.version, "0.2.2");
    assert.equal(first.commit, r.git("rev-parse", "--short", "HEAD"));
    r.commit({ "apps/dock/src/web/hub.tsx": "x", "README.md": "b" });
    assert.deepEqual(readExtensionVersion(r.dir), first, "a commit that leaves the extension alone keeps its version: the dock built later names the zip's");
    r.commit({ "packages/web/src/x.ts": "y" });
    assert.equal(readExtensionVersion(r.dir).version, "0.2.4");
    r.commit({ "pnpm-lock.yaml": "z" });
    assert.equal(readExtensionVersion(r.dir).version, "0.2.5");

    const shallow = mkdtempSync(join(tmpdir(), "apc-extversion-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(r.dir).href, shallow], { stdio: "ignore" });
      assert.throws(() => readExtensionVersion(shallow), /shallow clone/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
    const plain = mkdtempSync(join(tmpdir(), "apc-extversion-plain-"));
    try {
      assert.deepEqual(readExtensionVersion(plain), { version: UNKNOWN_EXTENSION_VERSION, commit: null }, "no git: the lowest version, and the dock knows no latest");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    r.done();
  }
});

test("scripts/extension-changed.mjs tells the hooks what to do between two commits, and never fails", () => {
  const r = scratchRepo();
  try {
    const a = r.commit({ "README.md": "a" });
    const b = r.commit({ "apps/dock/src/web/hub.tsx": "x" });
    const c = r.commit({ "apps/extension/src/popup.ts": "y" });
    const d = r.commit({ "pnpm-lock.yaml": "z" });
    const changed = (from, to) => node("scripts/extension-changed.mjs", [from, to, r.dir]);
    assert.equal(changed(a, b), "none");
    assert.equal(changed(b, c), "rebuild");
    assert.equal(changed(a, d), "install-rebuild");
    assert.equal(changed(d, a), "install-rebuild", "a checkout back to an older branch rebuilds too");
    assert.equal(changed(c, c), "none");
    assert.equal(changed("0000000000000000000000000000000000000000", d), "none", "a fresh clone or a new worktree");
    assert.equal(changed("not-a-commit", d), "none", "git could not say: nothing, and exit 0");
    assert.equal(node("scripts/extension-changed.mjs", [], r.dir), "none");
  } finally {
    r.done();
  }
});

test("the hooks are POSIX sh, executable, and never block git", () => {
  const modes = execFileSync("git", ["-C", repo("."), "ls-files", "-s", "--", ".githooks"], { encoding: "utf8" });
  for (const hook of ["post-merge", "post-checkout", "post-rewrite"]) {
    const text = readFileSync(repo(`.githooks/${hook}`), "utf8");
    assert.ok(text.startsWith("#!/bin/sh\n"), hook);
    assert.match(text, /\. "\$\(dirname "\$0"\)\/lib\/rebuild-extension\.sh"/, hook);
    assert.match(text.trimEnd(), /exit 0$/, `${hook} ends with exit 0`);
    assert.match(modes, new RegExp(`^100755 \\S+ \\d\\t\\.githooks/${hook}$`, "m"), `${hook} is executable in git`);
    assert.ok(!text.includes("\r"), `${hook} has LF line endings`);
  }
  assert.match(readFileSync(repo(".githooks/post-checkout"), "utf8"), /\[ "\$3" = "1" \] \|\| exit 0/, "branch checkouts only");
  assert.match(readFileSync(repo(".githooks/post-rewrite"), "utf8"), /\[ "\$1" = "rebase" \] \|\| exit 0/, "rebases only");
  const lib = readFileSync(repo(".githooks/lib/rebuild-extension.sh"), "utf8");
  assert.ok(lib.includes("scripts/extension-changed.mjs") && lib.includes("node apps/extension/build.mjs < /dev/null"));
  assert.ok(lib.includes("CI=true pnpm install --frozen-lockfile < /dev/null"), "pnpm never waits for an answer nobody sees");
  assert.ok(lib.includes("APC extension rebuilt into apps/extension/dist: reload it on chrome://extensions"));
  assert.ok(!/\bexit 1\b|return 1\b/.test(lib), "a failed build warns and returns 0");
  assert.match(lib, /--git-dir[\s\S]*--git-common-dir[\s\S]*\[ "\$git_dir" = "\$common_dir" \] \|\| return 0/, "a linked worktree (an agent's) never rebuilds");
  assert.match(lib, /APC_HOOKS_IN_WORKTREES/);
});

test("prepare sets core.hooksPath inside a git work tree only, and leaves a person's choice alone", () => {
  const pkg = JSON.parse(readFileSync(repo("package.json"), "utf8"));
  assert.equal(pkg.scripts.prepare, "node scripts/git-hooks.mjs");
  const r = scratchRepo();
  const plain = mkdtempSync(join(tmpdir(), "apc-hooks-plain-"));
  try {
    r.commit({ "README.md": "a" });
    const hooksPath = () => {
      try {
        return r.git("config", "--get", "core.hooksPath");
      } catch {
        return "";
      }
    };
    node("scripts/git-hooks.mjs", [r.dir], r.dir);
    assert.equal(hooksPath(), ".githooks");
    r.git("config", "core.hooksPath", "my-hooks");
    node("scripts/git-hooks.mjs", [r.dir], r.dir);
    assert.equal(hooksPath(), "my-hooks", "someone else's hooksPath is kept");
    r.git("config", "--unset", "core.hooksPath");
    writeFileSync(join(r.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    const said = node("scripts/git-hooks.mjs", [r.dir], r.dir);
    assert.equal(hooksPath(), "", "hooks of the person's own in .git/hooks: core.hooksPath would turn them off, so nothing is set");
    assert.match(said, /pre-commit/);
    assert.match(said, /git config core\.hooksPath \.githooks/, "it says how to opt in");
    rmSync(join(r.dir, ".git", "hooks", "pre-commit"));
    r.git("config", "apc.hooks", "off");
    node("scripts/git-hooks.mjs", [r.dir], r.dir);
    assert.equal(hooksPath(), "", "apc.hooks off keeps them off across installs");
    assert.doesNotThrow(() => node("scripts/git-hooks.mjs", [plain], plain), "not a git work tree: exit 0");
    assert.doesNotThrow(() => node("scripts/git-hooks.mjs", [join(plain, "missing")], plain));
  } finally {
    r.done();
    rmSync(plain, { recursive: true, force: true });
  }
});
