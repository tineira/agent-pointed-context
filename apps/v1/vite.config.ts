import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * V1 is served under /v1 (TIN-604), and its files sit under a v1/ folder of the assets directory, so a
 * URL is its file's path and the Worker needs no assets.base_path: the page is v1/index.html, the
 * public files are in public/v1/, and the build writes the bundles to v1/assets/. dist/client/ itself
 * holds nothing else, so no asset is ever served outside /v1.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  environments: {
    client: {
      build: {
        assetsDir: "v1/assets",
        rolldownOptions: { input: "v1/index.html" },
      },
    },
  },
});
