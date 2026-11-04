import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hubPatterns } from "../src/drop.ts";
import { compareExtensionVersions, EXTENSION_PRESENT, EXTENSION_VERSION, extensionOutdated, markDockPresence } from "../src/presence.ts";

test("the dock marker writes only presence and the version, with no other data or capability", () => {
  const attributes = new Map<string, string>();
  const root = { setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
  markDockPresence(root, "0.2.131");
  markDockPresence(root, "0.2.131");
  assert.deepEqual([...attributes], [[EXTENSION_PRESENT, ""], [EXTENSION_VERSION, "0.2.131"]]);
  const script = readFileSync(new URL("../src/dock-presence.ts", import.meta.url), "utf8");
  assert.match(script, /markDockPresence\(document\.documentElement, chrome\.runtime\.getManifest\(\)\.version\)/, "the version is the manifest's");
});

test("extension versions order as Chrome orders them", () => {
  assert.ok(compareExtensionVersions("0.1.0", "0.2.5") < 0);
  assert.ok(compareExtensionVersions("0.2.9", "0.2.10") < 0, "numbers, not strings");
  assert.ok(compareExtensionVersions("0.2.131", "0.2.130") > 0);
  assert.equal(compareExtensionVersions("0.2", "0.2.0"), 0);
  assert.ok(Number.isNaN(compareExtensionVersions("0.2.x", "0.2.1")));
  assert.ok(Number.isNaN(compareExtensionVersions("1.2.3.4.5", "0.2.1")));
});

test("the dock flags only an installed extension that reported an older version", () => {
  assert.equal(extensionOutdated("0.2.120", "0.2.131"), true);
  assert.equal(extensionOutdated("0.1.0", "0.2.131"), true, "a 0.1.0 build that reports its version is older");
  assert.equal(extensionOutdated("0.2.131", "0.2.131"), false);
  assert.equal(extensionOutdated("0.2.140", "0.2.131"), false, "a build newer than the dock (a dock not yet redeployed) is not out of date");
  assert.equal(extensionOutdated(null, "0.2.131"), false, "a build too old to report a version: nothing to say");
  assert.equal(extensionOutdated("", "0.2.131"), false);
  assert.equal(extensionOutdated("0.2.120", null), false, "a dock that does not know the latest says nothing");
  assert.equal(extensionOutdated("garbage", "0.2.131"), false);
});

test("the presence script uses only the dock host access already in the manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.content_scripts, [{ matches: hubPatterns(false), js: ["dock-presence.js"], run_at: "document_idle" }], "only the dock's own paths, never /v1/");
  for (const match of manifest.content_scripts[0].matches) assert.ok(manifest.host_permissions.includes(`${new URL(match).origin}/*`));
  assert.equal(manifest.externally_connectable, undefined);
});

test("the manifest public key keeps the unpacked extension in the dock reader allowlist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
  assert.equal(id, "lhmcidpijocjiifjmoldencfocchonoj");
  const config = readFileSync(new URL("../../dock/wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(config.includes(`"READER_ORIGINS": "chrome-extension://${id}"`));
});
