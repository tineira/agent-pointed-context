import { createRoot } from "react-dom/client";
import { Dock as BridgeDock } from "./bridge.tsx";
import { HubDock } from "./hub.tsx";
import { Landing } from "./landing.tsx";
import "./dock.css";

// /: the APC v2 landing (TIN-420; the Worker sends a visitor who has a dock on to /dock). /dock: the dock
// with its hub (TIN-382). /bridge: the TIN-370 dock, fed by an opener on apc.tineira.com.
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
if (path === "/") document.title = "APC v2: one agent across your apps";
createRoot(document.getElementById("root")!).render(path.startsWith("/bridge") ? <BridgeDock /> : path === "/" ? <Landing /> : <HubDock />);
