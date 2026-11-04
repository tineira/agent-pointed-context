import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readExtensionVersion } from "../../scripts/lib/extension-version.mjs";

// The latest browser extension: the version the zip built from this commit has (the same reading of git as
// apps/extension/build.mjs), baked into the page so /dock and /extension can say when the installed one is
// older. Null when git cannot say: then no notice shows.
const extension = readExtensionVersion(fileURLToPath(new URL("../..", import.meta.url)));

// The dock page reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx); the Worker is the hub (src/worker).
export default defineConfig({
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [react(), cloudflare({ inspectorPort: false })],
  define: { __APC_EXTENSION_LATEST__: JSON.stringify(extension.commit ? extension.version : null) },
  server: { port: 5200, strictPort: true },
});
