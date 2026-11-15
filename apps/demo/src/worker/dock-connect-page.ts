/** Shared by the reference apps. The first script runs synchronously, before any asset or API fetch. */
export const CONNECT_HEAD = `(function () {
  if (!location.hash.startsWith("#apc_connect=")) return;
  var hash = location.hash;
  history.replaceState(history.state, "", location.pathname + location.search);
  try {
    sessionStorage.removeItem("apc_connect");
    var raw = hash.slice(13).replace(/-/g, "+").replace(/_/g, "/");
    while (raw.length % 4) raw += "=";
    var bytes = Uint8Array.from(atob(raw), function (c) { return c.charCodeAt(0); });
    sessionStorage.setItem("apc_connect", new TextDecoder("utf-8", {fatal:true}).decode(bytes));
  } catch (_) { /* The client reports an invalid or missing link without sending it. */ }
})();`;

export const CONNECT_EXPIRED = "This link expired. Drop the agent again, or use Connect an app in your dock.";

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** GET always returns 200, including without a session. Session creation/login happens only after fragment removal. */
export function dockConnectPage(name: string, options: { session?: boolean; signedIn?: boolean; account?: string; script?: string } = {}): Response {
  const script = options.script ?? "/assets/dock-connect.js";
  if (!script.startsWith("/") || script.startsWith("//") || /[?#\\]/.test(script)) throw new Error("connect script must be a same-origin path");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><script>${CONNECT_HEAD}</script>
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escape(name)}</title><style>
body{font:16px system-ui,sans-serif;background:#f4f5f7;color:#20242b;margin:0;padding:24px}main{max-width:520px;margin:8vh auto;background:white;border:1px solid #d4d7dc;border-radius:16px;padding:28px}button,select{font:inherit;padding:10px 16px;margin:8px 8px 8px 0}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #3468d4}h1{font-size:24px}#account{overflow-wrap:anywhere}
</style></head><body><main data-app="${escape(name)}" data-session="${options.session === false ? "false" : "true"}" data-signed-in="${options.signedIn === false ? "false" : "true"}" data-account="${escape(options.account ?? "")}">
<h1>Connect ${escape(name)} to your dock</h1><p id="account"></p><p id="message" role="status">Preparing your connection…</p><div id="consent"></div><apc-handoff hidden></apc-handoff><p><a href="/">Open ${escape(name)}</a></p>
</main><script type="module" src="${escape(script)}"></script></body></html>`, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}
