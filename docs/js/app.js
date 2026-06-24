// Round 2 Agente #7 HIGH-2: extraído del <script> inline de docs/index.html
// para poder eliminar 'unsafe-inline' del CSP script-src.
//
// Cambios vs la versión inline:
//  - onclick="X()" en HTML → data-action="X" + addEventListener acá.
//  - onchange="X()" en HTML → addEventListener('change') acá.
//  - Lógica funcional 100% idéntica. Si hay un bug nuevo, vino del refactor
//    y no de cambios de comportamiento.
//
// IMPORTANTE: este archivo se carga con `defer`, por lo tanto el DOM ya está
// parseado cuando ejecuta. NO requiere wrap en DOMContentLoaded para acceder
// a elementos del DOM, pero MANTENEMOS el listener DOMContentLoaded por
// compat con el flow original (setLang('en') + detectReferral + age gate).

// Firebase Web API key — pública por diseño. Restringida por HTTP referrer +
// API allowlist en GCP Console (Identity Toolkit, Firestore, FCM).
firebase.initializeApp({
  apiKey: 'AIzaSyDRCpXkNWupz2PmoOG6XcuFENYaU5xIUps',
  authDomain: 'miningtheblocks-669f6.firebaseapp.com',
  projectId: 'miningtheblocks-669f6',
});

var FUNCTIONS_BASE = 'https://us-central1-miningtheblocks-669f6.cloudfunctions.net';
var currentLang = 'en';

var GEM_NAMES = {
  es: { 1:'Diamante rojo', 2:'Painita', 3:'Musgravita', 4:'Jadeíta imperial',
        5:'Alejandrita', 6:'Rubí sangre de paloma', 7:'Diamante azul',
        8:'Diamante rosa', 9:'Esmeralda colombiana' },
  en: { 1:'Red Diamond', 2:'Painite', 3:'Musgravite', 4:'Imperial Jadeite',
        5:'Alexandrite', 6:'Pigeon Blood Ruby', 7:'Blue Diamond',
        8:'Pink Diamond', 9:'Colombian Emerald' }
};
var GEM_PRIZES = { 1:'$100,000', 2:'$50,000', 3:'$10,000', 4:'$1,000', 5:'$500', 6:'$100', 7:'$50', 8:'$25', 9:'$15' };

var ERRORS = {
  es: {
    not_found:       'Código no encontrado. Revisá que esté bien escrito.',
    already_redeemed:'Este código ya fue canjeado por efectivo.',
    already_minted:  'Este código ya fue reclamado como NFT.',
    server_error:    'Error del servidor. Intentá de nuevo en unos minutos.',
    invalid_email:   'El email ingresado no es válido.',
    invalid_wallet:  'La dirección de billetera no es válida.',
    missing_fields:  'Completá todos los campos.',
    unauthenticated: 'Debés iniciar sesión para canjear.',
    invalid_token:   'Sesión inválida o expirada. Iniciá sesión de nuevo.',
    not_owner:       'Este código no pertenece a tu cuenta. Iniciá sesión con la cuenta que generó la gema.',
    rate_limited:    'Demasiados intentos. Esperá un minuto y reintentá.',
    wallet_not_set:  'No tenés una wallet linkeada a tu cuenta. Abrí la app, andá a Perfil y guardá tu wallet primero (cooldown de 24h aplica si recién la cambiaste).',
    mint_in_progress:'Este código está siendo procesado como NFT en este momento. Esperá ~5 minutos y reintentá si querés canjearlo por cash.',
    'auth/wrong-password':   'Contraseña incorrecta.',
    'auth/user-not-found':   'No existe cuenta con ese email. Registrate primero desde la app.',
    'auth/invalid-email':    'Email mal escrito.',
    'auth/too-many-requests':'Demasiados intentos fallidos. Esperá unos minutos.',
    'auth/network-request-failed':'Sin conexión. Revisá tu internet.',
    'auth/invalid-credential':'Email o contraseña incorrectos.',
  },
  en: {
    not_found:       'Code not found. Check that it\'s written correctly.',
    already_redeemed:'This code has already been redeemed for cash.',
    already_minted:  'This code has already been claimed as an NFT.',
    server_error:    'Server error. Please try again in a few minutes.',
    invalid_email:   'The email address is not valid.',
    invalid_wallet:  'The wallet address is not valid.',
    missing_fields:  'Please fill in all fields.',
    unauthenticated: 'You must sign in to redeem.',
    invalid_token:   'Invalid or expired session. Sign in again.',
    not_owner:       'This code does not belong to your account. Sign in with the account that generated the gem.',
    rate_limited:    'Too many attempts. Wait a minute and try again.',
    wallet_not_set:  'No wallet linked to your account. Open the app, go to Profile and save your wallet first (24h cooldown applies if recently changed).',
    mint_in_progress:'This code is being processed as an NFT right now. Wait ~5 minutes and retry if you want to redeem for cash instead.',
    'auth/wrong-password':   'Wrong password.',
    'auth/user-not-found':   'No account found for that email. Register in the app first.',
    'auth/invalid-email':    'Email is malformed.',
    'auth/too-many-requests':'Too many failed attempts. Wait a few minutes.',
    'auth/network-request-failed':'No connection. Check your internet.',
    'auth/invalid-credential':'Email or password incorrect.',
  }
};

