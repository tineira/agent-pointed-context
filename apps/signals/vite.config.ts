import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Signals builds its posts from Pulse's model (apps/demo/src/model): same seed, same market.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 5201, strictPort: true },
});
