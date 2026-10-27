import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXTENSION_PRESENT, markDockPresence } from "../src/presence.ts";

test("the dock marker writes only presence, with no data or capability", () => {
  const attributes = new Map<string, string>();
  const root = { setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
  markDockPresence(root);
  markDockPresence(root);
  assert.deepEqual([...attributes], [[EXTENSION_PRESENT, ""]]);
});

test("the presence script uses only the dock host access already in the manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.content_scripts, [{ matches: ["https://v2.apc.tineira.com/*"], js: ["dock-presence.js"], run_at: "document_idle" }]);
  for (const match of manifest.content_scripts[0].matches) assert.ok(manifest.host_permissions.includes(match));
  assert.equal(manifest.externally_connectable, undefined);
});

test("the manifest public key keeps the unpacked extension in the dock reader allowlist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
  assert.equal(id, "lhmcidpijocjiifjmoldencfocchonoj");
  const config = readFileSync(new URL("../../dock/wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(config.includes(`"READER_ORIGINS": "chrome-extension://${id}"`));
});
