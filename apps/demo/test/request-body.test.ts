/**
 * The page's POST bodies are drained (TIN-995). Connect an agent sends `{}` and its route never read it; the local
 * runtime then answered the next request on that connection (the page's /state poll) with "fetch failed", a 500.
 * Node's fetch has no such connection reuse to reproduce, so this checks the cause instead: after the Worker answers,
 * no POST body under /api is unread (request.bodyUsed). A body too big or too slow is cancelled, never buffered or
 * waited for (64 KB, 500 ms in index.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const SID = "9".repeat(32);
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: "https://dock.test", PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const BOUND = 64 * 1024;

async function pulse() {
  const sandbox = new Sandbox(durableObjectRoom().ctx, DEPLOY);
  const { owner } = await sandbox.init();
  const env = { ...DEPLOY, SANDBOX: { idFromName: (name: string) => name, get: () => sandbox } };
  const page = { "content-type": "application/json", cookie: `apc_session=${SID}.${owner}`, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  return { env, page };
}

test("Connect an agent, and the routes that ignore their body, leave no POST body unread; /state stays 200", async () => {
  const { env, page } = await pulse();
  const post = async (path: string, headers: Record<string, string> = page) => {
    const request = new Request(`${ORIGIN}/api/s/${SID}${path}`, { method: "POST", headers, body: "{}" });
    const response = (await worker.fetch(request, env)) as Response;
    await response.arrayBuffer();
    return { status: response.status, bodyUsed: request.bodyUsed };
  };

  const agent = await post("/grants/agent");
  assert.deepEqual(agent, { status: 200, bodyUsed: true }, "Connect an agent reads the page's body");
  const state = (await worker.fetch(new Request(`${ORIGIN}/api/s/${SID}/state`, { headers: page }), env)) as Response;
  assert.equal(state.status, 200);
  const grant = ((await state.json()) as { grants: Array<{ id: string }> }).grants[0]!.id;
  assert.deepEqual(await post(`/grants/${grant}/revoke`), { status: 200, bodyUsed: true }, "Revoke ignores its body too");
  // An early refusal, before any route, reads it as well: the next request on that connection is the page's too.
  assert.deepEqual(await post("/grants/agent", { ...page, origin: "https://evil.test" }), { status: 403, bodyUsed: true });
  assert.deepEqual(await post("/grants/agent", { ...page, cookie: "" }), { status: 403, bodyUsed: true });
  assert.deepEqual(await post("/grants/agent", { ...page, "content-type": "text/plain" }), { status: 415, bodyUsed: true }, "json_required");
});

test("a body past the bound, or one that stalls, is cancelled: the answer comes, and at most the bound is read", { timeout: 5000 }, async () => {
  const { env, page } = await pulse();
  const send = async (stream: ReadableStream<Uint8Array>) => {
    const request = new Request(`${ORIGIN}/api/s/${SID}/grants/agent`, { method: "POST", headers: page, body: stream, duplex: "half" } as RequestInit);
    const started = Date.now();
    const response = (await worker.fetch(request, env)) as Response;
    await response.arrayBuffer();
    return { status: response.status, ms: Date.now() - started };
  };

  // 2 MB in 16 KB chunks, pulled only as it is read (finite, so an unbounded read ends and fails here instead of hanging).
  let pulled = 0;
  let cancelled = false;
  const big = new ReadableStream<Uint8Array>({
    pull: (c) => {
      if (pulled >= 2 * 1024 * 1024) return c.close();
      pulled += 16 * 1024;
      c.enqueue(new Uint8Array(16 * 1024));
    },
    cancel: () => void (cancelled = true),
  }, { highWaterMark: 0 });
  assert.equal((await send(big)).status, 200);
  assert.ok(pulled <= BOUND + 2 * 16 * 1024, `read ${pulled} bytes, not the whole body`);
  assert.equal(cancelled, true, "the rest is cancelled");

  // Stalls after one chunk: the answer does not wait for it beyond the drain's deadline.
  let stalledCancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(new TextEncoder().encode("{")),
    pull: () => new Promise<void>(() => {}),
    cancel: () => void (stalledCancelled = true),
  });
  const slow = await send(stalled);
  assert.equal(slow.status, 200);
  assert.ok(slow.ms < 2000, `answered in ${slow.ms} ms`);
  assert.equal(stalledCancelled, true, "the stalled rest is cancelled");
});
