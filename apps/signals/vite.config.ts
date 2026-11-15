import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Signals builds its posts from Pulse's model (apps/demo/src/model): same seed, same market.
export default defineConfig({
  environments: {
    client: {
      build: { rollupOptions: {
        input: { main: "index.html", dockConnect: "src/web/dock-connect.ts" },
        output: { entryFileNames: (chunk) => chunk.name === "dockConnect" ? "assets/dock-connect.js" : "assets/[name]-[hash].js" },
      } },
    },
  },
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [react(), cloudflare({ inspectorPort: false })],
  server: { port: 5201, strictPort: true },
});
