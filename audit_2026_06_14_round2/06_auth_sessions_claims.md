# Agente #6 — Auth + Sessions + Claims

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 5 |
| HIGH | 12 |
| MEDIUM | 15 |
| LOW | 13 |
| INFO | 6 |
| **TOTAL** | **51** |

## Top 5 críticos

1. **[CRIT] `sendVerificationEmail` SIN rate-limit** — `functions/index.js:1782-1882`. Bombeable por user autenticado. Riesgo de **suspender el Gmail app-password compartido** → outage TOTAL de notificaciones (verify + NFT alerts + reportProblem + gem claim emails). Fix: 1 línea con `_rateLimitFirestore`.

2. **[CRIT] `verifyIdToken` SIN `checkRevoked` en submitGemClaim** — `functions/index.js:1904`. Operación NFT tier-1 vale $100k. Token revocado puede seguir submiteando claims hasta 60min después → window completo de account takeover.

3. **[CRIT] Password reset NO revoca tokens NI notifica al user original** — `Login.js:192-208`. Playbook clásico de takeover: atacante con email fugaz resetea password, las sesiones existentes (incluida la víctima legítima) siguen válidas 60min mientras él cambia walletAddress, submite claims, etc.

4. **[CRIT] `requireRegistered` acepta providers desconocidos sin email check** — `functions/index.js:80-90`. Si Firebase agrega/habilitan Anonymous u otro provider sin email_verified, bypass automático.

5. **[CRIT] `verify.html` en `web.app` mientras la API key restrictions cubren `.com`** — discrepancia silenciosa. Si Google rota o cambian las allowlists, verify queda roto sin error visible.

## High severity (12)
- `checkRevoked` ausente también en createCryptoPayment, claimGemNFT, mineCube
- `requireAdminFresh` hace `getUser()` sin cache (cuota Auth Admin → DoS posible)
- `processPendingMints` NO logea en `adminActions` (audit gap)
- `grant_admin.js` usa `firebase-tools` access_token (footgun masivo si filtra)
- `grant_admin.js` audit log con `operator: process.env.USER` (spoofeable trivial)
- Cold-start NO hace `u.reload()` antes del email_verified check (UX bug)
- Web SDK compat v10.13.2 (versión vieja, ~120KB)
- Login muestra "email no verificado" → enumeration de cuentas existentes
- `updateEmail()` NO re-trigger sendVerificationEmail (limbo + escalación de takeover)
- `applyReferral` cooldown 10s solo client-side (backend OK)
- `mineCube` mismo problema de checkRevoked
- Firestore rule `usernames` regex NO anchored (`matches('[a-z0-9_]+')` permite "Admin" etc.)
- HTTP endpoints sin verificar origen real
- `pushToken` writable sin email_verified

## Medium severity (15)
- Logout NO limpia pushToken (notificaciones cross-user en device compartido)
- onSnapshot listeners no cancelados explícitamente en signOut
- AsyncStorage NO se limpia en signOut (KEEP_SIGNED_IN, ACTIVE_SERVER persisten)
- Registration setTimeout 150ms heurístico en handleGoToLogin
- logError no scrub email/phone/name (solo password/token)
- Profile.js useEffect deps=[] → onSnapshot suscrito a uid viejo si cambia auth
- Config.js muestra UID slice(0,6) en UI (correlación shoulder-surfing)
- App.js setupPushToken con timer 2s frágil
- verify.html depende directo de identitytoolkit (sin backend intermedio)
- requireRegistered no chequea `disabled` (Firebase Console ban no efectivo 60min)
- **Sin UI "logout everywhere"** (multi-device hijack)
- **Sin self-serve account deletion (GDPR/Play Store)**
- checkUsername / use NO atómico
- applyReferral acepta zero-width chars + RTL marks
- **App Check NO habilitado** — APK reverse-engineering trivial

## Patrones positivos (14)
- requireAdminFresh con getUser() fresh para custom claims
- setCustomUserClaims SOLO en CLI script (nunca expuesto en CFs públicas)
- adminActions audit log para addServerCredit + notifyAllUsers + grant_admin
- Cooldown 24h en walletAddress change (anti hot-swap durante takeover)
- Anti-enumeration en sendPasswordResetEmail
- submitGemClaim requiere Bearer + valida ownership del gem path
- Whitelist explícito en Firestore rules para users.update
- _rateLimitFirestore consistente entre instancias
- verify.html con createElement/textContent (no innerHTML)
- crypto.timingSafeEqual en adSession token
- email_verified requerido en usernames rule
- logError con scrub de PII en safeCtx (parcial)
- keep_signed_in se respeta con signOut defensivo en cold-start
- Tests sólidos en rules.test.js

## Riesgos privilege escalation
- **NINGUNA ruta directa** identificada
- Vector real: `firebase-tools` access_token del developer (vía malware en máquina local)
- Mitigación: SA dedicado con rol mínimo `Firebase Auth Admin`

## Riesgos session hijacking
- **Principal**: token replay 60min tras logout (sin checkRevoked en críticas)
- Multi-device hijack: 1 password reset = control simultáneo en todos los devices (60min)
- XSS en docs/index.html: `'unsafe-inline'` en CSP deja superficie, pero no hay UGC renderizado raw
- Anonymous Auth bypass: **acción manual crítica** — verificar que esté DISABLED en Firebase Console

## Recomendación priorizada

1. Rate-limit a `sendVerificationEmail` (10 min de trabajo, evita outage masivo)
2. `verifyIdToken(token, true)` + `revokeRefreshTokens` en password reset
3. Provider-whitelist explícito en `requireRegistered`
4. Firebase App Check (mitigar abuso de APK sideloaded)
5. Self-serve account deletion (compliance Play Store/GDPR)
6. Migrar verify.html a `miningtheblocks.com/verify`
7. SA dedicado para grant_admin.js
