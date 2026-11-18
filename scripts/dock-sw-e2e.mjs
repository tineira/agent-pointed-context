#!/usr/bin/env node
// A real Chrome updates an existing scope-/ registration at /sw.js, then navigates offline.
// Isolated localhost server and browser profile; no personal browser state or production traffic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const current = readFileSync(join(root, "apps/dock/public/sw.js"), "utf8");
const previous = readFileSync(join(root, "scripts/fixtures/dock-sw-before-site.js"), "utf8");
let script = previous;
let online = true;
const server = createServer((request, response) => {
  // DevTools page-only offline emulation does not cover the service worker target.
  // Refuse its real network requests too, so its fetch must actually reject.
  if (!online) return request.socket.destroy();
  response.writeHead(200, { "content-type": request.url === "/sw.js" ? "application/javascript" : "text/html", "cache-control": "no-store" });
  response.end(request.url === "/sw.js" ? script : "<!doctype html><title>SW check</title><p>online page</p>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), "apc-dock-sw-"));
const executable = process.argv[2] ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
// Port zero avoids interference with other authors' browser sessions.
const chrome = spawn(executable, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-extensions", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let ws;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let browserUrl = "";
  chrome.stderr.on("data", (data) => { browserUrl ||= String(data).match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? ""; });
  for (let i = 0; i < 150 && !browserUrl; i++) await delay(200);
  assert.ok(browserUrl, "Chrome exposes DevTools in 30 seconds");
  const debugOrigin = new URL(browserUrl).origin.replace("ws:", "http:");
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const answer = JSON.parse(data);
    const callback = pending.get(answer.id);
    if (!callback) return;
    pending.delete(answer.id);
    answer.error ? callback.reject(new Error(answer.error.message)) : callback.resolve(answer.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, expression);
    return result.result.value;
  };
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Page.navigate", { url: `${origin}/dock` });
  for (let i = 0; i < 100 && await evaluate("document.readyState") !== "complete"; i++) await delay(100);
  const scope = await evaluate(`(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, {once:true}));
    return (await navigator.serviceWorker.getRegistration()).scope;
  })()`);
  assert.equal(scope, `${origin}/`);
  script = current;
  await evaluate(`(async () => {
    const changed = new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, {once:true}));
    await (await navigator.serviceWorker.getRegistration()).update();
    await changed;
    return true;
  })()`);
  assert.equal(await evaluate("(async () => (await navigator.serviceWorker.getRegistrations()).length)()"), 1, "updated in place, no second scope");
  online = false;
  server.closeAllConnections();
  await cdp("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  for (const path of ["/dock", "/dock/agents/check"]) {
    const navigation = await cdp("Page.navigate", { url: `${origin}${path}` });
    assert.equal(navigation.errorText, undefined, path);
    let body = "";
    for (let i = 0; i < 100; i++) {
      body = await evaluate("document.body?.innerText ?? ''");
      if (body.includes("needs a connection")) break;
      await delay(100);
    }
    assert.match(body, /needs a connection/, path);
  }
  for (const path of ["/docs", "/try", "/build", "/", "/v1/"]) {
    const navigation = await cdp("Page.navigate", { url: `${origin}${path}` });
    assert.match(navigation.errorText ?? "", /ERR_INTERNET_DISCONNECTED/, `${path} gets the browser's offline error, not Dock HTML`);
  }
  console.log("Dock service worker in Chrome: passed (scope / updated in place; offline Dock note; site/V1 bypass)");
} finally {
  ws?.close();
  // Only this script's child, whose command line includes its unique temporary profile.
  chrome.kill();
  await new Promise((done) => chrome.exitCode !== null ? done() : chrome.once("exit", done));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  assert.equal(dirname(profile), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith("apc-dock-sw-"));
  for (let i = 0; i < 20; i++) {
    try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(100); }
  }
}
