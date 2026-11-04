// The published packages (@tineira/apc-protocol, @tineira/apc-server, @tineira/apc-web, @tineira/apc-conformance, TIN-612): what must hold
// before they go to npm. Pure logic; scripts/check-packages.mjs and scripts/build-packages.mjs feed it the files.

/** The packages published to npm, in build order (protocol first: the others import it). */
export const PACKAGES = ["protocol", "server", "web", "conformance"];

/** The dist-tag every pre-release goes out on; `latest` waits for 1.0. */
export const DIST_TAG = "next";

/**
 * Every package's `repository.url`, exactly: npm's trusted publishing (OIDC from GitHub Actions) requires it to
 * match the repository the workflow runs in.
 */
export const REPOSITORY_URL = "https://github.com/tineira/agent-pointed-context";

/** The tarball `pnpm pack` makes for a package directory, e.g. "protocol" → "tineira-apc-protocol-0.7.0.tgz". */
export function tarballName(dir, version) {
  return `tineira-apc-${dir}-${version}.tgz`;
}

/**
 * The `npm publish` arguments for one packed tarball: on `next`, public, never `latest`. Provenance comes with
 * trusted publishing on its own, so there is no --provenance.
 */
export function npmPublishArgs(tarball, { dryRun = false } = {}) {
  return ["publish", tarball, "--tag", DIST_TAG, "--access", "public", ...(dryRun ? ["--dry-run"] : [])];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** `APC_STANDARD_VERSION` as written in packages/protocol/src/version.ts, or null. */
export function standardVersionOf(source) {
  const m = /export const APC_STANDARD_VERSION\s*=\s*"([^"]+)"/.exec(source);
  return m ? m[1] : null;
}

/**
 * The versions agree: every package has the same version, it is a version of the standard (same major and
 * minor as `APC_STANDARD_VERSION`, a patch at least the standard's: 0.7.x ships the 0.7 contract), it stays
 * under 1.0 (pre-releases go out on `next`), and a release tag, when given, is `apc-v<that version>`.
 * @param {{ manifests: Array<{ name: string; version: string }>; standard: string | null; tag?: string }} input
 * @returns {{ ok: boolean; version: string | null; problems: string[] }}
 */
export function checkVersions({ manifests, standard, tag }) {
  const problems = [];
  const versions = [...new Set(manifests.map((m) => m.version))];
  if (versions.length !== 1) problems.push(`the packages do not share one version: ${manifests.map((m) => `${m.name}@${m.version}`).join(", ")}`);
  const version = versions.length === 1 ? versions[0] : null;
  if (!standard) problems.push("APC_STANDARD_VERSION was not found in packages/protocol/src/version.ts");
  if (version && standard) {
    const v = VERSION_RE.exec(version);
    const s = VERSION_RE.exec(standard);
    if (!v) problems.push(`${version} is not a semver version`);
    else if (!s) problems.push(`APC_STANDARD_VERSION ${standard} is not a semver version`);
    else {
      if (v[1] !== s[1] || v[2] !== s[2] || Number(v[3]) < Number(s[3])) problems.push(`the packages are ${version} but the standard is ${standard}: they ship ${s[1]}.${s[2]}.x from ${standard} on`);
      if (Number(v[1]) >= 1) problems.push(`${version} is 1.0 or later: the packages stay 0.x on the "${DIST_TAG}" tag until the standard is published`);
    }
  }
  if (tag !== undefined && version && tag !== `apc-v${version}`) problems.push(`the tag is ${tag}, but the packages are ${version}: tag apc-v${version}`);
  return { ok: problems.length === 0, version, problems };
}

/**
 * What a package's published manifest must say: the dist entry points (`publishConfig.exports`, `types`
 * and `bin` point into dist/), the files, MIT, the repository and the engines; its workspace dependencies
 * as `workspace:^` so pnpm publishes them as a caret range.
 * @param {Record<string, any>} manifest
 * @returns {string[]} problems
 */
export function checkManifest(manifest) {
  const problems = [];
  const name = manifest.name ?? "?";
  const pc = manifest.publishConfig ?? {};
  if (!/^@tineira\/apc-[a-z]+$/.test(name)) problems.push(`${name}: not an @tineira/apc-* name (the @apc scope on npm is someone else's)`);
  if (manifest.private) problems.push(`${name} is private`);
  if (manifest.license !== "MIT") problems.push(`${name}: license is not MIT`);
  if (pc.access !== "public") problems.push(`${name}: publishConfig.access is not public`);
  if (pc.tag !== DIST_TAG) problems.push(`${name}: publishConfig.tag is not ${DIST_TAG}`);
  if (!pc.exports || typeof pc.exports !== "object") problems.push(`${name}: no publishConfig.exports`);
  for (const target of distTargets(manifest)) if (!target.startsWith("./dist/")) problems.push(`${name}: ${target} is not in dist/`);
  for (const f of ["dist", "README.md", "LICENSE"]) if (!manifest.files?.includes(f)) problems.push(`${name}: files leaves out ${f}`);
  if (manifest.repository?.url !== REPOSITORY_URL) problems.push(`${name}: repository.url is ${manifest.repository?.url}, not exactly ${REPOSITORY_URL} (trusted publishing compares it)`);
  if (manifest.repository?.directory !== `packages/${name.replace("@tineira/apc-", "")}`) problems.push(`${name}: repository.directory is not its folder`);
  if (!manifest.engines?.node) problems.push(`${name}: no engines.node`);
  if (manifest.sideEffects !== false) problems.push(`${name}: sideEffects is not false`);
  for (const [dep, spec] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (dep.startsWith("@tineira/apc-") && spec !== "workspace:^") problems.push(`${name}: ${dep} is ${spec}, not workspace:^ (published as a caret range)`);
  }
  return problems;
}

/** Every file the published manifest points at: export conditions, types, main and bin. */
export function distTargets(manifest) {
  const pc = manifest.publishConfig ?? {};
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(pc.exports);
  for (const k of ["main", "types", "module"]) if (typeof pc[k] === "string") out.push(pc[k]);
  if (typeof pc.bin === "string") out.push(pc.bin);
  else if (pc.bin) walk(pc.bin);
  return [...new Set(out)];
}

/**
 * A declaration file as tsc writes it from sources that import `./x.ts` (rewriteRelativeImportExtensions
 * rewrites the JS, not the .d.ts): its relative `.ts` specifiers as `.js`, so a consumer's TypeScript
 * resolves them without allowImportingTsExtensions.
 */
export function rewriteDeclaration(source) {
  return source.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, "$1$2.js$3");
}
