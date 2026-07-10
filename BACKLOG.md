# MTB — Backlog priorizado post-release

Items del audit Round 2 NO cerrados, organizados de mayor a menor importancia.
Dividido en **lotes semanales** para resolver junto con la revisión semanal del [OPERATIONS_PLAYBOOK.md](OPERATIONS_PLAYBOOK.md).

Última actualización: 2026-06-23.

---

## 🎯 Cómo usar este documento

1. **Cada lunes** hacés primero las revisiones del playbook (15-20 min).
2. **Después** atacás 1 lote de este backlog (~1-2h adicionales).
3. Cuando completás un item: tachá la línea con `~~item~~` + nota el commit hash.
4. Cuando completás un lote entero: agregá `✅ DONE 2026-XX-XX commit hash` al header del lote.
5. Si un trigger reactivo dispara, **pausá** el lote semanal y atendé el incidente.

**Cadencia esperada**: 1 lote/semana → todo el backlog en ~3-4 meses (12-15 lotes).

---

## 📊 Inventario total

| Categoría | Items | Cobertura semanal estimada |
|---|---|---|
| 🔴 P1 — Seguridad backend MED | ~20 | Lotes 1-3 |
| 🟠 P2 — Compliance / Privacy | ~15 | Lotes 4-5 |
| 🟡 P3 — Auth / Sessions MED | ~14 | Lotes 6-7 |
| 🟢 P4 — Frontend / UX MED | ~10 | Lote 8 |
| 🔵 P5 — Android / Build MED | ~13 | Lotes 9-10 |
| 🟣 P6 — Push / i18n / Scripts MED | ~14 | Lote 11 |
| 🟤 P7 — Web / docs MED + LOWs | ~10 | Lote 12 |
| ⚫ P8 — Ops / Perf MED | ~12 | Lote 13 |
| ⚪ P9 — LOWs cosméticos | ~38 | Lotes 14-15 |
| 🩷 P10 — Cleanups gráficos | 7 | Lote 16 |
| 💗 Externo — Legal + audit | 2 | Anual / trigger volumen |

**Total**: ~155 items + 2 externos.

---

## 🔴 LOTE 1 — Seguridad backend crítica (semana 1, ~2h)

Items con mayor superficie de ataque o pérdida monetaria potencial.

- [ ] **MED-1-2** `mineCube` calcula `gem` twice (TX + post-TX save) con K inconsistente → inconsistencia data en layerK. Fix: calcular K una sola vez al inicio del TX. Archivo: `functions/index.js` (línea ~800).
- [ ] **MED-1-3** `mineCube` guarda gema con `add()` fuera TX; si falla, gema pierde permanentemente. Fix: mover `add()` dentro del `runTransaction`. Mismo archivo.
- [ ] **MED-1-7** `sendVerificationEmail` sin rate-limit; user puede spamear emails (consume gmail quota). Fix: rate-limit Firestore como `_rateLimitFirestore(uid, 'sendVerify', 60_000)`. Costo si no se atiende: bombing → outage Gmail.
- [ ] **MED-1-11** Nonce race entre `processPendingMints` manual y `mintProcessorScheduled` sin lock distribuido. Fix: doc `locks/mintProcessor` con TTL 5min, ambos paths lo adquieren primero.
- [ ] **MED-1-12** `cryptoPaymentProcessorScheduled` puede ejecutarse concurrentemente con sí mismo si dura >5min. Fix: mismo lock pattern.

**Acción tuya**: leer cada item → planear fix → 1 commit por item → `npm test` en functions → push.

---

## 🔴 LOTE 2 — Validación + invariantes backend (semana 2, ~1.5h)

