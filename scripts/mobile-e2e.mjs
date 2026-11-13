// End to end check of the mobile rule (APC 0.6, TIN-608, DESIGN.md 19), by hand: a real Chrome at 375x812 with
// touch emulation, real touches sent through the DevTools Protocol (Input.dispatchTouchEvent, so the page sees trusted
// pointer events of type "touch"), against Pulse and Signals running locally, and the mobile checks of the conformance
// suite (`page.mobile`) run with a page adapter that drives that browser.
//
// Start the apps first (each in its own terminal), then run this:
//   cd apps/demo && node node_modules/vite/bin/vite.js --port 5301 --strictPort
//   cd apps/signals && node node_modules/vite/bin/vite.js --port 5302 --strictPort
//   node scripts/mobile-e2e.mjs [--shots=<dir>] [--pulse=http://localhost:5301] [--signals=http://localhost:5302] [chrome.exe]
// Each app gets agents made on its Direct profile (POST /api/s/:sid/grants/agent), the bar and the pins are checked
// in the page, and the agent reads the pin through its MCP URL. Exits 1 when a check fails.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apcConformance } from "../packages/conformance/src/index.ts";
import { APC_MOBILE_VIEWPORT } from "../packages/protocol/src/core.ts";

const args = process.argv.slice(2);
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const SHOTS = opt("shots", null);
const APPS = [
  { name: "Pulse", url: opt("pulse", "http://localhost:5301"), path: "/customers" },
  { name: "Signals", url: opt("signals", "http://localhost:5302"), path: "/" },
];
const EXE = args.find((a) => !a.startsWith("--")) ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
const PORT = 9347;
const { width, height } = APC_MOBILE_VIEWPORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const profileDir = mkdtempSync(join(tmpdir(), "apc-mobile-"));
const CHROME_ARGS = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, "--headless=new", "--no-first-run", "--disable-extensions", "--disable-dev-shm-usage", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--disable-gpu", `--window-size=${width},${height}`, "about:blank"];

/** Starts Chrome and waits for its DevTools page: up to 30 s, and one more try if it does not come; its stderr is printed when it fails. */
async function startChrome() {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const proc = spawn(EXE, CHROME_ARGS, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    let exited = null;
    proc.on("exit", (code) => (exited = code));
    for (let i = 0; i < 150 && exited === null; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        const page = targets.find((t) => t.type === "page");
        if (page) return { proc, wsUrl: page.webSocketDebuggerUrl };
      } catch {
        // not up yet
      }
      await sleep(200);
    }
    last = `attempt ${attempt}: ${exited === null ? "no DevTools page in 30 s" : `exited with ${exited}`}\n${stderr}`;
    console.error(`Chrome did not start (${last})`);
    proc.kill();
    await sleep(1000);
  }
  throw new Error(`Chrome did not start (${EXE}): ${last}`);
}

const { proc: chrome, wsUrl } = await startChrome();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const touch = (type, x, y) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
const tap = async (x, y) => {
  await touch("touchStart", x, y);
  await sleep(60);
  await touch("touchEnd", x, y);
  await sleep(300);
};
const shot = async (name) => {
  if (!SHOTS) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });

/** In the page: where on screen a tap lands on the target `kind:id` (and part), or null. A grid over its box, innermost data-focus wins, as targetAt does. */
const POINT_FOR = `(want) => {
  const els = [...document.querySelectorAll("[data-focus]")].filter((e) => e.getAttribute("data-focus") === want.focus && (e.getAttribute("data-focus-part") ?? null) === (want.part ?? null));
  const room = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--apc-bar-height")) || 0) - 90;
  for (const el of els) {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    for (const fy of [0.5, 0.25, 0.75]) for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || x > innerWidth || y < 0 || y > room) continue;
      const hit = document.elementFromPoint(x, y)?.closest("[data-focus]");
      if (hit === el) return { x, y };
    }
  }
  return null;
}`;

