// End to end check of the APC browser extension (TIN-421, DESIGN.md 13), by hand: a real Chrome or Edge with the
// extension, a dock, and real drags sent through the DevTools Protocol (Input.dispatchDragEvent, so the page sees
// trusted events). By default against a local dock: needs the dock's dev server (cd apps/dock && pnpm dev, port 5200)
// and apps/extension built with --dev. With --prod, against v2.apc.tineira.com with the published build (apps/extension
// built without --dev), given the test page's site as if the person had granted it; the dock is a throwaway one,
// deleted at the end.
// usage: node scripts/extension-e2e.mjs [--prod] [--hold] [browser.exe]   (default: Chrome on Windows)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const PROD = args.includes("--prod");
/** --hold: stop once a reading is delivered and keep the dock, printing what an agent needs to read it. */
const HOLD = args.includes("--hold");
const DOCK = PROD ? "https://v2.apc.tineira.com" : "http://localhost:5200";
const EXE = args.find((a) => !a.startsWith("--")) ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT = PROD ? grantedCopy(resolve("apps/extension/dist")) : resolve("apps/extension/dist-dev");

/** The published build with the test page's site granted up front, as the popup's grant would; nothing else changes. */
function grantedCopy(dist) {
  const dir = mkdtempSync(join(tmpdir(), "apc-ext-"));
  cpSync(dist, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}
const T = "application/x-apc-agent";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(300);
  }
};

/**
 * A request's JSON, or an error that says which call answered what. The dock's dev server on Windows
 * sometimes fails a request before it reaches the Worker (vite answers 500 with an HTML page,
 * "fetch failed"): the script's own calls are tried once more then. The extension retries by itself.
 */
const request = async (what, url, init) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, init);
    const text = await r.text();
    if (r.status === 500 && text.trimStart().startsWith("<") && attempt === 0) continue;
    try {
      return { r, body: JSON.parse(text) };
    } catch {
      throw new Error(`${what}: ${r.status} ${text.slice(0, 120)}`);
    }
  }
};

