// End to end check of the APC browser extension (TIN-421, DESIGN.md 13), by hand: a real Chrome or Edge with the
// extension, a dock, and real drags sent through the DevTools Protocol (Input.dispatchDragEvent, so the page sees
// trusted events). By default against a local dock: needs the dock's dev server (cd apps/dock && pnpm dev, port 5200)
// and apps/extension built with --dev. With --prod, against apc.tineira.com with the published build (apps/extension
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
const DOCK = PROD ? "https://apc.tineira.com" : "http://localhost:5200";
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

/**
 * A freshly started dev server answers its first calls to each route slowly or with vite's 500 page while it loads the
 * Worker (TIN-583: the first run after a start timed out waiting for the reader request). The extension asks for a reader
 * once per drop and does not retry, so before the first drop each route the extension calls is asked until it answers JSON.
 * These calls carry no token and no extension origin: the dock refuses them, which is all a warm-up needs.
 */
async function warmUp() {
  for (const path of ["/apc/reader", "/apc/reader/status", "/apc/reading", "/apc/reading/log", "/apc/reading/log/clear"]) {
    await until(`the dock answers ${path}`, async () => {
      const r = await fetch(DOCK + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
      const text = (await r?.text().catch(() => "")) ?? "";
      return r && !text.trimStart().startsWith("<");
    }, 60_000);
  }
}
if (!PROD) await warmUp();

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
<p id="c">Refund to card 4111 1111 1111 1111 by Friday.</p>
<p id="d">Wire the deposit to DE89 3704 0044 0532 0130 00 today.</p>
<input id="secret" value="hunter2">`;
// An APC app, as Pulse is: its agent bar (apc-agents, the mark the extension knows it by, TIN-703), targets (data-focus)
// that take the drop, and text around them that does not.
const APC = `<!doctype html><title>APC-like app</title><apc-agents></apc-agents><h1>Churn</h1><p id="note">Text of the app, outside any target.</p>
<div id="app" data-focus="figure:kpi" style="padding:30px;background:#eef">APC app area</div>
<div id="ignored" data-focus="figure:mute" style="padding:30px;background:#fee">Target of an app that takes no native drops</div>
<script>
const app = document.getElementById("app");
app.addEventListener("dragover", (e) => e.preventDefault());
app.addEventListener("drop", (e) => { e.preventDefault(); app.textContent = "app took it"; });
</script>`;
// A page that uses data-focus for its own sake, with no APC mark (TIN-703): an ordinary page to the extension.
const FOCUS = `<!doctype html><title>Focus page</title><h1>Ledger</h1><div data-focus="row:1"><p id="row">Rent paid on the 3rd, 410,000 CLP.</p></div>`;
// A page with a dashboard in a frame from another origin (TIN-752): the frame's page is served by a second server, on its own port.
const INNER = `<!doctype html><title>Embedded dashboard</title><body style="margin:0"><p id="fig" style="margin:0;padding:20px">Net revenue in Q3 was 12.4 M, up 8%.</p></body>`;
const framed = (host) => `<!doctype html><title>Framed page</title><h1>Report</h1><p id="top">The dashboard below comes from another origin.</p>
<iframe id="dash" src="http://${host}:${inner.address().port}/inner" style="width:600px;height:200px;border:1px solid #ccc"></iframe>
<iframe id="boxed" sandbox="allow-scripts" srcdoc="<p style='margin:0;padding:20px'>Sandboxed text with an opaque origin.</p>" style="width:600px;height:100px;border:1px solid #ccc"></iframe>`;
const inner = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(INNER)).listen(0, "::");
await new Promise((r) => inner.once("listening", r));
// Every host name gets the same page: *.localhost names (Chrome resolves them to this machine) are separate sites.
// A page like X: its text in divs and spans, and drag handlers of its own (for attaching files) that
// take every dragover with "copy", which would refuse the agent's "link" drag.
const BUSY = `<!doctype html><title>Busy feed</title><main><div class="post"><div><span>Nimbus cut its Pro price by 30% in EU-West</span></div></div></main>
<script>
addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
addEventListener("drop", (e) => e.preventDefault());
</script>`;
// A page like Grok: step 5c adds a dragover handler to it that refuses every drag, once the extension's is in place.
// It also stops every drop before the bubble phase on window, in the capture phase on window and on document (TIN-573).
const REFUSING = `<!doctype html><title>Refusing page</title><main><p id="reply">Nimbus renewed its Enterprise contracts early</p><p id="other">Nimbus also raised its Basic price</p></main>
<script>
addEventListener("drop", (e) => e.stopImmediatePropagation(), true);
document.addEventListener("drop", (e) => e.stopPropagation());
</script>`;
// A checkout (TIN-571, TIN-619): a chosen shipping option, a ticked box, a select, a typed note, sensitive numbers,
// a password, and fields the person cannot see. The form has a margin of its own, where a drop outlines it whole.
const CHECKOUT = `<!doctype html><title>Checkout</title><h1>Checkout</h1><h2>Your order<span style="opacity:0">HEADSECRET</span></h2>
<p id="intro">Orders placed before noon ship the same day.</p>
<form id="checkout" style="padding:28px;border:1px solid #ccc"><fieldset><legend>Shipping method</legend>
<label><input type="radio" name="ship" value="dhl"> DHL Express</label>
<label><input type="radio" name="ship" value="post" checked> Registered post</label>
<label for="saved-sel">Saved</label><select id="saved-sel" style="position:absolute;left:-9999px"><option>４１１１１１１１１１１１１１１１</option></select></fieldset>
<label><input type="checkbox" name="insurance" checked> Insurance</label>
<label><input type="checkbox" name="saved" checked> Visa 4111 1111 1111 1111</label>
<label>Country <select name="country"><option>Peru</option><option selected>Chile</option></select></label>
<label>Notes <input id="notes" name="notes" value="Leave at the door"></label>
<label>Card number <input name="cardnumber" value="4111111111111111"></label>
<label>Password <input type="password" value="hunter2"></label>
<label>Ingresa tu RUN <input id="run" name="run" value="12.345.678-5"></label>
<label>Reference <input id="ref" name="ref" value="de89 3704 0044 0532 0130 00"></label>
<input type="hidden" name="csrf" value="HIDDENTOKEN">${'<input type="hidden" name="tracking" value="t">'.repeat(20)}
<label for="rt" id="rt-label">Promo note</label> <input id="rt" role="textbox" value="ROLEVALUE" style="opacity:0;position:absolute">
<p id="promo" style="position:relative">Promo codes apply at the end.<input id="bait" name="data" value="BAITVALUE" style="opacity:0.02;position:absolute;left:0;top:0;width:100%;height:100%"></p>
<span style="opacity:0">SPANSECRET</span><span style="filter:opacity(0)">FILTERSECRET</span><span style="color:transparent">INKLESS</span>
<div style="height:24px;overflow:hidden"><div style="height:24px">Billing extras</div><label>Clipped <input name="clipped" value="CLIPPEDVALUE"></label></div>
<input id="below" name="below" value="BELOWVALUE" style="position:absolute;left:20px;top:2400px">
<p id="total">Total: $42.00</p></form>
<p id="gone">This paragraph goes away while the agent is dragged over it.</p>
<p id="wrapped" style="width:420px;height:20px;line-height:20px;overflow:hidden;white-space:pre-line;margin:0">FIRSTLINE shows in the box
SECONDLINE card 4111 1111 1111 1111 is cut off
THIRDLINE is cut off too</p>
<cvv-box id="cvv" style="display:block;width:200px"></cvv-box>
<script>
customElements.define("cvv-box", class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" }).innerHTML = '<label id="cvv-label">CVV</label> <input name="code" aria-labelledby="cvv-label" value="123">';
  }
});
</script>`;
// A form built as Google Forms builds one (TIN-619): each question a card, its title a role=heading that the answer
// names with aria-labelledby, and the answer in boxes of its own; a question of ARIA radios under a radiogroup.
const GFORM = `<!doctype html><title>Event sign-up</title><h1>Event sign-up</h1><div role="list">
<div role="listitem" id="q1" style="padding:20px;margin:12px;border:1px solid #ccc"><div><div role="heading" aria-level="3"><span id="i1">Email</span><span aria-hidden="true"> *</span></div></div><div><div><div aria-hidden="true" style="font-size:12px">Your answer</div><input id="email" type="email" aria-labelledby="i1" value="tomas@example.com" style="width:300px"></div></div></div>
<div role="listitem" id="q2" style="padding:20px;margin:12px;border:1px solid #ccc"><div><div role="heading" aria-level="3"><span id="i2">Your name</span></div></div><div><div><input type="text" aria-labelledby="i2" value="Tomas Neira" style="width:300px"></div></div></div>
<div role="listitem" id="q3" style="padding:20px;margin:12px;border:1px solid #ccc"><div><div role="heading" aria-level="3"><span id="i3">T-shirt size</span></div></div><div role="radiogroup" aria-labelledby="i3"><div role="radio" aria-checked="false">S</div><div role="radio" aria-checked="true">M</div><div role="radio" aria-checked="false">L</div></div></div>
</div>`;
const REFUSE = `addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "none"; })`;
// A table, and a paragraph with what innerText reads badly: a formula next to a hidden copy of itself, as Wikipedia has, and images with and without alt text (TIN-422).
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
// A grid of cards as autio.cl draws them (TIN-697): a photo with a photo-count badge, the car's title as a heading,
// and an empty link stretched over the whole card, its words only for screen readers.
const SR = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap";
const car = (id, title, price) => `<article id="${id}" style="position:relative;border:1px solid #ccc;width:220px"><div><div class="media" style="position:relative;height:60px;background:#ddd">
<img src="${PIXEL}" alt="" style="width:100%;height:100%"><span style="pointer-events:none;position:absolute;top:4px;right:4px;z-index:3"><span aria-hidden="true">5</span><span style="${SR}">5 photos</span></span></div>
<div><h2 style="font-size:14px">${title}</h2><p class="price">${price}</p></div></div><a href="#${id}" style="position:absolute;inset:0;z-index:2"><span style="${SR}">${title}</span></a></article>`;
const CARDS = `<section><h2>Cars for sale</h2><div style="display:flex;gap:8px">${car("audi", "Audi A3 Attraction 2009", "$8.900.000")}${car("saveiro", "Volkswagen Saveiro Comfortline 2020", "$10.100.000")}</div></section>`;
const FIGURES = `<!doctype html><title>Figures</title><h1>Figures</h1><h2>Countries</h2>
<table><thead><tr><th>Country</th><th>Population</th></tr></thead><tbody><tr><td>Peru</td><td>33</td></tr><tr><td>Chile</td><td id="cell">19.6</td></tr></tbody></table>
<p id="formula">Churn is <math alttext="L \\times T"><mi>L</mi><mi>T</mi></math><span style="display:none"><math alttext="HIDDEN COPY"><mi>H</mi></math></span>, see <img src="${PIXEL}" alt="the churn chart" width="20" height="20"> and <img src="${PIXEL}" width="20" height="20"> and <img src="${PIXEL}" alt="" width="20" height="20">.</p>
<table><tr style="display:none"><th>HIDDEN HEADER</th><th>HIDDEN HEADER</th></tr><tr><td>Row</td><td id="unseen">Plain</td></tr></table>
<p id="contents"><span style="display:contents">Revenue fell</span> as <img src="${PIXEL}" alt="the second chart" width="20" height="20"> shows.</p>
<p id="twice">Area is <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px)"><math alttext="x^{2}"><mi>x</mi></math></span><img src="${PIXEL}" alt="x^{2}" width="20" height="20"> here.</p>
${CARDS}`;
// The corpus (TIN-765): static pages in scripts/extension-e2e-corpus, served by name (step 12).
const CORPUS = resolve("scripts/extension-e2e-corpus");
const corpus = (url) => {
  const name = /^\/corpus\/([a-z-]+)$/.exec(url.split("?")[0])?.[1];
  return name ? readFileSync(join(CORPUS, `${name}.html`), "utf8") : null;
};
const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url.startsWith("/corpus/") ? corpus(req.url) : req.url.startsWith("/busy") ? BUSY : req.url.startsWith("/refusing") ? REFUSING : req.url.startsWith("/checkout") ? CHECKOUT : req.url.startsWith("/gform") ? GFORM : req.url.startsWith("/apc") ? APC : req.url.startsWith("/figures") ? FIGURES : req.url.startsWith("/focus") ? FOCUS : req.url.startsWith("/framed-out") ? framed("nothere.localhost") : req.url.startsWith("/framed") ? framed("127.0.0.1") : PAGE)).listen(0, "::");
await new Promise((r) => server.once("listening", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/notes?token=s3cr3t`;

