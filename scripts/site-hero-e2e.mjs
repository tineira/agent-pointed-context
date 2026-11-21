// End to end check of the landing's real hero (TIN-1071, TIN-1072; design TIN-1063 §§ 2, 5, 6.3 item 4), by hand: a
// real headless Chrome over the DevTools Protocol, against the site under `vite preview` (which applies its CSP) and
// Pulse under `pnpm dev`. Beside scripts/mobile-e2e.mjs, with the same kind of Chrome and CDP client.
//
// Start both first (each in its own terminal), then run this:
//   corepack pnpm dev                                                    (Pulse at http://localhost:5173)
//   cd apps/site && node node_modules/vite/bin/vite.js build --mode local-pulse && node node_modules/vite/bin/vite.js preview --port 4173
//   node scripts/site-hero-e2e.mjs [--site=http://localhost:4173] [--pulse=http://localhost:5173] [--shots=<dir>] [chrome.exe]
//
// For each pass (1440 and 375 px wide, dark and light): on /, zero requests to Pulse, zero frames and no apc_session
// cookie before the click; "Use your own agent" mounts exactly one frame on /embed/hero, hidden until apc:embed-ready;
// the frame follows the site's theme and the toggle; no horizontal scroll; "Back to the demo" removes the frame. The
// first pass also plays the demo (the stage's own pin, two of the visitor's, then the panel), connects a real MCP client
// (initialize) to the address the frame shows, pins with a real mouse drag in the frame, reads the pin back through
// get_current_view, and opens /try to see Pulse connected. Every pass fails on a console error, an exception or a CSP
// violation in either document. A local `--mode local-pulse` build only: a production build frames production Pulse.
// Exits 1 when a check fails.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const SITE = opt("site", "http://localhost:4173");
const PULSE = opt("pulse", "http://localhost:5173");
const SHOTS = opt("shots", null);
const EXE = args.find((a) => !a.startsWith("--")) ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
const PORT = 9348;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const profileDir = mkdtempSync(join(tmpdir(), "apc-hero-"));
const chrome = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, "--headless=new", "--no-first-run", "--disable-extensions", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
let wsUrl = null;
for (let i = 0; i < 150 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
  } catch {
    // not up yet
  }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error(`Chrome did not start (${EXE})`);

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
const events = [];
/** Problems seen in any document: console errors, exceptions, CSP violations. Network failures are listed apart. */
const problems = [];
const networkErrors = [];
const requests = [];
/** Out-of-process frames (when Chrome isolates the embed): their CDP session ids. */
const frameSessions = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    return msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
  events.push(msg);
  const p = msg.params ?? {};
  if (msg.method === "Network.requestWillBeSent") requests.push(p.request.url);
  if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  if (msg.method === "Log.entryAdded" && p.entry.level === "error") {
    if (p.entry.source === "network") networkErrors.push(`${p.entry.text} ${p.entry.url ?? ""}`);
    else problems.push(`log (${p.entry.source}): ${p.entry.text}`);
  }
  if (msg.method === "Target.attachedToTarget" && p.targetInfo.type === "iframe") {
    frameSessions.set(p.targetInfo.url, p.sessionId);
    void (async () => {
      for (const method of ["Runtime.enable", "Log.enable", "Network.enable"]) await send(method, {}, p.sessionId).catch(() => {});
      await send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {});
    })();
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const evaluate = async (expression, extra = {}) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra.params }, extra.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
/** Evaluates in the hero frame: its own session when out of process, else its execution context in the page. */
async function inFrame(expression) {
  const session = [...frameSessions.entries()].find(([url]) => url.includes("/embed/hero"))?.[1];
  if (session) return evaluate(expression, { sessionId: session });
  const tree = await send("Page.getFrameTree");
  const frame = (tree.frameTree.childFrames ?? []).map((c) => c.frame).find((f) => f.url.includes("/embed/hero"));
  if (!frame) throw new Error("no hero frame in the frame tree");
  const world = await send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "e2e" });
  return evaluate(expression, { params: { contextId: world.executionContextId } });
}
const shot = async (name) => {
  if (!SHOTS) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const click = async (x, y) => {
  await mouse("mouseMoved", x, y, { button: "none" });
  await mouse("mousePressed", x, y);
  await sleep(40);
  await mouse("mouseReleased", x, y);
  await sleep(250);
};
/** A real mouse drag, in small steps, as a hand would. */
const drag = async (from, to) => {
  await mouse("mouseMoved", from.x, from.y, { button: "none" });
  await mouse("mousePressed", from.x, from.y);
  for (let i = 1; i <= 16; i++) {
    await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16, { buttons: 1 });
    await sleep(25);
  }
  await mouse("mouseReleased", to.x, to.y);
};
/** The center of the first element matching a selector, scrolled into view, in viewport pixels; or null. */
const centerOf = (selector) =>
  evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center", behavior: "instant" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const until = async (what, fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await fn()) return true;
  throw new Error(`timed out: ${what}`);
};

