import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionPoint, type SessionEvent } from "../src/worker/sessions.ts";

const event = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  sid: "a".repeat(32),
  grantId: "g_1234",
  label: "Your agent",
  clientName: "claude-ai",
  clientVersion: "1.0",
  protocolVersion: "2025-06-18",
  userAgent: "Claude-User",
  ip: "203.0.113.7",
  ...over,
});

test("the session key is stable per sandbox and grant, and differs across either", async () => {
  const a = await sessionPoint("salt", event());
  const again = await sessionPoint("salt", event({ clientVersion: "2.0", ip: "198.51.100.1" }));
  const otherGrant = await sessionPoint("salt", event({ grantId: "g_9999" }));
  const otherSandbox = await sessionPoint("salt", event({ sid: "b".repeat(32) }));
  assert.match(a.indexes[0]!, /^[0-9a-f]{32}$/);
  assert.equal(again.indexes[0], a.indexes[0], "a reconnect is the same session");
  assert.notEqual(otherGrant.indexes[0], a.indexes[0]);
  assert.notEqual(otherSandbox.indexes[0], a.indexes[0]);
  assert.notEqual((await sessionPoint("other salt", event())).indexes[0], a.indexes[0]);
});

test("the point carries the client and no secret, sid, grant id or IP in the clear", async () => {
  const p = await sessionPoint("salt", event());
  assert.deepEqual(p.blobs.slice(0, 5), ["connected", "claude-ai", "1.0", "2025-06-18", "Your agent"]);
  assert.match(p.blobs[5]!, /^[0-9a-f]{32}$/);
  assert.equal(p.blobs[6], "Claude-User");
  assert.deepEqual(p.doubles, [1]);
  const all = JSON.stringify(p);
  for (const clear of ["203.0.113.7", "g_1234", "a".repeat(32), "salt"]) assert.ok(!all.includes(clear), clear);
});

test("missing client info and IP become empty blobs", async () => {
  const p = await sessionPoint("salt", event({ clientName: null, clientVersion: null, protocolVersion: null, ip: null }));
  assert.deepEqual(p.blobs.slice(1, 4), ["", "", ""]);
  assert.equal(p.blobs[5], "");
});
