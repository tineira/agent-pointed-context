import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateDataset } from "../src/model/seed.ts";
import { mrrCsv, mrrRows } from "../src/user-side/mrr.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** C7: the application has no MRR code. Nothing the server bundles may import the user's side. */
test("no server or model module references the user's side", async () => {
  for (const dir of ["src/worker", "src/model", "../../packages"]) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.parentPath.includes("node_modules")) continue;
      const text = await readFile(path.join(entry.parentPath, entry.name), "utf8");
      assert.doesNotMatch(text, /(from|import)\s*\(?\s*["'][^"']*user-side|\bmrr(Rows|Csv)\b/,`${path.relative(root, path.join(entry.parentPath, entry.name))} references the user's side`);
    }
  }
});

test("the user's file covers active customer-months, with distinctive values for the canary check", () => {
  const seed = 99;
  const rows = mrrRows(seed);
  const active = generateDataset(seed).activity.filter((a) => a.active);
  assert.equal(rows.length, active.length);
  assert.ok(rows.every((r) => /^\d+\.\d{2}$/.test(r.mrr) && !r.mrr.endsWith(".00")), "decimal strings with non-zero cents");
  assert.equal(mrrCsv(seed).split("\n")[0], "customer_id,month,mrr");
  assert.deepEqual(mrrRows(seed), rows, "deterministic from the seed");
});
