/**
 * A dock agent dropped on a Direct-only app (APC 0.5): Signals deployed with APC_PROFILES="direct", in
 * process. Its Worker serves an apc.json without the Dock profile, its feed refuses to pair with a dock,
 * and its page, through @tineira/apc-web's enablePinning with the profiles and connect page from that apc.json,
 * answers the drop with how to connect directly, never by doing nothing. The page is a DOM just big
 * enough for enablePinning (there is no browser in `node --test`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { APC_JSON_PATH, couldNotCheckNote, directOnlyNote, parseApcManifest, type ApcManifest } from "@tineira/apc-protocol";

installWorkersStandIn();
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const DIRECT_ONLY = { HUB_ORIGINS: "https://dock.test", APC_PROFILES: "direct" };

class El {
  tagName: string;
  attrs = new Map<string, string>();
  children: El[] = [];
  parentElement: El | null = null;
  textContent = "";
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  classes = new Set<string>();
  classList = { add: (c: string) => void this.classes.add(c), remove: (c: string) => void this.classes.delete(c), contains: (c: string) => this.classes.has(c) };
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  appendChild(n: El) {
    n.parentElement = this;
    this.children.push(n);
  }
  remove() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  closest(selector: string): El | null {
    const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    for (let n: El | null = this; n; n = n.parentElement) if (name && n.attrs.has(name)) return n;
    return null;
  }
  find(attr: string): El | undefined {
    return this.attrs.has(attr) ? this : this.children.map((c) => c.find(attr)).find(Boolean);
  }
}

const windowListeners = new Map<string, Array<(e: unknown) => void>>();
const body = new El("body");
const root = new El("html");
let under: El | null = null;
Object.assign(globalThis, {
  // The page is Signals', on its own origin.
  location: { origin: ORIGIN },
  document: { documentElement: root, body, createElement: (tag: string) => new El(tag), elementFromPoint: () => under, addEventListener() {}, removeEventListener() {} },
  window: {
    addEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, [...(windowListeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, (windowListeners.get(t) ?? []).filter((f) => f !== fn)),
  },
});
// By URL, like the Durable Objects: the page module needs the DOM types, which this test project does not load.
const { agentDragPayload, APC_AGENT_TYPE, APC_DROPS_ATTR, enablePinning, loadApcProfiles } = await import(new URL("../../../packages/web/src/pinning.ts", import.meta.url).href);

/** The person drags an agent from their dock over the page and drops it at whatever is under the pointer; whether the page took the drop. */
function dropFromDock(): boolean {
  const data = agentDragPayload("ag_1a2b3c4d", { hub: "https://dock.test", ticket: `${"d".repeat(32)}.${"0".repeat(32)}` });
  let taken = false;
  const event = (type: string) => ({ type, clientX: 10, clientY: 10, dataTransfer: { types: [APC_AGENT_TYPE], getData: (t: string) => (t === APC_AGENT_TYPE ? data : ""), dropEffect: "none" }, preventDefault: () => (taken = true) });
  for (const type of ["dragenter", "dragover"]) for (const fn of windowListeners.get(type) ?? []) fn(event(type));
  const accepted = taken;
  for (const fn of windowListeners.get("drop") ?? []) fn(event("drop"));
  return accepted;
}

async function directOnlyManifest(): Promise<ApcManifest> {
  const response = await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), DIRECT_ONLY);
  const parsed = parseApcManifest(await response.json(), ORIGIN);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.manifest;
}

test("a Direct-only Signals says so in its apc.json, with its Connect panel, and refuses to pair with a dock", async () => {
  const manifest = await directOnlyManifest();
  assert.deepEqual(manifest.profiles, ["direct"]);
  assert.equal(manifest.direct?.connect, `${ORIGIN}/?connect`);
  const feed = new Feed(durableObjectRoom().ctx, DIRECT_ONLY);
  await feed.init(1);
  assert.deepEqual(await feed.pairHub("7".repeat(32), ORIGIN, { hub: "https://dock.test", agent: "ag_1", ticket: `${"d".repeat(32)}.${"0".repeat(32)}` }), { ok: false, error: "not_available" });
});

