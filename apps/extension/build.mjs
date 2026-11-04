// Build the APC browser extension (TIN-421) into dist/, or with --dev into dist-dev/ (local docks allowed), or into
// --out <dir> (the dock's build packs that into the zip it serves).
// The content script is one classic script (IIFE): content scripts cannot be modules. The service
// worker and the popup are ES modules.
// The manifest's version moves with every change to the extension (scripts/lib/extension-version.mjs): 0.2.<n>,
// n the commits up to the extension's last change, and version_name adds that commit's short hash, which the popup
// and chrome://extensions show.
// The build is all or nothing: it reads the version first, builds into a sibling folder, and only when every step
// succeeded swaps it in for the output folder. A failed build (a hook's rebuild after a pull, say) leaves the
// previous build in place and loadable. APC_EXTENSION_BUILD_FAIL_AFTER=<n> makes it fail after n entries (tests).
import { cpSync, renameSync, rmSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "vite";
import { readExtensionVersion } from "../../scripts/lib/extension-version.mjs";

process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const { values } = parseArgs({ options: { dev: { type: "boolean", default: false }, out: { type: "string" } } });
const dev = values.dev;
const outDir = resolve(values.out ?? (dev ? "dist-dev" : "dist"));
const failAfter = Number(process.env.APC_EXTENSION_BUILD_FAIL_AFTER ?? 0);
const entries = [
  { entry: "src/dock-presence.ts", file: "dock-presence.js", format: "iife" },
  { entry: "src/content.ts", file: "content.js", format: "iife" },
  { entry: "src/worker.ts", file: "worker.js", format: "es" },
  { entry: "src/popup.ts", file: "popup.js", format: "es" },
  { entry: "src/welcome.ts", file: "welcome.js", format: "es" },
];

// The version before anything is built: a shallow clone stops here, with the output folder untouched.
const { version, commit } = readExtensionVersion(fileURLToPath(new URL("../..", import.meta.url)));
const work = `${outDir}.building-${process.pid}`;
rmSync(work, { recursive: true, force: true });

let manifest;
try {
  for (const [i, e] of entries.entries()) {
    await build({
      configFile: false,
      logLevel: "warn",
      publicDir: false,
      define: { __APC_DEV__: JSON.stringify(dev) },
      build: {
        outDir: work,
        emptyOutDir: i === 0,
        minify: false,
        target: "chrome122",
        lib: { entry: e.entry, formats: [e.format], name: "apcExtension", fileName: () => e.file },
      },
    });
    if (failAfter && i + 1 >= failAfter) throw new Error(`stopped after ${i + 1} entries (APC_EXTENSION_BUILD_FAIL_AFTER)`);
  }

  manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  manifest.version = version;
  manifest.version_name = `${version} (${[commit ?? "unknown commit", ...(dev ? ["dev"] : [])].join(", ")})`;
  if (dev) {
    // A local dock on localhost (vite dev of apps/dock) and test pages on 127.0.0.1; never in the published build.
    manifest.name += " (dev)";
    manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
    manifest.content_scripts[0].matches.push("http://localhost/*");
  }
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  for (const page of ["popup.html", "welcome.html"]) await copyFile(page, `${work}/${page}`);
  for (const icon of ["icon-32.png", "icon-128.png"]) await copyFile(`public/${icon}`, `${work}/${icon}`);
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  console.error(`extension build failed; ${outDir} is unchanged: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

// Swap the new build in: rename the old one aside, the new one into place, then drop the old one. If the old
// folder cannot be renamed (a file held open on Windows), copy the new files over it instead.
const old = `${outDir}.old-${process.pid}`;
try {
  renameSync(outDir, old);
} catch {
  // No previous build, or it is held open: handled below.
}
try {
  renameSync(work, outDir);
} catch {
  cpSync(work, outDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
rmSync(old, { recursive: true, force: true });
console.log(`built ${outDir}: ${manifest.version_name}`);
