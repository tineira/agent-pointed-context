import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declaresMcpUrl, describeMcpCoverage, endpointRule, mcpUrlCoverage, parseApcManifest, usableEndpoints, type ApcManifest } from "../src/index.ts";

/**
 * `mcp.endpoints` (APC 0.11, TIN-888). The vectors in mcp-endpoint-vectors.json are the spec's table: the
 * same rows, which a hub in another language can run as they are.
 */
interface Vector { file: string; url: string; profile: "direct" | "dock" | null; shared: boolean; covered: boolean; why: string }
const { files, vectors } = JSON.parse(readFileSync(new URL("./mcp-endpoint-vectors.json", import.meta.url), "utf8")) as { files: Record<string, Record<string, unknown> & { origin: string }>; vectors: Vector[] };
const SPEC = new URL("../../../apps/dock/src/docs/pages/spec.md", import.meta.url);

const parsed = (raw: Record<string, unknown> & { origin: string }): ApcManifest => {
  const r = parseApcManifest(raw, raw.origin);
  assert.ok(r.ok, JSON.stringify(r));
  return r.manifest;
};

test("every vector of the spec's table holds", () => {
  for (const v of vectors) {
    const options = (v.profile ? { profile: v.profile, shared: v.shared } : { shared: v.shared }) as Parameters<typeof declaresMcpUrl>[2];
    assert.equal(declaresMcpUrl(parsed(files[v.file]!), v.url, options), v.covered, `${v.file} ${v.url} ${v.profile} shared=${v.shared}: ${v.why}`);
  }
});

/** The spec's files and table, as the JSON gives them. A test fails when the two drift; paste what it prints. */
export function vectorsMarkdown(): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const lines = ["```json", "{", ...Object.entries(files).map(([name, f], i, all) => `  ${JSON.stringify(name)}: ${JSON.stringify(f)}${i < all.length - 1 ? "," : ""}`), "}", "```", "", "| File | URL | Profile | Shared | Covered | Why |", "|---|---|---|---|---|---|"];
  for (const v of vectors) lines.push(`| \`${v.file}\` | \`${cell(v.url)}\` | ${v.profile ?? "(none)"} | ${v.shared ? "yes" : "no"} | ${v.covered ? "**yes**" : "no"} | ${cell(v.why)} |`);
  return lines.join("\n");
}

test("the spec's vector table is the JSON, row for row", () => {
  const spec = readFileSync(SPEC, "utf8").replace(/\r\n/g, "\n");
  const start = "<!-- mcp-endpoint-vectors:start -->\n";
  const end = "\n<!-- mcp-endpoint-vectors:end -->";
  const from = spec.indexOf(start);
  const to = spec.indexOf(end);
  assert.ok(from >= 0 && to > from, "spec.md has the vector table's markers");
  const expected = vectorsMarkdown();
  assert.equal(spec.slice(from + start.length, to), expected, `spec.md's vector table drifted from mcp-endpoint-vectors.json; it should read:\n${expected}`);
});

test("the parse is idempotent: the copy a hub keeps reads back the same", () => {
  for (const raw of Object.values(files)) {
    const once = parsed(raw);
    const twice = parsed(JSON.parse(JSON.stringify(once)) as Record<string, unknown> & { origin: string });
    assert.deepEqual(twice, once);
    for (const v of vectors) {
      if (files[v.file] !== raw || !v.profile) continue;
      assert.equal(declaresMcpUrl(twice, v.url, { profile: v.profile, shared: v.shared }), v.covered, `${v.url} after a round trip`);
    }
  }
});

const O = "https://ledger.example";
const app = (mcp: unknown, over: Record<string, unknown> = {}) => ({ name: "Ledger", standard: "0.11.0", origin: O, profiles: ["direct", "dock"], mcp, direct: { connect: `${O}/connect` }, ...over });
const e = (path: unknown, profiles: unknown = ["dock"], more: Record<string, unknown> = {}) => ({ path, profiles, ...more });