function setLang(lang) {
  currentLang = lang;
  try { localStorage.setItem('mtb_lang', lang); } catch (e) { /* private mode */ }
  document.querySelectorAll('.lang-btn').forEach(function(b) {
    b.classList.toggle('active', b.textContent.trim().toLowerCase() === lang);
  });
  document.querySelectorAll('[data-lang]').forEach(function(el) {
    var l = el.getAttribute('data-lang').split(' ')[0];
    el.classList.toggle('visible', l === lang);
  });
  document.querySelectorAll('[data-lang-inline]').forEach(function(el) {
    var l = el.getAttribute('data-lang-inline').split(' ')[0];
    el.classList.toggle('visible', l === lang);
  });
  document.documentElement.lang = lang;
  var copyBtn = document.getElementById('refCopyBtn');
  if (copyBtn && copyBtn.textContent !== '✓') {
    copyBtn.textContent = lang === 'es' ? 'Copiar' : 'Copy';
  }
}

function detectReferral() {
  var params = new URLSearchParams(window.location.search);
  var ref = (params.get('ref') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!ref) ref = localStorage.getItem('mtb_ref') || '';
  if (!ref) return;
  localStorage.setItem('mtb_ref', ref);
  document.getElementById('refBannerCode').textContent = ref;
  document.getElementById('refBanner').classList.add('visible');
}

function copyRefCode() {
  var code = document.getElementById('refBannerCode').textContent;
  var btn = document.getElementById('refCopyBtn');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(function() {
      btn.textContent = '✓';
      setTimeout(function() { btn.textContent = currentLang === 'es' ? 'Copiar' : 'Copy'; }, 2000);
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = '✓'; setTimeout(function() { btn.textContent = currentLang === 'es' ? 'Copiar' : 'Copy'; }, 2000); } catch (_) {}
    document.body.removeChild(ta);
  }
}

var verifiedCode = null;

function showError(id, msg) { document.getElementById(id).textContent = msg || ''; }

function setLoading(btnId, loading) {
  var btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.classList.toggle('loading', !!loading);
  // FIX-P0: NO sobreescribir textContent — destruía los spans data-lang
  // de i18n y el botón quedaba vacío al volver al estado normal.
}

