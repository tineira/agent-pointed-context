// Load test: N simulated visitors, C at a time, each running the full APC flow once.
// usage: node scripts/loadtest.mjs <base> <visitors> <concurrency> [loadtest-key]
// From one IP, more than about 10 new sandboxes a minute hit the rate limit unless the Worker has a
// LOADTEST_KEY secret and the same value is passed here (sent as x-apc-loadtest). Delete the secret
// after the test: that disables the bypass.
const [BASE, VISITORS = "20", CONC = "20", KEY = ""] = process.argv.slice(2);
const N = Number(VISITORS);
const C = Number(CONC);
const steps = new Map(); // step -> { ms: [], status: Map }

function record(step, ms, status) {
  if (!steps.has(step)) steps.set(step, { ms: [], status: new Map() });
  const s = steps.get(step);
  s.ms.push(ms);
  s.status.set(status, (s.status.get(status) ?? 0) + 1);
}

async function timed(step, url, init) {
  const t0 = performance.now();
  let status = "ERR";
  let body = null;
  try {
    const r = await fetch(url, init);
    status = r.status;
    const text = await r.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (step === "session" && r.ok) body.cookie = r.headers.get("set-cookie")?.split(";")[0];
  } catch (e) {
    status = `ERR:${e.cause?.code ?? e.message}`;
  }
  record(step, performance.now() - t0, status);
  return body;
}

async function visitor() {
  const json = { "content-type": "application/json" };
  const s = await timed("session", `${BASE}/api/session`, { method: "POST", headers: { ...json, "x-apc-loadtest": KEY }, body: "{}" });
  if (!s?.sid) return;
  const owner = { ...json, cookie: s.cookie };
  const base = `${BASE}/api/s/${s.sid}`;
  const state = await timed("state", `${base}/state`, { headers: owner });
  await timed("view", `${base}/view`, { method: "POST", headers: owner, body: JSON.stringify({ screen: "overview", params: { month: "2026-03" }, selection: null }) });
  const grant = state?.grants?.[0];
  if (!grant) return;
  const mcpUrl = `${BASE}/mcp/${s.sid}/${grant.secret}`;
  let id = 0;
  const mcp = (step, method, params) =>
    timed(step, mcpUrl, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  await mcp("mcp:initialize", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Load Test", version: "0" } });
  await mcp("mcp:tools/list", "tools/list", {});
  await timed("pin", `${base}/pin`, { method: "POST", headers: owner, body: JSON.stringify({ grant_id: grant.id, target: { kind: "figure", params: { key: "active_customers", month: "2026-03" } } }) });
  await mcp("mcp:list_customers", "tools/call", { name: "list_customers", arguments: { limit: 20 } });
  const view = await mcp("mcp:get_current_view", "tools/call", { name: "get_current_view", arguments: {} });
  const focus = view?.result?.structuredContent?.focus;
  if (focus) await mcp("mcp:get_figure", "tools/call", { name: focus.next, arguments: focus.next_args });
  await timed("compat", `${base}/compat.json`, { headers: owner });
}

const t0 = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(C, N) }, async () => {
    while (next < N) {
      next++;
      await visitor();
    }
  }),
);
const wall = (performance.now() - t0) / 1000;

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0;
};
let total = 0;
let failed = 0;
console.log(`visitors=${N} concurrency=${C} wall=${wall.toFixed(1)}s`);
console.log("step                   n    p50    p95    max  statuses");
for (const [step, s] of steps) {
  total += s.ms.length;
  for (const [st, n] of s.status) if (st !== 200 && st !== 202) failed += n;
  const sts = [...s.status].map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`${step.padEnd(20)} ${String(s.ms.length).padStart(4)} ${pct(s.ms, 50).toFixed(0).padStart(6)} ${pct(s.ms, 95).toFixed(0).padStart(6)} ${Math.max(...s.ms).toFixed(0).padStart(6)}  ${sts}`);
}
console.log(`requests=${total} failed=${failed} throughput=${(total / wall).toFixed(1)} req/s`);
