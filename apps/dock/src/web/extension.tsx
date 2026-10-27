import { useEffect, useState, type ReactNode } from "react";
import { EXTENSION_PRESENT } from "../../../extension/src/presence.ts";
import { extensionBrowser, extensionsAddress, EXTENSION_DOWNLOAD, EXTENSION_STORES } from "./extension-install.ts";

export function useExtensionInstalled(): boolean {
  const [installed, setInstalled] = useState(() => document.documentElement.hasAttribute(EXTENSION_PRESENT));
  useEffect(() => {
    // This is an unauthenticated hint. It never calls an API or completes the dock checklist.
    const update = () => setInstalled(document.documentElement.hasAttribute(EXTENSION_PRESENT));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [EXTENSION_PRESENT] });
    update();
    return () => observer.disconnect();
  }, []);
  return installed;
}

/** Small schematic illustrations: the words next to each picture give the full instructions. */
function Picture({ step, address }: { step: number; address: string }) {
  return <svg className="extension-picture" viewBox="0 0 320 170" aria-hidden="true">
    <rect className="picture-window" x="10" y="8" width="300" height="154" rx="10" />
    <path className="picture-line" d="M10 36H310" />
    <circle className="picture-dot" cx="24" cy="22" r="3" /><circle className="picture-dot" cx="36" cy="22" r="3" />
    {step === 1 && <>
      <path className="picture-line" d="M145 51h30l16 16v38h-46z M175 51v16h16" />
      <text x="168" y="91" textAnchor="middle">.zip</text>
      <rect className="picture-accent" x="73" y="119" width="174" height="28" rx="6" />
      <text className="picture-button" x="160" y="137" textAnchor="middle">↓ Download extension</text>
    </>}
    {step === 2 && <>
      <path className="picture-line" d="M38 65h42l12 14h52v62H38z M176 65h42l12 14h52v62H176z M150 105h18m-6-6 6 6-6 6" />
      <text x="90" y="116" textAnchor="middle">.zip</text><text x="229" y="105" textAnchor="middle">APC</text>
      <text x="229" y="125" textAnchor="middle">Keep this folder</text>
    </>}
    {step === 3 && <>
      <rect className="picture-highlight" x="32" y="52" width="256" height="32" rx="6" />
      <text x="46" y="73">{address}</text>
      <path className="picture-line" d="M48 108h160m-160 16h210m-210 16h120" />
    </>}
    {step === 4 && <>
      <text x="28" y="65">Extensions</text><text x="148" y="65">Developer mode</text>
      <rect className="picture-accent" x="261" y="51" width="34" height="18" rx="9" /><circle className="picture-knob" cx="285" cy="60" r="7" />
      <rect className="picture-highlight" x="28" y="89" width="128" height="28" rx="5" /><text x="40" y="108">Load unpacked</text>
    </>}
    {step === 5 && <>
      <text x="28" y="61">Choose a folder</text><rect className="picture-highlight" x="28" y="76" width="264" height="32" rx="5" />
      <text x="42" y="97">▱ APC extension</text><rect className="picture-accent" x="181" y="122" width="110" height="26" rx="5" />
      <text className="picture-button" x="236" y="140" textAnchor="middle">Select folder</text>
    </>}
    {step === 6 && <>
      <text x="160" y="64" textAnchor="middle">Your agent, on any page</text>
      <rect className="picture-accent" x="25" y="84" width="270" height="34" rx="6" />
      <text className="picture-button" x="160" y="105" textAnchor="middle">Let me drop my agent on any page</text>
      <text x="160" y="143" textAnchor="middle">Allow when your browser asks</text>
    </>}
    {step === 7 && <>
      <rect className="picture-highlight" x="28" y="55" width="68" height="90" rx="8" /><text x="62" y="76" textAnchor="middle">Dock</text>
      <circle className="picture-accent" cx="62" cy="105" r="13" /><text className="picture-button" x="62" y="110" textAnchor="middle">✦</text>
      <path className="picture-arrow" d="M80 105Q130 62 177 95m-9-8 9 8-12 2" />
      <rect className="picture-highlight" x="182" y="76" width="109" height="54" rx="5" />
      <path className="picture-line" d="M193 90h86m-86 12h76m-76 12h82" />
      <text x="237" y="149" textAnchor="middle">A paragraph</text>
    </>}
  </svg>;
}

function Step({ number, title, address, children }: { number: number; title: string; address: string; children: ReactNode }) {
  return <li className="extension-step" id={number === 7 ? "try-extension" : undefined}>
    <div className="extension-step-copy"><h2><span className="extension-number">{number}</span>{title}</h2>{children}</div>
    <Picture step={number} address={address} />
  </li>;
}

