/**
 * The Direct profile's page part (APC 0.4, TIN-578): the list where the person makes and names the
 * agents that connect to this app directly, each with its own MCP URL, and the connect instructions
 * (the URL, and a prompt to paste to the agent). Revoke is the agent bar's (core). The server side is
 * in @apc/server (direct.ts).
 *
 * A custom element in light DOM, like `<apc-agents>`: the app's fonts apply, styles are injected once,
 * scoped by class prefix and themed through --apc-* custom properties. Set `agents` and `appName`;
 * listen for `apc-add` (make an agent) and `apc-rename` (detail { id, name }).
 */

export interface DirectAgent {
  /** The app's id for the agent's grant. */
  id: string;
  name: string;
  /** Its MCP URL: the secret in it is the grant. */
  url: string;
  /** It has connected (sent initialize). */
  connected: boolean;
  /** The MCP client it connected with, e.g. "claude-code". */
  client?: string | null;
  /** It is also reached through a dock, shown as one agent (apc_link). */
  linked?: boolean;
}

export type DirectAgentsEvent = "apc-add" | "apc-rename";

/**
 * What a person pastes to their own agent to connect it. Many agents can add a server themselves when
 * asked in the chat, so it asks for that first, under a name the person will recognise, and for the
 * steps only if the agent cannot.
 */
export function connectPrompt(url: string, appName: string): string {
  return `Please connect this remote MCP server, named "${appName}". URL: ${url}. It uses Streamable HTTP and needs no OAuth or API key: the access is in the URL. If you can add it yourself, do it now and tell me when it's connected. If you can't, tell me the exact steps to add it in the app I'm using you in right now. Do not open the URL in a browser.`;
}

/** The words of one agent's line. Pure, so it is tested. */
export function directAgentStatus(a: DirectAgent): string {
  if (!a.connected) return "not connected yet";
  const as = a.client ? `connected as ${a.client}` : "connected";
  return a.linked ? `${as}, also through your dock` : as;
}

const STYLE_ID = "apc-direct-style";
const CSS = `
apc-direct-agents { display: flex; flex-direction: column; gap: 10px; color: var(--apc-ink, inherit); }
.apc-direct__agent { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--apc-line, #d6dce5); border-radius: 10px; }
.apc-direct__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.apc-direct__name { font-weight: 600; }
.apc-direct__status { color: var(--apc-muted, #5b6575); font-size: 0.9em; }
.apc-direct__link { border: 0; background: none; padding: 0; font: inherit; font-size: 0.9em; color: var(--apc-accent, #b85209); cursor: pointer; }
.apc-direct__link:hover { text-decoration: underline; }
.apc-direct__body { display: flex; flex-direction: column; gap: 6px; }
.apc-direct__hint { margin: 0; color: var(--apc-muted, #5b6575); font-size: 0.85em; }
.apc-direct__copy { display: flex; min-width: 0; align-items: stretch; border: 1px solid var(--apc-line, #d6dce5); border-radius: 8px; overflow: hidden; }
.apc-direct__copy code { flex: 1; min-width: 0; padding: 6px 8px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.apc-direct__copy button { flex: none; border: 0; border-left: 1px solid var(--apc-line, #d6dce5); background: none; padding: 0 10px; font: inherit; font-size: 0.85em; font-weight: 600; color: var(--apc-accent, #b85209); cursor: pointer; }
.apc-direct__rename { display: flex; flex-wrap: wrap; gap: 6px; }
.apc-direct__rename input { flex: 1; min-width: 8em; padding: 4px 8px; border: 1px solid var(--apc-line, #d6dce5); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
.apc-direct__rename button, .apc-direct__add { padding: 5px 12px; border: 1px solid var(--apc-line, #d6dce5); border-radius: 8px; background: var(--apc-chip, transparent); color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.apc-direct__add { align-self: flex-start; }
.apc-direct__add:hover, .apc-direct__rename button:hover { border-color: var(--apc-accent, #b85209); }
`;

function copyField(text: string, label: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "apc-direct__copy";
  const code = document.createElement("code");
  code.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = label), 1500);
      },
      () => undefined,
    );
  });
  box.append(code, button);
  return box;
}

