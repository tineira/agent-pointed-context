import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PACKAGES, REPOSITORY_URL, checkManifest, checkVersions, distTargets, npmPublishArgs, rewriteDeclaration, standardVersionOf, tarballName } from "../lib/packages.mjs";

const at = (version) => PACKAGES.map((n) => ({ name: `@tineira/apc-${n}`, version }));
const repo = (path) => new URL(`../../${path}`, import.meta.url);

test("the four packages share one version, a 0.x patch of the standard's", () => {
  assert.equal(checkVersions({ manifests: at("0.7.0"), standard: "0.7.0" }).ok, true);
  assert.equal(checkVersions({ manifests: at("0.7.2"), standard: "0.7.0" }).ok, true, "a software patch on the same contract");
  assert.equal(checkVersions({ manifests: at("0.7.0"), standard: "0.7.1" }).ok, false, "behind the standard");
  assert.equal(checkVersions({ manifests: at("0.6.9"), standard: "0.7.0" }).ok, false);
  assert.equal(checkVersions({ manifests: at("0.8.0"), standard: "0.7.0" }).ok, false);
  assert.equal(checkVersions({ manifests: at("1.0.0"), standard: "1.0.0" }).ok, false, "1.0 waits for the published standard");
  const split = [...at("0.7.0").slice(1), { name: "@tineira/apc-protocol", version: "0.7.1" }];
  assert.match(checkVersions({ manifests: split, standard: "0.7.0" }).problems.join(), /do not share one version/);
  assert.equal(checkVersions({ manifests: at("0.7.0"), standard: null }).ok, false);
});

test("a release tag names the packages' version", () => {
  assert.equal(checkVersions({ manifests: at("0.7.0"), standard: "0.7.0", tag: "apc-v0.7.0" }).ok, true);
  assert.match(checkVersions({ manifests: at("0.7.0"), standard: "0.7.0", tag: "apc-v0.7.1" }).problems.join(), /tag apc-v0\.7\.0/);
  assert.equal(checkVersions({ manifests: at("0.7.0"), standard: "0.7.0", tag: "v0.7.0" }).ok, false);
});

test("the repo as it is: versions agree, and every manifest is fit to publish", () => {
  const manifests = PACKAGES.map((n) => JSON.parse(readFileSync(repo(`packages/${n}/package.json`), "utf8")));
  const standard = standardVersionOf(readFileSync(repo("packages/protocol/src/version.ts"), "utf8"));
  assert.ok(standard);
  assert.deepEqual(checkVersions({ manifests, standard }).problems, []);
  assert.deepEqual(manifests.flatMap(checkManifest), []);
  const conformance = manifests[PACKAGES.indexOf("conformance")];
  assert.ok(distTargets(conformance).includes("./dist/cli.js"), "the apc-conformance command is published");
  for (const m of manifests) assert.equal(m.exports["."], "./src/index.ts", `${m.name}: the workspace keeps using the sources`);
});

test("a manifest that would publish wrong is caught", () => {
  const good = JSON.parse(readFileSync(repo("packages/server/package.json"), "utf8"));
  assert.deepEqual(checkManifest(good), []);
  assert.match(checkManifest({ ...good, dependencies: { "@tineira/apc-protocol": "workspace:*" } }).join(), /workspace:\^/);
  assert.match(checkManifest({ ...good, publishConfig: { ...good.publishConfig, tag: "next" } }).join(), /publishConfig\.tag is ignored/, "no tag that only looks like a guarantee");
  assert.match(checkManifest({ ...good, publishConfig: { ...good.publishConfig, exports: { ".": "./src/index.ts" } } }).join(), /not in dist/);
  assert.match(checkManifest({ ...good, files: ["dist"] }).join(), /README\.md/);
  assert.match(checkManifest({ ...good, private: true }).join(), /private/);
  assert.match(checkManifest({ ...good, name: "@apc/server" }).join(), /@tineira\/apc-\*/);
  for (const url of ["git+https://github.com/tineira/agent-pointed-context.git", "https://github.com/tineira/agent-pointed-context/", "https://github.com/Tineira/agent-pointed-context"]) {
    assert.match(checkManifest({ ...good, repository: { ...good.repository, url } }).join(), /not exactly https:\/\/github\.com\/tineira\/agent-pointed-context/, url);
  }
});

