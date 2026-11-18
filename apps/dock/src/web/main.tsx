import { createRoot } from "react-dom/client";
import { HubDock } from "./hub.tsx";
import { ExtensionInstall } from "./extension.tsx";
import { keepDockCurrent } from "./sw-reload.ts";
import "./dock.css";

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
const extension = path === "/extension" || path === "/extension/";
if (extension) document.title = "Add the APC browser extension";
createRoot(document.getElementById("root")!).render(extension ? <ExtensionInstall /> : <HubDock />);
