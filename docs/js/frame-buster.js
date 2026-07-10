// Round 2 audit #10 HIGH-5: frame-buster anti-clickjacking.
//
// Por qué este archivo existe: GitHub Pages no permite agregar `X-Frame-Options`
// ni `Content-Security-Policy: frame-ancestors` como headers HTTP reales. Los
// equivalentes via <meta http-equiv> son IGNORADOS por todos los browsers
// modernos para esos dos headers (spec). Por lo tanto la única defensa que
// funciona en GitHub Pages es chequear en JS y romper el frame si el sitio
// está embebido. Esta defensa se elimina cuando migremos a Firebase Hosting
// que sí setea esos headers (configurado en firebase.json).
//
// Se carga síncrono en el <head> (no defer/async) para correr antes que el
// DOM, evitando flash de contenido enmarcado. Es 1 línea, costo negligible.
if (window.top !== window.self) {
  try { window.top.location = window.self.location; }
  catch (e) { document.body && (document.body.innerHTML = ''); }
}