async function verifyCode() {
  var code = document.getElementById('codeInput').value.trim().toUpperCase();
  showError('codeError', '');
  document.getElementById('cardLogin').classList.remove('visible');
  document.getElementById('cardEmail').classList.remove('visible');
  document.getElementById('cardDone').classList.remove('visible');
  if (!code) { showError('codeError', currentLang === 'es' ? 'Ingresá tu código.' : 'Enter your code.'); return; }
  setLoading('btnVerify', true);
  try {
    var res = await fetch(FUNCTIONS_BASE + '/verifyGemCode?code=' + encodeURIComponent(code));
    var data = await res.json();
    if (!res.ok || !data.valid) {
      showError('codeError', (ERRORS[currentLang][data.error]) || (currentLang === 'es' ? 'Código inválido.' : 'Invalid code.'));
      return;
    }
    verifiedCode = code;
    // El backend ya no devuelve `tier` por seguridad. Mostramos genérico.
    document.getElementById('gemBadge').textContent = currentLang === 'es' ? '✓ Código válido' : '✓ Valid code';
    // Si el user ya está logueado, saltamos directo al form de datos. Sino, pedimos login.
    if (firebase.auth().currentUser) {
      document.getElementById('cardEmail').classList.add('visible');
      document.getElementById('nameInput').focus();
    } else {
      document.getElementById('cardLogin').classList.add('visible');
      document.getElementById('loginEmail').focus();
    }
  } catch (e) {
    showError('codeError', currentLang === 'es' ? 'Sin conexión. Verificá tu internet.' : 'No connection. Check your internet.');
  } finally {
    setLoading('btnVerify', false);
    setLang(currentLang); // restaurar textos del botón
  }
}

async function doLogin() {
  var email = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;
  showError('loginError', '');
  if (!email || !password) {
    showError('loginError', currentLang === 'es' ? 'Completá email y contraseña.' : 'Fill in email and password.');
    return;
  }
  setLoading('btnLogin', true);
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
    // Pre-llenar el email del form de canje (suele ser el mismo)
    var emailInput = document.getElementById('emailInput');
    if (emailInput && !emailInput.value) emailInput.value = email;
    document.getElementById('cardLogin').classList.remove('visible');
    document.getElementById('cardEmail').classList.add('visible');
    document.getElementById('nameInput').focus();
  } catch (e) {
    var key = e && e.code ? e.code : '';
    showError('loginError', (ERRORS[currentLang][key]) || (currentLang === 'es' ? 'Error al iniciar sesión.' : 'Sign in error.'));
  } finally {
    setLoading('btnLogin', false);
    setLang(currentLang);
  }
}

async function submitClaim() {
  var name   = document.getElementById('nameInput').value.trim();
  var email  = document.getElementById('emailInput').value.trim();
  var phone  = document.getElementById('phoneInput').value.trim();
  var wallet = document.getElementById('walletInput').value.trim();
  showError('emailError', '');
  var err = currentLang === 'es';
  if (!name)   { showError('emailError', err ? 'Ingresá tu nombre completo.' : 'Enter your full name.'); return; }
  if (!email)  { showError('emailError', err ? 'Ingresá tu email.' : 'Enter your email.'); return; }
  if (!phone)  { showError('emailError', err ? 'Ingresá tu teléfono.' : 'Enter your phone number.'); return; }
  // MEDIO-H18: validar formato exacto Ethereum (42 chars, 0x + 40 hex).
  // Antes `wallet.length < 40` aceptaba wallets de 40 chars (incompletas).
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) { showError('emailError', err ? 'Ingresá una dirección de billetera válida (0x + 40 caracteres hex).' : 'Enter a valid wallet address (0x + 40 hex chars).'); return; }

  // OPS-9: requerir Firebase ID token. Si la sesión expiró entre verifyCode
  // y submitClaim, volver a la pantalla de login.
  var user = firebase.auth().currentUser;
  if (!user) {
    document.getElementById('cardEmail').classList.remove('visible');
    document.getElementById('cardLogin').classList.add('visible');
    showError('loginError', err ? 'Tu sesión expiró. Iniciá sesión de nuevo.' : 'Your session expired. Sign in again.');
    return;
  }

  setLoading('btnClaim', true);
  try {
    var idToken = await user.getIdToken();
    var res = await fetch(FUNCTIONS_BASE + '/submitGemClaim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ code: verifiedCode, name: name, email: email, phone: phone, wallet: wallet }),
    });
    var data = await res.json();
    if (!res.ok || !data.success) {
      showError('emailError', (ERRORS[currentLang][data.error]) || (currentLang === 'es' ? 'Error al enviar.' : 'Submit error.'));
      return;
    }
    document.getElementById('cardEmail').classList.remove('visible');
    // Round 2 audit #4 HIGH (swap flow 2026-06-23): si el backend dice que
    // requiere transfer del NFT, mostramos el paso 2 (enviar + pegar txHash).
    // Si no, terminamos en cardDone como antes (flujo legacy / sin NFT).
    if (data.requiresNftTransfer) {
      window.pendingNftClaim = {
        code: verifiedCode,
        nftReceiverWallet: data.nftReceiverWallet,
        tokenId: data.tokenId,
        gemName: data.gemName,
        gemPrize: data.gemPrize,
      };
      var receiverEl = document.getElementById('nftReceiverWallet');
      if (receiverEl) receiverEl.textContent = data.nftReceiverWallet || '';
      var tokenEl = document.getElementById('nftTokenId');
      if (tokenEl) tokenEl.textContent = data.tokenId != null ? '#' + data.tokenId : '';
      document.getElementById('cardNftTransfer').classList.add('visible');
    } else {
      document.getElementById('cardDone').classList.add('visible');
    }
  } catch (e) {
    showError('emailError', currentLang === 'es' ? 'Sin conexión. Intentá más tarde.' : 'No connection. Try again later.');
  } finally {
    setLoading('btnClaim', false);
    setLang(currentLang);
  }
}

