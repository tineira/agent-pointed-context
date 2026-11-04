import { createRoot } from "react-dom/client";
import { HubDock } from "./hub.tsx";
import { Landing } from "./landing.tsx";
import { ExtensionInstall } from "./extension.tsx";
import "./dock.css";

// /: the landing of the APC standard (TIN-420; always, even for a visitor who has a dock: it offers "Open your dock", TIN-610). /dock: the dock
// with its hub (TIN-382).
// Installable (TIN-392): the service worker, and a compact window the first time the installed app opens.
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
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
createRoot(document.getElementById("root")!).render(path === "/extension" || path === "/extension/" ? <ExtensionInstall /> : path === "/" ? <Landing /> : <HubDock />);