let failed = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
  console.log(results.at(-1));
};

/** One Streamable HTTP MCP call, JSON or SSE; returns the JSON-RPC message and the session id. */
async function mcp(url, body, session) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  const json = (r.headers.get("content-type") ?? "").includes("event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).at(-1) : text ? JSON.parse(text) : null;
  return { status: r.status, json, session: r.headers.get("mcp-session-id") ?? session };
}

await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await send(method);
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `document.addEventListener("securitypolicyviolation", (e) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI));`,
});

const PASSES = [
  { width: 1440, height: 900, scheme: "dark", full: true },
  { width: 1440, height: 900, scheme: "light" },
  { width: 375, height: 812, scheme: "dark" },
  { width: 375, height: 812, scheme: "light" },
];
const pulseRequests = () => requests.filter((u) => u.startsWith(PULSE));
const pulseCookie = async () => (await send("Network.getCookies", { urls: [PULSE] })).cookies.filter((c) => c.name === "apc_session");

try {
  for (const pass of PASSES) {
    const tag = `${pass.width}px ${pass.scheme}`;
    console.log(`\n${tag}${pass.full ? ", full walk" : ""}`);
    await send("Network.clearBrowserCookies");
    await send("Emulation.setDeviceMetricsOverride", { width: pass.width, height: pass.height, deviceScaleFactor: 1, mobile: pass.width < 500 });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: pass.scheme }, { name: "prefers-reduced-motion", value: "no-preference" }] });
    await send("Page.navigate", { url: `${SITE}/` });
    await sleep(1200);
    await evaluate(`localStorage.clear(); sessionStorage.clear(); true`);
    requests.length = 0;
    problems.length = 0;
    networkErrors.length = 0;
    await send("Page.navigate", { url: `${SITE}/` });
    await until("the stage", () => evaluate(`!!document.querySelector(".hero-stage .hero-bar")`));
    await sleep(pass.full ? 500 : 2500);

    // Invariants 4 and 5: nothing of Pulse before the click.
    check(`${tag}: no frame before the click`, (await evaluate(`document.querySelectorAll("iframe").length`)) === 0);
    check(`${tag}: no request to Pulse before the click`, pulseRequests().length === 0, pulseRequests().join(", "));
    check(`${tag}: no apc_session cookie before the click`, (await pulseCookie()).length === 0);

    let button = ".hero-own";
    if (pass.full) {
      // The demo: the stage's own pin plays, then the visitor pins twice (drags the agent onto a bar), then the panel.
      await until("the stage's own pin", () => evaluate(`!!document.querySelector(".hero-bar.is-pinned")`), 8000);
      await until("its answer", () => evaluate(`!!document.querySelector(".hero-answer")`), 20_000);
      await shot("1440-dark-1-self-play");
      for (const bar of [1, 6]) {
        await evaluate(`document.querySelector(".hero-stage").scrollIntoView({ block: "center", behavior: "instant" }), true`);
        await sleep(300);
        const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const target = await rect(`.hero-stage .hero-bar:nth-child(${bar + 3})`);
        const mark = await rect(".hero-stage .apc-agents__mark");
        await drag(mark, target);
        await until(`the visitor's pin on bar ${bar}`, () => evaluate(`document.querySelectorAll(".hero-bar")[${bar}].classList.contains("is-pinned")`), 4000);
        await until(`its answer`, () => evaluate(`!!document.querySelector(".hero-answer")`), 20_000);
      }
      await until("the panel", () => evaluate(`!!document.querySelector(".hero-offer")`), 15_000);
      check(`${tag}: two pins, then "Now use your own agent" opens in the stage`, true);
      check(`${tag}: the panel says what the click does`, /sets its one sandbox cookie/.test(await evaluate(`document.querySelector(".hero-offer").textContent`)));
      await shot("1440-dark-2-panel");
      check(`${tag}: still no request to Pulse after the demo`, pulseRequests().length === 0);
      button = ".hero-offer .btn.primary";
    }

    // The click: one frame, Pulse's hero, sandboxed, hidden until ready.
    const at = await centerOf(button);
    await click(at.x, at.y);
    const frames = await evaluate(`[...document.querySelectorAll("iframe")].map((f) => ({ src: f.src, sandbox: f.getAttribute("sandbox"), allow: f.getAttribute("allow") }))`);
    check(`${tag}: one frame after the click`, frames.length === 1, JSON.stringify(frames));
    check(`${tag}: it points to /embed/hero, sandboxed`, frames[0]?.src === `${PULSE}/embed/hero` && frames[0]?.sandbox === "allow-scripts allow-same-origin" && frames[0]?.allow === "clipboard-write");
    await until("apc:embed-ready", () => evaluate(`document.querySelector(".hero-live")?.dataset.phase === "ready"`), 10_000).catch(() => {});
    check(`${tag}: the frame shows once Pulse says it is ready`, (await evaluate(`document.querySelector(".hero-live")?.dataset.phase`)) === "ready");
    await sleep(1500);
    const address = await inFrame(`[...document.querySelectorAll("input, textarea")].map((e) => e.value).find((v) => /\\/mcp\\//.test(v)) ?? null`);
    check(`${tag}: the MCP address shows at once`, !!address && address.startsWith(`${PULSE}/mcp/`), address ? "an /mcp/ address" : "none");
    check(`${tag}: the site never sees it`, !(await evaluate(`document.documentElement.outerHTML + JSON.stringify(sessionStorage) + JSON.stringify(localStorage)`)).includes("/mcp/"));

    // Theme: the frame takes the site's, and follows the toggle.
    check(`${tag}: the frame takes the site's theme`, (await inFrame(`document.documentElement.dataset.scheme`)) === pass.scheme);
    const toggle = await centerOf(".site-theme-toggle, button[aria-label*='theme' i]");
    if (toggle) {
      await click(toggle.x, toggle.y);
      await sleep(400);
      const flipped = pass.scheme === "dark" ? "light" : "dark";
      check(`${tag}: the toggle turns the frame ${flipped}`, (await inFrame(`document.documentElement.dataset.scheme`)) === flipped);
      await shot(`${pass.width}-${pass.scheme}-3-frame-toggled`);
      await click(toggle.x, toggle.y);
      await sleep(400);
      check(`${tag}: and back`, (await inFrame(`document.documentElement.dataset.scheme`)) === pass.scheme);
    } else check(`${tag}: a theme toggle to click`, false);
    await shot(`${pass.width}-${pass.scheme}-4-frame`);
    check(`${tag}: no horizontal scroll`, await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    const height = await evaluate(`document.querySelector(".hero-live-body").getBoundingClientRect().height`);
    check(`${tag}: the frame's height is within 280–720`, height >= 280 && height <= 720, `${Math.round(height)} px`);

    if (pass.full && address) {
      // A real MCP client connects to the address the frame shows.
      const init = await mcp(address, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.0.0" } } });
      check(`${tag}: initialize`, init.status === 200 && !!init.json?.result, `HTTP ${init.status}`);
      await mcp(address, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
      await until("apc:pulse-status connected", () => evaluate(`!!sessionStorage.getItem("apc:site:pulse-status")`), 15_000).catch(() => {});
      const hint = JSON.parse((await evaluate(`sessionStorage.getItem("apc:site:pulse-status")`)) ?? "null");
      check(`${tag}: the landing keeps "connected" and the name only`, hint?.connected === true && typeof hint.updatedAt === "number" && Object.keys(hint).sort().join() === "agentName,connected,updatedAt", JSON.stringify(hint));
      check(`${tag}: the frame says the agent connected`, /Claude/.test(await inFrame(`document.body.innerText`)));

      // A real pin: a mouse drag of the agent onto a bar, inside the frame.
      const box = await evaluate(`(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
      const inside = await inFrame(`(() => { const m = document.querySelector("[data-apc-mark]"); const b = [...document.querySelectorAll("[data-focus]")].at(-3); if (!m || !b) return null; b.scrollIntoView({ block: "center", behavior: "instant" }); m.scrollIntoView({ block: "nearest", behavior: "instant" }); const a = m.getBoundingClientRect(), c = b.getBoundingClientRect(); return { from: { x: a.left + a.width / 2, y: a.top + a.height / 2 }, to: { x: c.left + c.width / 2, y: c.top + c.height / 2 }, focus: b.getAttribute("data-focus") }; })()`);
      if (inside) {
        const from = { x: box.x + inside.from.x, y: box.y + inside.from.y };
        const to = { x: box.x + inside.to.x, y: box.y + inside.to.y };
        await drag(from, to);
        // The agent reads the pin: poll get_current_view until it names a focus (5 s at most).
        const focusOf = async () => {
          const view = await mcp(address, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_current_view", arguments: {} } }, init.session);
          const text = view.json?.result?.content?.find((c) => c.type === "text")?.text;
          try {
            return JSON.parse(text ?? "null")?.focus ?? null;
          } catch {
            return null;
          }
        };
        let focus = null;
        await until("get_current_view names the pin", async () => !!(focus = await focusOf()), 5000).catch(() => {});
        check(`${tag}: a real pin reaches the agent (get_current_view)`, !!focus, focus ? `${focus.kind ?? ""} ${JSON.stringify(focus.params ?? focus.target ?? "")}` : `dragged onto ${inside.focus}, no focus`);
        await until("the frame's badge turns to a check", () => inFrame(`!!document.querySelector("apc-pin[seen], apc-pin[data-seen], [data-apc-pin-seen]") || /reading|read /i.test(document.body.innerText)`), 5000).catch(() => {});
        await shot("1440-dark-5-pinned");
      } else check(`${tag}: the frame has an agent and a bar to pin`, false);

      // /try learns it (Option A): the card shows the agent, the steps done in the hero, Signals first.
      await send("Page.navigate", { url: `${SITE}/try` });
      await until("/try", () => evaluate(`!!document.querySelector(".try-app")`));
      await sleep(800);
      const t = await evaluate(`({ on: !!document.querySelector(".try-app.on"), conn: document.querySelector(".try-conn")?.textContent ?? null, done: document.querySelectorAll(".try-step.done").length, next: [...document.querySelectorAll(".try-step.next b")].map((b) => b.textContent), link: document.querySelector(".try-app.on .try-links a")?.href ?? null })`);
      check(`${tag}: /try shows Pulse connected`, t.on && /connected$/.test(t.conn ?? ""), t.conn ?? "no badge");
      check(`${tag}: /try marks the steps done in the hero, Signals first`, t.done === 3 && t.next.length === 1 && /second app/i.test(t.next[0]), JSON.stringify(t));
      check(`${tag}: /try links Pulse's overview`, t.link === `${PULSE}/overview`, t.link ?? "");
      await shot("1440-dark-6-try");
      await send("Page.navigate", { url: `${SITE}/` });
      await until("the stage", () => evaluate(`!!document.querySelector(".hero-stage")`));
      check(`${tag}: back on /, still no frame before a click`, (await evaluate(`document.querySelectorAll("iframe").length`)) === 0);
    } else {
      // Back to the demo.
      const back = await centerOf(".hero-live-bar .hero-own");
      await click(back.x, back.y);
      check(`${tag}: "Back to the demo" removes the frame`, (await evaluate(`document.querySelectorAll("iframe").length`)) === 0 && (await evaluate(`!!document.querySelector(".hero-stage .hero-bar")`)));
    }
    await sleep(500);
    const csp = problems.filter((p) => /Content.Security|CSP violation|Refused to/i.test(p));
    check(`${tag}: no CSP violation`, csp.length === 0, csp.join(" | "));
    const other = problems.filter((p) => !csp.includes(p));
    check(`${tag}: no console error or exception`, other.length === 0, other.join(" | "));
    if (networkErrors.length) console.log(`  network errors (listed, not failed): ${networkErrors.join(" | ")}`);
  }

  // A frame that never says it is ready (here: Pulse's own overview would never answer, so a blocked or wrong origin)
  // is covered by pulse-status.test.ts; the 5 s fallback is the component's timer.
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a file
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