- [ ] **MED-1-4** Historia permite cliente escribir `totalMined` arbitrarios; activity feed contaminada. Fix: rule deny en `serverChains/{id}/history/{e}` create con campos fuera de whitelist.
- [ ] **MED-1-5** `createCryptoPayment` expone `paymentId=amt_${amount}` → IDs enumerables. Fix: agregar nonce randomBytes(8).
- [ ] **MED-1-6** Rate-limit doc renueva `expiresAt` indefinidamente; buckets activos viven para siempre. Fix: cap `expiresAt = now + 24h` siempre.
- [ ] **MED-1-14** `_rateLimitFirestore` array `ts` crece hasta 100 entries; costo amplificado. Fix: prune entries con `ts < windowStart` antes de push.
- [ ] **MED-1-16** `processedTxs/{txHash}` puede duplicar si TX tiene 2 Transfer events al mismo amount. Fix: usar `txHash_logIndex` como docId.
- [ ] **MED-1-19** `firestoreBackupScheduled` sobrescribe si corre >1 vez/día. Fix: timestamp completo `YYYY-MM-DDTHH:mm:ss` en path.

---

## 🔴 LOTE 3 — Wallet + payment edge cases (semana 3, ~1.5h)

- [ ] **MED-1-8** `submitGemClaim` acepta wallet del body sin validar contra `users/{uid}.walletAddress`. Status: parcialmente cerrado en commits previos, **verificar**.
- [ ] **MED-1-9** `claimGemNFT` acepta walletAddress del body bypaseando setUserWallet cooldown. **Verificar** también.
- [ ] **MED-1-13** `notifyAllUsers` sólo envía Expo Push API; usuarios con FCM tokens no reciben. **Verificar cierre** (commit reciente lo trataba).
- [ ] **MED-1-20** `sendPushToUser` no valida formato Expo/FCM token; tokens garbage envían requests inválidos. Fix: regex `^(ExponentPushToken\[|[a-zA-Z0-9_-]{140,})` antes de enviar.
- [ ] **MED-2-2** Auto-mint en `mineCube` usa `add()` no idempotente → potencial duplicado NFT. Fix: docId determinístico `${uid}_${serverId}_${episode}_${K}_${N}`.
- [ ] **MED-2-3** `usernames.update` sin merge rompe `createdAt` en re-claims. Fix: rule require `data.createdAt == resource.data.createdAt`.

---

## 🟠 LOTE 4 — Compliance Play Store / GDPR (semana 4, ~2.5h)

**Bloqueantes para subir a Play Store en algún momento.**

- [ ] **HIGH-10-38** Sin self-serve account deletion in-app. Bloqueante Play Store policy desde mayo 2024. Fix: pantalla "Eliminar cuenta" en Config + Cloud Function `deleteSelfAccount` que purga doc + auth user + tokens.
- [ ] **MED-10-44** Touch targets sub-44pt. Fix: pase manual por screens críticas + `minHeight: 44` en TouchableOpacity.
- [ ] **MED-10-45** Contrastes sub-WCAG-AA en Login/Config (`#555` on `#0a0a0a`, ratio ~3.5:1). Fix: `#888` mínimo en texto secundario, `#bbb` en placeholders.
- [ ] **MED-10-43** 0 `accessibilityLabel` salvo 2 líneas en ServerList. Bloqueante European Accessibility Act. Fix: agregar en los ~30 TouchableOpacity más usados.
- [ ] **MED-6-34** Sin self-serve account deletion (duplicado de HIGH-10-38, se cierra junto).

---

## 🟠 LOTE 5 — Privacy / Legal docs (semana 5, ~1.5h)

- [ ] **HIGH-10-36** Privacy policy omite Cloudflare + GitHub como sub-procesadores; sin SCC disclosure. Fix: agregar §3.2 "Sub-procesadores" en privacy.html con Firebase, Pinata, Cloudflare, GitHub.
- [ ] **MED-10-39** Privacy dice 5 años, terms dice indefinidamente. Fix: alinear ambos en privacy.html §4 + terms.html §11. Decidir: 5 años desde último login.
- [ ] **MED-10-40** USA listado como prohibido pero CCPA disclosure presente. Fix: remover CCPA section O remover USA del prohibited list (consultar legal).
- [ ] **MED-10-41** `terms.html` 14.3 lista "CNZF — Centro Nacional de Zonas Fuera (Argentina)" — **organización inventada**. Fix: borrar línea o reemplazar por referencia real (Lotería Nacional / CNRT no aplica).

