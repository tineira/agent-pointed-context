import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import vm from "node:vm";
import { encodeApcConnect } from "@tineira/apc-protocol";
import { doc, El } from "../../../packages/web/test/fake-dom.ts";
import { CONNECT_EXPIRED, CONNECT_HEAD } from "../src/worker/dock-connect-page.ts";

class FakeOption extends El {
  label: string;
  constructor(label = "", value = "") {
    super("option");
    this.label = label;
    this.value = value;
  }
}

(El.prototype as unknown as { add(this: El, option: FakeOption): void }).add = function add(this: El, option: FakeOption) {
  this.append(option);
  if (this.children.length === 1) this.value = option.value;
};

let currentHash = "";
let events: string[] = [];
const sessionMap = new Map<string, string>();
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response(null, { status: 500 });

const sessionStorageStub: Storage = {
  get length() {
    return sessionMap.size;
  },
  clear: () => sessionMap.clear(),
  key: (i: number) => [...sessionMap.keys()][i] ?? null,
  getItem: (k: string) => sessionMap.get(k) ?? null,
  setItem: (k: string, v: string) => {
    events.push(`sessionStorage.setItem:${k}`);
    sessionMap.set(k, v);
  },
  removeItem: (k: string) => {
    events.push(`sessionStorage.removeItem:${k}`);
    sessionMap.delete(k);
  },
};

const locationStub = {
  href: "https://pulse.test/connect/dock",
  origin: "https://pulse.test",
  pathname: "/connect/dock",
  search: "",
  get hash() {
    return currentHash;
  },
  set hash(next: string) {
    currentHash = next;
  },
};

const historyStub = {
  state: { idx: 0 },
  replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
    events.push(`replaceState:${String(url ?? "")}`);
    currentHash = "";
  },
};

Object.assign(globalThis, {
  Option: FakeOption,
  sessionStorage: sessionStorageStub,
  location: locationStub,
  history: historyStub,
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    events.push(`fetch:${url}`);
    return fetchHandler(url, init);
  },
});

const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
Object.assign(win, { location: locationStub, history: historyStub, sessionStorage: sessionStorageStub });

(doc as unknown as { querySelector(selector: string): El | null }).querySelector = (selector: string) => {
  if (selector.startsWith("#")) {
    const id = selector.slice(1);
    return doc.documentElement.elements().find((e) => e.getAttribute("id") === id) ?? null;
  }
  const tag = selector.toUpperCase();
  return doc.documentElement.elements().find((e) => e.tagName === tag) ?? null;
};

let mainEl!: El;
let accountEl!: El;
let messageEl!: El;
let consentEl!: El;
let handoffEl!: El & { host: string; pairing: { code: string; expires_at: string } | null; autoFocus: boolean };

function resetDom(opts: { app?: string; session?: boolean; signedIn?: boolean; account?: string } = {}) {
  doc.body.replaceChildren();
  mainEl = doc.createElement("main");
  mainEl.dataset = {
    app: opts.app ?? "Pulse",
    session: opts.session === false ? "false" : "true",
    signedIn: opts.signedIn === false ? "false" : "true",
    account: opts.account ?? "",
  };
  accountEl = Object.assign(doc.createElement("p"), { id: "account" });
  messageEl = Object.assign(doc.createElement("p"), { id: "message" });
  consentEl = Object.assign(doc.createElement("div"), { id: "consent" });
  handoffEl = Object.assign(doc.createElement("apc-handoff"), { hidden: true, host: "", pairing: null, autoFocus: false });
  mainEl.append(accountEl, messageEl, consentEl, handoffEl);
  doc.body.append(mainEl);
  currentHash = "";
  sessionMap.clear();
  events = [];
  fetchHandler = async () => new Response(null, { status: 500 });
}

resetDom();
// Import once after fake DOM & globals exist; mountDockConnect can then be invoked per test.
const { mountDockConnect } = await import("../src/web/dock-connect.ts");

function runConnectHead(hash: string) {
  currentHash = hash;
  vm.runInNewContext(CONNECT_HEAD, {
    location: locationStub,
    history: historyStub,
    sessionStorage: sessionStorageStub,
    atob,
    Uint8Array,
    TextDecoder,
  });
}

beforeEach(() => {
  resetDom();
});