// ---- the browser, with the extension loaded over CDP ----
const profile = mkdtempSync(join(tmpdir(), "apc-e2e-"));
// Without occlusion tracking: on a PC someone is working on, the test's window sits behind theirs, Chrome on Windows then
// calls its pages hidden, and step 8's Float (a picture-in-picture window) never opens.
const browser = spawn(EXE, ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-features=CalculateNativeWinOcclusion", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const out = browser.stdio[3];
// Once the browser closed at the end, a late write gets EPIPE: nothing to do then.
out.on("error", () => {});
/** Exceptions and console errors of the pages a step watches (Runtime.enable), shown when it fails. */
const pageErrors = [];
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
    else if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) pageErrors.push(JSON.stringify(m.params).slice(0, 300));
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
        sid,
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

    // C1. A new site asks on the card; Just this once sends (and the dock asks the first time). The first drop is on a
    // card number: it is left out, and once the browser is allowed, "Include them this time" offers it. Meanwhile a
    // second drop waits on its own card: Include sends the first drop's reading, never the second's (TIN-619, Grok's review).
    const a = await open("a.localhost");
    await a.drop("#c");
    assert.deepEqual([...(await a.buttons()).keys()].sort(), ["always", "never", "once"]);
    await a.click("once");
    const pending = await until("a reader request in the dock", async () => (await api(`${base}/state`)).agents[0].pairings.find((p) => p.kind === "reader" && p.status === "pending"));
    await a.drop("#d");
    assert.deepEqual([...(await a.buttons()).keys()].sort(), ["always", "never", "once"], "the second drop waits on its own card");
    await api(`${base}/pairings/${pending.id}`, { action: "approve" });
    assert.match((await reads(/Refund to card/, "a.localhost")).page_text, /Refund to card \[sensitive number left out\] by Friday\./);
    /** The "Include them this time" card's buttons, through its closed shadow root. */
    const includeAt = async (value) => {
      const nodeId = await until(`the ${value} button of the sent card`, async () => {
        const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, a.sid);
        let found = null;
        const walk = (n) => {
          const at = (n.attributes ?? []).indexOf("data-apc-include");
          if (at >= 0 && n.attributes[at + 1] === value) found = n.nodeId;
          for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
        };
        walk(root);
        return found;
      }, 15_000);
      const q = (await cdp("DOM.getBoxModel", { nodeId }, a.sid)).model.content;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, button: "left", clickCount: 1 }, a.sid);
      await sleep(1500);
    };
    await includeAt("include");
    const included = await reads(/Refund to card 4111 1111 1111 1111/, "a.localhost");
    assert.doesNotMatch(included.page_text, /DE89|Wire the deposit/, "Include sent the first drop's reading, not the second's");
    assert.ok((await a.buttons()).has("once"), "the second drop's card is still unanswered");
    // The second drop, answered now, goes with its number left out.
    await a.click("once");
    assert.match((await reads(/Wire the deposit/, "a.localhost")).page_text, /Wire the deposit to \[sensitive number left out\] today\./);
    await includeAt("dismiss");
    console.log("C1. a new site asks; Just this once sends; Include them this time sends that drop's reading, never a later one's");

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

    // C5. A government domain asks every time and never offers Always (TIN-478).
    const sw = (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
    const { sessionId: swSession } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const gov = await open("sii.gob.localhost");
    await gov.drop("#b");
    assert.deepEqual([...(await gov.buttons()).keys()].sort(), ["dismiss", "once"]);
    await gov.click("once");
    await reads(/SPRING/, "sii.gob.localhost");
    await gov.drop("#a");
    assert.deepEqual([...(await gov.buttons()).keys()].sort(), ["dismiss", "once"], "it asks again");
    await gov.click("dismiss");
    console.log("C5. a government domain asks every time, with no Always");

    // C5b. A bank is not recognised by name: it asks as any site does, until the person sets it to Always ask.
    const bank = await open("bank.localhost");
    await bank.drop("#b");
    assert.deepEqual([...(await bank.buttons()).keys()].sort(), ["always", "never", "once"], "an ordinary site's card");
    await bank.click("once");
    // What the popup's Always ask does.
    const origin = new URL(pageUrl.replace("127.0.0.1", "bank.localhost")).origin;
    await cdp("Runtime.evaluate", { expression: `chrome.storage.local.get("sites").then((s) => chrome.storage.local.set({ sites: { ...(s.sites ?? {}), ${JSON.stringify(origin)}: "sensitive" } }))`, awaitPromise: true }, swSession);
    await bank.drop("#b");
    assert.deepEqual([...(await bank.buttons()).keys()].sort(), ["dismiss", "once"], "now it asks every time");
    await bank.click("once");
    await reads(/SPRING/, "bank.localhost");
    console.log("C5b. a site set to Always ask asks every time, with no Always");

    // C6. Never ask: every drop is sent at once, even on a sensitive site.
    await cdp("Runtime.evaluate", { expression: "chrome.storage.local.set({ mode: 'never_ask' })", awaitPromise: true }, swSession);
    await gov.drop("#a");
    assert.equal((await gov.buttons()).size, 0, "no card under Never ask");
    await reads(/EU-West rose/, "sii.gob.localhost");
    const fresh = await open("fresh.localhost");
    await fresh.drop("#b");
    await reads(/SPRING/, "fresh.localhost");
    console.log("C6. Never ask sends every drop at once, sensitive sites included");

    // C7. Not here sticks under Never ask (TIN-571): on a site set to Not here, and when chosen on the card that
    // asks once more after an update (an install has seen it: undone here, as an update from before would be).
    await other.drop("#a");
    assert.equal((await other.buttons()).size, 0, "no card on a Not here site under Never ask");
    assert.match((await latest()).page_text, /SPRING/, "and nothing sent");
    await cdp("Runtime.evaluate", { expression: "chrome.storage.local.set({ readingNoticeAll2: false, readingNoticeSites2: [] })", awaitPromise: true }, swSession);
    const updated = await open("updated.localhost");
    await updated.drop("#a");
    const offered = await until("the card that asks once more", async () => ((await updated.buttons()).size ? [...(await updated.buttons()).keys()].sort() : null), 10_000);
    assert.deepEqual(offered, ["always", "never", "once"]);
    await updated.click("never");
    await updated.drop("#a");
    assert.equal((await updated.buttons()).size, 0, "Not here on that card sticks");
    assert.match((await latest()).page_text, /SPRING/, "and nothing was sent");
    console.log("C7. under Never ask, Not here sticks, also when chosen on the card that asks once more");
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
    /** Pins in the top document and in its frames' documents (same-site frames are in the same tree). */
    const pinsByDocument = async (sid) => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      const found = { top: 0, inFrames: 0 };
      const walk = (n, framed) => {
        if ((n.attributes ?? []).includes("data-apc-pin-state")) found[framed ? "inFrames" : "top"]++;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c, framed);
        if (n.contentDocument) walk(n.contentDocument, true);
      };
      walk(root, false);
      return found;
    };
    /** The extension's cards for a drop an app cannot take (data-apc-answer), through their closed shadow roots. */
    const marked = async (sid, attr) => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      const found = [];
      const walk = (n) => {
        const a = n.attributes ?? [];
        const i = a.indexOf(attr);
        if (i >= 0) found.push(a[i + 1]);
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
      };
      walk(root);
      return found;
    };
    const answers = (sid) => marked(sid, "data-apc-answer");
    // A node id from DOM.getDocument names one element for as long as it lives, and the extension replaces a pin's
    // host (pin() removes the old one and appends a new one on each drop and move). An id taken, then used a moment
    // later, can name a pin that is gone: DOM.getBoxModel "Could not find node with given id" (the flake of 2c).
    // So the element is looked up again, with `find` (a fresh pinNodes() each time), until its box is read.
    const centreOf = async (find) => {
      for (let attempt = 0; ; attempt++) {
        const nodeId = await find();
        if (nodeId) {
          try {
            const q = (await cdp("DOM.getBoxModel", { nodeId }, sessionId)).model.border;
            return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
          } catch (e) {
            if (!/Could not find node/.test(String(e?.message ?? e))) throw e;
          }
        }
        if (attempt >= 40) throw new Error("timed out: the pin's box (no pin node stayed long enough to measure)");
        await sleep(100);
      }
    };
    const pinMarkNode = async () => (await pinNodes()).mark;
    const pinCloseNode = async () => (await pinNodes()).close;
    // 2b's drop on #b left a pin there; this drop on #a moves it.
    const paraAt = await evaluate(`(() => { const r = document.querySelector("#a").getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; })()`);
    await drag("#a", await payload());
    // At the paragraph's first line: in its left margin, or at its right end when the page leaves no margin.
    const onA = (at) => (at.x < paraAt.left || at.x > paraAt.right - 40) && Math.abs(at.y - (paraAt.top + 14)) < 12;
    await until("one unread pin at the start of #a", async () => {
      const n = await pinNodes();
      return n.states.length === 1 && n.states[0] === "unread" && onA(await centreOf(pinMarkNode));
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
    const hover = await centreOf(pinMarkNode);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y }, sessionId);
    await sleep(300);
    const closeAt = await centreOf(pinCloseNode);
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
    const pinAt = async () => centreOf(pinMarkNode);
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
      return n.states.length === 1 && n.states[0] === "unread" && onA(await centreOf(pinMarkNode));
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

    // 3. An APC app is the app's own (TIN-476): its target keeps the drop, and a drop on its text
    // outside any target, which the app leaves alone, still gets no reading and no pin from the extension.
    const { targetId: apcId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/apc") });
    const { sessionId: apc } = await cdp("Target.attachToTarget", { targetId: apcId, flatten: true });
    await sleep(2500);
    const dropOn = async (sid, sel) => {
      const at = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, sid)).result.value;
      const data = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
      for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }, sid);
      await sleep(2000);
    };
    await dropOn(apc, "#app");
    assert.equal((await cdp("Runtime.evaluate", { expression: `document.getElementById("app").textContent`, returnByValue: true }, apc)).result.value, "app took it");
    await dropOn(apc, "#note");
    assert.equal((await pinNodes(apc)).states.length, 0, "no pin from the extension on an APC app");
    assert.match((await tool("page__get_reading")).structuredContent.page_text, /SPRING/);
    // A drop nothing on the app took is answered, not refused in silence (TIN-703); a drop the app took is not.
    assert.deepEqual(await answers(apc), ["not_taken"], "one card for the drop the app left alone");
    await cdp("Target.closeTarget", { targetId: apcId });
    // An APC app that takes no dock drops (Pulse without v2) leaves the dragover over its own target unanswered, and
    // ignores the drop there: the card too, not silence (TIN-756). A new page, since a new card replaces the old.
    const { targetId: muteId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/apc") });
    const { sessionId: mute } = await cdp("Target.attachToTarget", { targetId: muteId, flatten: true });
    await sleep(2500);
    await dropOn(mute, "#ignored");
    assert.deepEqual(await answers(mute), ["not_taken"], "a target the app does not answer is not silent");
    assert.equal((await pinNodes(mute)).states.length, 0);
    await cdp("Target.closeTarget", { targetId: muteId });
    console.log("3. on an APC app the app keeps the drop, and the extension sends nothing and pins nothing; a drop the app leaves says so");

    // 3b. data-focus alone is not an APC app (TIN-703): the page takes the agent and its reading goes.
    const { targetId: focusId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/focus") });
    const { sessionId: focus } = await cdp("Target.attachToTarget", { targetId: focusId, flatten: true });
    await sleep(2500);
    await dropOn(focus, "#row");
    await until("the reading of a data-focus page", async () => /Rent paid on the 3rd/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    await until("a pin on the data-focus page", async () => (await pinNodes(focus)).states.length === 1);
    await cdp("Target.closeTarget", { targetId: focusId });
    console.log("3b. a page with data-focus but no APC mark takes the agent's drop and reading");

    // 3c. A drop on a frame from another origin of a granted host (another port) lands in the frame (TIN-752): read from the
    // frame (its address, the tab's title then its own), pinned in the frame's document, and the top frame takes nothing.
    const { targetId: framedId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/framed") });
    const { sessionId: framedSid } = await cdp("Target.attachToTarget", { targetId: framedId, flatten: true });
    await sleep(3000);
    const dash = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.getElementById("dash").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`, returnByValue: true }, framedSid)).result.value;
    const inFrameAt = { x: dash.x + 60, y: dash.y + 31 };
    const frameData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, ...inFrameAt, data: frameData }, framedSid);
    const framedReading = await until("the reading from the frame", async () => {
      const r = (await tool("page__get_reading")).structuredContent;
      return /Net revenue in Q3/.test(r?.page_text ?? "") ? r : null;
    });
    assert.match(framedReading.page_text, new RegExp(`Address: http://127\\.0\\.0\\.1:${inner.address().port}/inner`), "the frame's address");
    assert.match(framedReading.page_text, /Page: Framed page · Embedded dashboard/, "the tab's title, then the frame's");
    const framePins = await until("one pin, in the frame", async () => {
      const n = await pinsByDocument(framedSid);
      return n.inFrames === 1 ? n : null;
    });
    assert.equal(framePins.top, 0, "the top frame drew no pin");
    // A sandboxed frame (an opaque origin) has no address a reading could name: it says so, and nothing is sent (review on #142).
    const boxed = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.getElementById("boxed").getBoundingClientRect(); return { x: r.x + 60, y: r.y + 31 }; })()`, returnByValue: true }, framedSid)).result.value;
    const boxedData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    // Chrome puts a sandboxed frame in a process of its own: the drag goes to that frame's own target, in its coordinates.
    const boxedTarget = (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "iframe" && t.url === "about:srcdoc");
    const boxedSid = boxedTarget ? (await cdp("Target.attachToTarget", { targetId: boxedTarget.targetId, flatten: true })).sessionId : framedSid;
    const boxedAt = boxedTarget ? { x: 60, y: 31 } : boxed;
    for (const type of ["dragEnter", "dragOver", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, ...boxedAt, data: boxedData }, boxedSid);
    await until("the opaque frame's note", async () => (await marked(boxedSid, "data-apc-note")).includes("opaque_frame"), 8000);
    assert.match((await tool("page__get_reading")).structuredContent.page_text, /Net revenue in Q3/, "nothing was sent from the sandboxed frame");
    await cdp("Target.closeTarget", { targetId: framedId });
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("3c. a drop in a frame from another origin lands there: read from the frame, pinned in it, and only there; a sandboxed frame says it cannot be read");

    // 3d. A frame from an origin not granted (nothere.localhost, another site, so another process): no content script there,
    // so the drop is refused and nothing is sent. The service worker lists the tab's frames by their real origins
    // (webNavigation), which the popup asks for with the site and the top frame's note names (TIN-752).
    // Not checked here: the note itself. Drags sent through the DevTools Protocol never reach an out-of-process frame, and
    // the top page gets no dragleave for them either (it sees dragenter and dragover over its own content only).
    const { targetId: outId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/framed-out") });
    const { sessionId: outSid } = await cdp("Target.attachToTarget", { targetId: outId, flatten: true });
    await sleep(3000);
    const outFrame = (await cdp("Runtime.evaluate", { expression: `(() => { const f = document.getElementById("dash").getBoundingClientRect(); return { x: f.x + 60, y: f.y + 31 }; })()`, returnByValue: true }, outSid)).result.value;
    const outData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, ...outFrame, data: outData }, outSid);
    await sleep(1500);
    assert.match((await tool("page__get_reading")).structuredContent.page_text, /SPRING/, "nothing was sent from the frame");
    const swTarget = (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
    const { sessionId: swSid } = await cdp("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
    const frameOrigins = (await cdp("Runtime.evaluate", { expression: `chrome.tabs.query({ url: "http://127.0.0.1/framed-out*" }).then(([tab]) => chrome.webNavigation.getAllFrames({ tabId: tab.id })).then((frames) => frames.map((f) => new URL(f.url).origin))`, awaitPromise: true, returnByValue: true }, swSid)).result.value;
    assert.ok(frameOrigins.includes(`http://nothere.localhost:${inner.address().port}`), `the frame's origin is listed: ${JSON.stringify(frameOrigins)}`);
    await cdp("Target.closeTarget", { targetId: outId });
    console.log("3d. a frame from an origin not granted takes nothing, and the service worker lists it by its real origin (the note itself is not checked: see above)");

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

    // 5c. A page that refuses every drag from a handler added after the extension's (as Grok does) still takes the agent.
    const { targetId: refusingId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/refusing") });
    const { sessionId: refusing } = await cdp("Target.attachToTarget", { targetId: refusingId, flatten: true });
    await sleep(2500);
    const refusingAt = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#reply").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`, returnByValue: true }, refusing)).result.value;
    const refusingData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    const refusingDrag = (type) => cdp("Input.dispatchDragEvent", { type, x: refusingAt.x, y: refusingAt.y, data: refusingData }, refusing);
    await cdp("Runtime.evaluate", { expression: REFUSE }, refusing);
    await refusingDrag("dragEnter");
    // A second handler arrives during the drag: the first dragover answers before it, the next one after it.
    await cdp("Runtime.evaluate", { expression: REFUSE }, refusing);
    for (const type of ["dragOver", "dragOver", "drop"]) await refusingDrag(type);
    // The page also stops every drop on window (capture) and on document: the extension's capture listener comes first (TIN-573).
    await until("the reading of the refusing page", async () => /Enterprise contracts/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    // dragenter by itself moves the dragover listener last (TIN-573): a refusing handler added before the drag, then
    // one dragover only. Had dragenter not moved it, that dragover would answer before the handler and be refused.
    const otherAt = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#other").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`, returnByValue: true }, refusing)).result.value;
    const otherData = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    await cdp("Runtime.evaluate", { expression: REFUSE }, refusing);
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: otherAt.x, y: otherAt.y, data: otherData }, refusing);
    await until("the reading after dragenter alone moved the listener", async () => /Basic price/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    await cdp("Target.closeTarget", { targetId: refusingId });
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("5c. a page that refuses every drag from a later handler, and stops every drop, still takes the agent; dragenter alone moves the listener");

    // 10. A checkout (TIN-571, TIN-619): the outline is what goes. A paragraph sends its text; a field's card (the field with
    // its label) sends that field; a drop on the form's margin outlines the whole form and sends every field the person can
    // see. Under Ask per drop, sensitive numbers are left out and "Include them this time" sends the same reading with them;
    // under Send if it's in the outline they go at once; under Always leave out never. Passwords, codes and fields the
    // person cannot see never go. The selection follows the same rule.
    const { targetId: checkoutId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/checkout") });
    const { sessionId: checkout } = await cdp("Target.attachToTarget", { targetId: checkoutId, flatten: true });
    await sleep(2500);
    const inCheckout = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true }, checkout)).result.value;
    const latestReading = async () => (await tool("page__get_reading")).structuredContent;
    /** The "Include them this time" card's buttons (a closed shadow root: DevTools sees through it), by data-apc-include. */
    const includeButtons = async (sid) => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      const found = new Map();
      const walk = (n) => {
        const a = n.attributes ?? [];
        const i = a.indexOf("data-apc-include");
        if (i >= 0) found.set(a[i + 1], n.nodeId);
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
      };
      walk(root);
      return found;
    };
    /** Click a button of the card with real mouse events: "include" or "dismiss". */
    const clickInclude = async (sid, which) => {
      const nodeId = await until(`the ${which} button of the sent card`, async () => (await includeButtons(sid)).get(which), 10_000);
      const q = (await cdp("DOM.getBoxModel", { nodeId }, sid)).model.content;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, button: "left", clickCount: 1 }, sid);
    };
    /** The sent card's words, once it shows. */
    const cardText = async (sid) => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      let text = null;
      const walk = (n) => {
        if ((n.attributes ?? []).includes("data-apc-include")) return;
        if (n.nodeName === "P" && (n.children ?? []).some((c) => /left out\./.test(c.nodeValue ?? ""))) text = n.children.map((c) => c.nodeValue).join("");
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
      };
      walk(root);
      return text;
    };
    /** Wait for a reading newer than the one before. */
    const nextReading = (what, before) =>
      until(`the reading of ${what}`, async () => {
        const r = await latestReading();
        return r?.reading?.taken_at && r.reading.taken_at !== before ? r.page_text : null;
      });
    /** Drop on an element (its left part, or `at` inside its box; a selector, or an expression in parentheses), then wait for the new reading. */
    const dropOnPage = async (sid, selector, at = null) => {
      const before = (await latestReading())?.reading?.taken_at;
      const find = selector.startsWith("(") ? selector : `document.querySelector(${JSON.stringify(selector)})`;
      const offset = at ? `{ x: r.x + ${at.x}, y: r.y + ${at.y} }` : `{ x: r.x + 10, y: r.y + r.height / 2 }`;
      const point = (await cdp("Runtime.evaluate", { expression: `(() => { const r = ${find}.getBoundingClientRect(); return ${offset}; })()`, returnByValue: true }, sid)).result.value;
      const dragged = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
      for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data: dragged }, sid);
      return nextReading(selector, before);
    };
    const dropOnCheckout = (selector, at) => dropOnPage(checkout, selector, at);
    /**
     * Under Ask per drop: dismiss the card a drop that left something out shows, so the next check starts with none.
     * The reading reaches the dock before the service worker answers the page and the card shows: wait for the card
     * itself (TIN-583: dismissing too early left it up, and it stood on the next drop's check).
     */
    const dismiss = async (sid = checkout) => {
      await clickInclude(sid, "dismiss");
      await until("no sent card", async () => (await includeButtons(sid)).size === 0, 5000);
    };
    /** Change the sensitive-data setting as the person does, with the popup's own radio (TIN-619). */
    const setSensitive = async (value) => {
      const { targetId: popupId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
      const { sessionId: popupSession } = await cdp("Target.attachToTarget", { targetId: popupId, flatten: true });
      await until("the popup's sensitive-data choices", async () => (await cdp("Runtime.evaluate", { expression: "document.querySelectorAll('input[name=sensitive]').length === 3", returnByValue: true }, popupSession)).result.value);
      await sleep(500);
      await cdp("Runtime.evaluate", { expression: `document.querySelector('input[name=sensitive][value=${value}]').click()` }, popupSession);
      await until(`the setting ${value}`, async () => (await cdp("Runtime.evaluate", { expression: "chrome.storage.local.get('sensitive').then((s) => s.sensitive)", awaitPromise: true, returnByValue: true }, popupSession)).result.value === value);
      await cdp("Target.closeTarget", { targetId: popupId });
    };
    // Never in any reading: a password, hidden inputs and fields, text nobody can see, and what a box clips away or the outline leaves out.
    const NEVER = ["hunter2", "HIDDENTOKEN", "BAITVALUE", "ROLEVALUE", "123\n", "SPANSECRET", "FILTERSECRET", "INKLESS", "CLIPPEDVALUE", "BELOWVALUE", "Clipped", "HEADSECRET", "SECONDLINE", "THIRDLINE"];
    const SENSITIVE = ["4111", "４１１１", "12.345", "de89"];
    const noneOf = (text, list) => {
      for (const secret of list) assert.ok(!text.includes(secret), `the reading has no ${JSON.stringify(secret)}`);
    };
    const noSecret = (text) => noneOf(text, [...NEVER, ...SENSITIVE]);

    // A paragraph inside the form: its text, with the selection and where it is, and no field of the form around it.
    await inCheckout(`(() => { const t = document.querySelector("#intro").firstChild; const at = t.textContent.indexOf("before noon"); const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + "before noon".length); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const total = await dropOnCheckout("#total");
    assert.match(total, /Pointed at \(p\): Total: \$42\.00\nSelected: before noon\nThe selection is under the heading: Your order\nThe selection is in: Orders placed before noon ship the same day\.$/);
    assert.doesNotMatch(total, /Form fields/, "the outline was the paragraph");
    noSecret(total);
    // A selection of a card number printed on the page: the number left out, the rest of the selection kept, and the card offers it.
    await inCheckout(`(() => { const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Visa")); const r = document.createRange(); r.selectNodeContents(label.lastChild); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const selectedCard = await dropOnCheckout("#total");
    assert.match(selectedCard, /\nSelected: Visa \[sensitive number left out\]/);
    noSecret(selectedCard);
    assert.equal(await until("the sent card", () => cardText(checkout), 10_000), "Sent to your agent. 1 sensitive value left out.");
    let prior = (await latestReading()).reading.taken_at;
    await clickInclude(checkout, "include");
    assert.match(await nextReading("the selection, included", prior), /\nSelected: Visa 4111 1111 1111 1111/);
    await inCheckout(`getSelection().removeAllRanges()`);
    // The notes field: its card is its label, so its typed value goes, marked; typing after the drop sends nothing until the next drop.
    assert.match(await dropOnCheckout("#notes"), /Pointed at \(label\): Notes\nForm fields, as filled in on the page:\n- Notes: Leave at the door \(pointed at\)$/);
    await inCheckout(`(() => { const n = document.querySelector("#notes"); n.value = "Ring twice"; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(2000);
    assert.match((await latestReading()).page_text, /- Notes: Leave at the door \(pointed at\)/);
    assert.match(await dropOnCheckout("#notes"), /- Notes: Ring twice \(pointed at\)/);
    assert.equal(await inCheckout(`document.querySelector("#notes").value`), "Ring twice", "the drop typed nothing into the field");
    // A RUN and a lowercase IBAN, each dropped on: left out under Ask per drop; Include them this time sends that same reading with it.
    const run = await dropOnCheckout("#run");
    assert.match(run, /- Ingresa tu RUN: \(left out as sensitive\) \(pointed at\)$/);
    noSecret(run);
    prior = (await latestReading()).reading.taken_at;
    // What is in the field now is not what goes: the reading was taken at the drop.
    await inCheckout(`document.querySelector("#run").value = "CHANGED AFTER"`);
    await clickInclude(checkout, "include");
    const runIncluded = await nextReading("the RUN, included", prior);
    assert.match(runIncluded, /- Ingresa tu RUN: 12\.345\.678-5 \(pointed at\) \(sensitive: the person chose to send it\)$/);
    assert.doesNotMatch(runIncluded, /CHANGED AFTER/);
    await inCheckout(`document.querySelector("#run").value = "12.345.678-5"`);
    const ref = await dropOnCheckout("#ref");
    assert.match(ref, /- Reference: \(left out as sensitive\) \(pointed at\)$/);
    noSecret(ref);
    await dismiss();
    // A CVV labelled inside a shadow root: a code, never sent, and nothing to include.
    const cvv = await dropOnCheckout('(document.querySelector("#cvv").shadowRoot.querySelector("input"))');
    assert.match(cvv, /- CVV: \(left out: password or code\) \(pointed at\)$/);
    noSecret(cvv);
    await sleep(800);
    assert.equal((await includeButtons(checkout)).size, 0, "a code is not offered");
    // A field the person can hardly see (opacity 0.02) laid over a paragraph: the outline is the paragraph, and the field is
    // never read. A transparent role=textbox reached through its visible label: the label alone, nothing of the field.
    const bait = await dropOnCheckout("#promo");
    assert.match(bait, /Pointed at \(p\): Promo codes apply at the end\.$/);
    noSecret(bait);
    const role = await dropOnCheckout("#rt-label");
    assert.match(role, /Pointed at \(label\): Promo note$/);
    noSecret(role);
    // A paragraph wrapped past its 20 px overflow box, its card number on line 2: only line 1 goes, under any setting (Grok's fix check).
    // The heading above it has a span at opacity 0, which never goes either.
    await setSensitive("send");
    const wrapped = await dropOnCheckout("#wrapped", { x: 10, y: 10 });
    assert.match(wrapped, /Pointed at \(p\): FIRSTLINE shows in the box$/);
    assert.match(wrapped, /Under the heading: Your order\n/);
    noSecret(wrapped);
    await setSensitive("ask");
    // A page that takes away what was outlined before the drop: nothing is read in its place, and nothing is sent (Grok's review).
    const gonePoint = await inCheckout(`(() => { const r = document.querySelector("#gone").getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
    const goneDrag = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, x: gonePoint.x, y: gonePoint.y, data: goneDrag }, checkout);
    assert.match(await inCheckout(`document.querySelector("#gone").style.outline`), /solid/);
    prior = (await latestReading()).reading.taken_at;
    await inCheckout(`(() => { const p = document.querySelector("#gone"); const q = document.createElement("form"); q.innerHTML = '<input name="other" value="REPLACEDVALUE" style="width:600px;height:40px">'; p.replaceWith(q); })()`);
    await cdp("Input.dispatchDragEvent", { type: "drop", x: gonePoint.x, y: gonePoint.y, data: goneDrag }, checkout);
    await sleep(2500);
    assert.equal((await latestReading()).reading.taken_at, prior, "nothing was sent for a detached outline");
    // The form outlined whole, by a drop on its margin: every field the person can see, with what was typed in each.
    // The outline is drawn on the form while the agent is dragged there, and the drop reads that.
    const margin = { x: 8, y: 8 };
    const whole = await dropOnCheckout("#checkout", margin);
    assert.match(whole, /Pointed at \(form\): Shipping method/);
    assert.match(
      whole,
      /Form fields, as filled in on the page:\n- Shipping method: Registered post\n- Insurance: checked\n- Country: Chile\n- Notes: Ring twice\n- Card number: \(left out as sensitive\)\n- Password: \(left out: password or code\)\n- Ingresa tu RUN: \(left out as sensitive\)\n- Reference: \(left out as sensitive\)\n1 field left out as sensitive\./,
    );
    assert.match(whole, /Visa \[sensitive number left out\]/, "the card number in the form's own text is left out, and only it");
    noSecret(whole);
    assert.match(await until("the sent card", () => cardText(checkout), 10_000), /^Sent to your agent\. \d+ sensitive values left out\.$/);
    prior = (await latestReading()).reading.taken_at;
    await clickInclude(checkout, "include");
    const wholeIncluded = await nextReading("the whole form, included", prior);
    for (const line of [/- Card number: 4111111111111111 \(sensitive: the person chose to send it\)/, /- Ingresa tu RUN: 12\.345\.678-5 \(sensitive/, /- Reference: de89 3704 0044 0532 0130 00 \(sensitive/, /- Visa 4111 1111 1111 1111: checked \(sensitive/, /Visa 4111 1111 1111 1111/, /- Password: \(left out: password or code\)/]) assert.match(wholeIncluded, line);
    noneOf(wholeIncluded, NEVER);
    // Send if it's in the outline: they go at once, no card. Always leave out: never, no card. The popup sets it, for the next drop.
    await setSensitive("send");
    const sentAll = await dropOnCheckout("#checkout", margin);
    assert.match(sentAll, /- Card number: 4111111111111111 \(sensitive: the person chose to send it\)/);
    noneOf(sentAll, NEVER);
    await sleep(800);
    assert.equal((await includeButtons(checkout)).size, 0, "no card under Send if it's in the outline");
    await setSensitive("never");
    const neverSent = await dropOnCheckout("#checkout", margin);
    assert.match(neverSent, /- Card number: \(left out as sensitive\)/);
    noSecret(neverSent);
    await sleep(800);
    assert.equal((await includeButtons(checkout)).size, 0, "no card under Always leave out");
    await setSensitive("ask");
    await cdp("Target.closeTarget", { targetId: checkoutId });
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("10. the outline is what goes: a paragraph, a field's card, a whole form; sensitive numbers by the setting with Include them this time; never a password, code or hidden field; only on the drop");

    // 11. A Google-Forms-like card (TIN-619): a drop on the question's title outlines the whole card and sends the answer typed
    // in it, and only that answer; the same on the card's margin, on the answer itself, and for a question of ARIA radios.
    const { targetId: gformId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/gform") });
    const { sessionId: gform } = await cdp("Target.attachToTarget", { targetId: gformId, flatten: true });
    await sleep(2500);
    // While dragged over the title, the outline is on the card.
    const titleAt = (await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector("#i1").getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`, returnByValue: true }, gform)).result.value;
    const overTitle = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
    for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, x: titleAt.x, y: titleAt.y, data: overTitle }, gform);
    assert.match((await cdp("Runtime.evaluate", { expression: `document.querySelector("#q1").style.outline`, returnByValue: true }, gform)).result.value, /solid/, "the card is outlined");
    prior = (await latestReading())?.reading?.taken_at;
    await cdp("Input.dispatchDragEvent", { type: "drop", x: titleAt.x, y: titleAt.y, data: overTitle }, gform);
    const email = await nextReading("the Email question", prior);
    assert.match(email, /Pointed at \(div, listitem\): Email \*/);
    assert.match(email, /\nForm fields, as filled in on the page:\n- Email: tomas@example\.com$/);
    assert.doesNotMatch(email, /Tomas Neira|T-shirt/, "only this card");
    assert.match(await dropOnPage(gform, "#q1", { x: 4, y: 4 }), /\n- Email: tomas@example\.com$/);
    assert.match(await dropOnPage(gform, "#email"), /\n- Email: tomas@example\.com \(pointed at\)$/);
    const size = await dropOnPage(gform, "#i3");
    assert.match(size, /\n- T-shirt size: M$/);
    assert.doesNotMatch(size, /tomas@example/);
    await cdp("Target.closeTarget", { targetId: gformId });
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("11. a Google-Forms-like card: a drop on its title, its margin or its answer outlines the card and sends that answer only");

    // 12. Charts and the corpus (TIN-760, TIN-765): the pages of scripts/extension-e2e-corpus, written by hand with the DOM
    // shapes of Highcharts, ECharts, D3 and Recharts (class names included), a canvas chart, a pie and a map whose shapes
    // name themselves and the same without names, a big table and a form. A drop on a chart's mark outlines that mark (a
    // box drawn over it: CSS draws no outline on SVG shapes), pins there and reads what the page writes for it: its
    // category, its series where the page declares it, and its value only when it is written (its own accessible text or a
    // data label at it), else "(no value written on the chart)". Nothing is read off an axis. A drop elsewhere reads the
    // whole container, each label once.
    const NONE = "\\(no value written on the chart\\)";
    const openCorpus = async (name) => {
      const { targetId } = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", `/corpus/${name}`) });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      await sleep(2500);
      return { targetId, sid: sessionId };
    };
    const boxIn = async (sid, selector) => (await cdp("Runtime.evaluate", { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, sid)).result.value;
    /** Drag over (x, y), return what the outline is then, drop, and return the new reading. */
    const dropOnChart = async (sid, x, y) => {
      const before = (await latestReading())?.reading?.taken_at;
      const dragged = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
      for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, x, y, data: dragged }, sid);
      // The box is in a closed shadow root: DevTools sees through it.
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, sid);
      let boxNode = null;
      const walk = (n) => {
        if ((n.attributes ?? []).includes("data-apc-outline-box")) boxNode = n.nodeId;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
      };
      walk(root);
      const q = boxNode ? (await cdp("DOM.getBoxModel", { nodeId: boxNode }, sid)).model.border : null;
      const outlinedEls = (await cdp("Runtime.evaluate", { expression: `[...document.querySelectorAll("div,figure,svg,canvas,td,p,form")].filter((e) => e.style.outline.includes("solid")).map((e) => e.id || e.tagName)`, returnByValue: true }, sid)).result.value;
      await cdp("Input.dispatchDragEvent", { type: "drop", x, y, data: dragged }, sid);
      return { outlined: { box: q ? { left: q[0], top: q[1], right: q[4], bottom: q[5] } : null, outlined: outlinedEls }, text: await nextReading(`the corpus at ${Math.round(x)},${Math.round(y)}`, before) };
    };
    const around = (outer, inner) => outer && outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom && outer.right - outer.left < inner.right - inner.left + 12;
    /** Drop on an element's centre (or `at` from its top left) and check the reading's last lines; returns the drop. */
    const expectAt = async (sid, selector, pattern, at = null) => {
      const b = await boxIn(sid, selector);
      const drop = await dropOnChart(sid, at ? b.left + at.x : b.x, at ? b.top + at.y : b.y);
      assert.match(drop.text, pattern, `${selector}: ${drop.text}`);
      assert.doesNotMatch(drop.text, /≈|approximate/, `${selector}: no value read off an axis`);
      return { ...drop, box: b };
    };

    // Highcharts-like (charts-highcharts.html).
    const hc = await openCorpus("charts-highcharts");
    // The September point of SMU, under the tracker line laid over the series: no data label, so no value.
    const point = await expectAt(hc.sid, "#m8", new RegExp(`Under the heading: Venta neta\\nPointed at \\(path, chart point\\): SMU · S ${NONE}$`, "m"));
    assert.ok(around(point.outlined.box, point.box), `the outline is a box around the point: ${JSON.stringify(point.outlined)}`);
    assert.deepEqual(point.outlined.outlined, [], "nothing else is outlined");
    assert.doesNotMatch(point.text, /Instock|CENCOSUD|Precios|400 M/, "nothing outside the mark, and not February's tooltip");
    // The pin, in the point's left margin, at its top.
    const pinOnPoint = await until("the pin at the point", async () => {
      const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, hc.sid);
      let badge = null;
      const walk = (n) => {
        if ((n.attributes ?? []).includes("data-apc-pin-state")) badge = n.nodeId;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
      };
      walk(root);
      if (!badge) return null;
      const q = (await cdp("DOM.getBoxModel", { nodeId: badge }, hc.sid)).model.border;
      return { left: q[0], top: q[1], right: q[4] };
    });
    const sepNow = await boxIn(hc.sid, "#m8");
    assert.ok(pinOnPoint.right <= sepNow.left && sepNow.left - pinOnPoint.right < 12 && Math.abs(pinOnPoint.top - sepNow.top) < 3, `the pin sits at the point: ${JSON.stringify({ pinOnPoint, sepNow })}`);
    // July's data label is hidden by the plot's clip path: July has no value written.
    assert.doesNotMatch((await expectAt(hc.sid, "#m6", new RegExp(`Pointed at \\(path, chart point\\): SMU · J ${NONE}$`, "m"))).text, /999M/);
    // October's HTML data label lies over its point: a drop on it finds the point, and the label is its value.
    const october = await expectAt(hc.sid, "#octlabel", /Pointed at \(path, chart point\): SMU · O · 880M$/m);
    assert.ok(around(october.outlined.box, await boxIn(hc.sid, "#m9")), `the outline is a box around October's point: ${JSON.stringify(october.outlined)}`);
    // The line chart's background, and its plot band (shading, not data): the whole chart.
    const line = await boxIn(hc.sid, "#line svg");
    for (const at of [{ x: line.left + 40, y: line.top + 180 }, { x: line.left + 300, y: line.top + 220 }]) {
      const background = await dropOnChart(hc.sid, at.x, at.y);
      assert.equal(background.outlined.box, null, "no box over a mark");
      assert.deepEqual(background.outlined.outlined, ["line"], "the chart is outlined");
      assert.match(background.text, /Under the heading: Venta neta\nPointed at \(div\): SMU E F M A M J J A S O N D 0 1 000M/m);
      assert.doesNotMatch(background.text, /999M/, "a label the plot's clip path hides is not read");
    }
    // Instock: a bar with a data label reads its category and that exact label.
    const walmart = await expectAt(hc.sid, "#bar1", /Under the heading: Instock promedio\nPointed at \(path, chart bar\): WALMART · 96,23%$/m);
    assert.ok(around(walmart.outlined.box, walmart.box), `the outline is a box around the bar: ${JSON.stringify(walmart.outlined)}`);
    await expectAt(hc.sid, "#bar3", /Pointed at \(path, chart bar\): SMU · 87,67%$/m);
    const cencosud = await boxIn(hc.sid, "#bar0");
    assert.match((await dropOnChart(hc.sid, cencosud.right - 10, cencosud.y)).text, /Pointed at \(path, chart bar\): CENCOSUD · 98,51%$/m);
    // The bar chart's background: the chart, each value once (its outline copies skipped).
    const bars = await boxIn(hc.sid, "#bars svg");
    const barsBackground = await dropOnChart(hc.sid, bars.right - 20, bars.top + 12);
    assert.match(barsBackground.text, /Pointed at \(div\): 98,51% 96,23% 90,42% 87,67% 94,81% CENCOSUD WALMART TOTTUS SMU Total General 0% 10% 20%/);
    assert.doesNotMatch(barsBackground.text, /98,51%\s*98,51%/, "each label once");
    // Under the default Ask per drop (the hub fixed TIN-762): the percentages arrive whole, none taken for a card number.
    assert.doesNotMatch(barsBackground.text, /sensitive number left out/);
    // Precios, two value axes: a column of sales and a point of the price line read their month and no value, never a
    // value off either axis.
    const ago = await expectAt(hc.sid, "#col1", new RegExp(`Under the heading: Precios\\nPointed at \\(path, chart bar\\): Ago ${NONE}$`, "m"), { x: 15, y: 120 });
    assert.doesNotMatch(ago.text, /4[.,]1\dk|240M|Venta ·|Precio ·/);
    assert.ok(around(ago.outlined.box, ago.box), `the outline is a box around the column: ${JSON.stringify(ago.outlined)}`);
    await expectAt(hc.sid, "#price2", new RegExp(`Pointed at \\(path, chart point\\): Sep ${NONE}$`, "m"));
    // Its legend's symbol, under the months, is no mark: the whole chart.
    const legend = await expectAt(hc.sid, "#legendsales", /Under the heading: Precios\nPointed at \(div\): /m);
    assert.equal(legend.outlined.box, null, "no box over the legend");
    // Precios con etiquetas: each column's sales label is its value; a price's label, drawn above its point and on the
    // column behind it, could be either's, so it is nobody's (rule A).
    const labelled = await expectAt(hc.sid, "#lcol1", /Under the heading: Precios con etiquetas\nPointed at \(path, chart bar\): Ago · 300M$/m, { x: 15, y: 30 });
    assert.doesNotMatch(labelled.text, /3[.,]75k/);
    await expectAt(hc.sid, "#lprice1", new RegExp(`Under the heading: Precios con etiquetas\\nPointed at \\(path, chart point\\): Ago ${NONE}$`, "m"));
    // A stack: each segment's value is the label inside it; the stack's total above is no segment's (rule A).
    const storeQ1 = await expectAt(hc.sid, "#store0", /Under the heading: Ventas por canal\nPointed at \(rect, chart bar\): Q1 · 70$/m);
    const onlineQ1 = await expectAt(hc.sid, "#online0", /Pointed at \(rect, chart bar\): Q1 · 80$/m, { x: 30, y: 60 });
    for (const t of [storeQ1.text, onlineQ1.text]) assert.doesNotMatch(t.split("\n").pop(), /150/, "the total is no segment's value");
    // The small segments keep the labels written on them too (fix round 2): Q3's stores (50 px), Q2's online (60 px).
    await expectAt(hc.sid, "#store2", /Pointed at \(rect, chart bar\): Q3 · 50$/m);
    await expectAt(hc.sid, "#online1", /Pointed at \(rect, chart bar\): Q2 · 60$/m);
    // Stale tooltips that write their number apart from their words (an SVG one, its number hanging out of its box under
    // March's point; an HTML one with no shape over April's): never a value. January's own label is.
    await expectAt(hc.sid, "#v0", /Under the heading: Visitas por mes\nPointed at \(path, chart point\): Visitas · Ene · 300$/m);
    await expectAt(hc.sid, "#v2", new RegExp(`Pointed at \\(path, chart point\\): Visitas · Mar ${NONE}$`, "m"));
    await expectAt(hc.sid, "#v3", new RegExp(`Pointed at \\(path, chart point\\): Visitas · Abr ${NONE}$`, "m"));
    // A year as the title, drawn in the plot's margin over a column at the top tick: no value of that column's.
    await expectAt(hc.sid, "#yQ2", new RegExp(`Under the heading: Ventas del año\\nPointed at \\(rect, chart bar\\): Q2 ${NONE}$`, "m"));
    await expectAt(hc.sid, "#yQ1", /Pointed at \(rect, chart bar\): Q1 · 120$/m);
    await cdp("Target.closeTarget", { targetId: hc.targetId });

    // ECharts-like, D3 and Recharts-like (charts-libraries.html).
    const libs = await openCorpus("charts-libraries");
    // ECharts' SVG: the title "Visits" names its one series, the data label above the bar is its value.
    await expectAt(libs.sid, "#ewed", /Under the heading: Site traffic\nPointed at \(path, chart bar\): Visits · Wed · 150$/m);
    // D3: no data labels, so no value; a bar with a <title> of its own reads it.
    await expectAt(libs.sid, "#dB", new RegExp(`Under the heading: Letter frequency\\nPointed at \\(rect, chart bar\\): B ${NONE}$`, "m"));
    await expectAt(libs.sid, "#dC", /Pointed at \(rect, chart bar\): C: 2\.78%$/m);
    // Recharts: pv's label is pv's bar's value; uv's bar beside it has none written.
    await expectAt(libs.sid, "#pv1", /Under the heading: Page views\nPointed at \(path, chart bar\): Page B · 1398$/m);
    await expectAt(libs.sid, "#uv1", new RegExp(`Pointed at \\(path, chart bar\\): Page B ${NONE}$`, "m"));
    // Hidden labels (rule C): text the person cannot see, far off screen or in a control is never read: the series is the
    // visible "Sales" without its hidden span; A, B and C have no value written; D's ordinary label is its value.
    const SECRETS = /998877665544|424242|112233445566|4321|5566|777|4040|6060|7070|Internal|4455/;
    for (const [id, end] of [["#hA", `A ${NONE}`], ["#hB", `B ${NONE}`], ["#hC", `C ${NONE}`], ["#hD", "D · 140"]]) {
      const hiddenDrop = await expectAt(libs.sid, id, new RegExp(`Under the heading: Hidden labels\\nPointed at \\(rect, chart bar\\): Sales · ${end}$`, "m"));
      assert.doesNotMatch(hiddenDrop.text, SECRETS, `${id}: nothing hidden, off screen or in a control`);
    }
    // The chart's background: the whole chart, still without what is hidden.
    const hiddenBox = await boxIn(libs.sid, "#hidden svg");
    assert.doesNotMatch((await dropOnChart(libs.sid, hiddenBox.left + 460, hiddenBox.top + 150)).text, /998877665544|424242|112233445566|777|4040|6060|7070|4455/);
    await cdp("Target.closeTarget", { targetId: libs.targetId });

    // A canvas chart, a pie and a map with and without names, a big table and a form (charts-other.html).
    const rest = await openCorpus("charts-other");
    // A canvas has no marks: its container.
    const canvas = await expectAt(rest.sid, "#cv", /Under the heading: Monthly churn\nPointed at \(figure\): Churn by month, 2026$/m);
    assert.deepEqual(canvas.outlined.outlined, ["canvaschart"]);
    // A slice and a region that name themselves are marks, read from that name only.
    const slice = await expectAt(rest.sid, "#pie-cencosud", /Under the heading: Market share\nPointed at \(path, chart mark\): CENCOSUD: 38%$/m);
    assert.ok(around(slice.outlined.box, slice.box), `the outline is a box around the slice: ${JSON.stringify(slice.outlined)}`);
    await expectAt(rest.sid, "#map-1", /Under the heading: Customers by region\nPointed at \(path, chart mark\): Santiago: 7\.1M$/m);
    // Without names: no marks, the whole figure.
    const unnamedPie = await expectAt(rest.sid, "#pie2-cencosud", /Under the heading: Market share, unnamed slices\nPointed at \(figure\): Share of sales by store, without names$/m);
    assert.deepEqual([unnamedPie.outlined.box, unnamedPie.outlined.outlined], [null, ["pie2"]]);
    await expectAt(rest.sid, "#map2-1", /Under the heading: Customers by region, unnamed regions\nPointed at \(figure\): Customers in each region, without names$/m);
    // A big table: the cell, its column and its row, as before.
    await expectAt(rest.sid, "#stores tbody tr:nth-child(25) td:nth-child(3)", /Under the heading: Stores\nTable column: Sales\nTable row: Store 25\nPointed at \(td\): 2,125$/m);
    // A form: the field and what was typed in it.
    const goal = await expectAt(rest.sid, "#goalstore", /\n- Store: SMU \(pointed at\)/);
    assert.doesNotMatch(goal.text, /chart (point|bar|mark)|Target %/);
    // Outside charts: a paragraph clipped by a rect clip path that shows all of it is read whole (fix round 2).
    await expectAt(rest.sid, "#clippedpara", /Under the heading: Clipped paragraph\nPointed at \(p\): A paragraph clipped by a rect that shows all of it\.$/m);
    await cdp("Target.closeTarget", { targetId: rest.targetId });
    await drag("#b", await payload());
    await until("the SPRING reading again", async () => /SPRING/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    console.log("12. the corpus: a chart's mark is outlined, pinned and read from what the page writes for it (never a value off an axis); a shape that names itself is a mark; canvas, unnamed shapes, a table and a form read as before");

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

    // 8. Open dock and Float from the extension's popup (TIN-473). The browser gets this dock's cookie, so
    // /dock is this dock with its Float button (no first run gates it, TIN-489; no world to choose, TIN-621).
    await cdp("Storage.setCookies", { cookies: [{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: DOCK, path: "/", secure: DOCK.startsWith("https:") }] });
    /**
     * Click an element with real mouse events, as a person does: scrolled into view first. A mouse event outside the
     * viewport reaches nothing, so a button below the fold (the popup's Clear, in a tab as tall as the window) would take
     * no click at all (TIN-583): the point is checked to be inside the viewport.
     */
    const clickIn = async (sid, selector) => {
      const { root } = await cdp("DOM.getDocument", { depth: 0 }, sid);
      const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector }, sid);
      assert.ok(nodeId, `${selector} on the page`);
      await cdp("DOM.scrollIntoViewIfNeeded", { nodeId }, sid);
      const q = (await cdp("DOM.getBoxModel", { nodeId }, sid)).model.border;
      const x = (q[0] + q[4]) / 2;
      const y = (q[1] + q[5]) / 2;
      const { cssLayoutViewport: v } = await cdp("Page.getLayoutMetrics", {}, sid);
      assert.ok(x >= 0 && y >= 0 && x < v.clientWidth && y < v.clientHeight, `${selector} is in view to click (${Math.round(x)}, ${Math.round(y)} in ${v.clientWidth}×${v.clientHeight})`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
    };
    const popupClick = async (selector) => {
      const { targetId: popupId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
      const { sessionId: popupSession } = await cdp("Target.attachToTarget", { targetId: popupId, flatten: true });
      await sleep(1500);
      await clickIn(popupSession, selector);
    };
    const dockTarget = (float) => until(`the dock${float ? " with ?float=1" : ""}`, async () => (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.startsWith(`${DOCK}/dock`) && t.url.includes("float=1") === float));
    await popupClick("#open-dock");
    await dockTarget(false);
    await popupClick("#float");
    const floatDock = await dockTarget(true);
    const { sessionId: dockSession } = await cdp("Target.attachToTarget", { targetId: floatDock.targetId, flatten: true });
    await cdp("Runtime.enable", {}, dockSession);
    const floatPrompt = () => until("the Float prompt in the dock", async () => {
      // The dev server sometimes fails a call (see request() above). Vite lays its error overlay over the page, which would take the click.
      // During a reload the page has no context to evaluate in: this just looks again.
      const page = await cdp("Runtime.evaluate", { expression: "document.querySelector('vite-error-overlay')?.remove(); JSON.stringify({ ask: !!document.querySelector('[data-float-ask]'), failed: document.body.innerText.includes('Could not open your dock') })", returnByValue: true }, dockSession).catch(() => null);
      const { ask, failed } = JSON.parse(page?.result.value ?? "{}");
      // If that call was the dock's first, load it again.
      if (failed) await cdp("Page.reload", {}, dockSession);
      return ask;
    }, 30_000);
    // The prompt stays until Float opens, so a click Chrome refused can be made again, as a person would.
    const floating = async () => (await cdp("Runtime.evaluate", { expression: "!!window.documentPictureInPicture?.window", returnByValue: true }, dockSession).catch(() => null))?.result.value === true;
    // What the page saw of each try (TIN-583): the clicks on the prompt and what requestWindow answered, printed if Float never opens.
    // Kept in sessionStorage, which outlives the reload above; installed again on every try, since a reload drops the hooks.
    const FLOAT_LOG = `(() => {
      if (window.__apcFloatLog) return;
      const log = (e) => { const all = JSON.parse(sessionStorage.getItem("apc-e2e-float") ?? "[]"); all.push(Math.round(performance.now()) + " " + e); sessionStorage.setItem("apc-e2e-float", JSON.stringify(all)); };
      window.__apcFloatLog = log;
      log("page " + location.search + ", visible " + document.visibilityState + ", focused " + document.hasFocus());
      addEventListener("click", (e) => log("click on " + (e.target.closest?.("[data-float-ask]") ? "the prompt" : e.target.tagName) + ", trusted " + e.isTrusted + ", activation " + navigator.userActivation?.isActive), true);
      const pip = window.documentPictureInPicture;
      if (!pip) return log("no documentPictureInPicture");
      const ask = pip.requestWindow.bind(pip);
      pip.requestWindow = (o) => { log("requestWindow"); return ask(o).then((w) => (log("requestWindow opened"), w), (e) => { log("requestWindow refused: " + e.name + " " + e.message); throw e; }); };
    })()`;
    const floatLog = async () => (await cdp("Runtime.evaluate", { expression: `sessionStorage.getItem("apc-e2e-float")`, returnByValue: true }, dockSession).catch(() => null))?.result.value ?? "(the page could not say)";
    for (let attempt = 0; attempt < 3 && !(await floating()); attempt++) {
      await floatPrompt();
      await cdp("Runtime.evaluate", { expression: FLOAT_LOG }, dockSession);
      // A person clicks in the window in front; the dock's tab is brought there, as Open dock does.
      await cdp("Page.bringToFront", {}, dockSession);
      await clickIn(dockSession, "[data-float-ask]");
      await until("the Float window", floating, 6_000).catch(() => {});
    }
    assert.ok(await floating(), `the Float window opened (the page saw: ${await floatLog()})`);
    assert.equal((await cdp("Runtime.evaluate", { expression: "location.search", returnByValue: true }, dockSession)).result.value, "", "the prompt goes once Float is open");
    console.log("8. Open dock opens the dock; Float opens it ready, and one click floats the agents");

    // 9. A table cell and a formula read whole, and every reading is listed with Clear (TIN-422).
    const figures = await cdp("Target.createTarget", { url: pageUrl.replace("/notes", "/figures") });
    const { sessionId: figuresSession } = await cdp("Target.attachToTarget", { targetId: figures.targetId, flatten: true });
    await sleep(2000);
    const dropOnFigures = async (selector) => {
      const point = (await cdp("Runtime.evaluate", { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, returnByValue: true }, figuresSession)).result.value;
      const dragged = { items: [{ mimeType: T, data: await payload() }], dragOperationsMask: 2 };
      for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data: dragged }, figuresSession);
    };
    await dropOnFigures("#cell");
    const cell = await until("the reading of the table cell", async () => {
      const text = (await tool("page__get_reading")).structuredContent?.page_text ?? "";
      return /Pointed at \(td\): 19\.6/.test(text) ? text : null;
    });
    assert.match(cell, /Under the heading: Countries\nTable column: Population\nTable row: Chile\n/);
    await dropOnFigures("#formula");
    const formula = await until("the reading of the formula", async () => {
      const text = (await tool("page__get_reading")).structuredContent?.page_text ?? "";
      return /Churn is/.test(text) ? text : null;
    });
    assert.match(formula, /Pointed at \(p\): Churn is L \\times T, see the churn chart and \[image with no alt text\] and \.$/m);
    assert.doesNotMatch(formula, /HIDDEN COPY/);
    await dropOnFigures("#unseen");
    const unseen = await until("the reading under a hidden header", async () => {
      const text = (await tool("page__get_reading")).structuredContent?.page_text ?? "";
      return /Pointed at \(td\): Plain/.test(text) ? text : null;
    });
    assert.doesNotMatch(unseen, /HIDDEN HEADER/);
    await dropOnFigures("#contents");
    await until("the words inside display: contents", async () => /Pointed at \(p\): Revenue fell as the second chart shows\./.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    // As on Wikipedia: the MathML clipped out of sight beside an image of it, with the same text.
    await dropOnFigures("#twice");
    await until("a formula read once", async () => /Pointed at \(p\): Area is x\^\{2\} here\./.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    // A drop on a card's photo, under the link stretched over it, points at the card, under its own title (TIN-697).
    await dropOnFigures("#saveiro .media");
    const carCard = await until("the reading of a card", async () => {
      const text = (await tool("page__get_reading")).structuredContent?.page_text ?? "";
      return /Pointed at \(article\)/.test(text) ? text : null;
    });
    // Its text as the person sees it: the photo count first, as the badge shows it.
    assert.match(carCard, /Under the heading: Volkswagen Saveiro Comfortline 2020\nPointed at \(article\): 5 Volkswagen Saveiro Comfortline 2020 \$10\.100\.000/);
    // The card before it: under its own title too.
    await dropOnFigures("#audi .media");
    await until("the first card under its own title", async () => /Under the heading: Audi A3 Attraction 2009\nPointed at \(article\): 5 Audi A3/.test((await tool("page__get_reading")).structuredContent?.page_text ?? ""));
    await cdp("Target.closeTarget", { targetId: figures.targetId });
    const listed = (await api(`${base}/state`)).agents[0].readings;
    assert.equal(listed[0].kept, true);
    assert.equal(listed[1].kept, false);
    assert.equal(listed[0].site, "127.0.0.1:" + server.address().port);
    assert.ok(listed[0].bytes > 0);
    assert.ok(!JSON.stringify(listed).includes("Churn"), "the list holds no text");
    const { targetId: listId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
    const { sessionId: listSession } = await cdp("Target.attachToTarget", { targetId: listId, flatten: true });
    const popupList = async () => (await cdp("Runtime.evaluate", { expression: "document.getElementById('readings').innerText", returnByValue: true }, listSession)).result.value;
    await until("the readings in the popup", async () => /127\.0\.0\.1.*·.*·.*KB|127\.0\.0\.1.* B ·/.test((await popupList()) ?? ""));
    assert.match(await popupList(), /gone/, "a replaced reading says it is gone");
    await clickIn(listSession, "#clear-readings");
    await until("the list cleared at the dock", async () => (await api(`${base}/state`)).agents[0].readings.length === 0);
    await until("the list cleared in the popup", async () => /Each page you send/.test(await popupList())).catch(async (e) => {
      throw new Error(`${e.message} (the popup shows: ${JSON.stringify(await popupList())})`);
    });
    assert.equal((await tool("page__get_reading")).isError, true);
    await cdp("Target.closeTarget", { targetId: listId });
    console.log("9. a table cell and a formula read whole; the popup and the dock list readings, and Clear empties both");

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
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
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
  // Chrome's child processes hold the profile's files for a while after the browser goes, and on Windows that made the
  // removal fail with EPERM (TIN-583). Close the browser as a person would, wait for it to exit, then retry the removal
  // for a few seconds; a folder still held after that is left with a note, and the run's result stands.
  const exited = new Promise((r) => (browser.exitCode !== null ? r() : browser.once("exit", r)));
  await Promise.race([cdp("Browser.close").catch(() => {}), sleep(5000)]);
  if (!(await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]))) browser.kill();
  server.close();
  inner.close();
  for (const dir of [profile, ...(PROD || CONSENT ? [EXT] : [])]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    } catch (e) {
      console.warn(`could not remove ${dir} (${e.code ?? e.message}); delete it by hand`);
    }
  }
  process.exit(failed ? 1 : 0);
}
