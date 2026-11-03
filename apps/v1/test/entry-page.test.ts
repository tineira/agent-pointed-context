import assert from "node:assert/strict";
import { test } from "node:test";
import { stripBase, withBase } from "../src/base.ts";
import { entryPage } from "../src/web/entry-page.ts";

test("V1's landing is /v1/ and stays outside the sandbox with trailing slashes", () => {
  for (const path of ["/v1", "/v1/", "/v1///"]) assert.equal(entryPage(path), "landing", path);
});

test("demo routes under /v1 enter the sandbox", () => {
  for (const path of ["/v1/how-to", "/v1/overview", "/v1/customers/cus_0001", "/v1/agents", "/v1/connect"]) {
    assert.equal(entryPage(path), "sandbox", path);
  }
});

test("paths inside V1 map to and from /v1", () => {
  assert.equal(withBase("/"), "/v1/");
  assert.equal(withBase("/how-to?topic=examples"), "/v1/how-to?topic=examples");
  assert.equal(stripBase("/v1"), "/");
  assert.equal(stripBase("/v1/"), "/");
  assert.equal(stripBase("/v1/customers/cus_0001"), "/customers/cus_0001");
  assert.equal(stripBase("/v10/overview"), "/v10/overview");
});
