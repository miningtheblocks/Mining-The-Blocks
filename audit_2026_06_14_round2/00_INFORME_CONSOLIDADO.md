# Auditoría Round 2 — Informe Consolidado

**Fechas:** 2026-06-14 / 2026-06-15
**Cobertura:** **12 agentes especializados (1-12)** ejecutados en serie con autorización entre cada uno. Plan original completado al 100%.
**Estado base:** post 6 rondas previas + migración a `miningtheblocks.com` + bump dependencies (firebase-admin v12→v13, eslint v8→v9 flat config).

## Totales agregados

| Agente | CRIT | HIGH | MEDIUM | LOW | INFO | Total |
|--------|------|------|--------|-----|------|-------|
| #1 Backend Cloud Functions | 3 | 13 | 20 | 16 | 9 | **61** |
| #2 Firestore Rules + Indexes | 1 | 5 | 7 | 4 | — | **17** |
| #3 Smart Contract MTBGems | 6 | 10 | 13 | 15 | 7 | **51** |
| #4 Frontend RN (sin Cube201) | 6 | 10 | 11 | 16 | 3 | **46** |
| #5 Rendering 3D Cube201 | 5 | 12 | 17 | 12 | 5 | **51** |
| #6 Auth + Sessions + Claims | 5 | 12 | 15 | 13 | 6 | **51** |
| #7 Web app (docs/* + public/*) | 0 | 5 | 7 | 13 | 12 | **37** |
| #8 Crypto Payments + NFT E2E | 6 | 11 | 12 | 4 | 2 | **35** |
| #9 Android nativo + EAS Build | 2 | 9 | 12 | 13 | 6 | **42** |
| #10 Push + i18n + Scripts + Compliance | 5 | 12 | 14 | 11 | 4 | **46** |
| #11 Operacional: backups, DR, monitoring, CI | 6 | 11 | 14 | 9 | 5 | **45** |
| #12 Performance / Scalability / Cost | 6 | 11 | 13 | 9 | 7 | **46** |
| **TOTAL** | **51** | **121** | **155** | **135** | **66** | **528** |

---

## Agente #1 — Backend Cloud Functions

**Top 5 CRIT/HIGH:**
1. **[HIGH-3]** Cliente puede escribir `serverChains/{chainId}/meta/counter` con seq+1, colisionando con backend → activity history pierde unicidad de `seq`. Fix: backend-only seq + rule deny.
2. **[HIGH-4 + MED-8 + MED-9]** `claimGemNFT` y `submitGemClaim` aceptan wallet del body → bypassan cooldown anti-hot-swap de `setUserWallet`. Fix: forzar `wallet = users/{uid}.walletAddress` server-side.
3. **[HIGH-12]** `SERVER_SEED` es global. Leak → todos los premios de todos los servers revelados. Fix: `effectiveSeed = HMAC(SERVER_SEED, serverId)`.
4. **[CRIT-1]** docId `mined/{N}` no incluye `K` (capa) → potencial data mixing entre capas. Fix: `mined/{K}_{N}`.
5. **[MED-3 + HIGH-1]** Auto-mint de gemas en `mineCube` (líneas 791-835) NO transaccional → fallo de red puede dejar gemas perdidas sin recovery.

**Patrones positivos (15):** idempotency keys deterministicas, requireAdminFresh, transacciones bien estructuradas, HMAC-SHA256, rate-limiting Firestore, SAFE_CONFIRMATIONS=30, audit log, TTL en colecciones efímeras, CORS allowlist + Vary, whitelist getServers, esc() consistente, timingSafeEqual, mapeo errores públicos, assertValidId, audit comments.

**15 gaps sin cobertura de test** identificados.

---

## Agente #2 — Firestore Rules + Indexes

**Top 5 CRIT/HIGH:**
1. **[CRIT] `minedAt` vs `ts` schema mismatch** — backend escribe `ts`, cliente ordena por `minedAt` → **feed realtime de cubos minados ROTO** (snapshot vacío siempre).
2. **[HIGH] `settings`/`profile`/`pushNotifications` sin validación** — cliente puede inflar doc a ~1MB.
3. **[HIGH] `usernames.create` bypass con anonymous auth** — si Anonymous Auth está enabled en Console, squatting trivial.
4. **[HIGH] `activityFeed` y `mined` sin cap de read** — cost amplification (cliente authed descarga todo en bucle).
5. **[HIGH] Index faltante para `notifyAllUsers`** — query `[pushToken!=null, orderBy pushToken, __name__]` necesita composite no declarado → primera ejecución falla.

