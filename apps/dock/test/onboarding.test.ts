import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceOnboarding, newOnboarding, type Onboarding } from "../src/onboarding.ts";
import { dockReadEntry, hubFocus } from "../src/worker/logic.ts";

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

test("older stored milestones without read_apps accept their first and second app reads", () => {
  const { read_apps, ...old } = newOnboarding();
  let progress = JSON.parse(JSON.stringify(old)) as Onboarding;
  progress = advanceOnboarding(progress, { type: "app_read", agent: "first", app: "pulse" });
  assert.deepEqual(progress.read_apps, { first: ["pulse"] });
  assert.equal(progress.second_app, false);
  progress = advanceOnboarding(progress, { type: "app_read", agent: "first", app: "signals" });
  assert.equal(progress.second_app, true);
});

test("reading two apps through dock focus tools completes the second-app milestone", () => {
  for (const tool of ["get_current_view", "wait_for_focus"]) {
    let progress = newOnboarding();
    for (const id of ["pulse", "signals"]) {
      const focus = hubFocus({ kind: "post", id: "post_1", part: null, params: null, app_url: `https://${id}.example/post_1`, pinned_at: "2026-10-27T10:00:00Z", next: "get_post", next_args: { id: "post_1" } }, { id, name: id, origin: `https://${id}.example` });
      const entry = dockReadEntry(tool, { structuredContent: { focus } });
      assert.equal(entry.app, id);
      assert.equal(entry.pin, "post_1");
      assert.equal(entry.error, null);
      progress = advanceOnboarding(progress, { type: "app_read", agent: "first", app: focus.app.origin });
      assert.equal(progress.second_app, id === "signals");
    }
  }
});

test("empty focus, failed reads and tool listings never credit an app", () => {
  const focus = hubFocus({ kind: "post", id: "post_1", part: null, params: null, app_url: "https://signals.example/post_1", pinned_at: "2026-10-27T10:00:00Z", next: "get_post", next_args: {} }, { id: "signals", name: "Signals", origin: "https://signals.example" });
  for (const tool of ["get_current_view", "wait_for_focus"]) {
    for (const result of [{ structuredContent: { focus: null, views: [{ app: focus.app }] } }, { structuredContent: { timed_out: true } }, { isError: true, structuredContent: { focus, error: "failed" } }]) {
      const entry = dockReadEntry(tool, result);
      assert.equal(entry.app, null);
      assert.equal(entry.pin, null);
    }
  }
  const listing = dockReadEntry("list_app_tools", { structuredContent: { apps: [focus.app], focus } });
  assert.equal(listing.app, null);
  assert.equal(listing.pin, null);
});
