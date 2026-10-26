/**
 * The toolbar popup (TIN-421, TIN-465, DESIGN.md 13.3): this site's choice, the one grant for any page,
 * "Never ask", the sites the person chose for, the last drop's outcome, and the docks this browser
 * sends readings to. Asking Chrome for a grant closes the popup; the service worker injects the
 * content script into the open tabs then.
 */
import { openDock } from "./open-dock.ts";
import { ANY_PAGE, grantedAlone, hubPatterns, isSensitive, sitePattern, STATUS_TEXT, type DropStatus, type Mode, type SiteChoice } from "./drop.ts";

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) => Object.assign(document.createElement(tag), props);

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el("button", { type: "button", textContent: label, className: primary ? "primary" : "" });
  b.addEventListener("click", onClick);
  return b;
}

function item(label: string, action: string, onClick: () => void): HTMLLIElement {
  const li = el("li");
  li.append(el("span", { textContent: label }), button(action, onClick));
  return li;
}

const hostOf = (origin: string) => new URL(origin).host;

async function setChoice(origin: string, choice: SiteChoice | null): Promise<void> {
  const sites = ((await chrome.storage.local.get("sites")).sites ?? {}) as Record<string, SiteChoice>;
  if (choice) sites[origin] = choice;
  else delete sites[origin];
  await chrome.storage.local.set({ sites });
  void render();
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = sitePattern(tab?.url);
  const docks = new Set(hubPatterns(__APC_DEV__));
  const { origins = [] } = await chrome.permissions.getAll();
  const anyPage = ANY_PAGE.every((o) => origins.includes(o));
  const alone = origins.filter((o) => !docks.has(o) && !ANY_PAGE.includes(o));
  const stored = await chrome.storage.local.get(["mode", "sites", "last", "readers"]);
  const mode = (stored.mode as Mode | undefined) ?? "ask";
  const sites = (stored.sites ?? {}) as Record<string, SiteChoice>;

  // This site: its choice, or how to let the agent be dropped here.
  const here = $("here");
  here.replaceChildren();
  if (!site || docks.has(site.pattern)) {
    here.append(el("p", { className: "muted", textContent: site ? "This is your dock: drag your agent from here onto other pages." : "Open a web page to drop your agent on it." }));
  } else if (!anyPage && !grantedAlone(site.origin, alone)) {
    here.append(el("p", { textContent: `Your agent cannot be dropped on ${hostOf(site.origin)} yet.` }), el("div", { className: "row" }));
    here.lastElementChild!.append(button(`Allow on ${hostOf(site.origin)}`, () => void chrome.permissions.request({ origins: [site.pattern] }).then(render), true));
  } else {
    // A government, .bank or .insurance domain always asks (TIN-478); any other site asks every time once the person marks it.
    const byDomain = isSensitive(hostOf(site.origin));
    const choice = sites[site.origin] ?? (grantedAlone(site.origin, alone) ? "always" : undefined);
    const asksAlways = byDomain || choice === "sensitive";
    here.append(el("p", { textContent: `On ${hostOf(site.origin)}: ${mode === "never_ask" ? "every drop is sent (Never ask is on)." : choice === "never" ? "drops are not sent." : byDomain ? "a government or regulated domain, so every drop asks." : asksAlways ? "every drop asks." : choice === "always" ? "every drop is sent." : "the first drop asks."}` }));
    const row = el("div", { className: "row" });
    if (!byDomain) row.append(button("Always", () => void setChoice(site.origin, "always"), choice === "always"));
    row.append(button("Ask once", () => void setChoice(site.origin, null), !choice && !byDomain));
    if (!byDomain) row.append(button("Always ask", () => void setChoice(site.origin, "sensitive"), choice === "sensitive"));
    row.append(button("Not here", () => void setChoice(site.origin, "never"), choice === "never"));
    if (mode !== "never_ask") here.append(row);
  }

  // The one grant for any page.
  const any = $("any");
  any.replaceChildren(el("h2", { textContent: "Any page" }));
  if (anyPage) {
    any.append(el("p", { textContent: "Your agent can be dropped on any page." }), el("div", { className: "row" }));
    any.lastElementChild!.append(button("Turn off", () => void chrome.permissions.remove({ origins: ANY_PAGE }).then(render)));
  } else {
    any.append(el("p", { className: "muted", textContent: "Let any page take your agent, instead of allowing sites one by one. Each new site still asks on the first drop." }), el("div", { className: "row" }));
    any.lastElementChild!.append(button("Let me drop my agent on any page", () => void chrome.permissions.request({ origins: ANY_PAGE }).then(render), true));
  }

  const neverAsk = $("never-ask") as HTMLInputElement;
  neverAsk.checked = mode === "never_ask";
  neverAsk.onchange = () => void chrome.storage.local.set({ mode: neverAsk.checked ? "never_ask" : "ask" }).then(render);

  const rows = [
    ...Object.entries(sites).map(([origin, c]) => item(`${hostOf(origin)} · ${c === "always" ? "always" : c === "sensitive" ? "always ask" : "not here"}`, "Remove", () => void setChoice(origin, null))),
    ...alone.filter((p) => !(p.replace(/\/\*$/, "") in sites)).map((p) => item(`${p.replace(/\/\*$/, "").replace(/^https?:\/\//, "")} · allowed by itself`, "Revoke", () => void chrome.permissions.remove({ origins: [p] }).then(render))),
  ];
  $("sites").replaceChildren(...(rows.length ? rows : [el("li", { className: "muted", textContent: "None yet: your choices on the first drop show here." })]));

  const last = stored.last as { at: string; site: string; status: DropStatus } | undefined;
  $("last").textContent = last ? `${last.site}, ${new Date(last.at).toLocaleTimeString()}: ${STATUS_TEXT[last.status] ?? last.status}` : "None yet.";
  const readers = (stored.readers ?? {}) as Record<string, string>;
  const keys = Object.keys(readers);
  $("docks").replaceChildren(
    ...(keys.length
      ? keys.map((key) => {
          const [hub, agent] = key.split(" ");
          return item(`${new URL(hub!).host} · ${agent}`, "Forget", async () => {
            delete readers[key];
            await chrome.storage.local.set({ readers });
            void render();
          });
        })
      : [el("li", { className: "muted", textContent: "None yet: the first drop of an agent asks its dock." })]),
  );
}

$("open-dock").addEventListener("click", () => void openDock(false).then(() => close()));
$("float").addEventListener("click", () => void openDock(true).then(() => close()));

void render();