/** Defines `<apc-direct-agents>` where custom elements exist (a browser), so importing this module in Node is safe. */
export function defineDirectAgents(tag = "apc-direct-agents"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class ApcDirectAgents extends HTMLElement {
    private list: DirectAgent[] = [];
    private name = "this app";
    /** Agents whose connection is unfolded; an agent not connected yet is unfolded until it connects. */
    private open = new Set<string>();
    private shut = new Set<string>();
    private editing: string | null = null;
    private draft = "";

    get agents(): DirectAgent[] {
      return this.list;
    }
    set agents(next: DirectAgent[]) {
      this.list = next;
      this.render();
    }
    get appName(): string {
      return this.name;
    }
    set appName(next: string) {
      this.name = next;
      this.render();
    }

    connectedCallback(): void {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
      }
      this.render();
    }

    private emit(type: DirectAgentsEvent, detail: Record<string, unknown> = {}): void {
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
    }

    private isOpen(a: DirectAgent): boolean {
      return this.open.has(a.id) || (!a.connected && !this.shut.has(a.id));
    }

    private render(): void {
      if (!this.isConnected) return;
      const rows = this.list.map((a) => {
        const row = document.createElement("div");
        row.className = "apc-direct__agent";
        const head = document.createElement("div");
        head.className = "apc-direct__head";
        if (this.editing === a.id) {
          const form = document.createElement("form");
          form.className = "apc-direct__rename";
          // The app re-renders on every update: what the person typed is kept in draft.
          const input = document.createElement("input");
          input.value = this.draft;
          input.addEventListener("input", () => (this.draft = input.value));
          input.maxLength = 40;
          input.setAttribute("aria-label", "Agent name");
          input.placeholder = "Empty: back to its own name";
          const save = document.createElement("button");
          save.type = "submit";
          save.textContent = "Save";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.textContent = "Cancel";
          cancel.addEventListener("click", () => {
            this.editing = null;
            this.render();
          });
          input.addEventListener("keydown", (e) => e.key === "Escape" && cancel.click());
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            this.editing = null;
            this.emit("apc-rename", { id: a.id, name: this.draft });
            this.render();
          });
          form.append(input, save, cancel);
          head.append(form);
          queueMicrotask(() => {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          });
        } else {
          const name = document.createElement("span");
          name.className = "apc-direct__name";
          name.textContent = a.name;
          const status = document.createElement("span");
          status.className = "apc-direct__status";
          status.textContent = directAgentStatus(a);
          const rename = document.createElement("button");
          rename.type = "button";
          rename.className = "apc-direct__link";
          rename.textContent = "Rename";
          rename.addEventListener("click", () => {
            this.editing = a.id;
            this.draft = a.name;
            this.render();
          });
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "apc-direct__link";
          const open = this.isOpen(a);
          toggle.textContent = open ? "Hide connection" : "Show connection";
          toggle.setAttribute("aria-expanded", String(open));
          toggle.addEventListener("click", () => {
            if (open) {
              this.open.delete(a.id);
              this.shut.add(a.id);
            } else {
              this.open.add(a.id);
              this.shut.delete(a.id);
            }
            this.render();
          });
          head.append(name, status, rename, toggle);
        }
        row.append(head);
        if (this.isOpen(a)) {
          const body = document.createElement("div");
          body.className = "apc-direct__body";
          const urlHint = document.createElement("p");
          urlHint.className = "apc-direct__hint";
          urlHint.textContent = "Add this URL to your agent as a remote MCP server (Streamable HTTP). No login: the secret in the URL is its access, so give each agent its own.";
          const askHint = document.createElement("p");
          askHint.className = "apc-direct__hint";
          askHint.textContent = "Don't know how? Paste this to your agent:";
          body.append(urlHint, copyField(a.url, "Copy"), askHint, copyField(connectPrompt(a.url, this.name), "Copy prompt"));
          row.append(body);
        }
        return row;
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "apc-direct__add";
      add.textContent = this.list.length ? "Add another agent" : "Connect an agent";
      add.addEventListener("click", () => this.emit("apc-add"));
      this.replaceChildren(...rows, add);
    }
  }

  customElements.define(tag, ApcDirectAgents);
}

/** The element's type, for apps that hold a reference to it. */
export interface ApcDirectAgentsElement extends HTMLElement {
  agents: DirectAgent[];
  appName: string;
}
