// CRIT-22: mover sid/token a sessionStorage y limpiar URL ANTES de cargar el
// script de ads. El script de effectivecpmnetwork ejecuta en este origen y
// podría leer la URL/referer; sin estos params no puede exfiltrar el token.
// Extraído de inline en adpick.html para cumplir CSP script-src 'self' sin
// requerir 'unsafe-inline'.
(function() {
  try {
    var p = new URLSearchParams(window.location.search);
    var sid = p.get('sid');
    var t = p.get('t');
    if (sid) sessionStorage.setItem('mtb_ad_sid', sid);
    if (t) sessionStorage.setItem('mtb_ad_token', t);
    if (sid || t) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  } catch (e) { /* no-op */ }
})();
