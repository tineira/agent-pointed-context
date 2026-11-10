/**
 * The few extension APIs this extension calls, typed by hand (no @types/chrome dependency). Only
 * what is used, as Chrome documents it.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
      id?: string;
      /** The frame that sent the message: 0 is the tab's top frame. */
      frameId?: number;
      /** The sending frame's address. */
      url?: string;
    }
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(callback: (details: { reason: "install" | "update" | "chrome_update" | "shared_module_update" }) => void): void };
    function getURL(path: string): string;
    /** A frame element's (or window's) frameId in its tab, -1 when unknown (Chrome 106+, content scripts). */
    function getFrameId(target: Element | Window): number;
    function getManifest(): { version: string; version_name?: string; name: string; host_permissions?: string[]; content_scripts?: Array<{ matches?: string[] }> };
    const onStartup: { addListener(callback: () => void): void };
    const id: string;
  }
  namespace storage {
    const onChanged: { addListener(callback: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void): void };
    const local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    /** In memory only, for the browser session: never written to disk. */
    const session: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }
  namespace permissions {
    interface Permissions {
      origins?: string[];
      permissions?: string[];
    }
    function getAll(): Promise<Permissions>;
    function contains(p: Permissions): Promise<boolean>;
    function request(p: Permissions): Promise<boolean>;
    function remove(p: Permissions): Promise<boolean>;
    const onAdded: { addListener(callback: (p: Permissions) => void): void };
    const onRemoved: { addListener(callback: (p: Permissions) => void): void };
  }
  namespace scripting {
    interface RegisteredContentScript {
      id: string;
      js?: string[];
      matches?: string[];
      excludeMatches?: string[];
      runAt?: "document_start" | "document_end" | "document_idle";
      allFrames?: boolean;
      /** Also into about:blank, about:srcdoc, blob: and data: frames, by the origin that made them. */
      matchOriginAsFallback?: boolean;
      persistAcrossSessions?: boolean;
    }
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>;
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function executeScript(injection: { target: { tabId: number; allFrames?: boolean }; files: string[] }): Promise<unknown[]>;
  }
  namespace webNavigation {
    interface Frame {
      frameId: number;
      parentFrameId: number;
      url: string;
    }
    function getAllFrames(details: { tabId: number }): Promise<Frame[] | null>;
  }
  namespace windows {
    function create(props: { url: string; type?: "normal" | "popup"; width?: number; height?: number; focused?: boolean }): Promise<{ id?: number }>;
    function update(windowId: number, props: { focused?: boolean }): Promise<{ id?: number }>;
  }
  namespace commands {
    const onCommand: { addListener(callback: (command: string) => void): void };
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      windowId?: number;
    }
    function query(q: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Tab[]>;
    function update(tabId: number, props: { active?: boolean; url?: string }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    function create(props: { url: string }): Promise<Tab>;
  }
}

/** navigator.userAgentData, which Chromium has and the DOM lib does not declare yet. */
interface Navigator {
  readonly userAgentData?: { brands: Array<{ brand: string; version: string }>; platform: string };
}
interface WorkerNavigator {
  readonly userAgentData?: { brands: Array<{ brand: string; version: string }>; platform: string };
}

/** True in a dev build (node build.mjs --dev): local docks are allowed. */
declare const __APC_DEV__: boolean;
