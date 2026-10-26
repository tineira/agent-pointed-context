// End to end check of the APC browser extension (TIN-421, DESIGN.md 13), by hand: a real Chrome or Edge with the
// extension, a dock, and real drags sent through the DevTools Protocol (Input.dispatchDragEvent, so the page sees
// trusted events). By default against a local dock: needs the dock's dev server (cd apps/dock && pnpm dev, port 5200)
// and apps/extension built with --dev. With --prod, against v2.apc.tineira.com with the published build (apps/extension
// built without --dev), given the test page's site as if the person had granted it; the dock is a throwaway one,
// deleted at the end.
// With --consent, the consent model instead (TIN-465, DESIGN.md 13.3): the extension holds the one grant for any page and
// no site by itself, so each new site asks on a card in the page, clicked here with real mouse events.
// --shots=<dir> saves screenshots of the pin, unread and read (TIN-469).
// usage: node scripts/extension-e2e.mjs [--prod] [--hold | --consent] [--shots=<dir>] [browser.exe]   (default: Chrome on Windows)
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
/** --consent: the one grant for any page, and the consent card on new sites (TIN-465). */
const CONSENT = args.includes("--consent");
const SHOTS = args.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const DOCK = PROD ? "https://v2.apc.tineira.com" : "http://localhost:5200";
const EXE = args.find((a) => !a.startsWith("--")) ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT = PROD || CONSENT ? grantedCopy(resolve(PROD ? "apps/extension/dist" : "apps/extension/dist-dev")) : resolve("apps/extension/dist-dev");

/**
 * The build with grants given up front, as the person's would be; nothing else changes. Normally the
 * test page's site by itself (the popup's grant). Under --consent, the one grant for any page and no
 * site by itself (the welcome page's grant).
 */
