/**
 * The toolbar popup (TIN-421, TIN-465, TIN-786, DESIGN.md 13.3 and 13.6): three views behind tabs. This page (the site's
 * choice, the last drop, Open dock and Float), Activity (the readings this browser sent) and Settings (Every site, Your
 * sites, Never ask, the numbers, the paired agents). What to draw and what a click writes are the pure functions of
 * popup-state.ts; this file reads storage and Chrome and carries a click's plan out. Every write is a click's, never a
 * render's. Asking Chrome for a grant closes the popup; the service worker injects the content script into the open
 * tabs then.
 */
import { agoLabel, sizeLabel, type ReadingRow } from "../../dock/src/worker/reading.ts";
import { openDock } from "./open-dock.ts";
import { ANY_PAGE, devHubHosts, framesOutside, grantedAlone, grantedByPerson, hubAllowed, isDockPage, ownPatterns, SITE_LABELS, sensitiveMode, siteGrant, sitePattern, type Mode, type SiteChoice } from "./drop.ts";
import { agentName, agentRow, lastView, pillOf, rowRemove, rowsOf, rowWrite, siteClick, siteView, type Option, type Choice, type Plan, type Row, type SiteClick, type SiteState } from "./popup-state.ts";

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);
/** The most readings the popup lists; the dock's agent page has them all. */
const READINGS_SHOWN = 20;

function button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", { type: "button", textContent: label, className: cls });
  b.addEventListener("click", onClick);
  return b;
}
const btn = (label: string, onClick: () => void, primary = false, extra = "") => button(label, onClick, `btn ${primary ? "primary" : ""} ${extra}`.trim());
const link = (label: string, onClick: () => void) => button(label, onClick, "link");

/**
 * Dev builds only: the layout check of the e2e opens popup.html with `?tab=<url>` (and `?outside=<host>`) to draw a state
 * the popup tab itself cannot be in. Such a popup is read-only: no click writes or asks for anything, so a spoofed address
 * never reaches siteGrant or a permission request. The published build has none of this (the condition is a constant).
 */
let layoutOnly = false;
let layoutOutside: string | null = null;

