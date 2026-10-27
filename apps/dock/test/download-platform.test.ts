import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadPlatform } from "../src/web/download-platform.ts";

test("downloads: Windows offers both apps; its dock shell only offers Pulse", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0";
  assert.deepEqual(downloadPlatform(ua, false), { computer: true, dock: true, pulse: true, later: false });
  assert.deepEqual(downloadPlatform(ua, true), { computer: true, dock: false, pulse: true, later: false });
});

test("downloads: other computers keep the extension and a later note", () => {
  for (const ua of ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Mozilla/5.0 (X11; Linux x86_64)"]) {
    assert.deepEqual(downloadPlatform(ua, false), { computer: true, dock: false, pulse: false, later: true });
  }
});

test("downloads: phones and tablets need a computer, including Windows Phone", () => {
  for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile", "Mozilla/5.0 (iPad; CPU OS 18_0)", "Mozilla/5.0 (Linux; Android 15)", "Mozilla/5.0 (Windows Phone 10.0; Android 6.0; Microsoft)"]) {
    assert.deepEqual(downloadPlatform(ua, false), { computer: false, dock: false, pulse: false, later: false });
  }
});
