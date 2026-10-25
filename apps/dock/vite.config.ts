import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dock page reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx); the Worker is the hub (src/worker).
export default defineConfig({
  // No inspector: Pulse's dev server holds port 9229 when the three apps run side by side.
  plugins: [react(), cloudflare({ inspectorPort: false })],
  server: { port: 5200, strictPort: true },
});
