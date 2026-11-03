import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APC_STANDARD_VERSION } from "../src/index.ts";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

test("the standard's version is valid semver", () => {
  assert.match(APC_STANDARD_VERSION, SEMVER);
});

test("the first heading of the standard's changelog is its version (no Unreleased section)", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const first = changelog.match(/^## (.+)$/m);
  assert.ok(first, "the changelog has a `## ` heading");
  const heading = first[1] ?? "";
  assert.equal(heading.match(/^(\d+\.\d+\.\d+\S*)/)?.[1], APC_STANDARD_VERSION, `first heading is "${heading}"`);
});
