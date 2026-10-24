// Distinct MCP agent sessions from the apc_mcp_sessions Analytics Engine dataset (TIN-347).
// The SQL returns one row per (day, client, session); the count is done here, each session weighted
// by its sample interval, so it does not rely on COUNT(DISTINCT) over sampled data.

export const DATASET = "apc_mcp_sessions";

export function sessionsSql(days) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be an integer from 1 to 90");
  return [
    "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob2 AS client_name, index1 AS session, max(_sample_interval) AS weight",
    `FROM ${DATASET}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob1 = 'connected'`,
    "GROUP BY day, client_name, session",
    "ORDER BY day",
    "FORMAT JSON",
  ].join("\n");
}

/** Rows from the SQL API -> [{ day, client_name, sessions }], by day then by sessions descending. */
export function countSessions(rows) {
  const counts = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const client = r.client_name || "(unknown)";
    const key = `${day}\u0000${client}`;
    counts.set(key, (counts.get(key) ?? 0) + (Number(r.weight) || 1));
  }
  return [...counts]
    .map(([key, sessions]) => {
      const [day, client_name] = key.split("\u0000");
      return { day, client_name, sessions };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || b.sessions - a.sessions || a.client_name.localeCompare(b.client_name));
}

/** Distinct sessions per day across all clients: a session that changed client name counts once. */
export function dailyTotals(rows) {
  const days = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    if (!days.has(day)) days.set(day, new Map());
    days.get(day).set(r.session, Number(r.weight) || 1);
  }
  return [...days].map(([day, s]) => ({ day, sessions: [...s.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => a.day.localeCompare(b.day));
}
