// Runs only on known dock pages, with the host access the extension already has.
// No messages, page readings, storage, identifiers or capabilities.
import { markDockPresence } from "./presence.ts";

markDockPresence(document.documentElement);
