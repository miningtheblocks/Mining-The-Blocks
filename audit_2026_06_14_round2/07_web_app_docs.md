# Agente #7 — Web app (docs/* y public/*)

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 0 |
| HIGH | 5 |
| MEDIUM | 7 |
| LOW | 13 |
| INFO | 12 |
| **TOTAL** | **37** |

## Top 5 HIGH

1. **[HIGH] `docs/adpick.html` — Ad script de `effectivecpmnetwork` corre same-origin** — puede leer sessionStorage, robar tokens, defacear, redirigir. **Mover el sessionStorage NO resuelve nada** (el script tiene acceso pleno desde JS). Sandbox iframe es imprescindible. TODO #41 reconocido pero pendiente.

2. **[HIGH] `docs/index.html` — `'unsafe-inline'` invalida el CSP** — el meta tag declara políticas exhaustivas pero `'unsafe-inline'` en script-src + JS inline grande + onclick handlers vuelve el CSP funcionalmente decorativo contra XSS.

3. **[HIGH] Firebase SDK desde gstatic SIN SRI** — `<script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js">` sin `integrity="sha384-..."`. Para una página que tramita claims hasta $100k, supply chain attack vector real.

4. **[HIGH] Ad network script sin SRI ni sandbox** (compuesto con #1)

5. **[HIGH] `verify.html` helper `el(..., {html: ...})` expone `innerHTML` sink** — solo el comentario "uso solo para entities estáticas" impide XSS. Con `'unsafe-inline'` activo en firebase.json header, riesgo real ante refactor accidental.

## Hallazgos secundarios importantes

- **[MEDIUM] `verifyGemCode` usa `setCorsHeaders` con `*` wildcard** — cualquier origen puede enumerar códigos (rate-limit mitiga, pero CORS consistency rota)
- **[MEDIUM] CSP firebase.json menos estricto que meta tags** — divergencia silenciosa
- **[MEDIUM] `verify.html` NO tiene meta CSP** — depende 100% del header HTTP
- **[MEDIUM] CSP `img-src 'self' data: https:`** — wildcard permite exfiltración via `<img src=https://attacker.com>` si hay XSS
- **[MEDIUM] CSP `connect-src` lista `*.firebaseio.com` (dead-code)** — abre superficie sin uso real
- **[MEDIUM] `claimAdSession` sin Origin enforcement real** (entropy del token mitiga)
- **[LOW] `verify.html` default-SUCCESS en errores no enumerados** — UX bug con consecuencias de seguridad (CRIT-24 documentado como "default-deny" pero el código es default-success en realidad)
- **[LOW] Sin logout flow visible en web** después de claim
- **[LOW] `<meta X-Frame-Options>` no funciona** (browsers ignoran XFO en meta) — mitigado por frame-ancestors
- **[LOW] `?ref=` y `sid`/`t` sin cap de longitud antes de localStorage/sessionStorage**

## Patrones positivos detectados (14)
- Bearer auth (no cookies) → CSRF imposible
- Allowlist explícita de origins en setRestrictedCorsHeaders
- `rel="noopener noreferrer"` consistente
- `frame-ancestors 'none'` en todas las páginas
- `referrer` policy declarada
- Regex ETH estricta `^0x[a-fA-F0-9]{40}$`
- `textContent` consistente en index.html
- `createElement` + `textContent` en verify.html
- Rate limiting Firestore en verifyGemCode y logClientError
- crypto.timingSafeEqual en claimAdSession
- Token 192 bits de entropía
- Ownership check en submitGemClaim
- HSTS via GitHub Pages + Firebase Hosting
- Permissions-Policy declarado

## CSP por página

| Página | Header | Meta | unsafe-inline | Estado |
|--------|--------|------|---------------|--------|
| docs/index.html | — | sí, laxo | **sí** | HIGH-2 |
| docs/privacy.html | — | sí, estricto | no | OK |
| docs/terms.html | — | sí, estricto | no | Bug funcional: onclicks sin unsafe-inline |
| docs/adpick.html | — | sí + ad host | no | HIGH-1 |
| public/verify.html | firebase.json | **no** | sí | MEDIUM-10 |
| public/privacy.html | firebase.json | sí | meta gana | OK |
| public/terms.html | firebase.json | sí | meta gana | OK |

## Headers faltantes
- Cross-Origin-Opener-Policy
- Cross-Origin-Embedder-Policy
- Cross-Origin-Resource-Policy
- Cache-Control: no-store en verify.html
- Permissions-Policy completo (faltan payment, usb, browsing-topics, interest-cohort)
- Report-To / report-uri (monitoring)

## Conclusión

Web maduro tras múltiples rondas. **Disciplina sólida en lo fundamental** (Bearer, textContent, ownership checks, rate limits). **0 CRIT** explotable directamente.

El gap principal está en **defense-in-depth**:
1. CSP con `'unsafe-inline'` en página de claim (mayor ROI)
2. Sin SRI en Firebase SDK (prioridad #2)
3. Ad script same-origin (TODO reconocido, abrir sandbox iframe)
4. `verifyGemCode` con CORS wildcard (trivial)
5. `verify.html` default-success en errores no enumerados

Veredicto: listo para producción contra XSS/CSRF directos. Las 5 HIGH no son explotables sin evento externo (compromise CDN/ad/refactor). Vale la pena cerrar los HIGHs antes del lanzamiento mediático.
