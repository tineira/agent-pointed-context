import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APC_MOBILE_MEDIA } from "@tineira/apc-protocol";

const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");

test("Signals' inline pins: on touch the pitch is at least 72 px, so a × never sits on the next badge's mark (TIN-903)", () => {
  const at = css.indexOf(`@media ${APC_MOBILE_MEDIA} { .pins {`);
  assert.ok(at >= 0, "the pins have a touch rule under APC_MOBILE_MEDIA");
  const rule = css.slice(at, css.indexOf("}", css.indexOf("{", at + 10)));
  const gap = Number(/gap:\s*(\d+)px/.exec(rule)?.[1]);
  assert.ok(28 + gap >= 72, `pitch ${28 + gap} px is under 72`);
  assert.ok(Number(/padding-right:\s*(\d+)px/.exec(rule)?.[1]) >= 28, "the last badge keeps room for its ×");
});