async function currentTab(): Promise<{ url?: string; id?: number }> {
  if (__APC_DEV__) {
    const params = new URLSearchParams(location.search);
    const url = params.get("tab");
    if (url) {
      layoutOnly = true;
      layoutOutside = params.get("outside");
      return { url };
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { url: tab?.url, id: tab?.id };
}

interface Snapshot {
  origins: string[];
  /** Every granted pattern but the any-page ones and a dev dock's. */
  alone: string[];
  /** What the person granted by themself: not the extension's own patterns (its manifest), which Chrome lists but never lets go. */
  own: string[];
  required: string[];
  anyPage: boolean;
  mode: Mode;
  sites: Record<string, unknown>;
  readers: Record<string, string>;
  names: Record<string, unknown>;
  sensitive: ReturnType<typeof sensitiveMode>;
  last: unknown;
}

async function snapshot(): Promise<Snapshot> {
  const { origins = [] } = await chrome.permissions.getAll();
  const docks = new Set(devHubHosts(__APC_DEV__));
  const alone = origins.filter((o) => !docks.has(o) && !ANY_PAGE.includes(o));
  const required = ownPatterns(chrome.runtime.getManifest());
  const stored = await chrome.storage.local.get(["mode", "sites", "last", "readers", "readerNames", "sensitive"]);
  return {
    origins,
    alone,
    own: grantedByPerson(alone, required),
    required,
    anyPage: ANY_PAGE.every((o) => origins.includes(o)),
    mode: stored.mode === "never_ask" ? "never_ask" : "ask",
    sites: (stored.sites ?? {}) as Record<string, unknown>,
    readers: (stored.readers ?? {}) as Record<string, string>,
    names: (stored.readerNames ?? {}) as Record<string, unknown>,
    sensitive: sensitiveMode(stored.sensitive),
    last: stored.last,
  };
}

const choiceOf = (v: unknown): SiteChoice | undefined => (v === "always" || v === "never" || v === "sensitive" ? v : undefined);

function siteState(site: { origin: string }, snap: Snapshot): SiteState {
  return { origin: site.origin, host: new URL(site.origin).host, stored: choiceOf(snap.sites[site.origin]), mode: snap.mode, anyPage: snap.anyPage, own: snap.alone, required: snap.required };
}

/** Ask Chrome for a grant. Called first in the click's handler, with arguments made at render: Chrome wants the gesture. */
function request(origins: string[]): void {
  if (layoutOnly) return;
  void chrome.permissions.request({ origins }).catch(() => false).then(() => render());
}

/** Set, delete or leave one site's stored choice from a fresh read, then remove the one grant a plan names. */
async function apply(origin: string, plan: Plan): Promise<void> {
  if (plan.write !== undefined) {
    const sites = ((await chrome.storage.local.get("sites")).sites ?? {}) as Record<string, unknown>;
    if (plan.write === null) delete sites[origin];
    else sites[origin] = plan.write;
    await chrome.storage.local.set({ sites });
  }
  if (plan.revoke) await chrome.permissions.remove({ origins: [plan.revoke] }).catch(() => false);
}

let tabSite: { origin: string } | null = null;

/** A click on this tab's site control: the plan comes from the state now, not the one drawn. */
async function act(click: SiteClick): Promise<void> {
  if (layoutOnly || !tabSite) return;
  try {
    const plan = siteClick(siteState(tabSite, await snapshot()), click);
    if (plan) await apply(tabSite.origin, plan);
  } catch {
    // Nothing was claimed: the view below is drawn again from what is stored.
  }
  void render();
}

async function setSites(change: (sites: Record<string, unknown>) => void): Promise<void> {
  const sites = ((await chrome.storage.local.get("sites")).sites ?? {}) as Record<string, unknown>;
  change(sites);
  await chrome.storage.local.set({ sites });
}

/**
 * The dock's answer for one reader token, or null when it did not answer or no longer knows the token. A network
 * error or a 5xx is tried once more, as the service worker's send is (TIN-583): listing and Clear can both be repeated,
 * and one failed call would otherwise say "Couldn't reach your dock" right after a Clear that went through.
 */
async function logCall(key: string, token: string, path: string): Promise<{ agent?: string; readings?: ReadingRow[] } | null> {
  const hub = key.split(" ")[0]!;
  if (!hubAllowed(hub, __APC_DEV__)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${hub}/apc/reading/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
      if (r.status >= 500) continue;
      return r.ok ? ((await r.json()) as { agent?: string; readings?: ReadingRow[] }) : null;
    } catch {
      // network: try again
    }
  }
  return null;
}

/** Keep the agents' names the dock told, beside their tokens (`readerNames`, no secret), so the header needs no network. */
async function rememberNames(found: Array<[string, unknown]>): Promise<void> {
  const names = ((await chrome.storage.local.get("readerNames")).readerNames ?? {}) as Record<string, string>;
  let changed = false;
  for (const [key, raw] of found) {
    const name = agentName(raw);
    if (name && names[key] !== name) {
      names[key] = name;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ readerNames: names });
}

/** Ask the dock once per popup for the name of each paired agent whose name is not kept yet. */
const asked = new Set<string>();
async function learnNames(snap: Snapshot): Promise<void> {
  if (layoutOnly) return;
  const missing = Object.entries(snap.readers).filter(([key]) => !agentName(snap.names[key]) && !asked.has(key));
  for (const [key] of missing) asked.add(key);
  const logs = await Promise.all(missing.map(([key, token]) => logCall(key, token, "log")));
  await rememberNames(missing.map(([key], i) => [key, logs[i]?.agent] as [string, unknown]));
}

// --- This page ---

function seg(options: Option[], onPick: (v: Choice) => void, label: string): HTMLElement {
  const group = el("div", { className: "seg" });
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const o of options) {
    const b = el("button", { type: "button", textContent: SITE_LABELS[o.value], disabled: o.disabled });
    b.setAttribute("aria-pressed", String(o.selected));
    b.addEventListener("click", () => onPick(o.value));
    group.append(b);
  }
  return group;
}

const hostOf = (origin: string) => new URL(origin).host;

