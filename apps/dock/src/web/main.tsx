import { createRoot } from "react-dom/client";
import { Dock as BridgeDock } from "./bridge.tsx";
import { HubDock } from "./hub.tsx";
import "./dock.css";

// /bridge: the TIN-370 dock, fed by an opener on apc.tineira.com. /: the dock with its hub (TIN-382).
createRoot(document.getElementById("root")!).render(location.pathname.startsWith("/bridge") ? <BridgeDock /> : <HubDock />);
