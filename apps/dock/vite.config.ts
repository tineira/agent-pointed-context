import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { readExtensionVersion } from "../../scripts/lib/extension-version.mjs";
import { zipDirectory } from "../../scripts/lib/zip.mjs";
import { DOC_PAGES, EXAMPLES_DIR } from "./src/docs/pages.ts";
import { staticDocFiles } from "./src/docs/static.ts";

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

/**
 * The docs without JavaScript (TIN-914): each /docs page as HTML with its text in it (docs.html, docs/spec.html…,
 * which the asset server answers at /docs and /docs/spec), its Markdown at /docs/<page>.md, and /llms.txt,
 * written next to the client build's index.html from the same sources the page renders (src/docs/static.ts).
 */
function staticDocs(): Plugin {
  return {
    name: "apc-static-docs",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle(options) {
      const dir = options.dir!;
      const sources = Object.fromEntries(DOC_PAGES.map((p) => [p.path, readFileSync(join(root, p.file), "utf8")]));
      const examplesDir = join(root, EXAMPLES_DIR);
      const examples = Object.fromEntries(readdirSync(examplesDir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(examplesDir, f), "utf8")]));
      for (const { file, content } of staticDocFiles(readFileSync(join(dir, "index.html"), "utf8"), sources, examples)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), content);
      }
    },
  };
}

// The dock page reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx); the Worker is the hub (src/worker).
export default defineConfig({
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [extensionZip(), staticDocs(), react(), cloudflare({ inspectorPort: false })],
  define: { __APC_EXTENSION_LATEST__: JSON.stringify(latest) },
  server: { port: 5200, strictPort: true },
});
