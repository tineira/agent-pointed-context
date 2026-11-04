import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { zipDirectory } from "../lib/zip.mjs";

/** Reads a zip back through its central directory: { path: bytes }, checking each CRC. */
function unzip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "an end of central directory record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const data = method === 8 ? inflateRawSync(zip.subarray(start, start + size)) : zip.subarray(start, start + size);
    assert.equal(crc32(data), crc, name);
    out[name] = data;
    at += 46 + nameLength;
  }
  return out;
}

test("zipDirectory packs a folder with its files at the root, readable and the same bytes every time", () => {
  const dir = mkdtempSync(join(tmpdir(), "apc-zip-"));
  try {
    const src = join(dir, "dist");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "manifest.json"), '{ "version": "0.2.5" }\n');
    writeFileSync(join(src, "sub", "a.js"), "console.log('a');\n".repeat(50));
    writeFileSync(join(src, "icon.png"), Buffer.from([0, 1, 2, 255]));
    const zip = zipDirectory(src);
    const files = unzip(zip);
    assert.deepEqual(Object.keys(files), ["icon.png", "manifest.json", "sub/a.js"]);
    assert.equal(files["manifest.json"].toString(), '{ "version": "0.2.5" }\n');
    assert.deepEqual([...files["icon.png"]], [0, 1, 2, 255]);
    assert.ok(zipDirectory(src).equals(zip), "deterministic");
    // A real unzip agrees, where one is on hand (Info-ZIP on Linux, bsdtar on Windows).
    const file = join(dir, "x.zip");
    writeFileSync(file, zip);
    const tool = process.platform === "win32" ? ["tar", ["-tf", file]] : ["unzip", ["-Z1", file]];
    let listed = null;
    try {
      listed = execFileSync(tool[0], tool[1], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).sort();
    } catch {
      // No such tool here: the reader above is the check.
    }
    if (listed) assert.deepEqual(listed, ["icon.png", "manifest.json", "sub/a.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