export function ExtensionInstall() {
  const installed = useExtensionInstalled();
  const [browser, setBrowser] = useState(() => extensionBrowser(navigator.userAgent));
  const address = extensionsAddress(browser);
  const store = EXTENSION_STORES[browser];
  const [copyStatus, setCopyStatus] = useState("");
  const manualSteps = <ol className="extension-steps">
    <Step number={1} title="Download the extension" address={address}>
      <p>Get the ready-to-use zip. You don’t need to build anything.</p>
      <a className="extension-primary" href={EXTENSION_DOWNLOAD}>Download extension (.zip)</a>
    </Step>
    <Step number={2} title="Unzip it into a folder you keep" address={address}>
      <p>On Windows, right-click the zip and choose <b>Extract all</b>. On a Mac, double-click it. Move the extracted folder somewhere permanent, such as Documents.</p>
      <p>Your browser loads the extension from this folder, so keep it there. The folder should contain <code>manifest.json</code>.</p>
    </Step>
    <Step number={3} title="Open your extensions page" address={address}>
      <p>Copy this address, paste it into a new tab’s address bar, and press Enter. A web page can’t open it for you.</p>
      <label className="extension-browser">Your browser <select value={browser} onChange={(e) => { setBrowser(e.target.value as "chrome" | "edge"); setCopyStatus(""); }}><option value="chrome">Chrome</option><option value="edge">Edge</option></select></label>
      <div className="extension-copy"><code>{address}</code><button type="button" onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(address); setCopyStatus("Copied. Paste it into a new tab’s address bar."); }
          catch { setCopyStatus("Select and copy the address above, then paste it into a new tab’s address bar."); }
        })();
      }}>Copy address</button></div>
      <p role="status">{copyStatus}</p>
    </Step>
    <Step number={4} title="Turn on Developer mode" address={address}>
      <p>Find <b>Developer mode</b> on the extensions page and switch it on. In Chrome it’s at the top right; in Edge it may be in the left sidebar.</p>
      <p>This lets you add the downloaded folder while APC’s store listings are being prepared.</p>
    </Step>
    <Step number={5} title="Load the unzipped folder" address={address}>
      <p>Click <b>Load unpacked</b>, then select the folder you unzipped — the one containing <code>manifest.json</code>. Choose the folder, rather than a file inside it.</p>
      <p>You’ll see “APC: point your agent at any page” in your extensions.</p>
    </Step>
    <Step number={6} title="Allow it on any page" address={address}>
      <p>The extension’s welcome page opens. Click <b>Let me drop my agent on any page</b>, then allow access when your browser asks.</p>
      <p>Nothing is sent until you drop your agent. If the welcome page closed, click APC in your browser’s Extensions menu to allow access there.</p>
    </Step>
  </ol>;

  return <main className="extension-install">
    <header className="extension-header"><a href="/">Agent Pointed Context</a><a href="/dock">Back to your dock →</a></header>
    <section className="extension-intro">
      <span className="kicker">Your agent, on any page</span>
      <h1>Add the APC browser extension</h1>
      <p>Drag your agent from the dock onto a paragraph, and ask about what you’re reading.</p>
      <p className="extension-computer">You need Chrome or Edge on a computer. If you’re on your phone, open this page on your computer to install it.</p>
      {installed ? <div className="extension-installed" role="status"><b>Installed ✓</b><p>Your browser has the extension. <a href="#try-extension">Try it with your agent below ↓</a></p></div> : store ? <a className="extension-primary" href={store}>Add to {browser === "edge" ? "Edge" : "Chrome"}</a> : <p>Until APC is in the browser stores, add it from a downloaded folder. Follow these seven steps once.</p>}
    </section>
    {installed || store ? <details className="extension-manual"><summary>Install again or see the download steps (1–6)</summary>{manualSteps}</details> : manualSteps}
    <ol className="extension-steps" start={7}>
      <Step number={7} title="Try it with your agent" address={address}>
        <p><a href="/dock">Open your dock</a> and keep it beside another page. Drag your connected agent from the dock onto a paragraph in that page. The extension stays out of the way on the dock itself.</p>
        <p>Allow the site when the extension asks, and allow this browser in the dock. Ask your agent: <b>what is this?</b></p>
        <p>The dock’s <b>Any page</b> checklist item checks itself when your first page reading is sent.</p>
      </Step>
    </ol>
    <aside className="extension-note"><h2>About the Developer mode warning</h2><p>Your browser may remind you that this extension was loaded from a folder instead of a store. That’s expected with this install method. Close or dismiss the reminder to keep using APC; if it offers to disable extensions, leave APC enabled. Once the store listings are ready, you’ll be able to install from there.</p></aside>
    <details className="extension-update"><summary>Updating the extension later</summary><p>Download the zip again, unzip it, and replace the files in the folder you kept. On <code>{address}</code>, click APC’s reload button. Reload any page where you want to drop your agent.</p></details>
  </main>;
}
