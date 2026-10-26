/**
 * The few extension APIs this extension calls, typed by hand (no @types/chrome dependency). Only
 * what is used, as Chrome documents it.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
      id?: string;
    }
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    const onStartup: { addListener(callback: () => void): void };
    const id: string;
  }
  namespace storage {
    const local: {
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
      runAt?: "document_start" | "document_end" | "document_idle";
      allFrames?: boolean;
      persistAcrossSessions?: boolean;
    }
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>;
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }
    function query(q: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
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
