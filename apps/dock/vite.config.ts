import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { readExtensionVersion } from "../../scripts/lib/extension-version.mjs";
import { zipDirectory } from "../../scripts/lib/zip.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The latest browser extension: the version of the zip this build serves (the same reading of git as
// apps/extension/build.mjs), baked into the page so /dock and /extension can say when the installed one is
// older. Null when git cannot say: then no notice shows.
const extension = readExtensionVersion(root);
const latest = extension.commit ? extension.version : null;

/** Where the dock serves the extension it was built with; /extension, the downloads and the notice link here. */
const ZIP_PATH = "extension/apc-extension.zip";

/**
 * Builds the extension (apps/extension/build.mjs, into a temporary folder) and zips it with manifest.json at
 * the root. Checks that its version is the one baked into the page, so the notice and the bytes it points at
 * always come from the same build.
 */
function buildExtensionZip(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "apc-dock-extension-"));
  try {
    const out = join(dir, "dist");
    const built = spawnSync(process.execPath, [join(root, "apps/extension/build.mjs"), "--out", out], { stdio: ["ignore", "inherit", "inherit"] });
    if (built.status !== 0) throw new Error("the browser extension's build failed");
    const version = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).version;
    if (latest !== null && version !== latest) throw new Error(`the extension built as ${version}, but the page says the latest is ${latest}`);
    return zipDirectory(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Serves the extension from the dock itself, at /extension/apc-extension.zip: an asset of the client build
 * (served with public/_headers like every asset), and under vite dev built on the first request.
 */
function extensionZip(): Plugin {
  let dev: Buffer | undefined;
  return {
    name: "apc-extension-zip",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      if (this.environment.config.command !== "build") return;
      this.emitFile({ type: "asset", fileName: ZIP_PATH, source: buildExtensionZip() });
    },
    configureServer(server) {
      server.middlewares.use(`/${ZIP_PATH}`, (_req, res) => {
        dev ??= buildExtensionZip();
        res.setHeader("content-type", "application/zip");
        res.setHeader("content-security-policy", "frame-ancestors 'none'");
        res.setHeader("x-frame-options", "DENY");
        res.end(dev);
      });
    },
  };
}

// The dock page reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx); the Worker is the hub (src/worker).
export default defineConfig({
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [extensionZip(), react(), cloudflare({ inspectorPort: false })],
  define: { __APC_EXTENSION_LATEST__: JSON.stringify(latest) },
  server: { port: 5200, strictPort: true },
});