// Round 2 audit #4 HIGH (swap flow 2026-06-23): paso 2 del flujo de canje
// cuando el gem ya tiene NFT minteado. El user envía el NFT a
// NFT_RECEIVER_WALLET en MetaMask, pega el txHash, y nosotros lo verificamos
// on-chain antes de marcar el canje como pendiente de pago.
async function confirmNftTransfer() {
  var es = currentLang === 'es';
  var hashInput = document.getElementById('nftTxHashInput');
  var txHash = (hashInput.value || '').trim().toLowerCase();
  showError('nftTxError', '');
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) {
    showError('nftTxError', es
      ? 'El txHash tiene que ser 0x + 64 caracteres hexadecimales.'
      : 'The txHash must be 0x + 64 hex characters.');
    return;
  }
  var pending = window.pendingNftClaim || {};
  if (!pending.code) {
    showError('nftTxError', es ? 'Sesión perdida. Recargá la página.' : 'Session lost. Reload.');
    return;
  }
  var user = firebase.auth().currentUser;
  if (!user) {
    showError('nftTxError', es ? 'Tu sesión expiró. Iniciá sesión de nuevo.' : 'Your session expired. Sign in again.');
    return;
  }
  setLoading('btnConfirmNft', true);
  try {
    var idToken = await user.getIdToken();
    var res = await fetch(FUNCTIONS_BASE + '/confirmGemNftSent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ code: pending.code, txHash: txHash }),
    });
    var data = await res.json();
    if (!res.ok || !data.success) {
      var msg = data && data.error ? data.error : 'error';
      if (msg === 'tx_already_used') msg = es ? 'Ese txHash ya fue usado para otro canje.' : 'That txHash was already used.';
      else if (msg === 'tx_not_found') msg = es ? 'No encontramos esa transacción on-chain. Verificá que el hash sea correcto.' : 'Transaction not found on-chain.';
      else if (msg === 'tx_reverted') msg = es ? 'La transacción revirtió. Mandá el NFT de nuevo.' : 'Transaction reverted.';
      else if ((msg || '').indexOf('tx_not_confirmed') === 0) msg = es ? 'Esperá unos minutos a que la transacción se confirme (mínimo 3 bloques) y reintentá.' : 'Wait a few minutes for the tx to confirm and retry.';
      else if (msg === 'transfer_mismatch') msg = es ? 'El NFT enviado no coincide con tu canje. Verificá que enviaste el token correcto a la wallet correcta.' : 'NFT mismatch.';
      else if (msg === 'wallet_not_set') msg = es ? 'No tenés una billetera vinculada a tu cuenta MTB.' : 'No wallet linked.';
      else if (msg === 'rpc_unavailable') msg = es ? 'No pudimos verificar la transacción (problema de red). Reintentá en un minuto.' : 'RPC unavailable.';
      else msg = es ? 'No pudimos verificar el envío del NFT (' + msg + ').' : 'Could not verify NFT transfer (' + msg + ').';
      showError('nftTxError', msg);
      return;
    }
    document.getElementById('cardNftTransfer').classList.remove('visible');
    document.getElementById('cardDone').classList.add('visible');
  } catch (e) {
    showError('nftTxError', es ? 'Sin conexión. Intentá más tarde.' : 'No connection. Try again later.');
  } finally {
    setLoading('btnConfirmNft', false);
    setLang(currentLang);
  }
}

