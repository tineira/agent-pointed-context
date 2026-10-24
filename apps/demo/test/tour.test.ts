import assert from "node:assert/strict";
import { test } from "node:test";
import { tourStep } from "../src/worker/tour.ts";

const base = { skipped: false, done: false, acked: false, grantId: null as string | null, hasPin: false, reads: 0 };

test("the guided first run walks connect, point, pin, one read, a second read (TIN-361)", () => {
  assert.equal(tourStep(base), "connect");
  assert.equal(tourStep({ ...base, grantId: "g" }), "connected");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true }), "point");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, hasPin: true }), "pinned");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, hasPin: true, reads: 1 }), "read_once");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, hasPin: false, reads: 1 }), "read_once", "an unpinned mark after one read still asks to move it");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, hasPin: true, reads: 2 }), "read_twice");
});

test("skipping or finishing turns the guide off at any step", () => {
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, reads: 1, skipped: true }), "off");
  assert.equal(tourStep({ ...base, grantId: "g", acked: true, reads: 2, done: true }), "off");
  assert.equal(tourStep({ ...base, skipped: true }), "off");
});
