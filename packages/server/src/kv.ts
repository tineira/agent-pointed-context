/**
 * The little storage the Direct profile's helpers need (APC 0.4): string keys and values, read and
 * written synchronously, so an app's Durable Object checks and writes with nothing running in between.
 * `sqlKv` puts them in one table of any synchronous SQLite (a Durable Object's `ctx.storage.sql`);
 * `memoryKv` keeps them in memory, for tests or an app that keeps its own state elsewhere.
 */
export interface ApcKv {
  get(key: string): string | null;
  put(key: string, value: string): void;
  delete(key: string): void;
  /** Every entry whose key starts with `prefix`. */
  list(prefix: string): Array<[string, string]>;
}

/** What `sqlKv` needs from a database: a Durable Object's `SqlStorage`, or any synchronous SQLite. */
export interface SqlLike {
  exec(query: string, ...bindings: any[]): { toArray(): unknown[] };
}

/** One table, created if missing. Call it again after the database was wiped (`deleteAll`). */
export function sqlKv(sql: SqlLike, table = "apc_kv"): ApcKv {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) throw new Error(`not a table name: ${table}`);
  sql.exec(`create table if not exists ${table} (key text primary key, value text not null)`);
  return {
    get: (key) => (sql.exec(`select value from ${table} where key = ?`, key).toArray()[0] as { value?: string } | undefined)?.value ?? null,
    put: (key, value) => void sql.exec(`insert into ${table} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`, key, value).toArray(),
    delete: (key) => void sql.exec(`delete from ${table} where key = ?`, key).toArray(),
    list: (prefix) =>
      (sql.exec(`select key, value from ${table} where substr(key, 1, ?) = ? order by key`, prefix.length, prefix).toArray() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  };
}

export function memoryKv(): ApcKv {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    put: (key, value) => void map.set(key, value),
    delete: (key) => void map.delete(key),
    list: (prefix) => [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}
