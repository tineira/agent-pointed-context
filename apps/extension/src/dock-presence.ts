// Runs only on known dock pages, with the host access the extension already has.
// No messages, page readings, storage, identifiers or capabilities: only that the extension is here, and its
// version (so the dock can say when it is out of date).
import { markDockPresence } from "./presence.ts";

markDockPresence(document.documentElement, chrome.runtime.getManifest().version);