test("CONNECT_HEAD clears #apc_connect via history.replaceState synchronously into sessionStorage before any fetch (including unpadded base64url)", async () => {
  // Choose ticket length so base64url is unpadded (not divisible by 4).
  const payload = { v: 1 as const, hub: "https://dock.test", agent: "ag_pad", ticket: "a".repeat(32) + "." + "b".repeat(32) };
  const fragment = encodeApcConnect(payload);
  assert.notEqual(fragment.slice(13).length % 4, 0, "exercises unpadded base64url handling");

  runConnectHead(fragment);
  assert.equal(locationStub.hash, "", "fragment cleared immediately");
  assert.deepEqual(events, ["replaceState:/connect/dock", "sessionStorage.removeItem:apc_connect", "sessionStorage.setItem:apc_connect"], "no fetch occurs before fragment removal");
  assert.deepEqual(JSON.parse(sessionMap.get("apc_connect")!), payload);
});

test("dock_connect shows exact expiry message when fragment is missing, invalid, or rejected as expired by the server", async () => {
  // Missing fragment / storage -> no fetches made.
  await mountDockConnect();
  assert.equal(messageEl.textContent, CONNECT_EXPIRED);
  assert.equal(events.some((e) => e.startsWith("fetch:")), false);

  // Server rejects ticket_expired -> exact expiry message & clears sessionStorage.
  resetDom();
  const payload = { v: 1 as const, hub: "https://dock.test", agent: "ag_exp", ticket: "c".repeat(32) + "." + "d".repeat(32) };
  runConnectHead(encodeApcConnect(payload));
  fetchHandler = async (url) => {
    if (url === "/api/session") return Response.json({ sid: "sid_exp", created: false });
    if (url === "/api/s/sid_exp/connect/dock") return Response.json({ ok: false, error: "ticket_expired" }, { status: 400 });
    return new Response(null, { status: 404 });
  };
  await mountDockConnect();
  assert.equal(messageEl.textContent, CONNECT_EXPIRED);
  assert.equal(sessionMap.get("apc_connect"), undefined);
});

test("dock_connect clears fragment before any fetch, shows signed-in sandbox, completes consent and Signals handoff polling", async () => {
  resetDom({ app: "Signals" });
  const payload = { v: 1 as const, hub: "https://dock.test", agent: "ag_sig", ticket: "e".repeat(32) + "." + "f".repeat(32) };
  runConnectHead(encodeApcConnect(payload));

  const pairing = { code: "K7M4P2", expires_at: new Date(Date.now() + 300_000).toISOString() };
  let step = 0;
  fetchHandler = async (url, init) => {
    assert.equal(locationStub.hash, "", `hash is already gone before fetch ${url}`);
    if (url === "/api/session") return Response.json({ sid: "sid_123", created: false });
    if (url === "/api/s/sid_123/connect/dock") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      step++;
      if (step === 1) return Response.json({ ok: false, error: "consent_required", consent: "cn_1" }, { status: 400 });
      assert.equal(body.consent, "cn_1");
      return Response.json({ ok: true, grant_id: "g_sig", status: "pending", pairing });
    }
    return new Response(null, { status: 404 });
  };

  await mountDockConnect();
  assert.equal(events[0], "replaceState:/connect/dock");
  assert.ok(events.indexOf("replaceState:/connect/dock") < events.indexOf("fetch:/api/session"));
  assert.equal(accountEl.textContent, "Your Signals sandbox in this browser");
  assert.doesNotMatch(accountEl.textContent ?? "", /sid_123/, "the sandbox id is a key: never shown");
  const allow = consentEl.elements().find((b) => b.textContent === "Allow") as (El & { onclick?: () => void }) | undefined;
  assert.ok(allow, "Allow button rendered");
  allow.onclick?.();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(handoffEl.hidden, false);
  assert.deepEqual(handoffEl.pairing, pairing);
  assert.equal(sessionMap.get("apc_connect"), undefined, "sessionStorage cleared once submitted");
});

test("dock_connect on Orders keeps sessionStorage intact while signed out so returning after login works", async () => {
  resetDom({ app: "Orders", session: false, signedIn: false, account: "No account signed in." });
  const payload = { v: 1 as const, hub: "https://dock.test", agent: "ag_ord", ticket: "1".repeat(32) + "." + "2".repeat(32) };
  runConnectHead(encodeApcConnect(payload));
  await mountDockConnect();
  assert.equal(accountEl.textContent, "No account signed in.");
  assert.match(messageEl.textContent, /Sign in first/);
  assert.ok(sessionMap.get("apc_connect"), "keeps stored handoff across login");
  assert.equal(events.some((e) => e.startsWith("fetch:")), false);
});
