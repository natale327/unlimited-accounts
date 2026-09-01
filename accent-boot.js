// Applies the saved accent color before first paint (avoids default-color flash).
// Must be loaded synchronously in <head>. CSP-safe: external file, no inline script.
(function () {
  try {
    var c = localStorage.getItem('accentColor');
    if (c) {
      var r = document.documentElement.style;
      r.setProperty('--color-accent', c);
      r.setProperty('--color-accent-strong', 'color-mix(in srgb, ' + c + ' 82%, white)');
      r.setProperty('--color-accent-soft', 'color-mix(in srgb, ' + c + ' 22%, transparent)');
    }
  } catch (e) {}
})();
