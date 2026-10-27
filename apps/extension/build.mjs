// Build the APC browser extension (TIN-421) into dist/, or with --dev into dist-dev/ (local docks allowed).
// The content script is one classic script (IIFE): content scripts cannot be modules. The service
// worker and the popup are ES modules.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "vite";

const dev = process.argv.includes("--dev");
const outDir = dev ? "dist-dev" : "dist";
const entries = [
  { entry: "src/dock-presence.ts", file: "dock-presence.js", format: "iife" },
  { entry: "src/content.ts", file: "content.js", format: "iife" },
  { entry: "src/worker.ts", file: "worker.js", format: "es" },
  { entry: "src/popup.ts", file: "popup.js", format: "es" },
  { entry: "src/welcome.ts", file: "welcome.js", format: "es" },
];

for (const [i, e] of entries.entries()) {
  await build({
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    define: { __APC_DEV__: JSON.stringify(dev) },
    build: {
      outDir,
      emptyOutDir: i === 0,
      minify: false,
      target: "chrome122",
      lib: { entry: e.entry, formats: [e.format], name: "apcExtension", fileName: () => e.file },
    },
  });
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (dev) {
  // A local dock on localhost (vite dev of apps/dock) and test pages on 127.0.0.1; never in the published build.
  manifest.name += " (dev)";
  manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
  manifest.content_scripts[0].matches.push("http://localhost/*");
}
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
for (const page of ["popup.html", "welcome.html"]) await copyFile(page, `${outDir}/${page}`);
for (const icon of ["icon-32.png", "icon-128.png"]) await copyFile(`public/${icon}`, `${outDir}/${icon}`);
console.log(`built ${outDir}${dev ? " (dev)" : ""}`);