test("each tarball is published with npm on next, public, protocol first, with no token or --provenance", () => {
  assert.equal(REPOSITORY_URL, "https://github.com/tineira/agent-pointed-context");
  assert.deepEqual(PACKAGES.map((d) => tarballName(d, "0.7.0")), ["tineira-apc-protocol-0.7.0.tgz", "tineira-apc-server-0.7.0.tgz", "tineira-apc-web-0.7.0.tgz", "tineira-apc-conformance-0.7.0.tgz"]);
  assert.deepEqual(npmPublishArgs("/t/x.tgz"), ["publish", "/t/x.tgz", "--tag", "next", "--access", "public"]);
  assert.deepEqual(npmPublishArgs("/t/x.tgz", { dryRun: true }).slice(-1), ["--dry-run"]);
  const workflow = readFileSync(repo(".github/workflows/publish.yml"), "utf8");
  assert.ok(!/NPM_TOKEN|--provenance|secrets\./.test(workflow), "trusted publishing: no token, provenance is automatic");
  assert.ok(!/^\s*registry-url\s*:/m.test(workflow), "no registry-url: setup-node would write an _authToken line and a placeholder NODE_AUTH_TOKEN");
  // A YAML env key (`NODE_AUTH_TOKEN: …`) or a shell assignment (`NODE_AUTH_TOKEN=…`); the guard's `${NODE_AUTH_TOKEN:-}` only reads it.
  assert.ok(!/NODE_AUTH_TOKEN\s*(:\s|:$|=)/m.test(workflow) && !/_authToken\s*=/.test(workflow), "nothing sets NODE_AUTH_TOKEN or writes an _authToken");
  assert.match(workflow, /if \[ -n "\$\{NODE_AUTH_TOKEN:-\}" \]/, "the tag job fails when NODE_AUTH_TOKEN is set");
  assert.match(workflow, /npm config get \/\/registry\.npmjs\.org\/:_authToken/, "the tag job fails when npm has a token configured");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /tags: \["apc-v\*"\]/);
  assert.ok(!/pull_request/.test(workflow), "never on a pull request");
  assert.match(workflow, /npm publish "\$RUNNER_TEMP\/apc-tarballs\/tineira-apc-\$p-\$version\.tgz" --tag next --access public/);
  const publishes = workflow.split("\n").filter((l) => /^\s*npm publish /.test(l));
  assert.equal(publishes.length, 2, "the tag job and the dry run");
  for (const l of publishes) assert.match(l, /--tag next/, "every publish names its dist-tag: npm would default to latest");
  assert.equal(publishes.filter((l) => !l.includes("--dry-run")).length, 1);
  assert.equal(workflow.match(/^\s+id-token: write\s*$/gm)?.length, 1, "only the tag job gets an OIDC token");
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/, "a tag publishes only a commit of main");
});

test("declarations import .js, not the .ts the sources import", () => {
  assert.equal(rewriteDeclaration('export * from "./core.ts";\nexport type * from "./types.ts";'), 'export * from "./core.js";\nexport type * from "./types.js";');
  assert.equal(rewriteDeclaration('import type { ApcKv } from "./kv.ts";'), 'import type { ApcKv } from "./kv.js";');
  assert.equal(rewriteDeclaration('let x: import("../a/b.ts").T;'), 'let x: import("../a/b.js").T;');
  assert.equal(rewriteDeclaration('import { z } from "zod";\nimport { a } from "@tineira/apc-protocol";'), 'import { z } from "zod";\nimport { a } from "@tineira/apc-protocol";', "packages untouched");
  assert.equal(rewriteDeclaration('const s = "see ./x.ts";'), 'const s = "see ./x.ts";', "only specifiers");
});