**Patrones positivos (11):** seq+1, doble check history, whitelist updates, anti-reasignación uid, idempotency closing_{N}, collections admin-only segregadas, requireAdminFresh, randomBytes en códigos, CORS allowlist.

**15 paths sin cobertura de test**.

---

## Agente #3 — Smart Contract MTBGems.sol

**Top 5 CRIT:**
1. **[CRIT-1] Owner EOA único — sin multisig.** Si `COMPANY_WALLET_KEY` se filtra: mint infinito de tier-1 ($100k nominal), pause, transferOwnership.
2. **[CRIT-5] Pinning IPFS en un solo proveedor (Pinata).** Cuenta caduca/cierra/DMCA → todos los NFTs sin imagen.
3. **[CRIT-2] Sin supply cap on-chain.** La escasez declarada en metadata (1 tier-1, ... 10000 tier-9) **NO está enforced**. Owner malicioso → dilución infinita.
4. **[CRIT-6] `tx.wait()` sin confirmations explícitas.** Vulnerable a reorgs Polygon (hasta 100 bloques históricos).
5. **[CRIT-4] Race condition de nonce** entre `processPendingMints` (manual) y `mintProcessorScheduled` (cron).

**Ventana de oportunidad:** 0 NFTs minteados → redeploy trivial. Plan migración a multisig: 4 fases (preparación → deploy → cutover → hardening), ~1-2 semanas. Pre-launch checklist obligatorio de 19 items.

**Patrones positivos (10):** CEI + nonReentrant correctos, renounceOwnership disabled, `++_nextTokenId` (IDs desde 1), ERC721Pausable canónico, eventos GemMinted indexed, processedTxs idempotency, HMAC-SHA256 SERVER_SEED, validación robusta en runMintProcessing, cooldown 24h setUserWallet, IPFS CIDv1.

---

## Agente #4 — Frontend React Native (sin Cube201)

**Top 5 CRIT:**
1. **[CRIT-FE-01]** Push token sin opt-in del user — `App.js:190-235`. Permiso pedido auto sin contexto; toggles de Config son cosméticos.
2. **[CRIT-FE-04]** Wallet input pisado por snapshots en Profile — `Profile.js:29-34`. Data loss en flow crítico de seguridad.
3. **[CRIT-FE-02]** AppState listener en GetPeaks sobrevive al unmount — `GetPeaks.js:151-156`. Leak potencial permanente.
4. **[CRIT-FE-06]** Override global de `console.log` a nivel módulo — `DynamicCube201.js:25-32`. Anti-pattern + HMR cadena infinita + dead code en prod.
5. **[ALTO-FE-11]** UpdateModal NO valida `userinfo`/`port`/`pathname` en `downloadUrl` — bypass de última línea de defensa contra APK malicioso.

**Otros importantes:**
- Profile listener con auth.currentUser stale → cross-user data leak potencial
- Registration username/referral debounce race
- BuyCredits restore desde cache pierde amount+wallet
- **~1200 LOC de dead code** + ~650KB de deps innecesarias (`@react-three/fiber`, `@react-three/drei`)
- Audio sigue tras signOut; logout NO cierra modales

**Patrones positivos (12):** anti-downgrade, logError con scrub+cap+dedupe, ErrorBoundary stack oculto, OverlayModalsProvider lazy-mount, ServerContext cleanup, AudioManager cap 8, validación ETH regex, i18n persistido, allowlist UpdateModal, cooldown applyReferral, reset password sin enumeration.

**6 memory leaks. 8 async races. 0 tests automatizados** (deuda técnica significativa).

---

## Agente #5 — Rendering 3D DynamicCube201

**Top 5 CRIT:**
1. **[CRIT-1] Schema `ts` vs `minedAt` — multijugador NO funciona realmente.** Solo aparenta funcionar por optimistic local update. Confirma hallazgo del Agente #2. Fix de 1 línea.
2. **[CRIT-2] Render loop sobre GL context muerto al navegar.** Manifesta como "la app se cuelga al volver".
3. **[CRIT-3] `_numMeshPool` global corrompido entre remounts.** Pool sobrevive unmount pero `scene.traverse` dispone los materials.
4. **[CRIT-4] `getFaceRange()` en JSX itera 240k entries por re-render** — 14M iter/seg durante pan. Datos ya cacheados en `faceRangesRef`. Fix trivial.
5. **[CRIT-5] `addDarkPatch` aloca PlaneGeometry + Material por cada celda minada** — en endgame (~50k cells) cientos de MB de VRAM. **OOM en Adreno 5xx / Mali-G52**.

