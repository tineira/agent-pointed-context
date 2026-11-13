/**
 * Consent in the app, checked by its server (APC 0.7, TIN-606): `DockConsent` gives the page a nonce to show
 * its consent with, and takes it back once, for the same dock and agent, before it expires. Since APC 0.9
 * (TIN-859) each consent carries a pairing code, given back when the nonce is taken.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, normalizePairingCode } from "@tineira/apc-protocol";
import { DOCK_CONSENT_TTL_MS, DockConsent, memoryKv, newPairingCode, sqlKv } from "../src/index.ts";

const HUB = "https://dock.test";

test("a consent nonce works once, for the dock and agent it was asked for, and gives back its pairing code", () => {
  const consent = new DockConsent(memoryKv());
  const asked = consent.ask(HUB, "ag_1");
  assert.match(asked.nonce, /^cn_[0-9a-f]{32}$/);
  assert.equal(normalizePairingCode(asked.pairing_code), asked.pairing_code, "raw and canonical");
  assert.deepEqual(consent.takeConsent(asked.nonce, HUB, "ag_1"), { ok: true, pairing_code: asked.pairing_code });
  assert.deepEqual(consent.takeConsent(asked.nonce, HUB, "ag_1"), { ok: false }, "used once");

  const other = consent.ask(HUB, "ag_1");
  assert.deepEqual(consent.takeConsent(other.nonce, HUB, "ag_2"), { ok: false }, "another agent");
  assert.deepEqual(consent.takeConsent(other.nonce, HUB, "ag_1"), { ok: false }, "a wrong use spends it too");
  const elsewhere = consent.ask(HUB, "ag_1");
  assert.deepEqual(consent.takeConsent(elsewhere.nonce, "https://other-dock.test", "ag_1"), { ok: false }, "another dock");
});

test("each consent has its own code, bound to its nonce", () => {
  const consent = new DockConsent(memoryKv());
  const a = consent.ask(HUB, "ag_1");
  const b = consent.ask(HUB, "ag_1");
  assert.notEqual(a.nonce, b.nonce);
  assert.deepEqual(consent.takeConsent(b.nonce, HUB, "ag_1"), { ok: true, pairing_code: b.pairing_code });
  assert.deepEqual(consent.takeConsent(a.nonce, HUB, "ag_1"), { ok: true, pairing_code: a.pairing_code });
});

test("a pairing code is 6 characters of Crockford base32, and 10,000 of them almost never repeat", () => {
  const seen = new Set<string>();
  const used = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const code = newPairingCode();
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    for (const c of code) {
      assert.ok(PAIRING_CODE_ALPHABET.includes(c), `${c} in ${code}`);
      used.add(c);
    }
    seen.add(code);
  }
  // 10,000 draws from 2^30: the expected number of repeats is under 0.05.
  assert.ok(seen.size >= 9_995, `${seen.size} distinct`);
  assert.equal(used.size, 32, "every character of the alphabet turns up");
});

test("a consent nonce expires, and nothing that is not one is taken", () => {
  const now = { t: 1_000_000 };
  const kv = memoryKv();
  const consent = new DockConsent(kv, { now: () => now.t });
  const late = consent.ask(HUB, "ag_1");
  now.t += DOCK_CONSENT_TTL_MS;
  assert.deepEqual(consent.takeConsent(late.nonce, HUB, "ag_1"), { ok: false }, "expired");
  for (const bad of [undefined, null, 42, "", "cn_", "cn_xyz", `cn_${"0".repeat(32)}`]) assert.deepEqual(consent.takeConsent(bad, HUB, "ag_1"), { ok: false }, String(bad));

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
  const asked = consent.ask(HUB, "ag_1");
  assert.deepEqual(new DockConsent(sqlKv(sql)).takeConsent(asked.nonce, HUB, "ag_1"), { ok: true, pairing_code: asked.pairing_code }, "another instance on the same storage takes it");
});
