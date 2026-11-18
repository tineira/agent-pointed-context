import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERIC_ERROR, plainError, plainPinError } from "../src/web/plain-errors.ts";

/** The codes the Pulse and Signals servers (and the hub client) answer with, for the pin, revoke, add-agent and pairing calls. */
const KNOWN = [
  "unknown_grant", "invalid_target", "not_found", "out_of_grant", "too_many", "dock_only", "invalid", "rate_limited", "forbidden", "expired", "sandbox_expired",
  "hub_not_allowed", "app_not_allowed", "hub_unreachable", "hub_refused", "hub_ignores_pairing_code", "invalid_pairing_code", "pairing_code_required",
  "pairing_in_progress", "pairing_ended", "not_cancellable", "not_available", "ticket_expired", "ticket_not_for_pairing", "ticket_origin_mismatch",
  "too_many_requests", "consent_required", "consent_expired", "dock_expired", "unauthorized",
];

test("every known code becomes a sentence, never the code", () => {
  for (const app of ["Pulse", "Signals"]) {
    for (const code of KNOWN) {
      for (const text of [plainError(app, code), plainPinError(app, code)]) {
        if (code.includes("_")) assert.ok(!text.includes(code), `${code} leaked: ${text}`);
        assert.ok(!/[a-z]+_[a-z_]+/.test(text), `a raw code shows in: ${text}`);
        assert.match(text, /^[A-Z].*[.]$/, `a sentence: ${text}`);
      }
    }
  }
});

test("an unknown or missing code gets the generic sentence, without the code", () => {
  assert.equal(plainError("Pulse", "something_new"), GENERIC_ERROR);
  assert.equal(plainError("Signals", undefined), GENERIC_ERROR);
  assert.equal(plainError("Signals", null), GENERIC_ERROR);
  assert.equal(plainError("Pulse", ""), GENERIC_ERROR);
  assert.ok(!GENERIC_ERROR.includes("_"));
  // An inherited key of Object is no code either.
  assert.equal(plainError("Pulse", "constructor"), GENERIC_ERROR);
  assert.equal(plainError("Pulse", "toString"), GENERIC_ERROR);
});

test("the sentences name the app they are shown in", () => {
  assert.equal(plainError("Pulse", "hub_not_allowed"), "Pulse does not pair with that dock.");
  assert.equal(plainError("Signals", "hub_not_allowed"), "Signals does not pair with that dock.");
  assert.match(plainError("Signals", "hub_refused"), /Signals didn't pair/);
});

test("not_found means an old dock when pairing and a missing thing when pinning", () => {
  assert.match(plainError("Pulse", "not_found"), /too old to connect to apps/);
  assert.match(plainPinError("Pulse", "not_found"), /no longer in the data/);
  assert.match(plainPinError("Pulse", "out_of_grant"), /can't read that part/);
});
