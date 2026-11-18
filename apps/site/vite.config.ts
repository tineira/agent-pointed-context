import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { DOC_PAGES, EXAMPLES_DIR } from "./src/docs/pages.ts";
import { staticDocFiles } from "./src/docs/static.ts";
const root = fileURLToPath(new URL("../..", import.meta.url));

/** A dev navigation must load Dock's own Vite client/module namespace on port 5200. */
function dockLinks(): Plugin {
  return {
    name: "apc-site-dev-dock-links",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path !== "/dock" && !path.startsWith("/dock/") && path !== "/extension" && !path.startsWith("/extension/")) return next();
        res.writeHead(302, { location: `http://localhost:5200${req.url}` });
        res.end();
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


export default defineConfig({
  plugins: [dockLinks(), staticDocs(), react(), cloudflare({ inspectorPort: false })],
  build: { assetsDir: "site-assets" },
  // Direct site development: the hub still answers these URLs, over HTTP only.
  server: { origin: "http://localhost:5202", port: 5202, strictPort: true, proxy: {
    "/api": "http://localhost:5200", "/assets": "http://localhost:5200",
    "/sw.js": "http://localhost:5200", "/manifest.webmanifest": "http://localhost:5200",
    "/icon": "http://localhost:5200", "/favicon": "http://localhost:5200",
  } },
});
