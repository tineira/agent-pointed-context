/**
 * Older pairing tests start after owner approval, so their manifest, code and relay assertions stay focused.
 * Seed that already-approved, origin-bound ticket explicitly; connect-013.test.ts exercises its real issuance.
 * Unverified acknowledgement defaults to false to retain coverage of pending rows from before the cut.
 */
export async function approvedConnectTicket(
  hub: { ticket(agent: string): Promise<{ ticket: string; expires_at: number } | null> },
  db: { prepare(query: string): { run(...params: Array<string | number | null>): unknown } },
  agent: string, origin: string,
) {
  const t = await hub.ticket(agent);
  if (!t) throw new Error("Unknown fixture agent");
  db.prepare("delete from tickets where ticket = ?").run(t.ticket);
  db.prepare("insert into connect_tickets (ticket, agent_id, origin, unverified_acked, expires_at) values (?, ?, ?, 0, ?)").run(t.ticket, agent, origin, t.expires_at);
  return t;
}
