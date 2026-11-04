/**
 * A Cloudflare Durable Object on Node, for the conformance suite and other local tests (no network,
 * no workerd): the object's own code on Node's SQLite, with a stand-in for what Cloudflare gives it.
 * The person's pages are fake WebSockets that record what the object sends them.
 *
 * Call `installWorkersStandIn()` before importing a module that imports "cloudflare:workers".
 */
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

let installed = false;

/** Lets "cloudflare:workers" resolve on Node, to a DurableObject base class that keeps ctx and env. */
export function installWorkersStandIn(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
      return next(specifier, context);
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.WebSocketRequestResponsePair ??= class {};
}

/** One page of the person's, connected to the object: what it was sent, and whether it is still open. */
export interface FakePage {
  readyState: number;
  sent: string[];
  send(text: string): void;
  close(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** What a Durable Object gets from Cloudflare, on a fresh in-memory database, plus the pages around it. */
export interface DurableObjectRoom {
  ctx: unknown;
  db: DatabaseSync;
  /** The alarm the object set last, in ms. */
  alarm: number | null;
  pages: FakePage[];
  /** The person opens a page: a socket that answered its heartbeat just now. */
  openPage(): FakePage;
  /** The person closes every page. */
  closePages(): void;
  /** Every message sent to any page since the last call, parsed, oldest first. */
  takeMessages(): Array<Record<string, unknown>>;
}

export function durableObjectRoom(): DurableObjectRoom {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: SQLInputValue[]) {
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
  const OPEN = 1;
  const room: DurableObjectRoom = {
    db,
    alarm: null,
    pages: [],
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
      acceptWebSocket: () => {},
      getWebSockets: () => room.pages.filter((p) => p.readyState === OPEN),
      // Every open page answered its heartbeat just now.
      getWebSocketAutoResponseTimestamp: () => new Date(),
    },
    openPage() {
      let attachment: unknown = { accepted_at: Date.now() };
      const page: FakePage = {
        readyState: OPEN,
        sent: [],
        send: (text) => void page.sent.push(text),
        close: () => void (page.readyState = 3),
        serializeAttachment: (value) => void (attachment = value),
        deserializeAttachment: () => attachment,
      };
      room.pages.push(page);
      return page;
    },
    closePages() {
      for (const page of room.pages) page.close();
    },
    takeMessages() {
      const out: Array<Record<string, unknown>> = [];
      for (const page of room.pages) {
        for (const text of page.sent.splice(0)) {
          try {
            out.push(JSON.parse(text) as Record<string, unknown>);
          } catch {
            // not JSON
          }
        }
      }
      return out;
    },
  };
  return room;
}