function grantedCopy(dist) {
  const dir = mkdtempSync(join(tmpdir(), "apc-ext-"));
  cpSync(dist, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (CONSENT) manifest.host_permissions = [...manifest.host_permissions.filter((o) => o !== "http://127.0.0.1/*"), "https://*/*", "http://*/*"];
  else manifest.host_permissions.push("http://127.0.0.1/*");
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
<div id="app" data-focus="figure:kpi" style="padding:30px;background:#eef">APC app area</div>
<script>
const app = document.getElementById("app");
app.addEventListener("dragover", (e) => e.preventDefault());
app.addEventListener("drop", (e) => { e.preventDefault(); app.textContent = "app took it"; });
</script>`;
// Every host name gets the same page: *.localhost names (Chrome resolves them to this machine) are separate sites.
// A page like X: its text in divs and spans, and drag handlers of its own (for attaching files) that
// take every dragover with "copy", which would refuse the agent's "link" drag.
const BUSY = `<!doctype html><title>Busy feed</title><main><div class="post"><div><span>Nimbus cut its Pro price by 30% in EU-West</span></div></div></main>
<script>
addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
addEventListener("drop", (e) => e.preventDefault());
</script>`;
const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url.startsWith("/busy") ? BUSY : PAGE)).listen(0, "::");
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

  if (CONSENT) {
    // C0. Installing opens the welcome page, which asks for the one grant.
    assert.ok((await cdp("Target.getTargets")).targetInfos.some((t) => t.url === `chrome-extension://${extensionId}/welcome.html`), "the welcome page is open");
    console.log("C0. installing opens the welcome page");

    // A page on a site of its own, and what the agent reads.
    const open = async (host) => {
      const url = pageUrl.replace("127.0.0.1", host);
      const { targetId: id } = await cdp("Target.createTarget", { url });
      const { sessionId: sid } = await cdp("Target.attachToTarget", { targetId: id, flatten: true });
      await sleep(2500);
      const at = async (sel) => (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, sid)).result.value;
      /** The consent card's buttons (a closed shadow root: DevTools sees through it), by data-apc-consent. */
      const buttons = async () => {
        const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
        const found = new Map();
        const walk = (n) => {
          const a = n.attributes ?? [];
          const i = a.indexOf("data-apc-consent");
          if (i >= 0) found.set(a[i + 1], n.nodeId);
          for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
        };
        walk(root);
        return found;
      };
      return {
        drop: async (sel) => {
          const { x, y } = await at(sel);
          const data = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
          for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x, y, data }, sid);
          await sleep(1500);
        },
        buttons,
        click: async (value) => {
          // The card comes once the service worker answered, which takes longer when it was asleep.
          const nodeId = await until(`a ${value} button on the card`, async () => (await buttons()).get(value), 10_000);
          const q = (await cdp("DOM.getBoxModel", { nodeId }, sid)).model.content;
          const x = (q[0] + q[4]) / 2;
          const y = (q[1] + q[5]) / 2;
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
          await sleep(1500);
        },
      };
    };
    const latest = async () => (await tool("call_app_tool", { app: "page", tool: "get_reading" })).structuredContent;
    const reads = (re, host) =>
      until(`a reading matching ${re} from ${host}`, async () => {
        const r = await latest();
        return re.test(r?.page_text ?? "") && (!host || r.app?.origin?.includes(host)) ? r : null;
      });

    // C1. A new site asks on the card; Just this once sends (and the dock asks the first time).
    const a = await open("a.localhost");
    await a.drop("#a");
    assert.deepEqual([...(await a.buttons()).keys()].sort(), ["always", "never", "once"]);
    await a.click("once");
    const pending = await until("a reader request in the dock", async () => (await api(`${base}/state`)).agents[0].pairings.find((p) => p.kind === "reader" && p.status === "pending"));
    await api(`${base}/pairings/${pending.id}`, { action: "approve" });
    await reads(/EU-West rose/, "a.localhost");
    console.log("C1. a new site asks; Just this once sends");

    // C2. Just this once asked again; Always on this site sends and is kept.
    await a.drop("#b");
    await a.click("always");
    await reads(/SPRING/, "a.localhost");
    console.log("C2. the next drop asks again; Always on this site sends");

    // C3. Always: no card any more.
    await a.drop("#a");
    assert.equal((await a.buttons()).size, 0, "no card on an Always site");
    await reads(/EU-West rose/, "a.localhost");
    console.log("C3. on an Always site, drops are sent without a card");

    // C4. Not here: nothing now, nothing later.
    const other = await open("other.localhost");
    await other.drop("#b");
    await other.click("never");
    await other.drop("#b");
    assert.equal((await other.buttons()).size, 0, "no card on a Not here site");
    assert.match((await latest()).page_text, /EU-West rose/);
    console.log("C4. Not here sends nothing, now or on the next drop");

    // C5. A sensitive site asks every time and never offers Always.
    const bank = await open("bank.localhost");
    await bank.drop("#b");
    assert.deepEqual([...(await bank.buttons()).keys()].sort(), ["dismiss", "once"]);
    await bank.click("once");
    await reads(/SPRING/, "bank.localhost");
    await bank.drop("#a");
    assert.deepEqual([...(await bank.buttons()).keys()].sort(), ["dismiss", "once"], "it asks again");
    await bank.click("dismiss");
    console.log("C5. a sensitive site asks every time, with no Always");

    // C6. Never ask: every drop is sent at once, even on a sensitive site.
    const sw = (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
    const { sessionId: swSession } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    await cdp("Runtime.evaluate", { expression: "chrome.storage.local.set({ mode: 'never_ask' })", awaitPromise: true }, swSession);
    await bank.drop("#a");
    assert.equal((await bank.buttons()).size, 0, "no card under Never ask");
    await reads(/EU-West rose/, "bank.localhost");
    const fresh = await open("fresh.localhost");
    await fresh.drop("#b");
    await reads(/SPRING/, "fresh.localhost");
    console.log("C6. Never ask sends every drop at once, sensitive sites included");
    console.log("all passed");
  } else {
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

    // 2b. An agent waiting (wait_for_focus) with only the browser paired is woken by the next drop.
    const started = Date.now();
    const waiting = tool("wait_for_focus", { timeout_s: 25 });
    await sleep(1500);
    // #b again: the steps below expect the latest reading to be the SPRING paragraph.
    await drag("#b", await payload());
    const woke = (await waiting).structuredContent;
    assert.equal(woke.focus?.kind, "page_reading", `the wait got the drop, not: ${JSON.stringify(woke).slice(0, 160)}`);
    assert.ok(Date.now() - started < 15_000, "the drop ended the wait, not its timeout");
    console.log(`2b. a wait in flight is woken by the drop (${((Date.now() - started) / 1000).toFixed(1)} s)`);

    // 2c. The agent's mark stays pinned on the paragraph: unread, then read; one pin per page; × clears it (TIN-469).
    const pinNodes = async (sid = sessionId) => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      const found = { states: [], close: null, mark: null };
      const walk = (n) => {
        const a = n.attributes ?? [];
        const i = a.indexOf("data-apc-pin-state");
        if (i >= 0) {
          found.states.push(a[i + 1]);
          found.mark = n.nodeId;
        }
        if (a.includes("data-apc-pin-close")) found.close = n.nodeId;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
      };
      walk(root);
      return found;
    };
    const centreOf = async (nodeId) => {
      const q = (await cdp("DOM.getBoxModel", { nodeId }, sessionId)).model.border;
      return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
    };
    // 2b's drop on #b left a pin there; this drop on #a moves it.
    const paraAt = await evaluate(`(() => { const r = document.querySelector("#a").getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; })()`);
    await drag("#a", await payload());
    // At the paragraph's first line: in its left margin, or at its right end when the page leaves no margin.
    const onA = (at) => (at.x < paraAt.left || at.x > paraAt.right - 40) && Math.abs(at.y - (paraAt.top + 14)) < 12;
    await until("one unread pin at the start of #a", async () => {
      const n = await pinNodes();
      return n.states.length === 1 && n.states[0] === "unread" && onA(await centreOf(n.mark));
    });
    const shot = async (name) => {
      if (!SHOTS) return;
      const clip = { x: Math.max(0, paraAt.right - 640), y: Math.max(0, paraAt.top - 60), width: 680, height: 140, scale: 2 };
      writeFileSync(join(SHOTS, `pin-${name}.png`), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", clip }, sessionId)).data, "base64"));
    };
    await shot("unread");
    await tool("page__get_reading");
    await until("the pin turns read", async () => (await pinNodes()).states[0] === "read", 15_000);
    await shot("read");
    await drag("#b", await payload());
    await until("the pin moved to the new drop, unread", async () => {
      const n = await pinNodes();
      return n.states.length === 1 && n.states[0] === "unread";
    });
    const hover = await centreOf((await pinNodes()).mark);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y }, sessionId);
    await sleep(300);
    const closeAt = await centreOf((await pinNodes()).close);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: closeAt.x, y: closeAt.y, button: "left", clickCount: 1 }, sessionId);
    await until("the pin is gone", async () => (await pinNodes()).states.length === 0);
    await until("the dock forgot the reading", async () => (await tool("page__get_reading")).isError === true);
    assert.equal((await tool("get_current_view")).structuredContent.focus, null);
    // Back to the SPRING reading the steps below expect.
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("2c. the pin sits on the paragraph, turns read, moves with a new drop, and × clears the reading");

    // 2d. A drop on another page replaces the reading at the dock: the first page's pin turns grey.
    await until("the pin for the SPRING drop", async () => (await pinNodes()).states.length === 1);
    const { targetId: secondId } = await cdp("Target.createTarget", { url: pageUrl });
    const { sessionId: second } = await cdp("Target.attachToTarget", { targetId: secondId, flatten: true });
    await sleep(2500);
    const at2 = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#a").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, second)).result.value;
    const data2 = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: at2.x, y: at2.y, data: data2 }, second);
    await until("a pin on the second page", async () => (await pinNodes(second)).states[0] === "unread");
    // A read pin asks every 10 s, so this can take that long.
    await until("the first page's pin turns stale", async () => (await pinNodes()).states[0] === "stale", 25_000);
    await cdp("Target.closeTarget", { targetId: secondId });
    // Back to the SPRING reading the steps below expect.
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("2d. a newer drop on another page turns the first page's pin grey");

    // 2e. Dragging the pin to another paragraph moves the agent's focus there, with no new consent (TIN-471).
    const pinAt = async () => centreOf((await until("a pin", async () => (await pinNodes()).mark)));
    const glide = async (from, to, finish) => {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y }, sessionId);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 }, sessionId);
      for (let i = 1; i <= 8; i++) {
        const x = from.x + ((to.x - from.x) * i) / 8;
        const y = from.y + ((to.y - from.y) * i) / 8;
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, sessionId);
        await sleep(40);
      }
      await finish?.();
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 }, sessionId);
    };
    await until("the pin on #b", async () => (await pinNodes()).states[0] === "unread");
    await glide(await pinAt(), await centre("#a"));
    await until("the reading of #a, after moving the pin", async () => /EU-West rose/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    await until("one unread pin at #a", async () => {
      const n = await pinNodes();
      return n.states.length === 1 && n.states[0] === "unread" && onA(await centreOf(n.mark));
    });
    // Esc puts it back: no new reading.
    const before = await pinAt();
    await glide(before, await centre("#b"), async () => {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
    });
    await sleep(2000);
    assert.match((await tool("page__get_reading")).structuredContent.page_text, /EU-West rose/);
    const after = await pinAt();
    assert.ok(Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2, "Esc put the pin back");
    // Back to the SPRING reading the steps below expect.
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("2e. dragging the pin to another paragraph moves the focus; Esc puts it back");
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
    const forged = await request("forged reader", `${DOCK}/apc/reader`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ ticket: await ticket(), agent: agent.id, label: "evil" }) });
    assert.equal(forged.body.error, "reader_not_allowed");
    console.log("5. a page's origin cannot ask for a reader");

    // 5b. A page built of divs and spans that takes every drag for its own sake (as X does) still takes the agent.
    const { targetId: busyId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/busy") });
    const { sessionId: busy } = await cdp("Target.attachToTarget", { targetId: busyId, flatten: true });
    await sleep(2500);
    const busyAt = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector(".post span").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`, returnByValue: true }, busy)).result.value;
    const busyData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: busyAt.x, y: busyAt.y, data: busyData }, busy);
    const busyReading = await until("the reading of the busy page's post", async () => {
      const r = (await tool("page__get_reading")).structuredContent;
      return /Nimbus cut its Pro price/.test(r?.page_text ?? "") ? r : null;
    });
    assert.equal(busyReading.reading.element.tag, "div");
    await cdp("Target.closeTarget", { targetId: busyId });
    // Back to the SPRING reading the steps below expect.
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("5b. a page of divs that takes every drag for its own sake still takes the agent");

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
  }
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
  if (PROD || CONSENT) rmSync(EXT, { recursive: true, force: true, maxRetries: 5 });
  process.exit(failed ? 1 : 0);
}