// ---- the dock: one dock, its agent connected ----
let cookie = "";
const api = async (path, body) => {
  const { r, body: out } = await request(path, DOCK + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return out;
};
const { did } = await api("/api/dock", {});
const base = `/api/d/${did}`;
let state = await api(`${base}/state`);
const agent = state.agents[0];
const mcp = async (method, params) => {
  const { body } = await request(method, agent.mcp_url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return body;
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-e2e", version: "1.0" } });
const tool = async (name, args = {}) => (await mcp("tools/call", { name, arguments: args })).result;
const ticket = async () => (await api(`${base}/agents/${agent.id}/ticket`, {})).ticket;

// ---- a page without APC, and one that takes the drop itself as an APC app does ----
const PAGE = `<!doctype html><title>Churn notes</title><h1>Churn notes</h1><h2>EU-West</h2>
<p id="a">Churn in EU-West rose 4.2% in March, after the Nimbus offer.</p>
<p id="b">Signups from the SPRING code were mostly Pro.</p>
<input id="secret" value="hunter2">
<div id="app" style="padding:30px;background:#eef">APC app area</div>
<script>
const app = document.getElementById("app");
app.addEventListener("dragover", (e) => e.preventDefault());
app.addEventListener("drop", (e) => { e.preventDefault(); app.textContent = "app took it"; });
</script>`;
const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE)).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/notes?token=s3cr3t`;

// ---- the browser, with the extension loaded over CDP ----
const profile = mkdtempSync(join(tmpdir(), "apc-e2e-"));
const browser = spawn(EXE, ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const out = browser.stdio[3];
let buf = "";
let n = 0;
const waiting = new Map();
browser.stdio[4].on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++n;
    waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });

let failed = false;
let held = false;
let extensionId = "";
/** Thrown to stop after step 2 under --hold. */
class Holding extends Error {}
try {
  console.log("browser", (await cdp("Browser.getVersion")).product);
  extensionId = (await cdp("Extensions.loadUnpacked", { path: EXT })).id;
  console.log("extension", extensionId);
  await sleep(1500); // onInstalled registers the content script on 127.0.0.1
  const { targetId } = await cdp("Target.createTarget", { url: pageUrl });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await sleep(2000);
  const evaluate = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).result.value;
  const centre = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const drag = async (sel, payload) => {
    const { x, y } = await centre(sel);
    const data = { items: [{ mimeType: T, data: payload }], dragOperationsMask: 2 /* link */ };
    for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, x, y, data }, sessionId);
    await cdp("Input.dispatchDragEvent", { type: "drop", x, y, data }, sessionId);
  };
  const payload = async () => JSON.stringify({ v: 1, agent: agent.id, hub: DOCK, ticket: await ticket() });

  // 1. First drop: the extension asks the dock; the person allows it; the reading arrives.
  await drag("#a", await payload());
  const pending = await until("a reader request in the dock", async () => (await api(`${base}/state`)).agents[0].pairings.find((p) => p.kind === "reader" && p.status === "pending"));
  console.log("dock asks:", pending.app.name);
  await api(`${base}/pairings/${pending.id}`, { action: "approve" });
  const view = await until("the reading as the agent's focus", async () => {
    const r = await tool("get_current_view");
    return r.structuredContent?.focus?.kind === "page_reading" ? r.structuredContent : null;
  });
  assert.equal(view.focus.app.id, "page");
  assert.equal(view.focus.id, "127.0.0.1:" + server.address().port);
  let reading = (await tool("call_app_tool", { app: "page", tool: "get_reading" })).structuredContent;
  assert.equal(reading.untrusted, true);
  assert.match(reading.page_text, /Pointed at \(p\): Churn in EU-West rose 4\.2% in March/);
  assert.match(reading.page_text, /Under the heading: EU-West/);
  assert.ok(!JSON.stringify(reading).includes("s3cr3t"), "no query string");
  assert.ok(!JSON.stringify(reading).includes("hunter2"), "no form value");
  console.log("1. first drop: allowed in the dock, reading delivered");

  // 2. Next drop: the token is kept, no question asked.
  await drag("#b", await payload());
  reading = await until("the second reading", async () => {
    const r = (await tool("page__get_reading")).structuredContent;
    return /SPRING/.test(r?.page_text ?? "") ? r : null;
  });
  assert.equal((await api(`${base}/state`)).agents[0].pairings.filter((p) => p.kind === "reader").length, 1);
  console.log("2. second drop: sent straight away, through page__get_reading");
  if (HOLD) {
    // Leave the dock and its reading for an agent to read by hand; whoever holds this deletes the dock after.
    console.log("HOLD " + JSON.stringify({ dock: DOCK, did, cookie, mcp_url: agent.mcp_url }));
    throw new Holding();
  }

  // 3. An APC app keeps its drop: the extension stands back.
  await drag("#app", await payload());
  await sleep(1500);
  assert.equal(await evaluate(`document.getElementById("app").textContent`), "app took it");
  assert.match((await tool("page__get_reading")).structuredContent.page_text, /SPRING/);
  console.log("3. a page that takes the drop keeps it; no reading");

  // 4. A drag naming another hub is refused in the page.
  await drag("#a", JSON.stringify({ v: 1, agent: agent.id, hub: "https://evil.example", ticket: "x".repeat(32) }));
  await sleep(1000);
  assert.match((await tool("page__get_reading")).structuredContent.page_text, /SPRING/);
  console.log("4. a drag naming an unknown dock sends nothing");

  // 5. Only an extension's origin can ask for a reader or send a reading.
  const forged = await fetch(`${DOCK}/apc/reader`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ ticket: await ticket(), agent: agent.id, label: "evil" }) });
  assert.equal((await forged.json()).error, "reader_not_allowed");
  console.log("5. a page's origin cannot ask for a reader");

  // 7 (before 6, which unpairs). A site the person did not grant has no listener: the same page on localhost sends nothing.
  const other = await cdp("Target.createTarget", { url: pageUrl.replace("127.0.0.1", "localhost") });
  const { sessionId: otherSession } = await cdp("Target.attachToTarget", { targetId: other.targetId, flatten: true });
  await sleep(2000);
  const at = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#a").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, otherSession)).result.value;
  const data = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }, otherSession);
  await sleep(2000);
  assert.match((await tool("page__get_reading")).structuredContent.page_text, /SPRING/);
  await cdp("Target.closeTarget", { targetId: other.targetId });
  console.log("7. on a site the person did not grant, a drop sends nothing");

  // 6. Unpair in the dock: the next drop asks again.
  const reader = (await api(`${base}/state`)).agents[0].pairings.find((p) => p.kind === "reader");
  await api(`${base}/pairings/${reader.id}`, { action: "unpair" });
  await drag("#a", await payload());
  await until("a new reader request after unpairing", async () => (await api(`${base}/state`)).agents[0].pairings.find((p) => p.kind === "reader" && p.status === "pending"));
  console.log("6. after Unpair, the next drop asks the dock again");
  console.log("all passed");
} catch (error) {
  if (error instanceof Holding) {
    held = true;
  } else {
    failed = true;
    console.error("FAILED:", error.message);
    // What the extension itself recorded about the last drop (its popup shows the same).
    try {
      const sw = (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
      const { sessionId } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
      const last = await cdp("Runtime.evaluate", { expression: "chrome.storage.local.get('last').then((s) => JSON.stringify(s.last))", awaitPromise: true, returnByValue: true }, sessionId);
      console.error("extension's last drop:", last.result.value);
    } catch (e) {
      console.error("(could not read the extension's last drop:", e.message + ")");
    }
  }
} finally {
  if (!held) await api(`${base}/reset`, {}).catch(() => {});
  browser.kill();
  server.close();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  if (PROD) rmSync(EXT, { recursive: true, force: true, maxRetries: 5 });
  process.exit(failed ? 1 : 0);
}
