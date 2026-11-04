import assert from "node:assert/strict";
import { test } from "node:test";
import { APC_JSON_PATH, compareStandard, declaresMcpUrl, directOnlyNote, parseApcManifest } from "../src/index.ts";

const O = "https://signals.example";
const app = (over: Record<string, unknown> = {}) => ({ name: "Signals", standard: "0.5.0", origin: O, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${O}/?connect` }, ...over });

test("apc.json lives at /.well-known/apc.json and reads back as a manifest (APC 0.5)", () => {
  assert.equal(APC_JSON_PATH, "/.well-known/apc.json");
  assert.deepEqual(parseApcManifest(app(), O), { ok: true, manifest: { name: "Signals", standard: "0.5.0", origin: O, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${O}/?connect` } } });
  const dockOnly = parseApcManifest(app({ profiles: ["dock"], direct: undefined }), O);
  assert.ok(dockOnly.ok && !("direct" in dockOnly.manifest), "a Dock-only app needs no connect page");
  const hub = parseApcManifest({ name: "APC dock", standard: "0.5.0", origin: O, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${O}/apc/pair`, confirm: `${O}/apc/confirm` } }, O);
  assert.ok(hub.ok && hub.manifest.profiles[0] === "hub" && hub.manifest.dock?.pair === `${O}/apc/pair`);
  const later = parseApcManifest(app({ profiles: ["direct", "dock", "carrier-pigeon"], extra: { any: 1 } }), O);
  assert.ok(later.ok && later.manifest.profiles.length === 2, "words and keys a reader does not know are ignored");
});

test("an apc.json that names another origin is refused as such; anything else wrong is invalid", () => {
  assert.equal((parseApcManifest(app(), "https://evil.example") as { error: string }).error, "apc_json_wrong_origin");
  for (const [bad, why] of [
    [null, "null"],
    [[], "an array"],
    [app({ name: "" }), "no name"],
    [app({ name: "x".repeat(61) }), "a long name"],
    [app({ standard: "0.5" }), "a short version"],
    [app({ origin: `${O}/` }), "an origin with a slash"],
    [app({ origin: "signals.example" }), "not an origin"],
    [app({ profiles: [] }), "no profiles"],
    [app({ profiles: ["other"] }), "no profile it knows"],
    [app({ profiles: ["hub", "dock"] }), "a hub that is also an app"],
    [app({ mcp: undefined }), "no mcp"],
    [app({ mcp: { path: "mcp/" } }), "a relative path"],
    [app({ mcp: { path: "/mcp" } }), "a path without its last slash"],
    [app({ mcp: { path: "/a/../mcp/" } }), "a path with .."],
    [app({ direct: undefined }), "Direct with no connect page"],
    [app({ direct: { connect: "https://elsewhere.example/connect" } }), "a connect page on another origin"],
    [app({ direct: { connect: `https://user:pw@signals.example/` } }), "credentials in the connect page"],
    [{ ...app({ profiles: ["hub"] }), direct: undefined }, "a hub with no pairing endpoints"],
  ] as const) {
    const r = parseApcManifest(bad, O);
    assert.equal(r.ok, false, why);
    assert.equal((r as { error: string }).error, "apc_json_invalid", why);
  }
});

test("an MCP URL is declared when it is on the origin and under mcp.path", () => {
  const m = (parseApcManifest(app(), O) as { manifest: Parameters<typeof declaresMcpUrl>[0] }).manifest;
  assert.equal(declaresMcpUrl(m, `${O}/mcp/abc/def`), true);
  assert.equal(declaresMcpUrl(m, `${O}/mcp/`), false, "the path itself is no grant");
  assert.equal(declaresMcpUrl(m, `${O}/tenant/mcp/abc`), false);
  assert.equal(declaresMcpUrl(m, `https://evil.example/mcp/abc`), false);
  assert.equal(declaresMcpUrl(m, `https://u:p@signals.example/mcp/abc`), false);
  assert.equal(declaresMcpUrl(m, "not a url"), false);
});

test("versions of the standard compare as numbers, and the Direct-only answer names the app", () => {
  assert.ok(compareStandard("0.10.0", "0.9.9") > 0);
  assert.equal(compareStandard("0.5.0", "0.5.0"), 0);
  assert.ok(compareStandard("0.4.9", "0.5.0") < 0);
  assert.match(directOnlyNote("Signals"), /^Signals connects agents directly, not through a dock\. Connect your agent to Signals on its own URL/);
});
