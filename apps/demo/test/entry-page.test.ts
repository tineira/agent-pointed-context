import assert from "node:assert/strict";
import { test } from "node:test";
import { entryPage } from "../src/web/entry-page.ts";

test("public entry routes stay outside the sandbox with trailing slashes", () => {
  assert.equal(entryPage("/"), "chooser");
  for (const path of ["/v1", "/v1/", "/v1///"]) assert.equal(entryPage(path), "v1", path);
});

test("demo routes still enter the sandbox and V1 matching is exact", () => {
  for (const path of ["/how-to", "/overview", "/customers/cus_0001", "/agents", "/v10", "/v1/overview"]) {
    assert.equal(entryPage(path), "sandbox", path);
  }
});
