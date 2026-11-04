// Build the APC browser extension (TIN-421) into dist/, or with --dev into dist-dev/ (local docks allowed), or into
// --out <dir> (the dock's build packs that into the zip it serves).
// The content script is one classic script (IIFE): content scripts cannot be modules. The service
// worker and the popup are ES modules.
// The manifest's version moves with every change to the extension (scripts/lib/extension-version.mjs): 0.2.<n>,
// n the commits up to the extension's last change, and version_name adds that commit's short hash, which the popup
// and chrome://extensions show.
// The build is all or nothing: it reads the version first, builds into a sibling folder, and only when every step
// succeeded swaps it in for the output folder. A failed build (a hook's rebuild after a pull, say) leaves the
// previous build in place and loadable (exit 1). If the output folder cannot be swapped (a file in it held open), it
// is overwritten file by file, manifest.json last; if even that fails, the build says the folder was only partly
// updated (exit 2). For tests: APC_EXTENSION_BUILD_FAIL_AFTER=<n> fails after n entries, APC_EXTENSION_BUILD_NO_RENAME=1
// takes the file-by-file path, APC_EXTENSION_BUILD_FAIL_COPY=<file> fails writing that file.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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

// Swap the new build in: rename the old one aside, the new one into place, then drop the old one. When the old
// folder cannot be renamed (a file in it held open, on Windows), overwrite it file by file instead (overwrite()).
const old = `${outDir}.old-${process.pid}`;
const forceInPlace = process.env.APC_EXTENSION_BUILD_NO_RENAME === "1";
let swapped = false;
if (!forceInPlace) {
  let aside = false;
  try {
    if (existsSync(outDir)) {
      renameSync(outDir, old);
      aside = true;
    }
    renameSync(work, outDir);
    swapped = true;
  } catch {
    // Put the old build back if it was moved aside, then overwrite it in place below.
    if (aside && !existsSync(outDir)) renameSync(old, outDir);
  }
}
if (!swapped) {
  try {
    overwrite(work, outDir);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    const shown = relative(fileURLToPath(new URL("../..", import.meta.url)), outDir).split(sep).join("/");
    console.error(`${shown} was only partly updated: close what holds it and run node apps/extension/build.mjs again (${error instanceof Error ? error.message : error})`);
    process.exit(2);
  }
  rmSync(work, { recursive: true, force: true });
}
rmSync(old, { recursive: true, force: true });
console.log(`built ${outDir}: ${manifest.version_name}`);

/**
 * Overwrites `to` with the files of `from`, one by one, manifest.json last (so Chrome never reads a new manifest
 * over old scripts), then removes what the new build does not have. Throws on the first file it cannot write or
 * remove; the caller then says the folder was only partly updated. APC_EXTENSION_BUILD_FAIL_COPY=<file> makes
 * writing that file fail (tests).
 */
function overwrite(from, to) {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()) : []);
  const fresh = list(from).sort((a, b) => (a === "manifest.json") - (b === "manifest.json") || (a < b ? -1 : 1));
  for (const file of fresh) {
    if (process.env.APC_EXTENSION_BUILD_FAIL_COPY === file) throw new Error(`could not write ${file} (APC_EXTENSION_BUILD_FAIL_COPY)`);
    mkdirSync(dirname(join(to, file)), { recursive: true });
    copyFileSync(join(from, file), join(to, file));
  }
  const keep = new Set(fresh);
  for (const file of list(to)) if (!keep.has(file)) rmSync(join(to, file));
}
