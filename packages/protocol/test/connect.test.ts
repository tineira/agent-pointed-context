import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeApcConnect, encodeApcConnect, parseApcManifest } from "../src/index.ts";

const value = { v: 1 as const, hub: "https://dock.test", agent: "ag_1", ticket: `${"a".repeat(32)}.${"b".repeat(32)}` };
test("connect fragments round trip without query parameters; malformed data and unsafe hubs fail closed", () => {
  const hash = encodeApcConnect(value);
  assert.match(hash, /^#apc_connect=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeApcConnect(hash), value);
  for (const bad of ["", "#apc_connect=%%%", hash + "&extra=1", "#apc_connect=e30", "#apc_connect=_w"]) assert.equal(decodeApcConnect(bad), null);
  for (const hub of ["http://dock.test", "https://dock.test/path", "https://dock.test/#x", "https://user@dock.test"]) assert.throws(() => encodeApcConnect({ ...value, hub }));
});

test("dock_connect is exposed only as a fragment-free URL on the manifest origin", () => {
  const base = { name: "Orders", standard: "0.13.0", origin: "https://orders.test", profiles: ["dock"], mcp: { path: "/mcp/" } };
  for (const bad of ["/connect", "https://evil.test/connect", "https://orders.test/connect#", "https://orders.test/connect#x", "blob:https://orders.test/x", 3, null]) assert.equal(parseApcManifest({ ...base, dock_connect: bad }, base.origin).ok, false, String(bad));
  const parsed = parseApcManifest({ ...base, dock_connect: `${base.origin}/connect/dock` }, base.origin);
  assert.ok(parsed.ok);
  assert.equal(parsed.manifest.dock_connect, `${base.origin}/connect/dock`);
  assert.ok(parseApcManifest(base, base.origin).ok, "old manifests remain readable for existing pairings");
});
