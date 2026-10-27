import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceOnboarding, newOnboarding, type Onboarding } from "../src/onboarding.ts";

test("milestones can arrive in any order and survive a serialized reload", () => {
  let progress = advanceOnboarding(newOnboarding(), { type: "reading_sent" });
  assert.equal(progress.connected, false);
  assert.equal(progress.reading_sent, true);
  progress = JSON.parse(JSON.stringify(progress)) as Onboarding;
  progress = advanceOnboarding(progress, { type: "pin_read" });
  progress = advanceOnboarding(progress, { type: "connected" });
  assert.equal(progress.pin_read, true);
  assert.equal(progress.reading_sent, true);
  assert.equal(progress.connected, true);
  assert.equal(progress.kept, false, "installs are optional, never inferred from other milestones");
  assert.equal(advanceOnboarding(progress, { type: "connected" }), progress);
});

test("a second app needs two distinct apps read by the same agent", () => {
  let progress = newOnboarding();
  const read = (agent: string, app: string) => { progress = advanceOnboarding(progress, { type: "app_read", agent, app }); };
  read("first", "signals");
  read("second", "pulse");
  read("first", "signals");
  assert.equal(progress.second_app, false);
  assert.deepEqual(progress.read_apps.first, ["signals"]);
  progress = JSON.parse(JSON.stringify(progress)) as Onboarding;
  read("first", "pulse");
  assert.equal(progress.second_app, true);
  read("first", "third");
  assert.deepEqual(progress.read_apps.first, ["signals", "pulse"], "stop retaining app ids once complete");
});

test("starting over creates an empty checklist without changing the previous dock", () => {
  const previous = advanceOnboarding(newOnboarding(), { type: "kept" });
  assert.equal(newOnboarding().kept, false);
  assert.equal(previous.kept, true);
});
