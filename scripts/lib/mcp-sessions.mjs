// Distinct MCP agent sessions from the apc_mcp_sessions Analytics Engine dataset (TIN-347).
// The SQL returns one row per (day, source, client, session); the count is done here, so it does not rely on
// COUNT(DISTINCT) over sampled data. A session weighs its smallest sample interval: Analytics Engine
// can sample some of a session's points even at low volume (seen at 2 on 2026-10-24 with one agent),
// and one kept point at interval 1 means the session was seen whole, not that a second one was missed.
// The source is blob8: "dock" for an APC v2 dock's hub (TIN-416), empty on Pulse v1's points.

export const DATASET = "apc_mcp_sessions";

export function sessionsSql(days) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be an integer from 1 to 90");
  return [
    "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob8 AS source, blob2 AS client_name, index1 AS session, min(_sample_interval) AS weight",
    `FROM ${DATASET}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob1 = 'connected'`,
    "GROUP BY day, source, client_name, session",
    "ORDER BY day",
    "FORMAT JSON",
  ].join("\n");
}

/** A row's source: "dock", or "pulse" for Pulse v1's points, which carry none. */
export const sourceOf = (r) => r.source || "pulse";

/** Rows from the SQL API -> [{ day, source, client_name, sessions }], by day, source, then by sessions descending. */
export function countSessions(rows) {
  const counts = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const client = r.client_name || "(unknown)";
    const key = `${day}\u0000${sourceOf(r)}\u0000${client}`;
    counts.set(key, (counts.get(key) ?? 0) + (Number(r.weight) || 1));
  }
  return [...counts]
    .map(([key, sessions]) => {
      const [day, source, client_name] = key.split("\u0000");
      return { day, source, client_name, sessions };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || b.sessions - a.sessions || a.client_name.localeCompare(b.client_name));
}

/** Distinct sessions per day across all clients: a session that changed client name counts once. */
export function dailyTotals(rows) {
  const days = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    if (!days.has(day)) days.set(day, new Map());
    days.get(day).set(`${sourceOf(r)}\u0000${r.session}`, Number(r.weight) || 1);
  }
  return [...days].map(([day, s]) => ({ day, sessions: [...s.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => a.day.localeCompare(b.day));
}
