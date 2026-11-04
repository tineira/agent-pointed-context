/**
 * The hub's page readings (TIN-422), run for real: hub.ts on Node's SQLite, with a stand-in for what
 * Cloudflare gives a Durable Object. The MCP calls go through its own fetch, as an agent's do.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {};

const { Hub, DOCK_TTL_MS } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);

const TTL_MS = 10 * 60_000;
const DID = "a".repeat(32);
const BROWSER = `chrome-extension://${"a".repeat(32)}`;
const OTHER_BROWSER = `chrome-extension://${"b".repeat(32)}`;
const CANARY = "zebra7319canary";

const reading = (site: string, words = "Churn rose") => ({
  reading: {
    url: `https://${site}/notes/${CANARY}?token=x`,
    title: `Title ${CANARY}`,
    element: { tag: "td", text: `${words} ${CANARY}`, name: `Name ${CANARY}`, heading: `Heading ${CANARY}`, column: `Column ${CANARY}`, row: `Row ${CANARY}` },
    selection: `Selected ${CANARY}`,
    selection_context: { heading: `Selection heading ${CANARY}`, text: `Selection block ${CANARY}` },
    form: { fields: [{ label: `Shipping ${CANARY}`, value: `Registered post ${CANARY}`, pointed: true }], left_out: 1, more: 0 },
  },
});

/** A hub with one agent, on a fresh database, and what a Durable Object would have around it. */
async function dock() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: Array<string | number | null>) {
      if (query.trim().replace(/;\s*$/, "").includes(";")) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows };
    },
  };
  const tables = () => db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map((t) => String(t.name));
  const room = {
    alarm: null as number | null,
    ctx: {
      storage: {
        sql,
        setAlarm: async (at: number) => void (room.alarm = at),
        deleteAll: async () => {
          for (const table of tables()) db.exec(`drop table ${table}`);
        },
      },
      setWebSocketAutoResponse: () => {},
      blockConcurrencyWhile: (work: () => unknown) => work(),
      getWebSockets: () => [],
    },
  };
  const hub = new Hub(room.ctx, { READER_ORIGINS: `${BROWSER},${OTHER_BROWSER}` });
  await hub.init(DID);
  const first = (await hub.state("https://dock.test")).agents[0];

  /** A browser the person allowed for this agent: the extension's token. */
  const allow = async (origin: string): Promise<string> => {
    const { ticket } = await hub.ticket(first.id);
    const { claim } = await hub.reader({ ticket, agent: first.id, label: "Chrome" }, origin);
    const asked = (await hub.state("https://dock.test")).agents[0].pairings.find((p: { status: string }) => p.status === "pending");
    await hub.decide(asked.id, "approve");
    return (await hub.readerStatus({ claim }, origin)).token;
  };

  /** One tool call, through the hub's MCP endpoint. */
  const callTool = async (name: string) => {
    const response = await hub.fetch(
      new Request(`https://dock.test${new URL(first.mcp_url).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
      }),
    );
    return (await response.json()).result;
  };

  const everything = (except: string[] = []) => JSON.stringify(tables().filter((t) => !except.includes(t)).map((t) => db.prepare(`select * from ${t}`).all()));
  const agentState = async () => (await hub.state("https://dock.test")).agents[0];
  return { hub, db, room, agent: first.id as string, allow, callTool, everything, agentState };
}

/** Every console call during the test, to search. */
function watchConsole(t: TestContext): () => string {
  const said: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => void said.push(args));
  return () => JSON.stringify(said);
}

test("the hub never logs a reading's text: only the reader's own row holds it, until it ends", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const saidOnConsole = watchConsole(t);
  const { hub, agent, allow, callTool, db, everything } = await dock();
  const token = await allow(BROWSER);

  assert.equal((await hub.reading(reading("example.com"), token, BROWSER)).ok, true);
  const got = await callTool("page__get_reading");
  assert.match(got.structuredContent.page_text, new RegExp(`Table column: Column ${CANARY}`));
  // The form state and the selection's place reach the agent in page_text, marked untrusted with the rest (TIN-571).
  assert.equal(got.structuredContent.untrusted, true);
  assert.match(got.structuredContent.page_text, new RegExp(`- Shipping ${CANARY}: Registered post ${CANARY} \\(pointed at\\)\n1 field left out as sensitive\\.`));
  assert.match(got.structuredContent.page_text, new RegExp(`The selection is in: Selection block ${CANARY}`));

  // The address also goes into the focus, for as long as the reading lives. Nothing else holds a word of it.
  assert.ok(!everything(["readers", "pointer"]).includes(CANARY));
  const [row] = db.prepare("select agent_id, at, site, bytes from reading_log").all();
  assert.deepEqual({ ...row }, { agent_id: agent, at: new Date().toISOString(), site: "example.com", bytes: row!.bytes });
  assert.ok(Number(row!.bytes) > 0);

  t.mock.timers.tick(TTL_MS);
  await hub.alarm();
  assert.ok(!everything().includes(CANARY));
  assert.ok(!saidOnConsole().includes(CANARY));
});

test("the alarm ends a reading at 10 minutes, nobody asking, and keeps the dock (TIN-422)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, callTool, db, room, agentState } = await dock();
  const token = await allow(BROWSER);
  const sent = Date.now();
  await hub.reading(reading("example.com"), token, BROWSER);
  assert.equal(room.alarm, sent + TTL_MS);
  assert.ok((await agentState()).focus);

  // A use of the dock pushes its own end out, not the reading's.
  t.mock.timers.tick(60_000);
  await callTool("get_current_view");
  assert.equal(room.alarm, sent + TTL_MS);

  t.mock.timers.tick(TTL_MS - 60_000);
  await hub.alarm();
  const [row] = db.prepare("select reading, reading_at from readers").all();
  assert.equal(row!.reading, null);
  assert.equal(row!.reading_at, null);
  assert.equal(db.prepare("select count(*) as n from pointer").all()[0]!.n, 0);
  // Nothing else due: the next ring is the dock's end, and the dock is still there.
  assert.ok(room.alarm! > Date.now() + TTL_MS);
  assert.equal((await agentState()).readings[0].kept, false);
  assert.equal((await hub.readingState(token, BROWSER)).latest, null);
});

test("an alarm that rings late changes nothing: a reading past its end is not given to the agent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, callTool } = await dock();
  await hub.reading(reading("example.com"), await allow(BROWSER), BROWSER);
  t.mock.timers.tick(TTL_MS + 1);
  const view = await callTool("get_current_view");
  assert.equal(view.structuredContent.focus, null);
  assert.ok(!JSON.stringify(view).includes(CANARY));
});

test("a browser that pairs again keeps its list, and can clear it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, agentState } = await dock();
  await hub.reading(reading("before.example"), await allow(BROWSER), BROWSER);
  const again = await allow(BROWSER);
  assert.deepEqual((await hub.readingLog(again, BROWSER)).readings.map((r: { site: string; kept: boolean }) => [r.site, r.kept]), [["before.example", false]]);
  await hub.readingLogClear(again, BROWSER);
  assert.deepEqual((await agentState()).readings, []);
});

test("two readings: the alarm rings for the older one, then the newer", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, room } = await dock();
  const one = await allow(BROWSER);
  const two = await allow(OTHER_BROWSER);
  const start = Date.now();
  await hub.reading(reading("one.example"), one, BROWSER);
  t.mock.timers.tick(60_000);
  await hub.reading(reading("two.example"), two, OTHER_BROWSER);
  assert.equal(room.alarm, start + TTL_MS);
  t.mock.timers.tick(TTL_MS - 60_000);
  await hub.alarm();
  assert.equal(room.alarm, start + 60_000 + TTL_MS);
});

test("past its end the dock is wiped, as before", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, db } = await dock();
  await hub.reading(reading("example.com"), await allow(BROWSER), BROWSER);
  t.mock.timers.tick(DOCK_TTL_MS + 1000);
  await hub.alarm();
  assert.equal(db.prepare("select count(*) as n from reading_log").all()[0]!.n, 0);
  assert.equal(db.prepare("select count(*) as n from meta where key = 'owner'").all()[0]!.n, 0);
});

test("the list is newest first, and says which reading the hub still has", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, agentState } = await dock();
  const token = await allow(BROWSER);
  await hub.reading(reading("one.example"), token, BROWSER);
  t.mock.timers.tick(1000);
  await hub.reading(reading("two.example"), token, BROWSER);
  const log = await hub.readingLog(token, BROWSER);
  assert.deepEqual(log.readings.map((r: { site: string; kept: boolean }) => [r.site, r.kept]), [["two.example", true], ["one.example", false]]);
  assert.deepEqual((await agentState()).readings, log.readings);
  // × on the pin ends the reading; its line stays, as gone.
  await hub.readingClear(token, BROWSER);
  assert.deepEqual((await agentState()).readings.map((r: { kept: boolean }) => r.kept), [false, false]);
});

test("the log keeps the last 50 of an agent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, agentState } = await dock();
  const token = await allow(BROWSER);
  for (let i = 0; i < 55; i++) {
    await hub.reading(reading(`s${i}.example`), token, BROWSER);
    t.mock.timers.tick(1000);
  }
  const rows = (await agentState()).readings;
  assert.equal(rows.length, 50);
  assert.equal(rows[0].site, "s54.example");
  assert.equal(rows.at(-1).site, "s5.example");
});

test("Clear in the popup takes this browser's list and reading; the dock sees it at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, allow, callTool, agentState } = await dock();
  const one = await allow(BROWSER);
  const two = await allow(OTHER_BROWSER);
  await hub.reading(reading("two.example"), two, OTHER_BROWSER);
  t.mock.timers.tick(1000);
  await hub.reading(reading("one.example"), one, BROWSER);

  // Each browser sees only what it sent; the dock sees both.
  assert.deepEqual((await hub.readingLog(one, BROWSER)).readings.map((r: { site: string }) => r.site), ["one.example"]);
  assert.equal((await agentState()).readings.length, 2);

  assert.equal((await hub.readingLogClear(one, BROWSER)).ok, true);
  assert.deepEqual((await agentState()).readings.map((r: { site: string }) => r.site), ["two.example"]);
  assert.equal((await agentState()).focus, null);
  // The other browser's reading is still there for the agent.
  assert.match((await callTool("page__get_reading")).structuredContent.page_text, /two\.example/);
});

test("Clear in the dock takes every browser's list and reading for that agent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, agent, allow, callTool, agentState, everything } = await dock();
  const one = await allow(BROWSER);
  const two = await allow(OTHER_BROWSER);
  await hub.reading(reading("one.example"), one, BROWSER);
  t.mock.timers.tick(1000);
  await hub.reading(reading("two.example"), two, OTHER_BROWSER);
  assert.equal((await hub.clearReadings(agent)).ok, true);
  assert.deepEqual((await agentState()).readings, []);
  assert.equal((await agentState()).focus, null);
  assert.equal((await callTool("page__get_reading")).isError, true);
  assert.ok(!everything().includes(CANARY));
  assert.equal((await hub.clearReadings("ag_nobody")).ok, false);
});

test("the list asks for the reader's token, from the extension's origin", async () => {
  const { hub, allow } = await dock();
  const token = await allow(BROWSER);
  assert.equal((await hub.readingLog("wrong", BROWSER)).ok, false);
  assert.equal((await hub.readingLog(token, "https://evil.example")).ok, false);
  assert.equal((await hub.readingLogClear(token, "https://evil.example")).ok, false);
  assert.equal(typeof (await hub.readingLog(token, BROWSER)).agent, "string");
});

test("removing an agent takes its list", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  const { hub, agent, allow, db } = await dock();
  await hub.reading(reading("example.com"), await allow(BROWSER), BROWSER);
  await hub.removeAgent(agent);
  assert.equal(db.prepare("select count(*) as n from reading_log").all()[0]!.n, 0);
});