const results = [];
let failed = 0;
for (const app of APPS) {
  console.log(`\n${app.name} at ${width}x${height}, touch`);
  await send("Page.navigate", { url: `${app.url}${app.path}` });
  await sleep(2500);
  const sidOf = () => evaluate(`(performance.getEntriesByType("resource").map((r) => r.name).reverse().find((n) => /\\/api\\/s\\/[0-9a-f]+\\//.test(n)) ?? "").match(/\\/api\\/s\\/([0-9a-f]+)/)?.[1] ?? null`);
  const sid = await sidOf();
  if (!sid) throw new Error(`${app.name}: no sandbox opened at ${app.url}`);
  const origin = new URL(app.url).origin;
  const reload = async (waitFor) => {
    await send("Page.navigate", { url: `${app.url}${app.path}` });
    await sleep(2200);
    if (waitFor) for (let i = 0; i < 30 && !(await evaluate(`!!document.querySelector('[data-apc-mark][data-grant="${waitFor}"]')`)); i++) await sleep(200);
  };
  const stateOf = () => evaluate(`fetch("/api/s/${sid}/state").then((r) => r.json())`);

  /** The targets the page shows on a phone: two different ones whose tap point is in view. */
  const found = await evaluate(`JSON.stringify([...document.querySelectorAll("[data-focus]")].map((e) => ({ focus: e.getAttribute("data-focus"), part: e.getAttribute("data-focus-part") })).filter((w, i, all) => all.findIndex((x) => x.focus === w.focus && x.part === w.part) === i).slice(0, 12))`);
  const candidates = JSON.parse(found).map((w) => ({ ...w, kind: w.focus.split(":")[0], id: w.focus.split(":").slice(1).join(":") }));
  const usable = [];
  for (const w of candidates) {
    if (usable.length === 2) break;
    if (usable.some((u) => u.focus === w.focus && u.part === w.part)) continue;
    const point = await evaluate(`(${POINT_FOR})(${JSON.stringify(w)})`);
    if (point) usable.push(w);
  }
  if (usable.length < 2) throw new Error(`${app.name}: fewer than two targets can be tapped in the page`);
  const targets = usable.map((w) => ({ kind: w.kind, id: w.id, part: w.part ?? null, params: null }));
  const want = (t) => ({ focus: `${t.kind}:${t.id}`, part: t.part });

  const visibleMark = (grantId) =>
    `(() => { const m = [...document.querySelectorAll('[data-apc-mark][data-grant="${grantId}"]')].find((e) => !e.closest("apc-pin") && e.getBoundingClientRect().width > 0); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, shown: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("[data-apc-mark]") === m }; })()`;

  const grants = new Map();
  const adapter = {
    name: app.name,
    profile: "direct",
    connect: async () => {
      const made = await evaluate(`fetch("/api/s/${sid}/grants/agent", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json())`);
      const grantId = made.grant_id ?? made.id;
      if (!grantId) throw new Error(`${app.name}: could not make an agent: ${JSON.stringify(made)}`);
      const secret = (await stateOf()).grants.find((g) => g.id === grantId).secret;
      grants.set(grantId, true);
      await reload(grantId);
      return { grantId, mcpUrl: `${origin}/mcp/${sid}/${secret}` };
    },
    targets,
    probe: { tool: "get_current_view", args: {} },
    page: {
      setOpen: () => {},
      showView: async () => {},
      pin: async () => false,
      takePresence: () => [],
      revoke: async () => false,
      mobile: {
        async agentBar() {
          const visible = [];
          for (const id of grants.keys()) {
            const m = await evaluate(visibleMark(id));
            // Finger sized and in view, not covered by anything.
            if (m?.shown && m.w >= 40 && m.h >= 40) visible.push(id);
          }
          await shot(`${app.name.toLowerCase()}-bar`);
          const collapsible = await evaluate(`!!document.querySelector(".apc-agents__collapse, .apc-agents__mini")`);
          return { visible, collapsible };
        },
        async pinByTouch(grantId, target) {
          const mark = await evaluate(visibleMark(grantId));
          if (!mark) return false;
          await tap(mark.x, mark.y);
          const armed = await evaluate(`document.documentElement.dataset.apcArmed === ${JSON.stringify(grantId)} && !!document.querySelector("[data-apc-tap-pin]")`);
          if (!armed) throw new Error("a tap on the agent's mark did not arm it (no tap to pin note)");
          await shot(`${app.name.toLowerCase()}-armed`);
          const point = await evaluate(`(${POINT_FOR})(${JSON.stringify(want(target))})`);
          if (!point) throw new Error(`the target ${target.kind}:${target.id} cannot be tapped in the page`);
          await sleep(150);
          await tap(point.x, point.y);
          await sleep(500);
          const left = await evaluate(`document.documentElement.dataset.apcArmed ?? null`);
          if (left !== null) return false;
          const pin = (await stateOf()).grants.find((g) => g.id === grantId)?.pin;
          await shot(`${app.name.toLowerCase()}-pinned`);
          return !!pin && pin.kind === target.kind && pin.id === target.id && (pin.part ?? null) === target.part;
        },
        async unpinByTouch(grantId) {
          const at = await evaluate(`(() => { const m = [...document.querySelectorAll('[data-apc-mark][data-grant="${grantId}"]')].find((e) => !e.closest("apc-pin") && e.getBoundingClientRect().width > 0); const b = m?.closest(".apc-agents__agent")?.querySelector(".apc-agents__unpin"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
          if (!at || at.w < 40 || at.h < 40) return false;
          await tap(at.x, at.y);
          await sleep(500);
          return (await stateOf()).grants.find((g) => g.id === grantId)?.pin == null;
        },
      },
    },
  };

  const checks = apcConformance(adapter).filter((c) => c.name.includes("mobile"));
  if (checks.length !== 3) throw new Error(`${app.name}: expected 3 mobile checks, got ${checks.length}`);
  for (const check of checks) {
    try {
      await check.run();
      console.log(`  ok   ${check.name}`);
      results.push({ name: check.name, ok: true });
    } catch (error) {
      failed++;
      console.log(`  FAIL ${check.name}\n       ${error instanceof Error ? error.message : error}`);
      results.push({ name: check.name, ok: false });
    }
  }

  // Beyond the suite: Cancel and Escape let go, a touch drag pins, a tap elsewhere lets go and passes through, scripts and route changes do nothing or let go, and the keyboard pins.
  const first = [...grants.keys()][0];
  const mark = await evaluate(visibleMark(first));
  const extra = async (name, run) => {
    try {
      await run();
      console.log(`  ok   ${app.name}: ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${app.name}: ${name}\n       ${error instanceof Error ? error.message : error}`);
    }
  };
  const armedNow = () => evaluate(`document.documentElement.dataset.apcArmed ?? null`);
  await extra("a bar of dock agents only stays in full, even when the person collapsed it on a desktop", async () => {
    // The Dock profile's collapse rule (APC 0.4) does not apply on a phone. The agents are set on the bar itself: no dock is paired here.
    const r = await evaluate(`(() => {
      try { localStorage.setItem("apc-agents.collapsed", "1"); } catch {}
      const bar = [...document.querySelectorAll("apc-agents")].find((e) => e.getBoundingClientRect().width > 0);
      bar.agents = [{ id: "g_dockonly", name: "Dock agent", state: "idle", paths: ["dock"] }];
      const mark = bar.querySelector('[data-grant="g_dockonly"]');
      const out = { mini: !!bar.querySelector(".apc-agents__mini"), fold: !!bar.querySelector(".apc-agents__collapse"), shown: !!mark && mark.getBoundingClientRect().width >= 40 && !mark.closest("[hidden]") };
      try { localStorage.removeItem("apc-agents.collapsed"); } catch {}
      return out;
    })()`);
    if (r.mini || r.fold || !r.shown) throw new Error(`the bar of a dock agent: ${JSON.stringify(r)}`);
    await reload(first);
  });
  await extra("Cancel in the note lets go", async () => {
    await tap(mark.x, mark.y);
    if ((await armedNow()) !== first) throw new Error("not armed");
    const cancel = await evaluate(`(() => { const r = document.querySelector("[data-apc-tap-cancel]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }; })()`);
    if (cancel.h < 40) throw new Error(`Cancel is ${cancel.h}px tall`);
    await tap(cancel.x, cancel.y);
    if ((await armedNow()) !== null || (await evaluate(`!!document.querySelector("[data-apc-tap-pin]") || document.body.classList.contains("apc-armed")`))) throw new Error("still armed after Cancel");
  });
  await extra("tapping the armed mark again lets go", async () => {
    await tap(mark.x, mark.y);
    await tap(mark.x, mark.y);
    if ((await armedNow()) !== null) throw new Error("still armed");
  });
  await extra("a tap on something that is no target lets go and passes through to a button; nothing is pinned", async () => {
    await evaluate(`(() => { const b = document.createElement("button"); b.id = "apc-probe"; b.textContent = "probe"; Object.assign(b.style, { position: "fixed", top: "100px", left: "10px", width: "100px", height: "50px", zIndex: "2147483000" }); b.onclick = () => { window.__probeClicks = (window.__probeClicks || 0) + 1; }; document.body.append(b); })()`);
    await tap(mark.x, mark.y);
    if ((await armedNow()) !== first) throw new Error("not armed");
    await tap(60, 125);
    const clicks = await evaluate(`window.__probeClicks || 0`);
    const still = await armedNow();
    await evaluate(`document.getElementById("apc-probe").remove()`);
    if (clicks !== 1) throw new Error(`the button got ${clicks} clicks, expected 1 (the tap must pass through)`);
    if (still !== null) throw new Error("still armed after a tap on something that is no target");
    if ((await stateOf()).grants.find((g) => g.id === first)?.pin) throw new Error("a pin was made");
  });
  await extra("a script cannot arm or pin: element.click() and synthetic pointer events do nothing", async () => {
    const out = await evaluate(`(() => {
      const mark = [...document.querySelectorAll("[data-apc-mark]")].find((e) => !e.closest("apc-pin") && e.getBoundingClientRect().width > 0);
      mark.click();
      const armedAfterClick = document.documentElement.dataset.apcArmed ?? null;
      const fire = (el, type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, clientX: 20, clientY: 20, button: 0 }));
      fire(mark, "pointerdown");
      fire(window, "pointerup");
      return { armedAfterClick, armedAfterPointer: document.documentElement.dataset.apcArmed ?? null, drag: document.body.classList.contains("apc-dragging") };
    })()`);
    if (out.armedAfterClick !== null || out.armedAfterPointer !== null || out.drag) throw new Error(JSON.stringify(out));
    // Armed by the person, a script's pointer events on a target pin nothing.
    await tap(mark.x, mark.y);
    const point = await evaluate(`(${POINT_FOR})(${JSON.stringify(want(targets[0]))})`);
    await evaluate(`(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); for (const t of ["pointerdown", "pointerup", "click"]) el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: "touch", clientX: ${point.x}, clientY: ${point.y}, button: 0 })); })()`);
    await sleep(300);
    const pin = (await stateOf()).grants.find((g) => g.id === first)?.pin;
    if ((await armedNow()) === first) await tap(mark.x, mark.y);
    await reload(first); // the app's own handler for the script's click may have navigated
    if (pin) throw new Error(`a script pinned: ${JSON.stringify(pin)}`);
  });
  await extra("a route change lets go", async () => {
    await tap(mark.x, mark.y);
    if ((await armedNow()) !== first) throw new Error("not armed");
    await evaluate(`history.pushState({}, "", location.pathname + location.search + "#route-change")`);
    await sleep(600);
    const still = await armedNow();
    await evaluate(`history.replaceState({}, "", location.pathname + location.search)`);
    if (still !== null) throw new Error("still armed after the URL changed");
  });
  await extra("a finger can also drag the mark onto a target", async () => {
    const point = await evaluate(`(${POINT_FOR})(${JSON.stringify(want(targets[1]))})`);
    const m = await evaluate(visibleMark(first));
    await touch("touchStart", m.x, m.y);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", m.x + ((point.x - m.x) * i) / 10, m.y + ((point.y - m.y) * i) / 10);
      await sleep(30);
    }
    await touch("touchEnd", point.x, point.y);
    await sleep(500);
    const pin = (await stateOf()).grants.find((g) => g.id === first)?.pin;
    if (!pin || pin.id !== targets[1].id) throw new Error(`pin is ${JSON.stringify(pin)}`);
  });
  await extra("from the keyboard: Enter on the mark arms, focus moves to a target, Enter on it pins", async () => {
    const key = async (type, k, code, vk, text) => send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    const press = async (k, code, vk, text) => {
      await key(text ? "keyDown" : "rawKeyDown", k, code, vk, text);
      await key("keyUp", k, code, vk);
      await sleep(300);
    };
    await evaluate(`[...document.querySelectorAll('[data-apc-mark][data-grant="${first}"]')].find((e) => !e.closest("apc-pin") && e.getBoundingClientRect().width > 0).focus()`);
    await press("Enter", "Enter", 13, "\r");
    if ((await armedNow()) !== first) throw new Error("Enter on the mark did not arm it");
    const where = await evaluate(`JSON.stringify({ on: document.activeElement?.closest?.("[data-focus]")?.getAttribute("data-focus") ?? null, say: document.querySelector("[data-apc-tap-pin]")?.textContent })`);
    const { on, say } = JSON.parse(where);
    if (!on) throw new Error("focus did not move to a target");
    if (!/Enter or Space/.test(say)) throw new Error(`the note does not say how to pin: ${say}`);
    // The target whose own action would navigate: Pulse's customer row, Signals' offer link. Its click must be swallowed.
    const navSelector = app.name === "Pulse" ? '[data-focus^="customer:"]:not([data-focus-part])' : '[data-focus-part="offer"]';
    await evaluate(`document.querySelector(${JSON.stringify(navSelector)}).focus()`);
    const hrefBefore = await evaluate(`location.href`);
    await press("Enter", "Enter", 13, "\r");
    const pin = (await stateOf()).grants.find((g) => g.id === first)?.pin;
    if (!pin) throw new Error("Enter on a focused target did not pin");
    const navFocus = await evaluate(`document.querySelector(${JSON.stringify(navSelector)}).getAttribute("data-focus")`);
    if (pin.id !== navFocus.split(":").slice(1).join(":")) throw new Error(`pinned ${pin.id}, expected the focused ${navFocus}`);
    const hrefAfter = await evaluate(`location.href`);
    if (hrefAfter !== hrefBefore) throw new Error(`the target's own action also ran: ${hrefBefore} -> ${hrefAfter}`);
    if ((await armedNow()) !== null) throw new Error("still armed after the pin");
    if ((await evaluate(`document.querySelectorAll('[data-focus][tabindex="0"]').length`)) > 0 && !(await evaluate(`[...document.querySelectorAll("[data-focus]")].every((e) => e.getAttribute("tabindex") !== "0" || e.matches("a, button, input"))`))) throw new Error("targets keep the tabindex the pin mode gave them");
  });
}

try {
  await send("Browser.close");
} catch {
  // already gone
}
ws.close();
chrome.kill();
await sleep(500);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  // Chrome may still hold a file; the OS temp directory is cleaned later
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
