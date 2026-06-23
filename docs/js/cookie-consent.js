// Round 2 audit #8 HIGH-6: cookie consent banner para adpick.html.
//
// Objetivo: NO cargar el iframe del ad network (que setea cookies de tracking)
// hasta que el user da consentimiento explícito (GDPR Art. 7, LGPD, CCPA,
// Ley 25.326). Persistimos la decisión en localStorage por 6 meses para no
// preguntar en cada visita.
//
// Por qué custom (sin biblioteca): el CSP del archivo es estricta
// (script-src 'self'), no podemos cargar CDNs externos. La lógica es tan
// simple que una biblioteca de ~10KB no aporta nada.

(function () {
  'use strict';

  var STORAGE_KEY = 'mtb_cookie_consent_v1';
  var EXPIRY_DAYS = 180; // 6 meses
  var IFRAME_SELECTOR = 'iframe.ad-iframe';
  var BANNER_ID = 'mtbCookieBanner';
  var FOOTER_BTN_ID = 'mtbCookiePrefsBtn';

  function readConsent() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.choice || !parsed.expiresAt) return null;
      if (Date.now() > parsed.expiresAt) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed.choice; // 'accepted' | 'rejected'
    } catch (_) {
      return null;
    }
  }

  function saveConsent(choice) {
    try {
      var payload = {
        choice: choice,
        decidedAt: Date.now(),
        expiresAt: Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) { /* localStorage disabled, no-op */ }
  }

  function loadIframe() {
    var iframe = document.querySelector(IFRAME_SELECTOR);
    if (!iframe) return;
    iframe.style.display = '';
    var src = iframe.getAttribute('data-src');
    if (src && !iframe.getAttribute('src')) {
      iframe.setAttribute('src', src);
    }
  }

  function unloadIframe() {
    var iframe = document.querySelector(IFRAME_SELECTOR);
    if (!iframe) return;
    iframe.removeAttribute('src');
    iframe.style.display = 'none';
  }

  function hideBanner() {
    var b = document.getElementById(BANNER_ID);
    if (b) b.style.display = 'none';
  }

  function showBanner() {
    var b = document.getElementById(BANNER_ID);
    if (b) b.style.display = 'flex';
  }

  function isEs() {
    return (document.documentElement.lang || '').toLowerCase().indexOf('es') === 0
      || (navigator.language || '').toLowerCase().indexOf('es') === 0;
  }

  function injectBanner() {
    if (document.getElementById(BANNER_ID)) return;
    var es = isEs();
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', es ? 'Aviso de cookies' : 'Cookie notice');
    banner.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0',
      'z-index:1000',
      'background:#0d0d0d', 'color:#eee',
      'border-top:1px solid #2a2a2a',
      'padding:16px 18px', 'font-size:13px', 'line-height:1.55',
      'display:flex', 'flex-direction:column', 'gap:10px',
      'box-shadow:0 -4px 14px rgba(0,0,0,0.4)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    var msg = document.createElement('p');
    msg.style.cssText = 'margin:0;flex:1;color:#ccc';
    msg.textContent = es
      ? 'Esta página muestra publicidad de terceros que puede usar cookies y tecnologías similares para personalizar avisos y medir su efectividad. Necesitamos tu consentimiento antes de cargar el bloque de anuncios. Sin tu consentimiento, no podemos mostrarte anuncios ni acreditar el pico extra. Podés cambiar esta decisión en cualquier momento desde el botón "Cookies" del pie de página.'
      : 'This page shows third-party ads that may use cookies and similar tracking technologies to personalize ads and measure their effectiveness. We need your consent before loading the ad block. Without consent, we cannot show ads or credit the extra pick. You can change this decision anytime via the "Cookies" button at the footer.';

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end';

    var rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.textContent = es ? 'Rechazar' : 'Reject';
    rejectBtn.style.cssText = 'background:#1a1a1a;border:1px solid #333;color:#999;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;cursor:pointer';
    rejectBtn.addEventListener('click', function () { onChoice('rejected'); });

    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = es ? 'Aceptar y mostrar anuncios' : 'Accept and show ads';
    acceptBtn.style.cssText = 'background:#1a3a1a;border:1px solid #2e7d32;color:#5cb85c;font-size:13px;font-weight:700;padding:9px 16px;border-radius:8px;cursor:pointer';
    acceptBtn.addEventListener('click', function () { onChoice('accepted'); });

    btnRow.appendChild(rejectBtn);
    btnRow.appendChild(acceptBtn);

    banner.appendChild(msg);
    banner.appendChild(btnRow);
    document.body.appendChild(banner);
  }

  function injectFooterButton() {
    if (document.getElementById(FOOTER_BTN_ID)) return;
    var btn = document.createElement('button');
    btn.id = FOOTER_BTN_ID;
    btn.type = 'button';
    btn.textContent = isEs() ? 'Cookies' : 'Cookies';
    btn.title = isEs() ? 'Cambiar preferencia de cookies' : 'Change cookie preference';
    btn.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:80px',
      'z-index:50',
      'background:rgba(20,20,20,0.85)', 'color:#888',
      'border:1px solid #2a2a2a',
      'font-size:11px', 'font-weight:700',
      'padding:6px 10px', 'border-radius:6px',
      'cursor:pointer',
    ].join(';');
    btn.addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEY);
      injectBanner();
      showBanner();
      unloadIframe();
    });
    document.body.appendChild(btn);
  }

  function injectRejectedNotice() {
    var existing = document.getElementById('mtbCookieRejectedNotice');
    if (existing) { existing.style.display = 'block'; return; }
    var n = document.createElement('div');
    n.id = 'mtbCookieRejectedNotice';
    var es = isEs();
    n.style.cssText = 'margin:14px auto;max-width:480px;padding:12px 14px;background:#1a1000;border:1px solid #3a2800;color:#aa7700;border-radius:10px;font-size:13px;line-height:1.5;text-align:center';
    n.textContent = es
      ? 'Rechazaste las cookies de publicidad. No vas a ver anuncios ni acreditar el pico extra. Tocá "Cookies" abajo a la derecha para cambiar tu decisión.'
      : 'You rejected ad cookies. You will not see ads or earn the extra pick. Tap "Cookies" at bottom-right to change your decision.';
    var main = document.querySelector('main') || document.body;
    main.insertBefore(n, main.firstChild);
  }

  function clearRejectedNotice() {
    var n = document.getElementById('mtbCookieRejectedNotice');
    if (n) n.style.display = 'none';
  }

  function onChoice(choice) {
    saveConsent(choice);
    hideBanner();
    if (choice === 'accepted') {
      clearRejectedNotice();
      loadIframe();
    } else {
      unloadIframe();
      injectRejectedNotice();
    }
  }

  function init() {
    // Defensive: arrancar con iframe oculto hasta resolver consent. Si JS
    // falla más adelante por alguna razón, mejor "no anuncios" que "anuncios
    // sin consent".
    unloadIframe();
    injectFooterButton();
    var consent = readConsent();
    if (consent === 'accepted') {
      loadIframe();
    } else if (consent === 'rejected') {
      injectRejectedNotice();
    } else {
      injectBanner();
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