---

## 🟡 LOTE 6 — Auth + sessions cleanup (semana 6, ~2h)

- [ ] **MED-6-23** Logout NO limpia pushToken → notificaciones cross-user en device compartido. Fix: en signOut, set `users/{uid}.pushToken = null` antes de auth.signOut().
- [ ] **MED-6-24** onSnapshot listeners no cancelados explícitamente en signOut. Fix: contexto global con array de unsubscribes, iterar en signOut.
- [ ] **MED-6-25** AsyncStorage NO limpiada en signOut (KEEP_SIGNED_IN persisten). Fix: `AsyncStorage.multiRemove(['keep_signed_in', 'cached_uid', ...])`.
- [ ] **MED-6-28** Profile.js useEffect deps=[] → onSnapshot suscrito a uid viejo. Fix: deps=[uid] + cleanup unsubscribe.
- [ ] **MED-6-29** Config.js muestra UID slice(0,6) en UI (correlación shoulder-surfing). Fix: ocultar detrás de "Mostrar ID técnico" toggle.
- [ ] **MED-6-30** App.js setupPushToken con timer 2s frágil. Fix: usar auth state change listener en vez de setTimeout.

---

## 🟡 LOTE 7 — Defense in depth auth (semana 7, ~1.5h)

- [ ] **MED-6-32** requireRegistered no chequea `disabled` (Firebase ban no efectivo 60min). Fix: agregar `if (user.disabled) throw ...`.
- [ ] **MED-6-33** Sin UI "logout everywhere" (multi-device hijack). Fix: botón en Config → Cloud Function `revokeAllTokens` con `admin.auth().revokeRefreshTokens(uid)`.
- [ ] **MED-6-35** checkUsername / use NO atómico. Fix: TX con read del username + create users/{uid} en mismo doc.
- [ ] **MED-6-36** applyReferral acepta zero-width chars + RTL marks. Fix: normalize().replace(/[​-‏﻿]/g, '') antes de comparar.
- [ ] **MED-6-27** logError no scrub email/phone/name. Fix: extender regex en `scrubPII()` con email + tel internacional.
- [ ] **MED-1-1** `mineCube` actualiza `lastMineAt` sólo en alreadyMined, no en rate_limited → bot puede burst. Fix: setear `lastMineAt` también en branch rate_limited.

---

## 🟢 LOTE 8 — Frontend UX cleanup (semana 8, ~2h)

- [ ] **MED-4-17** Dead code ~1200 LOC + ~650KB deps (MassiveCube, ThreeSetup, @react-three/fiber, @react-three/drei). Fix: borrar con confianza + `npm uninstall`. Verificar no roto con `expo export`.
- [ ] **MED-4-18** ImagePicker pide AMBOS permisos (gallery + camera) cuando sólo uno se usa. Fix: `mediaTypes: 'photo'` + remover CAMERA del manifest.
- [ ] **MED-4-21** No hay teardown audio en signOut (~5MB residente). Fix: `audioManager.cleanup()` en signOut handler.
- [ ] **MED-4-22** Logout NO cierra modales. Fix: `OverlayModalsProvider.closeAll()` en signOut.
- [ ] **MED-4-23** logError NO redacta wallets como valor (sólo por key name). Fix: agregar regex `0x[a-fA-F0-9]{40}` a scrubPII.
- [ ] **MED-4-26** Auto-claim daily pick sin gesto usuario al cruzar 0 → UX sorprendente. Fix: opt-in setting + confirmación.

---

## 🔵 LOTE 9 — Android manifest hygiene (semana 9, ~1.5h)

