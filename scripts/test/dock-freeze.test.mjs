import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DOCK_HOME, FROZEN_PATHS, checkDockFreeze, isFrozenDockPath, parseNameStatus } from "../lib/dock-freeze.mjs";

const entry = (status, ...paths) => ({ status, paths });

test("parseNameStatus reads plain and rename lines, and rejects what it cannot read", () => {
  assert.deepEqual(parseNameStatus("M\tapps/dock/package.json"), { status: "M", paths: ["apps/dock/package.json"] });
  assert.deepEqual(parseNameStatus("R100\tapps/dock/src/worker/hub.ts\tpackages/server/src/hub.ts"), {
    status: "R",
    paths: ["apps/dock/src/worker/hub.ts", "packages/server/src/hub.ts"],
  });
  assert.deepEqual(parseNameStatus("A\tapps/extension/src/new.ts"), { status: "A", paths: ["apps/extension/src/new.ts"] });
  assert.equal(parseNameStatus(""), null);
  assert.equal(parseNameStatus("not a git line"), null);
  assert.equal(parseNameStatus("Z100\tsomewhere"), null);
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
  assert.deepEqual(parseNameStatus("M\tapps\\extension\\src\\drop.ts"), { status: "M", paths: ["apps/extension/src/drop.ts"] });
});

test("every frozen path exists in this repo, so the freeze never guards nothing", () => {
  // The removal PR deletes these together with the freeze itself; while it runs, the guard must match real paths.
  for (const frozen of FROZEN_PATHS) {
    const path = new URL(`../../${frozen}`, import.meta.url);
    assert.equal(existsSync(path), true, `${frozen} is frozen but does not exist; the check would pass having read nothing`);
  }
});