**10 memory leaks. 8 frame perf issues.**

**Patrones positivos (13):** scratch vectors módulo (`_sv1`-`_sv12`), `sharedNumberPlaneGeo` protegida, raycaster singleton, throttling 60/30/15 FPS, renderPaused en background, cleanup dispose recursivo con guard, optimistic + revert, watchdog timeout, bitmap font inline, InstancedMesh `needsUpdate` correcto.

---

## Agente #6 — Auth + Sessions + Claims

**Top 5 CRIT:**
1. **[CRIT] `sendVerificationEmail` SIN rate-limit** — bombeable, puede **suspender el Gmail app-password compartido** → outage TOTAL de emails (verify + alerts + claim + reportProblem). Fix de 1 línea.
2. **[CRIT] `verifyIdToken` SIN `checkRevoked` en `submitGemClaim`** (operación tier-1 = $100k). Token revocado válido 60min → ventana de account takeover.
3. **[CRIT] Password reset NO revoca tokens NI notifica al user original.** Account-takeover playbook clásico. Estándar incumplido.
4. **[CRIT] `requireRegistered` acepta providers desconocidos sin email check.** Frágil ante Anonymous Auth o providers futuros.
5. **[CRIT] `verify.html` en `web.app` mientras API key restrictions cubren `.com`** — outage silencioso potencial.

**Otros importantes:**
- `checkRevoked` ausente en createCryptoPayment, claimGemNFT, mineCube
- `processPendingMints` NO logea en `adminActions`
- `grant_admin.js` usa firebase-tools access_token (footgun: malware en máquina dev → OWNER del proyecto)
- Cold-start NO hace `u.reload()`
- Firestore rule usernames regex NO anchored
- **Sin App Check** — APK reverse-engineering trivial
- **Sin self-serve account deletion** (compliance Play Store/GDPR)
- **Sin "logout everywhere"**

**Patrones positivos (14):** requireAdminFresh con getUser, setCustomUserClaims solo CLI, adminActions audit, cooldown 24h wallet, anti-enumeration reset password, Bearer + ownership submitGemClaim, whitelist rules, _rateLimitFirestore, createElement en verify.html, timingSafeEqual, email_verified en usernames rule, logError scrub PII parcial, keep_signed_in defensivo, rules.test.js sólido.

**Privilege escalation:** ninguna ruta directa. Vector real: malware en máquina del dev → firebase-tools access_token.

---

## Agente #7 — Web app (docs/* + public/*)

