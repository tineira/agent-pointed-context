import assert from "node:assert/strict";
import { test } from "node:test";
import { checkChangelog, isDocs } from "../lib/changelog.mjs";

const code = ["apps/dock/src/web/hub.tsx", "apps/dock/test/hub.test.ts"];

test("a PR that changes code and no changelog fails", () => {
  const result = checkChangelog({ files: code, labels: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /apps\/dock\/src\/web\/hub\.tsx/);
  assert.match(result.reason, /no-changelog/);
});

test("the same PR passes with an entry in the root changelog", () => {
  assert.equal(checkChangelog({ files: [...code, "CHANGELOG.md"], labels: [] }).ok, true);
  assert.equal(checkChangelog({ files: [...code, "packages/protocol/CHANGELOG.md"], labels: [] }).ok, false, "the standard's changelog alone is not enough for other code");
});

test("the same PR passes with the no-changelog label, and other labels do not count", () => {
  assert.equal(checkChangelog({ files: code, labels: ["no-changelog"] }).ok, true);
  assert.equal(checkChangelog({ files: code, labels: ["bug", "changelog"] }).ok, false);
});

test("docs alone need no entry, but a changelog is not docs", () => {
  assert.equal(checkChangelog({ files: ["README.md", "DESIGN.md", "docs/notes.txt", "AGENTS.md"], labels: [] }).ok, true);
  assert.equal(isDocs("CHANGELOG.md"), false);
  assert.equal(isDocs("packages/protocol/CHANGELOG.md"), false);
  assert.equal(isDocs("skills/pulse-agent/SKILL.md"), true);
});

test("a workflow or a script is not docs; docs plus code still needs an entry", () => {
  assert.equal(checkChangelog({ files: [".github/workflows/ci.yml"], labels: [] }).ok, false);
  assert.equal(checkChangelog({ files: ["README.md", "scripts/canary.mjs"], labels: [] }).ok, false);
});

test("Windows separators and an empty diff", () => {
  assert.equal(checkChangelog({ files: ["CHANGELOG.md", "packages\\web\\src\\index.ts"], labels: [] }).ok, true);
  assert.equal(checkChangelog({ files: [], labels: [] }).ok, true);
});

const contract = ["packages/protocol/src/types.ts"];

test("a contract change needs the standard's changelog; the root one is not enough", () => {
  const result = checkChangelog({ files: [...contract, "CHANGELOG.md"], labels: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /packages\/protocol\/CHANGELOG\.md/);
  assert.equal(checkChangelog({ files: [...contract, "packages/protocol/CHANGELOG.md"], labels: [] }).ok, true);
  assert.equal(checkChangelog({ files: [...contract, "packages\\protocol\\CHANGELOG.md"], labels: [] }).ok, true);
});

test("a PR with a contract change and other code needs both changelogs", () => {
  const files = [...contract, ...code];
  assert.equal(checkChangelog({ files: [...files, "CHANGELOG.md"], labels: [] }).ok, false);
  assert.equal(checkChangelog({ files: [...files, "packages/protocol/CHANGELOG.md"], labels: [] }).ok, false);
  assert.equal(checkChangelog({ files: [...files, "CHANGELOG.md", "packages/protocol/CHANGELOG.md"], labels: [] }).ok, true);
});

test("no-changelog skips the rule for a contract change too; a changelog-only PR passes", () => {
  assert.equal(checkChangelog({ files: contract, labels: ["no-changelog"] }).ok, true);
  assert.equal(checkChangelog({ files: ["packages/protocol/CHANGELOG.md"], labels: [] }).ok, true);
  assert.equal(checkChangelog({ files: ["CHANGELOG.md"], labels: [] }).ok, true);
});
