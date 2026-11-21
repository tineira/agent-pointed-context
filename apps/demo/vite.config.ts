import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { embedCapabilityProblems, type BuiltChunk } from "./src/web/embed/capability.ts";

/**
 * The hero view (embed-hero.html, TIN-1070) is the one page another site may frame. Two guards keep it that way:
 *
 * - **The build fails** if the hero's own chunks (its entry and everything it imports) name an action the hero must not
 *   reach: Revoke, Start over, Allow (the dock's pairing), Wake, Settings (src/web/embed/capability.ts).
 * - **Under `vite dev`**, the page runs under its real policy (`script-src 'self'`): React's inline Fast Refresh preamble
 *   is left out of that page, and the hero's entry imports it as a module instead (`@vitejs/plugin-react/preamble`).
 */
function embedHero(): Plugin {
  return {
    name: "apc-embed-hero",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.path.endsWith("embed-hero.html") && !ctx.path.startsWith("/embed-hero")) return html;
        return html.replace(/<script type="module">\s*import \{ injectIntoGlobalHook \}[\s\S]*?<\/script>/, "");
      },
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((c): BuiltChunk[] => (c.type === "chunk" ? [{ fileName: c.fileName, name: c.name, isEntry: c.isEntry, imports: c.imports, dynamicImports: c.dynamicImports, code: c.code }] : []));
      // Only the client build has the hero: the Worker's build has no such entry and is not checked.
      if (!chunks.some((c) => c.isEntry && c.name === "embedHero") && !chunks.some((c) => c.isEntry && c.name === "main")) return;
      const problems = embedCapabilityProblems(chunks);
      if (problems.length) this.error(`The hero view (embed-hero.html) must not reach these actions:\n${problems.join("\n")}`);
    },
  };
}

export default defineConfig({
  environments: {
    client: {
      build: { rollupOptions: {
        input: { main: "index.html", dockConnect: "src/web/dock-connect.ts", embedHero: "embed-hero.html" },
        output: { entryFileNames: (chunk) => chunk.name === "dockConnect" ? "assets/dock-connect.js" : "assets/[name]-[hash].js" },
      } },
    },
  },
  plugins: [react(), tailwindcss(), cloudflare(), embedHero()],
});
