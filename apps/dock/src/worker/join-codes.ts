/**
 * The join codes' directory (TIN-838): one Durable Object for every dock, so a short code typed on
 * another computer finds the dock that made it. It holds only code, dock id and end, never a secret: the
 * dock that made the code still has to say yes before the new computer gets one of its own.
 *
 * A code is taken once (the first claim wins and the code goes) and lives JOIN_CODE_TTL_MS. Lookups of a
 * code that is not here are counted: past MISSES_PER_MINUTE in a minute the directory answers "busy",
 * so guessing codes costs more than the two minutes one lives.
 */
import { DurableObject } from "cloudflare:workers";

/** The one directory: every dock's codes go to the object of this name. */
export const DIRECTORY = "join-codes";
const MISSES_PER_MINUTE = 60;

export class JoinCodes extends DurableObject {
  private sql: SqlStorage;
  /** Lookups that found nothing, this minute (memory only: a restart forgets them, which is fine). */
  private misses = { minute: 0, count: 0 };

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec("create table if not exists codes (code text primary key, did text not null, expires_at integer not null)");
  }

  private purge(): void {
    this.sql.exec("delete from codes where expires_at <= ?", Date.now());
  }

  /** Keep a new code for a dock until expiresAt; false when the code is already someone's (make another). */
  async put(code: string, did: string, expiresAt: number): Promise<boolean> {
    this.purge();
    if (this.sql.exec("select 1 from codes where code = ?", code).toArray().length) return false;
    this.sql.exec("insert into codes (code, did, expires_at) values (?, ?, ?)", code, did, expiresAt);
    return true;
  }

  /** The dock a live code belongs to, once: the code goes. "busy" while too many codes were not found this minute. */
  async take(code: string): Promise<{ did: string } | { error: "unknown_code" | "busy" }> {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.misses.minute !== minute) this.misses = { minute, count: 0 };
    if (this.misses.count >= MISSES_PER_MINUTE) return { error: "busy" };
    this.purge();
    const row = this.sql.exec<{ did: string }>("select did from codes where code = ?", code).toArray()[0];
    if (!row) {
      this.misses.count++;
      return { error: "unknown_code" };
    }
    this.sql.exec("delete from codes where code = ?", code);
    return { did: row.did };
  }

  /** A code the dock let go of (a newer one, or Cancel). */
  async drop(codes: string[]): Promise<void> {
    for (const code of codes) this.sql.exec("delete from codes where code = ?", code);
  }
}
