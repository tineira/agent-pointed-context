import { createRoot } from "react-dom/client";
import { Dock } from "./dock.tsx";
import "./dock.css";

createRoot(document.getElementById("root")!).render(<Dock />);
