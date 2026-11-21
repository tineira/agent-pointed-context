(() => {
  var theme = null;
  try {
    var stored = localStorage.getItem("apc-theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {}
  if (!theme) {
    theme = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
})();