test("a malformed mcp.endpoints makes the file invalid", () => {
  for (const [mcp, why] of [
    [{}, "neither path nor endpoints"],
    [{ endpoints: null }, "null"],
    [{ endpoints: {} }, "an object"],
    [{ endpoints: "x" }, "a string"],
    [{ path: 5, endpoints: [e("/mcp/{secret}")] }, "a path that is not a string beside endpoints"],
    [{ path: "no-slash", endpoints: [e("/mcp/{secret}")] }, "a bad mcp.path beside endpoints"],
    [{ path: "/mcp", endpoints: [e("/mcp/{secret}")] }, "mcp.path without its last slash beside endpoints"],
    [{ endpoints: Array.from({ length: 17 }, (_, i) => e(`/mcp${i}/{secret}`)) }, "17 entries"],
    [{ endpoints: ["/mcp/{secret}"] }, "an entry that is a string"],
    [{ endpoints: [[]] }, "an entry that is a list"],
    [{ endpoints: [e(5)] }, "a path that is not a string"],
    [{ endpoints: [e("mcp/{secret}")] }, "a relative path"],
    [{ endpoints: [e("/mcp/%7Bsecret%7D")] }, "a %"],
    [{ endpoints: [e("/mcp?x")] }, "a ?"],
    [{ endpoints: [e("/mcp#x")] }, "a #"],
    [{ endpoints: [e("/mcp\\x")] }, "a backslash"],
    [{ endpoints: [e("/mcp x")] }, "a space"],
    [{ endpoints: [e("/mcp/\u0000")] }, "a control character"],
    [{ endpoints: [e("/mcp/../admin")] }, "a .. segment"],
    [{ endpoints: [e("/mcp/./x")] }, "a . segment"],
    [{ endpoints: [e(`/${"m".repeat(200)}`)] }, "a path over 200 characters"],
    [{ endpoints: [{ path: "/mcp" }] }, "no profiles"],
    [{ endpoints: [e("/mcp", null)] }, "profiles null"],
    [{ endpoints: [e("/mcp", "direct")] }, "profiles a string"],
    [{ endpoints: [e("/mcp", [1])] }, "a profile that is not a string"],
    [{ endpoints: [e("/mcp", Array(9).fill("direct"))] }, "nine profiles"],
    [{ endpoints: [e("/mcp/{secret}"), e("/mcp/{secret}", ["direct"])] }, "a path listed twice"],
    [{ path: "/mcp/", endpoints: [e("/api/mcp", ["direct"])] }, "an exact endpoint outside mcp.path"],
    [{ path: "/mcp/x/", endpoints: [e("/mcp/{secret}")] }, "a template outside mcp.path"],
  ] as const) {
    const r = parseApcManifest(app(mcp), O);
    assert.equal(r.ok, false, why);
    assert.equal((r as { error: string }).error, "apc_json_invalid", why);
  }
});

test("an entry a 0.11 reader does not fully understand is dropped whole, and the file still parses", () => {
  for (const [entry, why] of [
    [e("/mcp/", ["direct"]), "a trailing slash"],
    [e("/mcp//x", ["direct"]), "an empty segment"],
    [e("/", ["direct"]), "the root"],
    [e("/{secret}"), "a secret with no fixed segment before it"],
    [e("/mcp/{secret}/x"), "{secret} not last"],
    [e("/mcp/{sid}/{secret}"), "two variables"],
    [e("/mcp/{id}"), "another variable"],
    [e("/mcp/{secrets}"), "a near-miss variable"],
    [e("/mcp/{secret}", ["dock"], { requires: "pairing_code" }), "an unknown key"],
    [e("/mcp/{secret}", ["dock"], { "x-note": "hi" }), "an x- key"],
  ] as const) {
    const r = parseApcManifest(app({ endpoints: [entry] }), O);
    assert.ok(r.ok, why);
    assert.equal(endpointRule(entry), null, why);
    assert.deepEqual(usableEndpoints(r.manifest), [], why);
    assert.deepEqual(r.manifest.profiles, ["direct", "dock"], `${why}: the profiles still read, for the extension and the page`);
    for (const url of [`${O}/mcp/AbCdEfGhIjKlMnOpQrStUv`, `${O}/mcp`, `${O}/mcp/`]) {
      for (const profile of ["direct", "dock"] as const) assert.equal(declaresMcpUrl(r.manifest, url, { profile, shared: true }), false, `${why}: ${url} ${profile}`);
    }
  }
  const empty = parseApcManifest(app({ path: "/mcp/", endpoints: [] }), O);
  assert.ok(empty.ok, "an empty list parses");
  assert.equal(declaresMcpUrl(empty.manifest, `${O}/mcp/AbCdEfGhIjKlMnOpQrStUv`, { profile: "dock" }), false, "an empty list covers nothing, even with mcp.path beside it");
  assert.equal(describeMcpCoverage(empty.manifest), "mcp.endpoints, with no entry this reader can use");
});

