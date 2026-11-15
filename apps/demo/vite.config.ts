import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: { rollupOptions: {
    input: { main: "index.html", dockConnect: "src/web/dock-connect.ts" },
    output: { entryFileNames: (chunk) => chunk.name === "dockConnect" ? "assets/dock-connect.js" : "assets/[name]-[hash].js" },
  } },
  plugins: [react(), tailwindcss(), cloudflare()],
});
