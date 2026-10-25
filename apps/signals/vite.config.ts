import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Signals builds its posts from Pulse's model (apps/demo/src/model): same seed, same market.
export default defineConfig({
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [react(), cloudflare({ inspectorPort: false })],
  server: { port: 5201, strictPort: true },
});
