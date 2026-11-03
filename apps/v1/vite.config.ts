import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// V1 is served under /v1 (TIN-604); wrangler.jsonc's assets.base_path matches.
export default defineConfig({
  base: "/v1/",
  plugins: [react(), tailwindcss(), cloudflare()],
});
