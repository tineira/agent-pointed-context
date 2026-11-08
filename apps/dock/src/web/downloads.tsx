import { DESKTOP, DESKTOP_SHELL, DOCK_DESKTOP } from "./setup.tsx";
import { downloadPlatform } from "./download-platform.ts";
import { useExtensionInstalled, useExtensionOutdated } from "./extension.tsx";

/** Small platform marks identify the downloads; their adjacent text supplies the accessible name. */
function WindowsLogo() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M1 3.3 8.5 2.2v7H1zm9-1.4L19 .5v8.7h-9zM1 10.7h7.5v7L1 16.6zm9 0h9v8.8l-9-1.4z" />
  </svg>;
}

function BrowserLogos() {
  return <span className="download-logos" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="18" height="18">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.8h9M8.4 14.1 3.9 6.3m11.7 7.8-4.5 7.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M21.7 15.1c-.5 4.2-4.3 7.4-9 7.4C6.5 22.5 2 18.1 2 12.5 2 6.4 6.3 1.5 12.3 1.5c5.6 0 9.7 3.9 9.7 9 0 3.3-2.2 5.2-5.6 5.2-3.1 0-5.2-1.4-5.2-3.6 0-1.7 1.2-3 3.2-3.1-4.3-1.4-8.2 1.1-8.2 4.6 0 4.2 4.2 6.2 8.1 5.4 2.9-.6 5.4-1.9 7.4-3.9Z" />
    </svg>
  </span>;
}

/**
 * The downloads, as items of the dock's "⋯" menu (TIN-702): no longer cards below the dock, and
 * also offered in the Try your dock steps they belong to (TIN-701). The dock for Windows is offered
 * only outside the app itself.
 */
export function DownloadItems() {
  const installed = useExtensionInstalled();
  const { outdated } = useExtensionOutdated();
  const extensionLabel = outdated ? "Extension out of date" : installed ? "Extension installed ✓" : "Browser extension";
  const platform = downloadPlatform(navigator.userAgent, DESKTOP_SHELL);
  if (!platform.computer) return <p role="none" className="menu-note">Desktop apps and the browser extension need a computer.</p>;
  const pulse = DESKTOP.find((d) => d.label === "Windows");
  return <>
    {platform.dock && <a role="menuitem" className="menu-item" href={DOCK_DESKTOP.url} title={DOCK_DESKTOP.note}>
      <WindowsLogo /><span>Dock for Windows</span><small className="download-note">Unsigned for now</small>
    </a>}
    {platform.pulse && pulse && <a role="menuitem" className="menu-item" href={pulse.url} title={pulse.note}>
      <WindowsLogo /><span>Pulse for Windows</span><small className="download-note">Unsigned for now</small>
    </a>}
    <a role="menuitem" className="menu-item" href="/extension" target="_blank" rel="noreferrer" aria-label={`${extensionLabel}, for Chrome and Edge`}>
      <BrowserLogos /><span>{extensionLabel}</span>
    </a>
    {platform.later && <p role="none" className="menu-note">Windows apps available · Mac and Linux later</p>}
  </>;
}
