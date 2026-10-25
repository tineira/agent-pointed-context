import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dock reuses Pulse's agent icons (apps/demo/src/web/agent-icon.tsx) and its side of the bridge.
export default defineConfig({
  plugins: [react()],
  server: { port: 5200, strictPort: true },
});