- [ ] **MED-9-9** FOREGROUND_SERVICE granted sin declaración de tipo (Android 14+). Fix: declarar `foregroundServiceType` en manifest.
- [ ] **MED-9-10** `BIND_GET_INSTALL_REFERRER_SERVICE` queryable sin propósito (dead permission). Fix: remover del manifest.
- [ ] **MED-9-11** 20+ permisos badge OEM inyectados; ruido tech-savvy users. Fix: `tools:node="remove"` en los OEM unused (Samsung, Huawei).
- [ ] **MED-9-12** `CropImageActivity` exported=true sin intent-filter; accesible vía component name. Fix: `android:exported="false"` o remover si no se usa.
- [ ] **MED-9-13** Intent filter scheme `exp+miningtheblocks` deja fingerprint DEV. Fix: cambiar a `mtb://` puro.

---

## 🔵 LOTE 10 — Build / EAS / CI tweaks (semana 10, ~1.5h)

- [ ] **MED-9-21** EAS profile production no declara `credentialsSource` → builds producción firman distinto. Fix: `credentialsSource: "local"` en eas.json production.
- [ ] **MED-9-22** Triple duplicación exclusiones en 3 archivos. Fix: consolidar en `react-native.config.js`.
- [ ] **MED-9-23** `react-native-svg-transformer` en deps pero no conectado en metro.config.js. Fix: agregar transformer O remover dep.
- [ ] **MED-9-24** `react.edgeToEdgeEnabled` declarado 3 veces (una deprecada). Fix: dejar solo en app.json.
- [ ] **MED-9-31** Sitio web NO muestra SHA-256 APK al user. Fix: agregar `<code>` con SHA en docs/index.html debajo del botón "Descargar".
- [ ] **MED-9-37** ProGuard `-keep class com.bissi.miningtheblocks.** { *; }` muy amplio. Fix: limitar a paquetes específicos (auth, payment) en proguard-rules.pro.
- [ ] **MED-11-19** `service-account*.json` está en `.gitignore` pero NO en `.easignore`. Fix: agregar línea a `.easignore`.

---

## 🟣 LOTE 11 — Push + i18n + Scripts (semana 11, ~2h)

- [ ] **MED-10-12** Backend `sendPushToUser` lee `pushToken` con `|| 'expo'` default legacy. Fix: explicit branch + warn si type missing.
- [ ] **MED-10-13** `pushToken` writable desde cliente sin verificación email. Fix: rule require `request.auth.token.email_verified == true`.
- [ ] **MED-10-14** Sin tracking `permission_denied` para offer re-prompt. Fix: doc `users/{uid}.notifPermissionDenied = Timestamp` cuando user dice no.
- [ ] **MED-10-15** Push token no incluye `appVersion` ni `installId`. Fix: enviar como metadata en `users/{uid}` para debugging.
- [ ] **MED-10-21** Sin pluralización: strings hardcoded con números específicos. Fix: usar Intl.PluralRules + estructura `key.one`, `key.other` en es/en.
- [ ] **MED-10-25** ~6 strings hardcoded fuera i18n. Fix: pase grep + extraer.
- [ ] **MED-10-31** `upload-to-ipfs.js` NO logea qué tier se actualizó. Fix: console.log explícito + audit doc.
- [ ] **MED-10-32** `full_reset_game.js` sin transacción ni rollback. Fix: dry-run flag + confirm + log + try/catch wrap.

---

## 🟤 LOTE 12 — Web / docs hardening (semana 12, ~1.5h)

