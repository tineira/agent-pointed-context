import { createRoot } from "react-dom/client";
import { Dock as BridgeDock } from "./bridge.tsx";
import { HubDock } from "./hub.tsx";
import "./dock.css";

// /bridge: the TIN-370 dock, fed by an opener on apc.tineira.com. /: the dock with its hub (TIN-382).
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

createRoot(document.getElementById("root")!).render(location.pathname.startsWith("/bridge") ? <BridgeDock /> : <HubDock />);