test("a dock agent dropped on a Direct-only app is answered with how to connect directly, never lost", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manifest = await directOnlyManifest();
  const target = new El("article");
  target.setAttribute("data-focus", "post:p_1");
  body.appendChild(target);
  under = target;
  const lost: string[] = [];
  const stop = enablePinning({
    // Signals' page passes what its apc.json says; it does not set acceptNativeDrops.
    profiles: manifest.profiles,
    direct: { name: manifest.name, connect: manifest.direct?.connect ?? null },
    onUnknownAgent: () => void lost.push("onUnknownAgent"),
    onPin: () => void lost.push("onPin"),
  });
  assert.equal(root.hasAttribute(APC_DROPS_ATTR), true, "the page tells the browser extension it answers drops itself");
  assert.equal(dropFromDock(), true, "the page takes the drop, so the browser does not refuse it");
  assert.deepEqual(lost, [], "it is not paired or pinned");
  const note = body.find("data-apc-dock-unsupported");
  assert.ok(note, "a note in the page");
  assert.equal(note.getAttribute("role"), "status");
  assert.equal(note.children[0]!.textContent, directOnlyNote("Signals"));
  assert.match(note.children[0]!.textContent, /^Signals connects agents directly, not through a dock\./);
  const link = note.children.find((c) => c.tagName === "A")!;
  assert.equal(link.getAttribute("href"), `${ORIGIN}/?connect`, "it links to the Connect panel");
  t.mock.timers.tick(20_000);
  assert.equal(body.find("data-apc-dock-unsupported"), undefined, "the note goes after 20 s");

  // Off any target the drop is answered too.
  under = null;
  assert.equal(dropFromDock(), true);
  const first = body.find("data-apc-dock-unsupported");
  assert.ok(first);
  // Dropped again: the note is replaced, never stacked, and the new one keeps its full 20 s.
  t.mock.timers.tick(15_000);
  dropFromDock();
  const notes = body.children.filter((c) => c.attrs.has("data-apc-dock-unsupported"));
  assert.equal(notes.length, 1, "one note");
  assert.notEqual(notes[0], first, "the newer one");
  t.mock.timers.tick(15_000);
  assert.ok(body.find("data-apc-dock-unsupported"), "the old note's timer does not take the new one away");
  t.mock.timers.tick(5_000);
  assert.equal(body.find("data-apc-dock-unsupported"), undefined);
  stop();
  assert.equal(root.hasAttribute(APC_DROPS_ATTR), false);
});