function lastBlock(snap: Snapshot): HTMLElement | null {
  const v = lastView(snap.last, Date.now(), { readers: snap.readers, names: snap.names });
  if (!v) return null;
  const box = el("div", { className: `last ${v.kind === "waiting" ? "wait" : v.kind === "failed" ? "bad" : ""}`.trim() });
  if (v.kind === "waiting") {
    box.append(el("div", { className: "l1" }), el("div", { className: "row" }));
    box.firstElementChild!.append(el("span", { textContent: v.text }));
    const open = btn("Open dock", () => void openDock(false, v.hub ?? undefined).then(() => close()), true);
    open.dataset.openDock = "";
    box.lastElementChild!.append(open);
  } else {
    const l1 = el("div", { className: "l1" });
    l1.append(el("span", { textContent: v.lead }), el("span", { textContent: agoLabel(v.at, Date.now()) }));
    box.append(l1, el("div", { className: v.kind === "failed" ? "sm" : "muted sm", textContent: v.kind === "failed" ? v.reason : v.detail }));
  }
  const wrap = el("div", { className: "blk" });
  wrap.append(el("h5", { textContent: "Last drop" }), box);
  return wrap;
}

/** What the tab shows under the header: the three steps unpaired, else the site and the last drop. */
async function pageView(snap: Snapshot, tab: { url?: string; id?: number }): Promise<{ here: Node[]; last: Node | null; primaryDock: boolean }> {
  const site = sitePattern(tab.url);
  const dockPage = isDockPage(tab.url, __APC_DEV__);
  const web = site && !dockPage ? site : null;
  tabSite = web;
  // The tab's frames (TIN-752): allowing a site asks for the origins of its frames in the same prompt.
  let frames: Array<{ url?: string; frameId?: number }> = [];
  if (!layoutOnly && typeof tab.id === "number") frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) ?? [];
  const outside = layoutOnly ? (layoutOutside ? [`https://${layoutOutside}`] : []) : web ? framesOutside(frames, snap.origins, __APC_DEV__).filter((o) => o !== web.origin) : [];
  // The arguments of every request are made here, so a click asks at once.
  const grant = web ? siteGrant(web, frames, snap.origins, __APC_DEV__) : [];
  const nodes: Node[] = [];

  if (!Object.keys(snap.readers).length) {
    const granted = web && grantedAlone(web.origin, snap.alone);
    const done = snap.anyPage ? "Allowed on every site" : granted && web ? `Allowed on ${hostOf(web.origin)}` : null;
    const steps = el("ol", { className: "steps" });
    const one = el("li", { className: done ? "done" : "" });
    const box = el("div");
    if (done) box.append(el("span", { textContent: done }));
    else {
      box.append(btn("Allow on every site", () => request(ANY_PAGE), true));
      if (web) box.append(link("or only this site", () => request(grant)));
    }
    one.append(box);
    const two = el("li");
    const dock = btn("Open dock", () => void openDock(false).then(() => close()), !!done);
    dock.id = "open-dock";
    dock.title = "Alt+Shift+A";
    const twoBox = el("div");
    twoBox.append(dock);
    two.append(twoBox);
    const three = el("li");
    const threeBox = el("div");
    threeBox.append(el("span", { textContent: "Drag your agent onto a page" }));
    three.append(threeBox);
    steps.append(one, two, three);
    return { here: [steps], last: null, primaryDock: false };
  }

  if (!web) {
    nodes.push(el("p", { className: "muted", textContent: dockPage ? "Drag your agent from here onto another page." : "Open a web page to drop your agent." }));
    return { here: nodes, last: lastBlock(snap), primaryDock: !dockPage };
  }

  const host = hostOf(web.origin);
  const state = siteState(web, snap);
  const view = siteView(state);
  nodes.push(el("div", { className: "host", textContent: host }));
  if (view.kind === "allow") {
    const allow = btn(`Allow on this site`, () => request(grant), true, "block");
    const row = el("div", { className: "row" });
    row.append(link("or on every site", () => request(ANY_PAGE)));
    nodes.push(allow, row);
  } else if (view.kind === "never-ask") {
    const state = el("div", { className: "warn", textContent: "Never ask is on" });
    const row = el("div", { className: "row" });
    row.append(
      link("Settings", () => select("settings")),
      link("Never send here", () => void act("never")),
    );
    nodes.push(state, row);
  } else if (view.kind === "domain") {
    nodes.push(el("span", { className: "muted sm", textContent: view.label }), seg(view.options, (v) => void act(v === "never" ? "never" : "ask"), "This site"));
  } else {
    nodes.push(seg(view.options, (v) => void act(v === "ask" ? "ask" : v === "always" ? "always" : "never"), "This site"));
    const tick = el("input", { type: "checkbox", checked: view.tick.checked, disabled: view.tick.disabled });
    tick.addEventListener("change", () => void act(tick.checked ? "tick-on" : "tick-off"));
    const label = el("label", { className: "chk sm" });
    label.append(tick, el("span", { textContent: SITE_LABELS.sensitiveSite }));
    nodes.push(label);
  }
  // A frame from an origin not allowed yet (TIN-752): the extension cannot see a drop there. Each asks for its own origin.
  if (view.kind !== "allow") {
    for (const o of outside) {
      const row = el("div", { className: "row" });
      row.append(btn(`Allow ${hostOf(o)}`, () => request([`${o}/*`]), true));
      nodes.push(row);
    }
  }
  return { here: nodes, last: lastBlock(snap), primaryDock: false };
}

