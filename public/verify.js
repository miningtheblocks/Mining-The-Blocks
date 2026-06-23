// Round 2 audit #3 HIGH-1: script inline extraído a archivo externo. Esto
// permite eliminar `'unsafe-inline'` del CSP script-src en verify.html y
// dejar `'self'` solo, cerrando defense-in-depth contra XSS.
//
// IMPORTANTE: lógica funcional 100% idéntica al script que estaba inline.

var API_KEY = 'AIzaSyDRCpXkNWupz2PmoOG6XcuFENYaU5xIUps';

function getParam(name) {
  var search = window.location.search;
  var re = new RegExp('[?&]' + name + '=([^&]*)');
  var m = search.match(re);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
}

// Round 2 audit #3 HIGH-2: el() helper sin branch `html` (innerHTML).
// El uso previo era solo para entidades estáticas (✅, ❌); las reemplazamos
// por su carácter Unicode directo via textContent — sin footgun residual.
function el(tag, opts) {
  var node = document.createElement(tag);
  if (opts && opts.cls) node.className = opts.cls;
  if (opts && opts.text != null) node.textContent = opts.text;
  if (opts && opts.style) node.setAttribute('style', opts.style);
  return node;
}

function clearBody() {
  var body = document.getElementById('body-content');
  while (body.firstChild) body.removeChild(body.firstChild);
  return body;
}

function showSuccess() {
  var body = clearBody();
  var isEmailChange = mode === 'verifyAndChangeEmail';
  body.appendChild(el('div', { cls: 'status-icon', text: '✅' }));
  body.appendChild(el('p', { cls: 'title', text: isEmailChange ? '¡Email actualizado!' : '¡Email verificado!' }));

  var sub = el('p', { cls: 'subtitle' });
  if (isEmailChange) {
    sub.appendChild(document.createTextNode('Tu email cambió correctamente. '));
    sub.appendChild(el('span', { cls: 'highlight', text: 'Usá el nuevo email' }));
    sub.appendChild(document.createTextNode(' para iniciar sesión la próxima vez.'));
  } else {
    sub.appendChild(document.createTextNode('Tu cuenta está activa. '));
    sub.appendChild(el('span', { cls: 'highlight', text: 'Ya podés iniciar sesión' }));
    sub.appendChild(document.createTextNode(' en la app.'));
  }
  body.appendChild(sub);

  var steps = el('div', { cls: 'steps' });
  steps.appendChild(el('p', { text: 'Próximos pasos' }));
  var ol = el('ol');
  var li1 = el('li');
  li1.appendChild(document.createTextNode('Abrí la app '));
  li1.appendChild(el('strong', { text: 'Mining The Blocks', style: 'color:#fff' }));
  ol.appendChild(li1);
  var li2 = el('li');
  li2.appendChild(document.createTextNode('Tocá '));
  li2.appendChild(el('strong', { text: '"Iniciar sesión"', style: 'color:#fff' }));
  li2.appendChild(document.createTextNode(' en la pantalla de registro'));
  ol.appendChild(li2);
  ol.appendChild(el('li', { text: 'Ingresá con tu email y contraseña' }));
  steps.appendChild(ol);
  body.appendChild(steps);
}

function showError(msg) {
  var body = clearBody();
  body.appendChild(el('div', { cls: 'status-icon', text: '❌' }));
  body.appendChild(el('p', { cls: 'title', text: 'No se pudo verificar' }));
  var box = el('div', { cls: 'error-box' });
  box.appendChild(el('span', { text: String(msg == null ? '' : msg) }));
  body.appendChild(box);
}

var mode = getParam('mode');
var oobCode = getParam('oobCode');

if (!mode || !oobCode) {
  showError('Link inválido. Pedí uno nuevo desde la app tocando "Reenviar email".');
} else if (mode !== 'verifyEmail' && mode !== 'verifyAndChangeEmail') {
  showError('Acción no reconocida. Pedí un nuevo link de verificación desde la app.');
} else {
  fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:update?key=' + API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: oobCode })
    }
  )
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data && data.error) {
      var code = (data.error.message || '').toString();
      if (code === 'EXPIRED_OOB_CODE') {
        showError('El link expiró. Pedí uno nuevo desde la app tocando "Reenviar email".');
      } else if (code === 'INVALID_OOB_CODE') {
        showError('El link ya fue usado o no es válido. Pedí uno nuevo desde la app.');
      } else if (code === 'USER_DISABLED') {
        showError('Esta cuenta fue deshabilitada. Contactá soporte.');
      } else {
        showError('No se pudo verificar el email (' + code.slice(0, 32) + '). Pedí un nuevo link desde la app.');
      }
    } else if (data && (data.email || data.localId || data.kind)) {
      showSuccess();
    } else {
      showError('Respuesta inesperada del servidor. Pedí un nuevo link desde la app.');
    }
  })
  .catch(function() {
    showError('Error de red. Verificá tu conexión e intentá de nuevo.');
  });
}