test("profile words: unknown ones and hub are left out one by one; dock on an exact path is left out; an entry may list a profile the top level does not (M8)", () => {
  assert.deepEqual(endpointRule(e("/mcp/{secret}", ["carrier-pigeon", "hub", "dock", "direct"])), { path: "/mcp/{secret}", base: "/mcp", secret: true, profiles: ["direct", "dock"] });
  assert.deepEqual(endpointRule(e("/mcp", ["direct", "dock"])), { path: "/mcp", base: "/mcp", secret: false, profiles: ["direct"] });
  const r = parseApcManifest(app({ endpoints: [e("/mcp/{secret}", ["dock"])] }, { profiles: ["direct"] }), O);
  assert.ok(r.ok, "a Dock entry while the app does not pair is legal (M8)");
  assert.deepEqual(r.manifest.mcp.endpoints, [{ path: "/mcp/{secret}", profiles: ["dock"] }], "kept as written");
});

test("declaresMcpUrl fails closed: no profile, an unknown one, no profiles on a hand-built manifest, neither form; never a throw", () => {
  const m = parsed(files.split!);
  const url = "https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv";
  const loose = declaresMcpUrl as (m: unknown, url: unknown, o?: unknown) => boolean;
  assert.equal(loose(m, url), false, "no options at all");
  assert.equal(loose(m, url, { profile: "hub" }), false, "hub is no endpoint profile");
  assert.equal(loose({ origin: m.origin, mcp: m.mcp }, url, { profile: "dock" }), false, "no top-level profiles");
  assert.equal(loose({ origin: O, mcp: {} }, url, { profile: "dock", shared: true }), false, "neither path nor endpoints");
  assert.equal(loose({ origin: O, mcp: { endpoints: [] } }, url, { profile: "dock" }), false, "an empty list");
  // An unparsed file whose endpoints is not a list never falls back to mcp.path, which alone would cover these.
  for (const endpoints of [null, {}, "x", 5]) {
    assert.equal(loose({ origin: O, profiles: ["dock"], mcp: { path: "/mcp/", endpoints } }, `${O}/mcp/public/anything`, { profile: "dock" }), false, JSON.stringify(endpoints));
  }
  assert.equal(loose({ origin: O, profiles: ["dock"], mcp: { path: "/mcp/" } }, `${O}/mcp/public/anything`, { profile: "dock" }), true, "the same URL under mcp.path alone");
  const legacy = parsed(files["path-only"]!);
  assert.equal(loose(legacy, "https://ledger.example/mcp/abc"), true, "on a 0.10 file the old two-argument call still works");
});

test("mcpUrlCoverage says what covered a URL, or why nothing did", () => {
  const m = parsed(files.split!);
  assert.deepEqual(mcpUrlCoverage(m, "https://ledger.example/mcp/AbCdEfGhIjKlMnOpQrStUv", { profile: "dock" }), { covered: true, by: "mcp.endpoints /mcp/{secret}" });
  const shared = mcpUrlCoverage(m, "https://ledger.example/mcp", { profile: "direct" });
  assert.ok(!shared.covered && /bearer/.test(shared.reason), JSON.stringify(shared));
  const written = mcpUrlCoverage(m, "https://LEDGER.example/mcp/AbCdEfGhIjKlMnOpQrStUv", { profile: "dock" });
  assert.ok(!written.covered && /not written as/.test(written.reason), JSON.stringify(written));
  assert.equal(describeMcpCoverage(m), "mcp.endpoints /mcp (direct), /mcp/{secret} (dock)");
  assert.equal(describeMcpCoverage(parsed(files["path-only"]!)), "mcp.path /mcp/");
});
