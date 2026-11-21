import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { DOC_PAGES, EXAMPLES_DIR } from "./src/docs/pages.ts";
import { staticDocFiles } from "./src/docs/static.ts";
const root = fileURLToPath(new URL("../..", import.meta.url));

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

/**
 * The local Pulse (TIN-1071): under `vite dev`, and in a build made with `--mode local-pulse` (for `vite preview`, which
 * applies the site's CSP), the site frames and links the Pulse of `pnpm dev` (src/pulse-origin.local.ts). The Worker's
 * policy follows through the same module; this plugin gives the local build's _headers the same frame-src. A
 * production build never sees the local origin (scripts/site-routes.mjs checks dist).
 */
const PRODUCTION_FRAMES = "frame-src https://pulse.apc.tineira.com/embed/";
function localPulseHeaders(): Plugin {
  return {
    name: "apc-local-pulse-headers",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle(options) {
      const file = join(options.dir!, "_headers");
      const text = readFileSync(file, "utf8");
      if (!text.includes(PRODUCTION_FRAMES)) throw new Error("_headers has no frame-src for Pulse to make local");
      writeFileSync(file, text.replace(PRODUCTION_FRAMES, "frame-src http://localhost:5173/embed/"));
    },
  };
}

/** Every import of src/pulse-origin.ts, from the page or the Worker, gets src/pulse-origin.local.ts instead. */
function localPulseOrigin(): Plugin {
  const local = fileURLToPath(new URL("./src/pulse-origin.local.ts", import.meta.url));
  return {
    name: "apc-local-pulse-origin",
    enforce: "pre",
    resolveId: (source) => (/(^|\/)pulse-origin\.ts$/.test(source) ? local : null),
  };
}

export default defineConfig(({ command, mode, isPreview }) => {
  const localPulse = (command === "serve" && !isPreview) || mode === "local-pulse";
  return {
    plugins: [staticDocs(), ...(localPulse ? [localPulseOrigin()] : []), ...(localPulse && command === "build" ? [localPulseHeaders()] : []), react(), cloudflare({ inspectorPort: false })],
    build: { assetsDir: "site-assets" },
    // The site asks nothing of a hub any more (TIN-1061): it serves every URL it links.
    server: { origin: "http://localhost:5202", port: 5202, strictPort: true },
  };
});
