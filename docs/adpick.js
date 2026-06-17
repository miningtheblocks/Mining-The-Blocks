// Main adpick logic — extraído de inline en adpick.html para cumplir CSP
// script-src 'self' sin requerir 'unsafe-inline' (CRIT-22/23).
//
// Comportamiento idéntico al script inline previo: lee credenciales desde
// sessionStorage (las puso adpick-init.js), arranca timer de 60s, cuando
// termina llama a Cloud Functions /claimAdSession para acreditar el pico.

var FUNCTIONS_BASE = 'https://us-central1-miningtheblocks-669f6.cloudfunctions.net';
var TIMER_SECONDS = 60;
var params = new URLSearchParams(window.location.search);
var SESSION_ID = '';
var TOKEN = '';
try {
  SESSION_ID = sessionStorage.getItem('mtb_ad_sid') || params.get('sid') || '';
  TOKEN = sessionStorage.getItem('mtb_ad_token') || params.get('t') || '';
} catch (e) {
  SESSION_ID = params.get('sid') || '';
  TOKEN = params.get('t') || '';
}
var currentLang = (navigator.language || 'en').startsWith('es') ? 'es' : 'en';

var timerInterval = null;
var remaining = TIMER_SECONDS;
var CIRCUMFERENCE = 2 * Math.PI * 54; // 339.3

var APP_SCHEME_URL = 'exp+miningtheblocks://peaks';
var APP_INTENT_URL = 'intent://peaks/#Intent;scheme=exp%2Bminingtheblocks;package=com.bissi.miningtheblocks;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.bissi.miningtheblocks;end';

function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('[data-lang]').forEach(function(el) {
    el.classList.toggle('visible', el.getAttribute('data-lang').split(' ')[0] === lang);
  });
  document.querySelectorAll('[data-lang-inline]').forEach(function(el) {
    el.classList.toggle('visible', el.getAttribute('data-lang-inline').split(' ')[0] === lang);
  });
  document.documentElement.lang = lang;
}

function goBackToApp() {
  window.location.href = APP_SCHEME_URL;
  setTimeout(function() {
    if (!document.hidden) {
      window.location.href = APP_INTENT_URL;
    }
  }, 1500);
}

function startTimer() {
  if (!SESSION_ID || !TOKEN) {
    showError(currentLang === 'es' ? 'Sesión inválida. Volvé a la app e intentá de nuevo.' : 'Invalid session. Go back to the app and try again.');
    return;
  }

  var arc = document.getElementById('timerArc');
  var numEl = document.getElementById('timerNum');

  timerInterval = setInterval(function() {
    remaining -= 1;
    numEl.textContent = remaining;
    var offset = CIRCUMFERENCE * (1 - remaining / TIMER_SECONDS);
    arc.style.strokeDashoffset = offset;

    if (remaining <= 0) {
      clearInterval(timerInterval);
      numEl.textContent = '✓';
      arc.style.stroke = '#5cb85c';
      arc.style.strokeDashoffset = 0;
      startAutoClaim();
    }
  }, 1000);
}

function startAutoClaim() {
  document.getElementById('timerWrap').style.opacity = '0.4';

  var barWrap = document.getElementById('claimBarWrap');
  barWrap.classList.add('visible');
  setLang(currentLang);

  // setTimeout(50) is more reliable than double-rAF on mobile Chrome
  // to ensure the browser renders display:flex before starting the CSS transition
  setTimeout(function() {
    document.getElementById('claimBarFill').style.width = '100%';
  }, 50);

  setTimeout(function() {
    claimPick();
  }, 1300);
}

function showError(msg) {
  document.getElementById('claimBarWrap').classList.remove('visible');
  document.getElementById('timerWrap').style.display = 'none';
  var errBox = document.getElementById('resultErr');
  var errMsg = document.getElementById('errMsg');
  errMsg.textContent = msg;
  errBox.classList.add('visible');
  setLang(currentLang);
}

async function claimPick() {
  try {
    var res = await fetch(FUNCTIONS_BASE + '/claimAdSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, token: TOKEN }),
    });
    var data = await res.json();
    if (!res.ok || !data.ok) {
      var errMsgs = {
        es: {
          not_found: 'Sesión no encontrada. Volvé a la app e intentá de nuevo.',
          invalid_token: 'Token inválido.',
          already_used: 'Este pico ya fue reclamado.',
          expired: 'La sesión expiró. Volvé a la app para generar una nueva.',
          not_ready: 'El anuncio todavía no está disponible. Esperá unas horas.',
        },
        en: {
          not_found: 'Session not found. Go back to the app and try again.',
          invalid_token: 'Invalid token.',
          already_used: 'This pick was already claimed.',
          expired: 'Session expired. Go back to the app to generate a new one.',
          not_ready: 'Ad not ready yet. Wait a few hours.',
        }
      };
      var msg = (errMsgs[currentLang] && errMsgs[currentLang][data.error]) ||
        (currentLang === 'es' ? 'Error desconocido.' : 'Unknown error.');
      showError(msg);
      return;
    }
    // Éxito
    document.getElementById('claimBarWrap').classList.remove('visible');
    document.getElementById('timerWrap').style.display = 'none';
    document.getElementById('resultOk').classList.add('visible');
    setLang(currentLang);

  } catch (e) {
    showError(currentLang === 'es' ? 'Sin conexión. Revisá tu internet e intentá de nuevo.' : 'No connection. Check your internet and try again.');
    setLang(currentLang);
  }
}

function openExamplesModal(e) {
  if (e) e.preventDefault();
  var modal = document.getElementById('examplesModal');
  modal.style.display = 'flex';
  setLang(currentLang);
}

function closeExamplesModal() {
  document.getElementById('examplesModal').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  setLang(currentLang);

  // Wire up back buttons
  document.getElementById('backBtnOk').href = APP_SCHEME_URL;
  document.getElementById('backBtnErr').href = APP_SCHEME_URL;

  // Wire up modal open/close via data-action en vez de onclick inline
  // (inline onclick handlers son bloqueados por CSP sin 'unsafe-inline').
  document.querySelectorAll('[data-action="open-examples"]').forEach(function(el) {
    el.addEventListener('click', openExamplesModal);
  });
  document.querySelectorAll('[data-action="close-examples"]').forEach(function(el) {
    el.addEventListener('click', closeExamplesModal);
  });

  startTimer();
});
