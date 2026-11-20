import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DOCK_HOME, FROZEN_PATHS, checkDockFreeze, isFrozenDockPath, parseNameStatusZ } from "../lib/dock-freeze.mjs";

const entry = (status, ...paths) => ({ status, paths });

test("parseNameStatusZ reads -z records: one path, two for a rename, copy or broken pair", () => {
  assert.deepEqual(parseNameStatusZ("M\0apps/dock/package.json\0"), [{ status: "M", raw: "M", paths: ["apps/dock/package.json"] }]);
  assert.deepEqual(parseNameStatusZ("R100\0apps/dock/src/worker/hub.ts\0packages/server/src/hub.ts\0"), [
    { status: "R", raw: "R100", paths: ["apps/dock/src/worker/hub.ts", "packages/server/src/hub.ts"] },
  ]);
  assert.deepEqual(parseNameStatusZ("A\0apps/extension/src/new.ts\0C75\0a.ts\0apps/extension/src/b.ts\0B\0b.ts\0c.ts\0"), [
    { status: "A", raw: "A", paths: ["apps/extension/src/new.ts"] },
    { status: "C", raw: "C75", paths: ["a.ts", "apps/extension/src/b.ts"] },
    { status: "B", raw: "B", paths: ["b.ts", "c.ts"] },
  ]);
  assert.deepEqual(parseNameStatusZ(""), []);
  assert.deepEqual(parseNameStatusZ("\0"), [], "only the trailing NUL");
});

test("a record the parser cannot read throws, so the check fails closed instead of skipping it", () => {
  assert.throws(() => parseNameStatusZ("not a git record\0x\0"), /cannot read a diff record/);
  assert.throws(() => parseNameStatusZ("R100\0only-one-path\0"), /missing its path/);
  assert.throws(() => parseNameStatusZ("A\0"), /missing its path/);
});

test("a path git would quote (non-ASCII, tab, quote) arrives verbatim in -z output and fails the freeze", () => {
  // The tab-separated format C-quotes these names (core.quotePath) and a naive tab-split misreads them; the
  // freeze reads -z output only, where git writes paths raw. The strings below are what `git diff -z` emits.
  const entries = parseNameStatusZ(`A\0apps/dock/src/настройка.ts\0M\0apps/extension/src/we"ird\tname.ts\0`);
  assert.deepEqual(entries, [
    { status: "A", raw: "A", paths: ["apps/dock/src/настройка.ts"] },
    { status: "M", raw: "M", paths: ['apps/extension/src/we"ird\tname.ts'] },
  ]);
  const result = checkDockFreeze({ entries });
  assert.equal(result.ok, false);
  assert.match(result.reason, /apps\/dock\/src\/настройка\.ts/);
  assert.match(result.reason, /we"ird\tname\.ts/);
});

test("adding or modifying a file under a frozen path fails, and the reason says where the Dock lives", () => {
  for (const entries of [
    [entry("A", "apps/dock/src/new.ts")],
    [entry("M", "apps/dock/package.json")],
    [entry("M", "apps/extension/src/drop.ts")],
    [entry("M", "apps/dock-desktop/src/main.rs")],
    [entry("M", ".github/workflows/dock-desktop.yml")],
    [entry("A", ".github/workflows/extension.yml")],
  ]) {
    const result = checkDockFreeze({ entries });
    assert.equal(result.ok, false, JSON.stringify(entries));
    assert.match(result.reason, new RegExp(DOCK_HOME.replace("/", "\\/")));
    for (const { paths } of entries) assert.match(result.reason, new RegExp(paths[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the frozen workflow files match exactly, not as a prefix", () => {
  assert.equal(isFrozenDockPath(".github/workflows/dock-desktop.yml"), true);
  assert.equal(isFrozenDockPath(".github/workflows/extension.yml"), true);
  assert.equal(isFrozenDockPath(".github/workflows/extension.yml.bak"), false);
  assert.equal(isFrozenDockPath(".github/workflows/ci.yml"), false);
  assert.equal(isFrozenDockPath(".github/workflows/desktop.yml"), false, "Pulse for desktop is not frozen");
  assert.equal(isFrozenDockPath("apps/desktop/MainWindow.cs"), false, "Pulse for Windows (apps/desktop) is not frozen");
  assert.equal(isFrozenDockPath("apps/dockage/x.ts"), false);
});

test("a rename fails from either side: Dock code neither leaves the frozen tree nor lands in it", () => {
  const out = checkDockFreeze({ entries: [entry("R", "apps/dock/src/worker/hub.ts", "packages/server/src/hub.ts")] });
  assert.equal(out.ok, false, "renamed out of the frozen tree");
  assert.match(out.reason, /apps\/dock\/src\/worker\/hub\.ts/);
  assert.equal(checkDockFreeze({ entries: [entry("R", "packages/web/src/x.ts", "apps/extension/src/x.ts")] }).ok, false, "renamed into the frozen tree");
});

test("deletions pass everywhere the freeze guards", () => {
  const result = checkDockFreeze({
    entries: [
      entry("D", "apps/dock/package.json"),
      entry("D", "apps/extension/src/drop.ts"),
      entry("D", "apps/dock-desktop/src/main.rs"),
      entry("D", ".github/workflows/dock-desktop.yml"),
      entry("D", ".github/workflows/extension.yml"),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("changes to other paths pass, and a mixed diff fails on the frozen change only", () => {
  assert.equal(
    checkDockFreeze({
      entries: [entry("M", "apps/demo/src/worker/index.ts"), entry("A", "scripts/check-dock-freeze.mjs"), entry("M", ".github/workflows/ci.yml")],
    }).ok,
    true,
  );
  const mixed = checkDockFreeze({
    entries: [entry("M", "apps/demo/src/worker/index.ts"), entry("M", "apps/dock/wrangler.jsonc"), entry("D", "apps/extension/README.md")],
  });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.violations, ["M\tapps/dock/wrangler.jsonc"]);
});

test("an empty diff passes and Windows separators are read as frozen paths", () => {
  assert.equal(checkDockFreeze({ entries: [] }).ok, true);
  assert.equal(isFrozenDockPath("apps\\dock\\package.json"), true);
  assert.deepEqual(parseNameStatusZ("M\0apps\\extension\\src\\drop.ts\0"), [{ status: "M", raw: "M", paths: ["apps/extension/src/drop.ts"] }]);
});

test("every frozen folder exists, and the two deleted workflows stay frozen while absent", () => {
  // The folders must exist or the freeze would guard nothing. The two workflow files are the exception: the
  // same PR that introduced this guard deleted them (TIN-1010) — a re-added one could again sign a Dock for
  // Windows build with the old key — so they stay in FROZEN_PATHS and must not come back. The removal PR
  // deletes the three folders together with the freeze itself (this guard, both test files, the AGENTS.md
  // row and the CI step), so this test leaves with them; it must not be kept and re-pointed at nothing.
  for (const frozen of FROZEN_PATHS) {
    const path = new URL(`../../${frozen}`, import.meta.url);
    if (frozen.endsWith("/")) {
      assert.equal(existsSync(path), true, `${frozen} is frozen but does not exist; the check would pass having read nothing`);
    } else {
      assert.equal(existsSync(path), false, `${frozen} is deleted (TIN-1010) and frozen: if it exists again, the freeze must fail on it`);
    }
  }
});
