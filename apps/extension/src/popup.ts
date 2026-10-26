/**
 * The toolbar popup (TIN-421, DESIGN.md 13.3): grant or revoke the current site, the granted sites,
 * the last drop's outcome, and the docks this browser sends readings to. Granting injects the
 * content script into the current tab at once, so the page needs no reload.
 */
import { hubPatterns, sitePattern, STATUS_TEXT, type DropStatus } from "./drop.ts";

const $ = (id: string) => document.getElementById(id)!;

function item(label: string, action: string, onClick: () => void): HTMLLIElement {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = label;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action;
  button.addEventListener("click", onClick);
  li.append(span, button);
  return li;
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = sitePattern(tab?.url);
  const docks = new Set(hubPatterns(__APC_DEV__));
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = origins.filter((o) => !docks.has(o));

  const here = $("here");
  here.replaceChildren();
  if (!site || docks.has(site.pattern)) {
    here.append(Object.assign(document.createElement("p"), { className: "muted", textContent: site ? "This is your dock: drag your agent from here onto other pages." : "Open a web page to let your agent read it." }));
  } else if (granted.includes(site.pattern)) {
    here.append(Object.assign(document.createElement("p"), { textContent: `Your agent may read ${new URL(site.origin).host}. Drag it here from your dock or Float.` }));
  } else {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: `Let your agent read pages on ${new URL(site.origin).host}` });
    button.addEventListener("click", async () => {
      if (!(await chrome.permissions.request({ origins: [site.pattern] }))) return;
      if (typeof tab?.id === "number") await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
      void render();
    });
    here.append(button);
  }

  $("sites").replaceChildren(
    ...(granted.length
      ? granted.map((pattern) => item(pattern.replace(/\/\*$/, "").replace(/^https?:\/\//, ""), "Revoke", () => void chrome.permissions.remove({ origins: [pattern] }).then(render)))
      : [Object.assign(document.createElement("li"), { className: "muted", textContent: "None yet." })]),
  );

  const stored = await chrome.storage.local.get(["last", "readers"]);
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
      : [Object.assign(document.createElement("li"), { className: "muted", textContent: "None yet: the first drop of an agent asks its dock." })]),
  );
}

void render();