function copyNftReceiverWallet() {
  var el = document.getElementById('nftReceiverWallet');
  if (!el) return;
  var txt = el.textContent || '';
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).catch(function() {});
  }
  var btn = document.getElementById('btnCopyNftWallet');
  if (btn) {
    var old = btn.textContent;
    btn.textContent = currentLang === 'es' ? '¡Copiado!' : 'Copied!';
    setTimeout(function() { if (btn) btn.textContent = old; }, 1500);
  }
}

function updateAgeBtn() {
  var ok = document.getElementById('check18').checked && document.getElementById('checkTC').checked;
  var btn = document.getElementById('ageBtn');
  btn.disabled = !ok;
  btn.classList.toggle('active', ok);
}

function acceptAge() {
  if (!document.getElementById('check18').checked || !document.getElementById('checkTC').checked) return;
  localStorage.setItem('mtb_age_ok', '1');
  document.getElementById('ageGate').style.display = 'none';
}

// Round 2 Agente #7 HIGH-2: en lugar de onclick="X()" inline en HTML, los
// handlers se registran acá via data-action attribute + addEventListener.
// Esto permite remover 'unsafe-inline' del CSP script-src.
//
// Convención:
//   - <button data-action="X">  → registra click handler que llama X()
//   - <button data-action="setLang" data-lang="es">  → llama setLang('es')
//   - <input  data-action="updateAgeBtn">  → registra change handler
function wireEventDelegation() {
  // Click handlers (botones + algunos checkboxes que disparan action).
  document.body.addEventListener('click', function(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    // No interceptar Enter en inputs (eso lo maneja keydown abajo).
    switch (action) {
      case 'setLang':
        var lang = el.getAttribute('data-lang') || 'en';
        return setLang(lang);
      case 'copyRefCode': return copyRefCode();
      case 'verifyCode':  return verifyCode();
      case 'doLogin':     return doLogin();
      case 'submitClaim': return submitClaim();
      case 'confirmNftTransfer': return confirmNftTransfer();
      case 'copyNftReceiverWallet': return copyNftReceiverWallet();
      case 'acceptAge':   return acceptAge();
      default: /* unknown action, ignore */
    }
  });
  // Change handlers (checkboxes del age gate).
  var c18 = document.getElementById('check18');
  var cTC = document.getElementById('checkTC');
  if (c18) c18.addEventListener('change', updateAgeBtn);
  if (cTC) cTC.addEventListener('change', updateAgeBtn);
}

document.addEventListener('DOMContentLoaded', function() {
  wireEventDelegation();
  var savedLang = null;
  try { savedLang = localStorage.getItem('mtb_lang'); } catch (e) { /* private mode */ }
  var browserLang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  var initialLang = savedLang || (browserLang.startsWith('es') ? 'es' : 'en');
  setLang(initialLang);
  detectReferral();
  if (localStorage.getItem('mtb_age_ok') === '1') {
    document.getElementById('ageGate').style.display = 'none';
  }
  document.getElementById('codeInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') verifyCode();
  });
  document.getElementById('emailInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitClaim();
  });
});
