import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APC_STANDARD_VERSION } from "../src/index.ts";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

test("the standard's version is valid semver", () => {
  assert.match(APC_STANDARD_VERSION, SEMVER);
});

test("the standard's version is the latest heading of its changelog", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+\S*)/gm)].map((match) => match[1]);
  assert.ok(headings.length > 0, "the changelog has a version heading");
  assert.equal(headings[0], APC_STANDARD_VERSION);
});
