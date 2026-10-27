import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionBrowser, extensionsAddress } from "../src/web/extension-install.ts";

test("Edge gets its own extensions address; Chrome and other visitors get Chrome instructions", () => {
  assert.equal(extensionsAddress(extensionBrowser("Chrome/156.0 Safari/537.36 Edg/156.0")), "edge://extensions");
  assert.equal(extensionsAddress(extensionBrowser("Chrome/156.0 Safari/537.36")), "chrome://extensions");
  assert.equal(extensionBrowser("iPhone Safari/605.1.15"), "chrome");
});
