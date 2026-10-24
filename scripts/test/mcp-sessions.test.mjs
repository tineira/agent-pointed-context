import assert from "node:assert/strict";
import { test } from "node:test";
import { countSessions, dailyTotals, sessionsSql } from "../lib/mcp-sessions.mjs";

const row = (day, client_name, session, weight = 1) => ({ day: `${day} 00:00:00`, client_name, session, weight: String(weight) });

test("the query groups by day, client and session over connected points only", () => {
  const sql = sessionsSql(7);
  assert.match(sql, /FROM apc_mcp_sessions/);
  assert.match(sql, /INTERVAL '7' DAY/);
  assert.match(sql, /blob1 = 'connected'/);
  assert.match(sql, /GROUP BY day, client_name, session/);
  assert.throws(() => sessionsSql(0));
  assert.throws(() => sessionsSql(1.5));
  assert.throws(() => sessionsSql(91));
});

test("sessions per day and client, weighted by sample interval, unnamed clients grouped", () => {
  const rows = [
    row("2026-10-23", "claude-ai", "s1"),
    row("2026-10-23", "claude-ai", "s2"),
    row("2026-10-23", "", "s3"),
    row("2026-10-24", "cursor", "s4", 4),
    row("2026-10-24", "claude-ai", "s1"),
  ];
  assert.deepEqual(countSessions(rows), [
    { day: "2026-10-23", client_name: "claude-ai", sessions: 2 },
    { day: "2026-10-23", client_name: "(unknown)", sessions: 1 },
    { day: "2026-10-24", client_name: "cursor", sessions: 4 },
    { day: "2026-10-24", client_name: "claude-ai", sessions: 1 },
  ]);
});

test("a daily total counts a session once even when it reported two client names", () => {
  const rows = [row("2026-10-24", "claude-ai", "s1"), row("2026-10-24", "Claude", "s1"), row("2026-10-24", "cursor", "s2")];
  assert.deepEqual(dailyTotals(rows), [{ day: "2026-10-24", sessions: 2 }]);
  assert.equal(countSessions(rows).reduce((a, c) => a + c.sessions, 0), 3);
});
