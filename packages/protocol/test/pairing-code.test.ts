/** The pairing code (APC 0.9, TIN-859): raw on the wire, formatted to show, normalized when typed, compared in constant time. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAIRING_CODE_ALPHABET, formatPairingCode, normalizePairingCode, pairingCodesMatch } from "../src/index.ts";

test("a typed code is normalized: case, spaces and dashes ignored, O as 0 and I or L as 1", () => {
  assert.equal(normalizePairingCode("K7M4P2"), "K7M4P2");
  assert.equal(normalizePairingCode("k7m-4p2"), "K7M4P2");
  assert.equal(normalizePairingCode(" k7m 4p2 "), "K7M4P2");
  assert.equal(normalizePairingCode("o1l-iOz"), "0111" + "0Z");
  for (const bad of [null, undefined, 42, "", "K7M4P", "K7M4P23", "K7M4PU", "K7M#P2", "x".repeat(40)]) assert.equal(normalizePairingCode(bad), null, String(bad));
});

test("a code is shown in two halves, and the alphabet is Crockford base32", () => {
  assert.equal(formatPairingCode("K7M4P2"), "K7M-4P2");
  assert.equal(formatPairingCode("k7m4p2"), "K7M-4P2");
  assert.equal(PAIRING_CODE_ALPHABET.length, 32);
  for (const c of "ILOU") assert.equal(PAIRING_CODE_ALPHABET.includes(c), false, c);
});

test("two codes match only when equal and both well formed", () => {
  assert.equal(pairingCodesMatch("K7M4P2", "K7M4P2"), true);
  assert.equal(pairingCodesMatch("K7M4P2", "K7M4P3"), false);
  assert.equal(pairingCodesMatch("K7M4P2", "K7M4P"), false);
  assert.equal(pairingCodesMatch("", ""), false);
});
