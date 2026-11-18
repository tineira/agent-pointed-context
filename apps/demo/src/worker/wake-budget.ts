import { DurableObject } from "cloudflare:workers";

/** All of Pulse's webhook POSTs, owner tests included (TIN-997). */
export const WAKE_GLOBAL_DAY_MAX = 2_000;

/** One instance, idFromName("global"): synchronous SQLite writes make taking a slot atomic. */
export class WakeBudget extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec("create table if not exists wake_days (day text primary key, count integer not null)");
  }

  take(): boolean {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const sql = this.ctx.storage.sql;
    sql.exec("delete from wake_days where day < ?", day);
    const rows = sql.exec<{ count: number }>(
      "insert into wake_days (day, count) values (?, 1) on conflict(day) do update set count = count + 1 where count < ? returning count",
      day, WAKE_GLOBAL_DAY_MAX,
    ).toArray();
    return rows.length === 1;
  }
}
