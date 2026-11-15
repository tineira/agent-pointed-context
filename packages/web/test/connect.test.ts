import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeApcConnect } from "@tineira/apc-protocol";
import { clearApcConnect, takeApcConnect } from "../src/connect.ts";

test("the connect page clears the fragment before storage, resumes across login, and clears on completion", () => {
  const value = { v: 1 as const, hub: "https://dock.test", agent: "ag_1", ticket: "a".repeat(32) + "." + "b".repeat(32) };
  const events: string[] = [];
  const saved = new Map<string, string>();
  const page = {
    location: { hash: encodeApcConnect(value), pathname: "/connect/dock", search: "?next=1" },
    history: { state: null, replaceState: (_state: unknown, _title: string, url: unknown) => { events.push("clear:" + url); page.location.hash = ""; } },
    sessionStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, text: string) => { events.push("store"); saved.set(key, text); }, removeItem: (key: string) => { saved.delete(key); } },
  };
  assert.deepEqual(takeApcConnect(page), value);
  assert.deepEqual(events, ["clear:/connect/dock?next=1", "store"]);
  assert.deepEqual(takeApcConnect(page), value);
  clearApcConnect(page.sessionStorage);
  assert.equal(takeApcConnect(page), null);
  page.location.hash = "#apc_connect=bad";
  assert.equal(takeApcConnect(page), null);
  assert.equal(page.location.hash, "");
});