// --- Settings ---

function rowItem(row: Row): HTMLLIElement {
  const li = el("li");
  li.append(el("span", { className: "a", textContent: row.label }));
  const c = el("span", { className: "c" });
  const select = el("select", { disabled: !row.origin });
  select.setAttribute("aria-label", `Choice for ${row.label}`);
  for (const value of ["always", "sensitive", "never"] as const) {
    const o = el("option", { value, textContent: SITE_LABELS[value], selected: row.value === value, disabled: value === "always" && row.alwaysDisabled });
    select.append(o);
  }
  select.addEventListener("change", () => {
    const w = rowWrite(row, select.value as SiteChoice);
    if (layoutOnly || !w) return;
    void setSites((sites) => {
      sites[w.origin] = w.value;
    }).then(() => render());
  });
  const x = el("button", { type: "button", className: "x", textContent: "×", title: row.tip, disabled: !row.removable });
  x.setAttribute("aria-label", `${row.tip === "Remove" ? "Remove" : "Back to Ask first"}: ${row.label}`);
  x.addEventListener("click", () => {
    const { deleteKey, revoke } = rowRemove(row);
    if (layoutOnly) return;
    // The key first, then the one grant: a close between the two leaves a state the next open shows and can finish.
    void (async () => {
      try {
        if (deleteKey) await setSites((sites) => void delete sites[deleteKey]);
        if (revoke) await chrome.permissions.remove({ origins: [revoke] }).catch(() => false);
      } catch {
        // drawn again from what is stored
      }
      void render();
    })();
  });
  c.append(select, x);
  li.append(c);
  return li;
}

function drawSettings(snap: Snapshot): void {
  const any = $("any-page") as HTMLInputElement;
  any.checked = snap.anyPage;
  any.onchange = () => {
    if (layoutOnly) return;
    if (any.checked) request(ANY_PAGE);
    else void chrome.permissions.remove({ origins: ANY_PAGE }).catch(() => false).then(() => render());
  };
  const rows = rowsOf(snap.sites, snap.own, snap.anyPage);
  $("sites-fold").hidden = rows.length === 0;
  $("sites-summary").textContent = `Your sites · ${rows.length}`;
  $("sites").replaceChildren(...rows.map(rowItem));

  const neverAsk = $("never-ask") as HTMLInputElement;
  neverAsk.checked = snap.mode === "never_ask";
  neverAsk.onchange = () => {
    if (!layoutOnly) void chrome.storage.local.set({ mode: neverAsk.checked ? "never_ask" : "ask" }).then(() => render());
  };

  // Card, account and id numbers, one choice for every site (TIN-619): the service worker reads it at each drop.
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="sensitive"]')) {
    r.checked = r.value === snap.sensitive;
    r.onchange = () => {
      if (!layoutOnly) void chrome.storage.local.set({ sensitive: sensitiveMode(r.value) });
    };
  }

  const keys = Object.keys(snap.readers);
  $("agents-block").hidden = keys.length === 0;
  $("agents").replaceChildren(
    ...keys.map((key) => {
      const a = agentRow(key, snap.names);
      const li = el("li");
      li.append(el("span", { className: "a", textContent: a.name }), el("span", { className: "b", textContent: a.hub }));
      const c = el("span", { className: "c" });
      c.append(
        btn("Unpair", () => {
          if (layoutOnly) return;
          void (async () => {
            const stored = await chrome.storage.local.get(["readers", "readerNames"]);
            const readers = (stored.readers ?? {}) as Record<string, string>;
            const names = (stored.readerNames ?? {}) as Record<string, string>;
            delete readers[key];
            delete names[key];
            await chrome.storage.local.set({ readers, readerNames: names });
            void render();
          })();
        }),
      );
      li.append(c);
      return li;
    }),
  );
}

