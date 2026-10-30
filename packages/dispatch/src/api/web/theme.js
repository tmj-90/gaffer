// Apply the viewer's chosen kit before first paint. "light" / "dark" pin the
// theme; anything else (or nothing stored) follows the system setting through
// color-scheme: light dark. app.js owns the toggle (setTheme) and writes the key.
// A classic script (not a module) so it blocks paint; CSP is script-src 'self'.
(function () {
  try {
    var t = localStorage.getItem("gaffer_theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (_e) {
    // Storage blocked (private window, policy): follow the system setting.
  }
})();
