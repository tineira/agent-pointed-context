import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dock page reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx); the Worker is the hub (src/worker).
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 5200, strictPort: true },
});
