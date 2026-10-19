import assert from "node:assert/strict";
import { test } from "node:test";
import { presenceEffects } from "../src/web/presence.ts";

test("the activity switch gates the mark's pulse exactly like the flash", () => {
  assert.deepEqual(presenceEffects({ show_activity: true }), { pulse: true, flash: true });
  assert.deepEqual(presenceEffects({ show_activity: false }), { pulse: false, flash: false });
  assert.deepEqual(presenceEffects(null), { pulse: false, flash: false }, "no state yet: nothing moves");
});