**0 CRIT — buenas noticias. Top 5 HIGH:**
1. **[HIGH] `docs/adpick.html` Ad script same-origin** — el ad de effectivecpmnetwork puede leer sessionStorage, robar tokens, defacear. Sandbox iframe imprescindible.
2. **[HIGH] `docs/index.html` `'unsafe-inline'` invalida el CSP** — meta tag declara políticas pero unsafe-inline + JS inline + onclicks vuelve CSP **funcionalmente decorativo** contra XSS.
3. **[HIGH] Firebase SDK desde gstatic SIN SRI** — vector de supply chain en página de claims hasta $100k.
4. **[HIGH] Ad network script sin SRI ni sandbox** (compuesto con #1).
5. **[HIGH] `verify.html` helper `el(..., {html: ...})`** expone innerHTML sink, solo el comentario lo "protege".

**Otros:**
- `verifyGemCode` usa CORS wildcard `*` — inconsistencia trivial
- `verify.html` NO tiene meta CSP — depende 100% del header
- **`verify.html` default-SUCCESS en errores no enumerados** — CRIT-24 documentado como "default-deny" pero el código es default-success (UX bug con consecuencias de seguridad)
- Sin logout flow web post-claim

**Patrones positivos (14):** Bearer auth (CSRF imposible), allowlist origins, `rel="noopener noreferrer"`, frame-ancestors none, referrer policy, regex ETH estricta, textContent consistente, createElement en verify.html, rate limits, timingSafeEqual, 192-bit entropy tokens, ownership check, HSTS GitHub Pages + Firebase, Permissions-Policy.

**Veredicto:** _"Listo para producción contra XSS/CSRF directos. Las 5 HIGH no son explotables sin evento externo (compromise CDN/ad/refactor)."_

---

## Agente #8 — Crypto Payments + NFT Claim End-to-End

**Top 5 CRIT (+1):**
1. **[CRIT] `tx.wait()` sin confirmaciones** en runMintProcessing — NFTs marked complete pueden no existir on-chain post-reorg.
2. **[CRIT] `status:processing` sin timeout** → si mintProcessor crashea, docs stuck eternamente → **gemas perdidas silenciosamente**.
3. **[CRIT] Race de nonce** entre `processPendingMints` (admin) y `mintProcessorScheduled` (cron) → backlog + MATIC quemado.
4. **[CRIT] Sin checkpoint de bloque + ventana solo 200 bloques** — scheduler atrasado >6.6 min → **pagos USDC legítimos perdidos silenciosamente**.
5. **[CRIT] No existe `markRedeemed` automatizado** — admin paga manualmente, marca a mano → **doble-pago humano de hasta $100k**.
6. **[CRIT extra]** Reorg Polygon profundo puede revertir pago acreditado sin desacreditar picks.

**Pérdidas potenciales identificadas:**
- Admin double-paga: **MEDIA-ALTA prob × $100k tier-1**
- Admin wallet compromise: MUY BAJA × **$1.5M+ (todo PAYMENT_WALLET + créditos infinitos)**
- Reorg revierte pago: BAJA × $500-2k/incidente
- Pago fuera de ventana 30min: MEDIA × $15 + soporte
- DoS amount slots (99 espacios): MEDIA × revenue/hora

**Race conditions: 8 identificadas. 5 cubiertas, 2 parciales, 1 pendiente.**

**Patrones positivos (17):** runTransaction consistente, docId determinístico, processedTxs/{txHash} con TTL, SAFE_CONFIRMATIONS=30 (insuficiente), CEI + nonReentrant, renounceOwnership disabled, pause()/unpause(), requireAdminFresh, whitelist Firestore, cross-uid check en submitGemClaim, randomBytes gemCode, HMAC-SHA256, adminActions log, TTL collections efímeras, backup diario, validación COMPANY_WALLET_KEY format, rate-limits Firestore.

**Pre-launch checklist: 24 items obligatorios.**

---

## Agente #9 — Android nativo + EAS Build + APK release

**Top 2 CRIT + Top 5 HIGH:**
1. **[CRIT-09-01] UpdateModal allowlist EXCLUYE el host real del APK** — `src/components/UpdateModal.js:29-35`. El sitio sirve el APK desde `github.com/miningtheblocks/Mining-The-Blocks/releases/...`, pero el allowlist solo acepta `miningtheblocks.com` y `miningtheblocks.github.io`. Cuando llegue una update, el botón cae al fallback `https://miningtheblocks.com/` y nunca lleva al user al APK directo → pánico + Google search + APKs falsos.
2. **[CRIT-09-02] `verifyAppSignature` trivialmente bypasseable** — ProGuard hace `-keep class com.bissi.miningtheblocks.** { *; }` preservando el método con nombres originales. Defense-in-depth débil, no garantía. Para real anti-tamper: App Check + verificación server-side de install signature via FCM token attestation.
3. **[HIGH-09-19] `.easignore` NO excluye `*.jks`** → `eas build` desde local sube la keystore JKS a EAS Cloud. CRIT operacional. Fix de 1 línea.
4. **[HIGH-09-04] Intent filter `exp+miningtheblocks://` scheme-only sin autoVerify** → app maliciosa puede secuestrar el deep link. Riesgo bajo hoy (handler solo abre modal), frágil ante uso futuro con tokens.
5. **[HIGH-09-05] `index.js` importa `react-native-gesture-handler` pero el módulo está excluido del autolinking** — 3 archivos lo desactivan. Inconsistencia que puede romper `<Drawer>` en runtime.

**Otros importantes:**
- AD_ID + Privacy Sandbox permissions inyectadas sin disclosure explícito (HIGH-09-06)
- CAMERA permission llega por expo-image-picker — Play Store mostraría warning (HIGH-09-07)
- RECEIVE_BOOT_COMPLETED auto-registrado sin uso real → asusta a sideload users (HIGH-09-08)
- `eas.json` production = AAB pero distribución es APK → confusión (HIGH-09-17)
- No hay verificación CI del SHA-256 del APK (HIGH-09-30)
- 20+ permisos badge OEM inyectados pero `shouldSetBadge:false` → ruido (MED-09-11)
- `verifyAppSignature` catch genérico → bypass total con Throwable plantado
- Keystore JKS en working tree (no en git) — riesgo operacional

**Datos verificados:** SHA-256 del APK matchea el `.sha256` committeado. Keystore confirmado fuera de git history. Manifest release: `targetSdkVersion=36`, `minSdkVersion=24`, `versionCode=5`, `versionName="1.1.0"`.

**Patrones positivos (15):** allowBackup/cleartext/dataExtractionRules hardening, signing fail-early, V2/V3/V4 signing only, Expo Updates disabled, anti-tamper signature check, R8+shrinkResources, ProGuard reflection-keeps correctos, strip-console con exclude error/warn, APK SHA publicado, etc.

---

## Agente #10 — Push notifications + i18n + Scripts admin + Compliance

**Top 5 CRIT:**
1. **[CRIT-10-01] `notifyAllUsers` ROTA silenciosamente** — `functions/index.js:1647-1655`. Manda tokens FCM al endpoint Expo Push API, que responde error sin tirar excepción → log dice "sent=N" cuando fueron 0. La única broadcast feature del producto NO entrega ningún mensaje. Fix: ramificar por `pushTokenType` como hace `sendPushToUser`.
2. **[CRIT-10-02] Toggles de notificación en Config.js son 100% cosméticos** — confirma y AMPLÍA [CRIT-FE-01] del #4. El backend NUNCA lee `settings.notify*`. Dark pattern explícito. Implicancia: rechazo automático Play Store + reportable a UE/GDPR.
3. **[CRIT-10-03] `sendPushToUser` y `notifyAllUsers` NO limpian tokens inválidos** — cross-user leak en device compartido + cost amplification + abuse vector si malware spoofea tokens.
4. **[CRIT-10-04] `i18n.t()` SIN motor de interpolación** — 17 call sites reimplementan `.replace('{n}', value)` con riesgo de reentrancia. 2 claves faltantes confirmadas (`profile.walletCooldown`, `profile.emailNotVerified`) — usuarios ven el key literal.
5. **[CRIT-10-05] Scripts admin cargan `firebase-tools.json` con OAuth = Owner del proyecto** — confirma + AMPLÍA #6. Path hardcoded del dev local + `operator: process.env.USER` spoofeable. Compromise = pwn total (Secret Manager + Firestore + billing).

**Otros importantes:**
- **0 `accessibilityLabel`** en toda la app salvo 2 líneas en ServerList — bloqueante Play Store / European Accessibility Act (MED-10-43)
- Contrastes sub-WCAG-AA en Login/Config (`#555` on `#0a0a0a`, ratio ~3.5:1) (MED-10-45)
- Touch targets sub-44pt (MED-10-44)
- Privacy policy omite Cloudflare + GitHub como sub-procesadores; sin SCC disclosure (HIGH-10-36)
- `terms.html` 14.3 inglés lista "CNZF — Centro Nacional de Zonas Fuera (Argentina)" — **organización inventada**, riesgo legal (MED-10-41)
- Inconsistencia retención: privacy dice 5 años, terms dice indefinidamente (MED-10-39)
- USA listado como prohibido pero CCPA disclosure presente (MED-10-40)
- Sin self-serve account deletion in-app (HIGH-10-38) — bloqueante Play Store policy desde mayo 2024
- Push channels Android: 1 solo (`default`) — sin granularidad por tipo (HIGH-10-10)
- Push payload sin `data: {}` → tap NO deep-linkea a screen relevante (HIGH-10-09)
- `notifyAllUsers` rate-limit 1/h no previene first malicious broadcast (HIGH-10-08)

**Patrones positivos (12):** Audit log notifyAllUsers, rate-limit 1/h, pagination defensiva, token validation typeof+length, i18n persistido AsyncStorage+Firestore, fallback EN→key, `_confirm.js` exige project name, `delete_users.js` triple gating, `delete_servers.js` sin substring match (CRIT-27 cerrado), `reset_server.js` paginación con startAfter, IPFS CIDv1 en upload script, `terms.html` cláusula responsible gambling.

---

## Agente #11 — Operacional: backups, DR, secrets, monitoring, CI/CD

**Top 5 CRIT:**
1. **[CRIT-11-01] Backup Firestore declarado pero NUNCA verificado** — `firestoreBackupScheduled` (functions/index.js:1697-1714) exporta a bucket sin garantía de existencia, sin lifecycle, sin encryption-at-rest CMEK, sin verificación de integridad, sin restore test. RPO=24h, RTO=DESCONOCIDO.
2. **[CRIT-11-02] CERO alerting operacional** — backup falla silenciosamente, MATIC balance sin alert, pendingMints stuck sin alert, email bombing sin alert, budget overrun sin alert, RPC outage sin alert. Outages se descubren via Twitter del cliente.
3. **[CRIT-11-03] `firebase-tools.json` = roles/owner reusado en TODOS los scripts admin** — un solo compromise = pwn total (Secret Manager + Firestore + billing). Sin separación de roles, sin alerting de uso, sin SA dedicado.
4. **[CRIT-11-04] Keystore JKS sin backup offline DOCUMENTADO** — pérdida = end of life del producto (no se puede shipear update). `ACCIONES_MANUALES.md` recomienda "3 copias offline" sin runbook ni `sha256sum` documentado. Naming con typo `@miningtheblock__miningtheblocks.jks` (doble underscore).
5. **[CRIT-11-05] `SERVER_SEED` NO rotable por diseño** — leak es retroactivo + futuro permanente. Recomienda P0 implementar `effectiveSeed = HMAC(SERVER_SEED, serverId+episode)` para limitar blast radius.

**Otros importantes (11 HIGH + 14 MEDIUM):**
- Sin staging environment, restore solo testeable en prod (HIGH-11-09)
- CI NO construye APK ni firma — solo lint+tests+secret scan (HIGH-11-29)
- Branch protection no confirmada en `master` (HIGH-11-30)
- `errorLog` y `adminActions` write-only sin reader programático (HIGH-11-21, 11-22)
- Sin Sentry/Crashlytics/APM (HIGH-11-23)
- Sin status page público (HIGH-11-24)
- Sin pre-commit hooks (`.husky/` ausente) (HIGH-11-31)
- Sin gitleaks/trufflehog — secret scan DIY (HIGH-11-32)
- TTL NO configurado en Console (`errorLog`, `rateLimits`, `processedTxs`, `adSessions`, `activityFeed`) (HIGH-11-39, 11-40)
- `.easignore` NO excluye `service-account*.json` (HIGH-11-19, extiende #9)
- Sin runbook escrito (`RUNBOOK.md`, `OPERATIONS.md`, `INCIDENT.md`) (HIGH-11-44)

**Matriz de DR:** 14 escenarios con probabilidad, impacto $, tiempo recovery (con/sin runbook). **4 escenarios "N/A — irreversible"** (CONTRACT, ALL-SECRETS, KEYSTORE, SEED leak). **9 escenarios recoverables con runbook** que no existe.

**Patrones positivos (12):** backup scheduler existe, secrets en Secret Manager, adminActions audit log, errorLog dedupe+cap, requireAdminFresh, `_confirm.js` gating, `.gitignore` exhaustivo, CI security-checks job, Dependabot configurado, SECURITY.md con SLAs, CI permissions least-privilege.

---

## Agente #12 — Performance / Scalability / Cost

**Top 5 CRIT/HIGH:**
1. **[CRIT] `mineCube` TX contention bomb** — 100 users minando mismo server = 400 writes/sec acercándose al límite project-wide 500W/sec. Endgame K=0 (6 cubos) genera contention storm.
2. **[CRIT] `activityFeed` sin TTL ni filtro** — cada gem_found/layer_complete/player_joined es 1 write → broadcast a TODOS los clientes con ActivityScreen abierta. Cumulative growth.
3. **[CRIT] `maxInstances: 10` soft caps backend a ~10 RPS sostenido** — backpressure visible a 10k DAU con notification spike.
4. **[CRIT] DynamicCube201 layers listener sin limit** — suscribe a TODA `servers/{id}/layers` (hasta 101 docs en server progresado).
5. **[CRIT] Schedulers always-on** — 288 invocations/día cada uno aun con queue vacía + RPC calls publicnode.com sin SLA.

**Tabla de costos por escala:**
| Escala | Realista | Optimista | Pesimista |
|---|---|---|---|
| 100 DAU | ~$1.50/mes | $1 | $3 |
| 1k DAU | ~$15-20/mes | $10 | $40 |
| 10k DAU | **~$185-205/mes** | $90 | **$700** |
| 100k DAU | ~$1850-2080/mes | $850 | $8,000+ |

**Gap optimista vs pesimista = 3-9× — completamente accionable.**

**Top 5 optimizaciones por ROI:** TTL `activityFeed` (2h, ahorra $30-100/mes @10k DAU); eliminar double-read `servers` (1h, $20-50/mes); self-throttle schedulers (30min, $5/mes); distributed counter en `layerRef.stats.mined` (4-6h, evita timeout en endgame); migrar a Alchemy + alert MATIC balance (2h).

---

## Síntesis transversal (post-12 agentes)

### 4 hallazgos críticos confirmados por múltiples agentes

1. **`minedAt` vs `ts` schema mismatch** (Agentes #2 + #5 + #12) — multijugador no funciona realmente. Fix de 1 línea.
2. **`tx.wait()` sin confirmaciones** (Agentes #3 + #8) — NFTs marked complete pueden no existir.
3. **Race de nonce en mint processor** (Agentes #3 + #8) — admin manual vs scheduler.
4. **`firebase-tools.json` = pwn total** (Agentes #6 + #10 + #11) — Owner del proyecto reutilizado en TODOS los scripts admin.

### Temas recurrentes (>=3 agentes)

- **Falta `checkRevoked` en `verifyIdToken`** en operaciones críticas (Agentes #6 + #8)
- **Wallet hot-swap bypass** via wallet del body (Agentes #1 + #6 + #8)
- **App Check ausente** — APK reverse-engineering trivial (Agentes #6 + #8 + #9)
- **Sin self-serve account deletion** — bloqueante Play Store/GDPR (Agentes #6 + #10 + #11)
- **Dead code masivo** ~1200 LOC + 650KB deps (Agentes #4 + #5)
- **0 tests cliente** (Agentes #4 + #5 + #11)
- **Sin alerting** en flows críticos (Agentes #6 + #8 + #11)
- **TTL no configurado en Console** (Agentes #6 + #11 + #12)

### Riesgos máximos en términos monetarios

| Riesgo | Prob | Impacto |
|--------|------|---------|
| `firebase-tools.json` leak → pwn total | MEDIA | **$1.5M+ / catastrófico** |
| Admin double-paga sin markRedeemed | MEDIA-ALTA | **$100k/incidente** |
| Wallet admin compromise + addServerCredit ilimitado | MUY BAJA | **$1.5M+** |
| Owner EOA del contrato compromised | BAJA-MEDIA | Mint infinito tier-1 |
| Keystore JKS pérdida | MEDIA | End of life del producto |
| `sendVerificationEmail` bombing → Gmail suspended | MEDIA | **Outage operacional total** de emails |
| Mint marked complete pero no en chain | BAJA | $15-100k por gema |
| `SERVER_SEED` leak (no rotable) | BAJA | $50k-500k drenados via mineo informado |
| Cloudflare account compromise | BAJA | Phishing APK; firma keystore protege |
| GitHub account compromise | BAJA | APK falso en Releases v1.x |

### Compliance / readiness gaps (Play Store / Apple / GDPR)

- 0 `accessibilityLabel` salvo 2 líneas — bloqueante European Accessibility Act + Play Store
- Sin self-serve account deletion — bloqueante Play Store policy desde mayo 2024
- Contrastes sub-WCAG-AA + touch targets sub-44pt
- Privacy policy omite Cloudflare + GitHub como sub-procesadores
- Sin Standard Contractual Clauses disclosure (transferencia datos UE→USA)
- `terms.html` lista organización inventada (CNZF Argentina)
- Inconsistencia retention (5 años vs indefinidamente)
- Push toggles cosméticos (dark pattern)

### Postura operacional (matriz Agente #11)

**4 escenarios irreversibles** sin pre-incident hardening:
- `COMPANY_WALLET_KEY` leak (contrato pwn)
- `firebase-tools.json` leak (proyecto pwn)
- Keystore JKS pérdida (no updates posibles)
- `SERVER_SEED` leak (fairness break retroactivo)

**9 escenarios recoverables** que requieren entre 15min y 8h — pero sin runbook documentado → improvisación.

### Priorización recomendada de fixes

**P0 — Antes del primer flujo de dinero real:**
- Fix `minedAt`/`ts` schema (1 línea)
- `tx.wait(N)` con N≥30 en mint
- Lock distribuido para nonce race
- `markGemRedeemed` Cloud Function
- Rate-limit `sendVerificationEmail`
- Checkpoint de bloque en cryptoPaymentProcessor
- Wallet hot-swap fix (forzar wallet desde user doc)
- **Service Account dedicado** (rol mínimo `Firebase Auth Admin`) para reemplazar `firebase-tools.json` en scripts admin
- **3 backups offline verificados del keystore JKS** + sha256 documentado
- **Budget alerts en Firebase Console** + MATIC balance alert
- **TTL en Console** (activityFeed, errorLog, rateLimits, processedTxs, adSessions)
- **`effectiveSeed = HMAC(SERVER_SEED, serverId+episode)`**
- **Fix `notifyAllUsers` FCM/Expo branch** + token cleanup en `sendPushToUser`
- **Backend respeta `settings.notify*`** (eliminar dark pattern)
- **Fix UpdateModal allowlist** (agregar `github.com` path-check)
- **`.easignore` excluye `*.jks` + `service-account*.json`**

**P1 — Antes de lanzamiento mediático:**
- Multisig Gnosis Safe del contrato (Agente #3 CRIT-1)
- Supply cap on-chain
- IPFS multi-pin
- `checkRevoked` en operaciones críticas
- Password reset con `revokeRefreshTokens` + email notify
- Sandbox iframe del ad network
- SRI en Firebase SDK
- Eliminar `'unsafe-inline'` del CSP
- **RUNBOOK.md con los 5-8 escenarios más probables**
- **Sentry RN integration** (3h, ROI altísimo)
- **Status page público** (1h con betterstack/instatus free)
- **Restore test E2E con staging environment**
- **Branch protection en `master`** (15min)
- **Self-serve account deletion in-app**
- **`accessibilityLabel` en 30 TouchableOpacity críticos + contrastes WCAG AA**
- **`t(key, vars)` con escape + warning sobre keys faltantes**

**P2 — Calidad / cleanup:**
- Eliminar ~1200 LOC dead code
- Tests jest + RN testing-library
- App Check
- "Logout everywhere"
- `processPendingMints` audit log
- Reducir `'unsafe-inline'` en HTMLs
- Pre-commit hooks con husky + gitleaks
- Workflow `deploy.yml` con Workload Identity Federation
- Weekly `errorLog` summary scheduled function
- Weekly `adminActions` anomaly detection
- Documentar restore procedure paso a paso
- Privacy fixes (Cloudflare/GitHub disclosure, SCC, CNZF rewrite, retention align)
- Multi-channel Android push + deeplink payload
- Pluralización i18n + RTL prep

**P3 — Defense in depth:**
- COOP/COEP/CORP headers
- Cache-Control no-store en verify.html
- Permissions-Policy completo
- Report-To monitoring
- SBOM CycloneDX en CI
- Pre-permission UI educativa antes del prompt nativo
- ARCHITECTURE.md
- Provenance SLSA en releases

---

## Veredicto consolidado

**51 hallazgos CRIT** distribuidos en 12 dominios. La mayoría son fixes localizados de pocas líneas; **un puñado son decisiones de producto** (multisig contract, App Check, self-serve account deletion, runbook documentado, separación de roles Owner).

El proyecto está **mejor que el promedio para un single-operator sideload Android con dinero real** — disciplina visible en patterns positivos (149 patrones positivos confirmados across los 12 agentes), comments SEC-/CRIT-/ALTO- documentando rondas previas, tests de helpers + rules, scripts admin con `confirmDestructive`, Secret Manager, audit logs.

**Lo que cierra "shipeable" → "operacionalmente responsable"** son ~2-3 semanas de trabajo focused: P0 técnico (8-10h) + P0 operacional (4-6h) + runbook (4-6h) + monitoring/alerting (3-4h) + multisig migration (1-2 semanas pre-launch real).

Sin esos pasos, el producto es shipeable pero **un solo evento adverso puede ser terminal** (4 escenarios irreversibles documentados).
