import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionBrowser, extensionsAddress } from "../src/web/extension-install.ts";

test("Edge gets its own extensions address; Chrome and other visitors get Chrome instructions", () => {
  assert.equal(extensionsAddress(extensionBrowser("Chrome/156.0 Safari/537.36 Edg/156.0")), "edge://extensions");
  assert.equal(extensionsAddress(extensionBrowser("Chrome/156.0 Safari/537.36")), "chrome://extensions");
  assert.equal(extensionBrowser("iPhone Safari/605.1.15"), "chrome");
});

test("the dock serves the extension it was built with, and every download link points there", async () => {
  const { EXTENSION_DOWNLOAD } = await import("../src/web/extension-install.ts");
  assert.equal(EXTENSION_DOWNLOAD, "/extension/apc-extension.zip", "the zip comes from the same deploy as the out-of-date notice");
  const { readFileSync } = await import("node:fs");
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.ok(config.includes('const ZIP_PATH = "extension/apc-extension.zip"'), "vite.config.ts emits the zip at that path");
  assert.match(config, /version !== latest\) throw/, "the build refuses a zip whose version is not the one baked into the page");
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(!/run_worker_first[^\]]*\/extension/.test(wrangler), "served as an asset, with public/_headers");
  assert.match(readFileSync(new URL("../public/_headers", import.meta.url), "utf8"), /^\/\*\n\s+Content-Security-Policy: frame-ancestors 'none'\n\s+X-Frame-Options: DENY/m);
  const page = readFileSync(new URL("../src/web/extension.tsx", import.meta.url), "utf8");
  assert.ok(!page.includes("github.com/tineira/agent-pointed-context/releases"), "/extension links the dock's own zip");
});