- [ ] **MED-7-1** `verifyGemCode` usa `setCorsHeaders` con `*` wildcard. Status: dead-code, **verificar y borrar**.
- [ ] **MED-7-2** CSP firebase.json menos estricto que meta tags → divergencia. Fix: unificar — el header HTTP es source of truth.
- [ ] **MED-7-3** `verify.html` NO tiene meta CSP. Fix: agregar meta consistente con header HTTP.
- [ ] **MED-7-4** CSP `img-src 'self' data: https:` wildcard permite exfiltración. Fix: limitar a `https://i.imgur.com https://gateway.pinata.cloud` (lo que se use).
- [ ] **MED-7-5** CSP `connect-src` lista `*.firebaseio.com` (dead-code, Firestore usa otros endpoints). Fix: borrar.
- [ ] **MED-7-6** `claimAdSession` sin Origin enforcement real. Fix: verificar Origin header == allowlist (token entropy ya mitiga).
- [ ] **LOW-7-1** `verify.html` default-SUCCESS en errores no enumerados. Status: hay un comentario CRIT-24 — **verificar implementación real**.
- [ ] **LOW-7-2** Sin logout flow visible en web post-claim. Fix: botón "Cerrar sesión" en verify.html post-success.
- [ ] **LOW-7-4** `?ref=`, `sid`, `t` sin cap longitud antes localStorage. Fix: `.slice(0, 32)` antes de guardar.

---

## ⚫ LOTE 13 — Ops + Performance MED (semana 13, ~2h)

- [ ] **MED-11-10** Backup NO incluye Cloud Storage ni Auth users (incompleto). Fix: extender backup function para hacer `gsutil cp -r` de Storage + `auth.exportUsers()`.
- [ ] **MED-11-17** Sin `gcloud auth` audit ni `firebase login --reauth` periódico. Fix: agregar al protocolo trimestral del playbook.
- [ ] **MED-11-18** No hay `.env.example` documentando vars necesarias. Fix: crear `.env.example` con dummies + comentarios. (**Verificar cierre** — vi en git status que existe ya.)
- [ ] **MED-11-25** `console.warn/error` backend NO escruben PII (URL con oobCode/email). Fix: wrapper `safeLog()` que aplica regex.
- [ ] **MED-11-26** Sin métricas custom de negocio (KPIs en GCP Monitoring). Fix: emitir `monitoring.createTimeSeries` en eventos críticos (signup, payment, mint).
- [ ] **MED-11-27** `reportProblem` emails pueden filtrar como spam sin alerta. Fix: enviar copia a inbox secundario + cron weekly que cuenta reportes vs. emails recibidos.
- [ ] **MED-12-1** `getPeaksStatus` llamado cada navegación sin cache client-side. Fix: `useRef` + cache 30s en cliente.
- [ ] **MED-12-2** Gmail SMTP 500 emails/día limit; a 100k DAU rompe verification. Fix: migrar a Resend / SendGrid cuando volumen >100 emails/día sostenido.

---

## ⚪ LOTE 14 — LOWs cosméticos backend + auth (semana 14, ~1h)

- [ ] **LOW-1-1** `requireRegistered` blacklist solo anonymous; whitelist providers sería más defensivo. Fix: array `ALLOWED_PROVIDERS = ['password', 'google.com']`.
- [ ] **LOW-1-2** `addServerCredit` no valida `targetUid` existe; crea docs fantasma. Fix: `await admin.auth().getUser(uid)` antes de write.
- [ ] **LOW-1-3** `setUserWallet` cooldown bypasseable con set→null→set intermedio. Fix: track `lastWalletChange` independiente de currentValue.
- [ ] **LOW-1-4** `checkUsername` sin rate-limit; permite enumerar usernames. Fix: `_rateLimitFirestore(ip, 'checkUsername', 1000, 10)`.
- [ ] **LOW-1-5** `createAdSession` TTL 24h físico vs 12min lógico. Fix: TTL = 1h.
- [ ] **LOW-1-8** `seededHash` sin guard si `serverSeed=undefined`. Fix: `if (!serverSeed) throw`.
- [ ] **LOW-1-10** `createCryptoPayment` retorna PAYMENT_WALLET cacheada. Fix: usar constants.js como source of truth.
- [ ] **LOW-1-11** `submitGemClaim` no normaliza checksums EIP-55. Fix: `ethers.getAddress(wallet)`.
- [ ] **LOW-1-12** `claimGemNFT` no valida `gemTier ∈ [1,9]` post-read. Fix: assert `tier >= 1 && tier <= 9`.

