/**
 * Consent in the app, checked by its server (APC 0.6, TIN-606): `DockConsent` gives the page a nonce to show
 * its consent with, and takes it back once, for the same dock and agent, before it expires.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DOCK_CONSENT_TTL_MS, DockConsent, memoryKv, sqlKv } from "../src/index.ts";

const HUB = "https://dock.test";

test("a consent nonce works once, for the dock and agent it was asked for", () => {
  const consent = new DockConsent(memoryKv());
  const nonce = consent.ask(HUB, "ag_1");
  assert.match(nonce, /^cn_[0-9a-f]{32}$/);
  assert.equal(consent.take(nonce, HUB, "ag_1"), true);
  assert.equal(consent.take(nonce, HUB, "ag_1"), false, "used once");

  const other = consent.ask(HUB, "ag_1");
  assert.equal(consent.take(other, HUB, "ag_2"), false, "another agent");
  assert.equal(consent.take(other, HUB, "ag_1"), false, "a wrong use spends it too");
  const elsewhere = consent.ask(HUB, "ag_1");
  assert.equal(consent.take(elsewhere, "https://other-dock.test", "ag_1"), false, "another dock");
});

test("a consent nonce expires, and nothing that is not one is taken", () => {
  const now = { t: 1_000_000 };
  const kv = memoryKv();
  const consent = new DockConsent(kv, { now: () => now.t });
  const late = consent.ask(HUB, "ag_1");
  now.t += DOCK_CONSENT_TTL_MS;
  assert.equal(consent.take(late, HUB, "ag_1"), false, "expired");
  for (const bad of [undefined, null, 42, "", "cn_", "cn_xyz", `cn_${"0".repeat(32)}`]) assert.equal(consent.take(bad, HUB, "ag_1"), false, String(bad));

  // Asking again clears the expired ones, so the store does not grow with unanswered consents.
  consent.ask(HUB, "ag_1");
  now.t += DOCK_CONSENT_TTL_MS;
  consent.ask(HUB, "ag_2");
  assert.equal(kv.list("consent:").length, 1);
});

test("the nonces live in a Durable Object's SQLite through sqlKv", () => {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (query: string, ...params: Array<string | number | null>) => {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows };
  } };
  const consent = new DockConsent(sqlKv(sql));
  const nonce = consent.ask(HUB, "ag_1");
  assert.equal(new DockConsent(sqlKv(sql)).take(nonce, HUB, "ag_1"), true, "another instance on the same storage takes it");
});
