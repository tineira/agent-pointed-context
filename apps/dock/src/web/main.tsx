import { createRoot } from "react-dom/client";
import { HubDock } from "./hub.tsx";
import { Landing } from "./landing.tsx";
import { ExtensionInstall } from "./extension.tsx";
import { Docs } from "./docs.tsx";
import { isDocsPath } from "../docs/pages.ts";
import { keepDockCurrent } from "./sw-reload.ts";
import "./dock.css";

// /: the landing of the APC standard (TIN-420; always, even for a visitor who has a dock: it offers "Open your dock", TIN-610). /dock: the dock
// with its hub (TIN-382).
// Installable (TIN-392): the service worker, and a compact window the first time the installed app opens.
// A page asks for a new service worker whenever it comes back into view, and a dock page reloads itself once a
// new one takes over, so it runs the new deploy's code (TIN-609, sw-reload.ts).
if ("serviceWorker" in navigator) {
  let storage: Storage | null = null;
  try {
    storage = sessionStorage;
  } catch {
    // storage refused: one reload per page still holds
  }
  keepDockCurrent({
    path: location.pathname,
    sw: navigator.serviceWorker,
    onVisible: (listener) => document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && listener()),
    reload: () => location.reload(),
    storage,
  });
}
if (matchMedia("(display-mode: standalone)").matches) {
  try {
    if (!localStorage.getItem("apc-dock-sized")) {
      window.resizeTo(380, 720);
      localStorage.setItem("apc-dock-sized", "1");
    }
  } catch {
    // storage or resizing refused: the window keeps its size
  }
}

const path = location.pathname;
if (path === "/") document.title = "Agent Pointed Context: one agent across your apps";
if (path === "/extension" || path === "/extension/") document.title = "Add the APC browser extension";
// /docs: the standard's docs (TIN-611); each page sets its own title.
createRoot(document.getElementById("root")!).render(
  path === "/extension" || path === "/extension/" ? <ExtensionInstall /> : path === "/" ? <Landing /> : isDocsPath(path) ? <Docs path={path} /> : <HubDock />,
);