---

## ⚪ LOTE 15 — LOWs cosméticos frontend / Android (semana 15, ~1h)

- [ ] **LOW-4-35** Magic strings URL dominio hardcoded en 4+ archivos. Fix: constante `MTB_DOMAIN = 'miningtheblocks.com'` en `src/utils/constants.js`.
- [ ] **LOW-4-36** onSnapshot ChainHistory activo mientras user navega lejos. Fix: cleanup en useFocusEffect.
- [ ] **LOW-4-38** Animated.spring no se detiene en cleanup GemPixelArt. Fix: `.stop()` en useEffect cleanup.
- [ ] **LOW-4-41** No hay eslint-plugin-react-hooks. Fix: `npm i -D eslint-plugin-react-hooks` + agregar a `.eslintrc`.
- [ ] **LOW-9-14** Intent filter carece `tools:ignore="AppLinkUrlError"`. Fix: agregar atributo.
- [ ] **LOW-9-15** No declarado `<uses-feature android:name="android.hardware.camera" required="false"/>`. Fix: agregar al manifest.
- [ ] **LOW-9-16** `enableOnBackInvokedCallback="false"` desactiva predictive-back Android 13+. Fix: setear true + verificar no rompe gestos.
- [ ] **LOW-9-27** `requestNonPersonalizedAdsOnly: false` sin gate GDPR/CMP. Fix: leer del cookie consent banner.
- [ ] **LOW-9-34** Pinning de Google CAs comentado. Fix: documentar decisión en RUNBOOK (rotate-risk vs MITM-protection).
- [ ] **LOW-10-17** Audit log `notifyAllUsers` incluye title/body. Fix: solo guardar lengths + hash.
- [ ] **LOW-10-26** Reset idioma persiste AsyncStorage pero Firestore falla. Fix: rollback AsyncStorage en catch.
- [ ] **LOW-10-27** `language === 'es' ? 'es' : 'en'` repetido. Fix: helper `getLang()` exportado.
- [ ] **LOW-10-34** Hardcoded path `/home/code/.config/configstore/firebase-tools.json` en scripts. Fix: `process.env.HOME + '/.config/...'`.
- [ ] **LOW-11-14** Sin `git tag` por release. Fix: incorporar `git tag v1.X.Y` al checklist de release.
- [ ] **LOW-11-20** `NOTIFY_EMAIL` hardcoded; cambiar requiere redeploy. Fix: mover a Secret Manager.
- [ ] **LOW-11-28** Cloud Logging retention 30 días. Fix: aumentar a 90d en GCP (gratis hasta cierto volumen).

---

## 🩷 LOTE 16 — Cleanups gráficos diferidos (semana 16, ~3h, opcional)

Estos son los 7 que documenté en el playbook como deferred. Hacer cuando haya tiempo, no son urgentes — el cubo ya anda bien.

- [ ] **[3]** Raycast result cache (50ms). Mejora "feel" del long-press. 2h.
- [ ] **[6]** Face detection tuple hysteresis. Reduce flicker en grid mode. 1.5h.
- [ ] **[7]** Audio priority queue. Cuando agregues sonidos simultáneos. 2h.
- [ ] **[8]** Render throttle sync con animaciones. Si crack/fragment se ven lentas. 2.5h.
- [ ] **[11]** Tone mapping ACES + sRGB en renderer. 30min. Future-proof PBR.
- [ ] **[12]** Viewport culling every 2 frames. Mejora pan smoothness. 1h.
- [ ] **Split DynamicCube201.js** (5272 líneas → módulos). 6-8h. Solo cuando v1.2.x estable.

---

## 💗 Items externos / triggers de volumen

**No accionables ahora — esperan trigger.**

