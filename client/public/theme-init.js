// Applies the saved (or system) theme before the app renders, so the page never flashes the wrong theme.
// A separate file rather than an inline script, because the server's CSP only allows scripts from 'self'.
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('offerly-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
  } catch (e) {
    // Storage blocked: keep the default dark theme.
  }
  document.documentElement.dataset.theme = theme;
})();