/** A promise the test settles when it likes: the page's apc.json, still on its way. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setImmediate(r));

test("a drop before the page knows its profiles is held, then answered as its own apc.json says", async () => {
  under = new El("article");
  under.setAttribute("data-focus", "post:p_2");
  // Signals' page reads its own apc.json (loadApcProfiles), served by its Worker.
  const read: string[] = [];
  const viaWorker = (async (url: string | URL | Request) => {
    read.push(String(url));
    return worker.fetch(new Request(String(url)), DIRECT_ONLY);
  }) as typeof fetch;
  assert.deepEqual(await loadApcProfiles(ORIGIN, viaWorker), ["direct"]);
  assert.deepEqual(read, [`${ORIGIN}${APC_JSON_PATH}`]);

  // Direct-only, the file still on its way: the drop is taken, and answered once the file says so.
  const file = later<readonly ("direct" | "dock")[] | null>();
  const answers: Array<{ target: unknown; message: string }> = [];
  const unknown: string[] = [];
  const stop = enablePinning({
    acceptNativeDrops: true,
    profiles: file.promise,
    direct: { name: "Signals", connect: `${ORIGIN}/?connect` },
    onDockUnsupported: (answer: { target: unknown; message: string }) => void answers.push(answer),
    onUnknownAgent: (drag: { agent: string }) => void unknown.push(drag.agent),
    resolveAgent: () => null,
    onPin: () => {},
  });
  assert.equal(root.hasAttribute(APC_DROPS_ATTR), true);
  assert.equal(dropFromDock(), true, "taken while the profiles load");
  await flush();
  assert.deepEqual([answers.length, unknown], [0, []], "held: neither answered nor paired yet");
  file.resolve(["direct"]);
  await flush();
  assert.deepEqual(unknown, [], "never sent to pairing");
  assert.deepEqual(answers, [{ drag: { v: 1, agent: "ag_1a2b3c4d", hub: "https://dock.test", ticket: `${"d".repeat(32)}.${"0".repeat(32)}` }, target: { kind: "post", id: "p_2", part: null, params: null }, name: "Signals", connect: `${ORIGIN}/?connect`, reason: "direct_only", message: directOnlyNote("Signals") }]);
  dropFromDock();
  assert.equal(answers.length, 2, "once known, answered at once");
  assert.equal(body.find("data-apc-dock-unsupported"), undefined, "the app's own answer, no default note");
  stop();

  // An app that offers Dock, the file still on its way: the held drop goes to pairing once it is read.
  const both = later<readonly ("direct" | "dock")[] | null>();
  const unknown2: string[] = [];
  const stop2 = enablePinning({ acceptNativeDrops: true, profiles: both.promise, onUnknownAgent: (drag: { agent: string }) => void unknown2.push(drag.agent), resolveAgent: () => null, onPin: () => {} });
  dropFromDock();
  await flush();
  assert.deepEqual(unknown2, []);
  both.resolve(["direct", "dock"]);
  await flush();
  assert.deepEqual(unknown2, ["ag_1a2b3c4d"], "an app that offers Dock asks to pair, as before");
  stop2();
});

test("the note links only to an http(s) page of the app itself", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [connect, shown] of [[`${ORIGIN}/?connect`, true], [`blob:${ORIGIN}/x`, false], ["javascript:alert(1)", false], ["https://elsewhere.example/connect", false]] as const) {
    const stop = enablePinning({ profiles: ["direct"], direct: { name: "Signals", connect }, onPin: () => {} });
    dropFromDock();
    const note = body.find("data-apc-dock-unsupported")!;
    assert.equal(note.children.some((c) => c.tagName === "A"), shown, connect);
    note.remove();
    stop();
  }
});

test("the page reads its own apc.json as the hub does: no redirect, a time limit, a byte cap; anything else is null", async () => {
  const asked: Array<RequestInit | undefined> = [];
  const serve = (make: () => Response | Promise<Response>) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push(init);
      return make();
    }) as typeof fetch;
  const file = { name: "Signals", standard: "0.5.0", origin: "https://a.test", profiles: ["direct"], mcp: { path: "/mcp/" }, direct: { connect: "https://a.test/?connect" } };
  assert.deepEqual(await loadApcProfiles("https://a.test", serve(() => Response.json(file))), ["direct"]);
  assert.equal(asked[0]?.redirect, "error", "no redirect followed");
  assert.equal(asked[0]?.credentials, "omit");
  assert.ok(asked[0]?.signal instanceof AbortSignal, "with a time limit");
  assert.equal(await loadApcProfiles("https://b.test", serve(() => Response.json({ ...file, origin: "https://b.test", pad: "x".repeat(20_000) }))), null, "over 16 KiB");
  assert.equal(await loadApcProfiles("https://c.test", serve(() => new Response("gone", { status: 404 }))), null);
  assert.equal(await loadApcProfiles("https://d.test", serve(() => Promise.reject(new TypeError("redirect not allowed")))), null, "a redirect, refused by fetch");
  // A body that never ends: null at the time limit, not when the browser gives up.
  const started = Date.now();
  const never = serve(() => new Response(new ReadableStream({ start: () => {} })));
  assert.equal(await loadApcProfiles("https://e.test", never), null);
  const took = Date.now() - started;
  assert.ok(took >= 2900 && took < 5000, `${took} ms`);
  // A failure is not kept: the next call reads again.
  assert.deepEqual(await loadApcProfiles("https://c.test", serve(() => Response.json({ ...file, origin: "https://c.test", direct: { connect: "https://c.test/?connect" } }))), ["direct"]);
});

test("a held drop whose profiles cannot be read is answered as unchecked, never paired; a later drop asks again", async () => {
  under = new El("article");
  under.setAttribute("data-focus", "post:p_3");
  const replies: Array<readonly ("direct" | "dock")[] | null> = [null, ["direct", "dock"]];
  let loads = 0;
  const answers: Array<{ reason: string; message: string }> = [];
  const unknown: string[] = [];
  const stop = enablePinning({
    acceptNativeDrops: true,
    profiles: () => Promise.resolve(replies[loads++] ?? null),
    direct: { name: "Signals", connect: `${ORIGIN}/?connect` },
    onDockUnsupported: (answer: { reason: string; message: string }) => void answers.push(answer),
    onUnknownAgent: (drag: { agent: string }) => void unknown.push(drag.agent),
    resolveAgent: () => null,
    onPin: () => {},
  });
  assert.equal(loads, 1, "loaded at once");
  await flush();
  dropFromDock();
  await flush();
  // The first load gave nothing; this drop asked again, and got Dock: it goes to pairing.
  assert.equal(loads, 2, "a dock drop after a failed load asks again");
  assert.deepEqual([answers.length, unknown], [0, ["ag_1a2b3c4d"]]);
  stop();

  // A loader that keeps failing: the drop is answered "unchecked", with no pairing.
  const answers2: Array<{ reason: string; message: string }> = [];
  const unknown2: string[] = [];
  const stop2 = enablePinning({
    acceptNativeDrops: true,
    profiles: () => Promise.resolve(null),
    direct: { name: "Signals", connect: `${ORIGIN}/?connect` },
    onDockUnsupported: (answer: { reason: string; message: string }) => void answers2.push(answer),
    onUnknownAgent: (drag: { agent: string }) => void unknown2.push(drag.agent),
    resolveAgent: () => null,
    onPin: () => {},
  });
  await flush();
  assert.equal(dropFromDock(), true, "still taken, so the person gets an answer");
  await flush();
  assert.deepEqual(unknown2, [], "never sent to pairing on a guess");
  assert.deepEqual(answers2.map((a) => [a.reason, a.message]), [["unchecked", couldNotCheckNote("Signals")]]);
  stop2();
});