- [ ] **HIGH-7 MICA + Howey legal** — consulta abogado crypto Argentina (USD 500-2k). Trigger: revenue >USD 50k/mes O expansión EU/US explícita. Documentado en OPERATIONS_PLAYBOOK §Anual.
- [ ] **Audit externo del contrato** Sherlock / Code4rena (USD 1-3k). Trigger: TVL >USD 10k O volumen mensual mints >USD 30k. Documentado mismo lugar.

---

## 🚫 Decisiones aceptadas (NO accionables)

Items del audit que decidiste **NO** atender, con razón. Para que tu yo del futuro entienda por qué no están en backlog.

| Item | Razón |
|---|---|
| Lista de 13 países prohibidos en TOS | "olvidate, no promociono en ninguno de esos paises" — el modelo ya tiene fricción de entrada implícita |
| App Check obligatorio | Trade-off: complica sideload. Mantener mientras sea APK only. Reabrir si Play Store. |
| Workload Identity Federation en CI | Overkill para single-operator. Mantener Service Account dedicado documentado en RUNBOOK. |
| SBOM SLSA provenance | Overkill para v1.x. Reabrir cuando audit Sherlock lo requiera. |
| `expo-three` deprecation | Ya hecho — migrado a `THREE.WebGLRenderer` nativo. |
| Pluralización RTL prep | Sin demanda real RTL todavía. Reabrir si user reporta. |

---

## 📈 Métricas de progreso

Actualizar cada vez que se cierra un lote.

| Lote | Status | Commit | Fecha |
|---|---|---|---|
| 1 — Seguridad backend crítica | pending | — | — |
| 2 — Validación + invariantes | pending | — | — |
| 3 — Wallet + payment | pending | — | — |
| 4 — Compliance Play Store | pending | — | — |
| 5 — Privacy / Legal docs | pending | — | — |
| 6 — Auth sessions cleanup | pending | — | — |
| 7 — Defense in depth auth | pending | — | — |
| 8 — Frontend UX cleanup | pending | — | — |
| 9 — Android manifest | pending | — | — |
| 10 — Build / EAS / CI | pending | — | — |
| 11 — Push + i18n + scripts | pending | — | — |
| 12 — Web / docs hardening | pending | — | — |
| 13 — Ops + Perf MED | pending | — | — |
| 14 — LOWs backend / auth | pending | — | — |
| 15 — LOWs frontend / Android | pending | — | — |
| 16 — Cleanups gráficos | pending | — | — |

---

## 🔄 Flujo recomendado cada lunes

1. **Revisión semanal del playbook** (15-20 min): Sentry, Firebase logs, balances, GitHub.
2. **Si hay alertas 🚨**: pausar y atender (trigger reactivo).
3. **Si no hay alertas**: agarrar el próximo lote pending de este backlog.
4. **Trabajar el lote** ~1-2h: leer items → fix → commit por item.
5. **Test**: `cd functions && npm test && npm run lint`.
6. **Push** + verificar CI verde.
7. **Update este doc**: tachar items completados + setear lote como `✅ DONE 2026-XX-XX commit_hash`.

Si un lote te lleva más de 2h → no lo termines de una; partilo en 2 semanas. Mejor ritmo sostenible que esfuerzo en spike.

---

## 📞 Referencias

- [OPERATIONS_PLAYBOOK.md](OPERATIONS_PLAYBOOK.md) — protocolo de revisiones periódicas
- [RUNBOOK.md](RUNBOOK.md) — disaster recovery
- [audit_2026_06_14_round2/](audit_2026_06_14_round2/) — reports originales con detalle técnico
- [audit_2026_06_21_pre_release/PENDING_FIXES.md](audit_2026_06_21_pre_release/PENDING_FIXES.md) — estado final pre-release

**Para detalle técnico de un item**, abrí el report del agente correspondiente (#1-#12). Cada item tiene contexto + repro + fix sugerido.