// --- Activity ---

async function renderReadings(): Promise<void> {
  const readers = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const tokens = Object.entries(readers);
  const list = $("readings");
  const clear = $("clear-readings") as HTMLButtonElement;
  const retry = $("retry-readings") as HTMLButtonElement;
  const say = (text: string) => list.replaceChildren(el("li", { className: "solo muted", textContent: text }));
  clear.hidden = true;
  retry.hidden = true;
  if (!tokens.length) return say("Nothing sent yet.");
  const logs = await Promise.all(tokens.map(([key, token]) => logCall(key, token, "log")));
  void rememberNames(tokens.map(([key], i) => [key, logs[i]?.agent] as [string, unknown]));
  const rows = logs.flatMap((log) => (log?.readings ?? []).map((r) => ({ ...r, agent: agentName(log?.agent) ?? "your agent" }))).sort((a, b) => b.at.localeCompare(a.at));
  if (!rows.length) {
    if (logs.every((l) => !l)) {
      say("Couldn't reach your dock.");
      retry.hidden = false;
      retry.onclick = () => void renderReadings();
    } else say("Nothing sent yet.");
    return;
  }
  const now = Date.now();
  list.replaceChildren(
    ...rows.slice(0, READINGS_SHOWN).map((r) => {
      const li = el("li", { title: `${sizeLabel(r.bytes)} · ${new Date(r.at).toLocaleString()}` });
      li.append(el("span", { className: "a", textContent: r.site }), el("span", { className: "b", textContent: `${r.agent} · ${agoLabel(r.at, now)}` }));
      if (r.kept) li.append(el("span", { className: "c live", textContent: "● at your dock" }));
      return li;
    }),
  );
  clear.hidden = false;
  clear.onclick = () => void Promise.all(tokens.map(([key, token]) => logCall(key, token, "log/clear"))).then(renderReadings);
}

// --- The frame ---

type View = "page" | "activity" | "settings";
let current: View = "page";
let paired = false;

function select(view: View): void {
  current = view;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  for (const v of ["page", "activity", "settings"]) $(`view-${v}`).hidden = v !== view;
  $("foot").hidden = !paired || view === "settings";
  if (view === "activity") void renderReadings();
}

let seq = 0;
async function render(): Promise<void> {
  const mine = ++seq;
  const [snap, tab] = await Promise.all([snapshot(), currentTab()]);
  const page = await pageView(snap, tab);
  if (mine !== seq) return;
  paired = Object.keys(snap.readers).length > 0;

  const pill = pillOf(snap.readers, snap.names, snap.last);
  $("pill").className = `pill${pill.on ? " on" : ""}`;
  $("pill").firstElementChild!.textContent = pill.text;

  $("here").replaceChildren(...page.here);
  const last = $("last");
  last.replaceChildren(...(page.last ? [page.last] : []));

  const foot = $("foot");
  foot.replaceChildren();
  if (paired) {
    const open = btn("Open dock", () => void openDock(false).then(() => close()), page.primaryDock);
    open.id = "open-dock";
    open.title = "Alt+Shift+A";
    const float = btn("Float", () => void openDock(true).then(() => close()));
    float.id = "float";
    float.title = "Alt+Shift+F";
    foot.append(open, float);
  }
  $("foot").hidden = !paired || current === "settings";
  drawSettings(snap);
  void learnNames(snap);
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.addEventListener("click", () => select(b.dataset.view as View));
$("shortcuts").addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// Which build this is: the version and the commit it was built from (build.mjs writes both into the manifest).
{
  const manifest = chrome.runtime.getManifest();
  $("version").textContent = manifest.version_name ?? manifest.version;
}

// A change made elsewhere (the dock's Allow, a drop's outcome, the card's answer) shows without reopening.
const WATCHED = ["mode", "sites", "sensitive", "readers", "readerNames", "last"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !WATCHED.some((k) => k in changes)) return;
  void render();
  if (current === "activity" && "readers" in changes) void renderReadings();
});

void render();
