// How long can wait_for_focus hold a request on this host? Run by hand; deploys nothing.
// usage: node scripts/wait-ceiling.mjs <base> [timeouts in s, comma-separated] [--no-page]
//   node scripts/wait-ceiling.mjs http://localhost:5173 30,50,60,90,120,180,300
//   node scripts/wait-ceiling.mjs https://apc.tineira.com 30,50
// Each probe opens a fresh sandbox, holds its page WebSocket open (a wait returns at once when no page
// is open), connects as an MCP client and calls wait_for_focus with no pin, so the call can only end at
// its timeout or when something between the client and the sandbox drops it. A timeout_s above the
// server's ceiling is refused by the tool's schema: to probe higher locally, run `pnpm dev` with
// WAIT_CEILING_S=<s> in apps/demo/.dev.vars. --no-page skips the WebSocket (the early-return check).
// Each probe opens one sandbox; more than about 10 a minute from one IP hits the hosted rate limit.
const [BASE, LIST = "30,50", ...flags] = process.argv.slice(2);
if (!BASE) {
  console.error("usage: node scripts/wait-ceiling.mjs <base> [timeouts] [--no-page]");
  process.exit(2);
}
const timeouts = LIST.split(",").map(Number).filter((n) => n > 0);
const withPage = !flags.includes("--no-page");
const json = { "content-type": "application/json" };

async function sandbox() {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/session`, { method: "POST", headers: json, body: "{}" });
      if (!r.ok) throw new Error(`session: ${r.status}`);
      const { sid } = await r.json();
      const cookie = r.headers.get("set-cookie").split(";")[0];
      const state = await (await fetch(`${BASE}/api/s/${sid}/state`, { headers: { cookie } })).json();
      return { sid, cookie, grant: state.grants[0] };
    } catch (error) {
      // The local Workers runtime on Windows sometimes drops a new sandbox's first requests.
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function openPage({ sid, cookie }) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/s/${sid}/ws`, { headers: { cookie } });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`ws: ${e.message ?? "error"}`));
  });
}

async function probe(timeoutS) {
  const box = await sandbox();
  const page = withPage ? await openPage(box) : null;
  const url = `${BASE}/mcp/${box.sid}/${box.grant.secret}`;
  let id = 0;
  const mcp = (method, params) =>
    fetch(url, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Wait Ceiling Probe", version: "0" } });
  const tools = await (await mcp("tools/list", {})).json();
  const ceiling = tools.result.tools.find((t) => t.name === "wait_for_focus").inputSchema.properties.timeout_s.maximum;
  const t0 = performance.now();
  let outcome;
  try {
    const r = await mcp("tools/call", { name: "wait_for_focus", arguments: { timeout_s: timeoutS } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: an edge error page
    }
    const result = body?.result?.structuredContent;
    outcome = result
      ? { status: r.status, timed_out: result.timed_out, page_open: result.page_open ?? null }
      : { status: r.status, error: body?.error?.message ?? body?.result?.content?.[0]?.text?.slice(0, 120) ?? text.slice(0, 120) };
  } catch (e) {
    outcome = { status: "ERR", error: String(e.cause?.code ?? e.message) };
  }
  const held = (performance.now() - t0) / 1000;
  page?.close();
  return { timeout_s: timeoutS, ceiling, held_s: Number(held.toFixed(1)), ...outcome };
}

console.log(`${BASE} page ${withPage ? "open" : "closed"}`);
for (const t of timeouts) {
  const row = await probe(t);
  const ok = row.timed_out === true && Math.abs(row.held_s - t) < 5;
  console.log(JSON.stringify({ ...row, survived: ok }));
}
