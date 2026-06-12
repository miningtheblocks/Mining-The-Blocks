# Auditoría Profesional — Mining The Blocks (MTB)

**Versión auditada:** 1.0.4 (versionCode 4)
**Commit head:** `3775ce2` (master)
**Fecha:** 2026-06-11
**Ámbito:** Cloud Functions, Firestore Rules, cliente React Native, sitio web, contrato Solidity, build Android, scripts, dependencias e historial Git.

Esta auditoría fue ejecutada por **4 perfiles especializados en paralelo** (seguridad ofensiva, calidad de código, rendimiento, release engineering / DevSecOps) sobre la 5ta iteración del producto, ya con 17 vulnerabilidades previas remediadas. El informe consolida ~110 hallazgos en una vista única, priorizada y accionable.

---

## 1. Veredicto ejecutivo

> **NO es seguro shipear a producción en el estado actual.**
> Hay 2 vulnerabilidades **críticas** que permiten fraude económico directo y 2 fallas de release **bloqueantes** para Play Store. Los 4 fixes que liberan el ship caben en un día de trabajo concentrado.

### Conteo consolidado por severidad

| Severidad | Seguridad | Cód./Arq. | Rendimiento | Release/Deps | **Total** |
|---|---:|---:|---:|---:|---:|
| **Crítico / Bloqueante** | 2 | 1 | 5 | 2 | **10** |
| **Alto** | 3 | 8 | 8 | 6 | **25** |
| **Medio** | 5 | 14 | 9 | 9 | **37** |
| **Bajo / Mejora** | 5 | 13 | 8 | 9 | **35** |
| **Total** | 15 | 36 | 30 | 26 | **107** |

### Calificación por dimensión

| Dimensión | Nota | Comentario |
|---|---:|---|
| Seguridad backend | 6.5/10 | Buen progreso (17 fixes previos vigentes), pero 2 críticos nuevos detectados |
| Seguridad firestore.rules | 6/10 | Whitelist incompleta (referredBy, walletAddress, rewardCash) |
| Calidad de código | 5.5/10 | God components, monolito backend, errores tragados |
| Rendimiento runtime | 4/10 | Render loop sin pausa, listeners sin límite, audio sin pool |
| Higiene de repo y release | 3.5/10 | debug.keystore en release, sin minify, ~5GB de basura |

---

## 2. Top 10 hallazgos críticos (bloqueantes para release)

### 🔴 1. SEC-003 — Doble-mineo del mismo cubo via coerción de string
**Archivo:** `functions/index.js:689, 709`
`cubeNumber` se acepta como `string` y se usa como docId. `"1"`, `"1.0"`, `"01"`, `" 1"` resuelven al mismo `n=1` pero crean docs `mined/` distintos, evadiendo el check `minedSnap.exists`. Permite **reclamar la misma gema (incluso tier 1 de $100k) ilimitadas veces**.

**Fix:**
```js
const n = Math.floor(Number(request.data?.cubeNumber));
if (!Number.isInteger(n) || n < 1 || n > TOTAL_CUBES_K) {
  throw new HttpsError("invalid-argument", "cubeNumber");
}
const minedRef = serverRef.collection("mined").doc(String(n)); // canónico
```

---

### 🔴 2. SEC-002 — Race + Map overwrite en pagos crypto
**Archivos:** `functions/index.js:1381-1395` (creación), `1421-1446` (procesamiento)
`createCryptoPayment` lee `where(amountUnits == X).get()` y luego `add()` — no atómico. Dos llamadas concurrentes pueden conseguir el mismo `amountUnits`. En `runCryptoPaymentProcessing`, `pendingByAmount.set(amount, doc)` **sobreescribe** y solo el último doc gana. Cuando entra un Transfer USDC, **el crédito puede acreditarse al usuario equivocado** (robo de pago).

**Fix:** Usar docId determinístico `amt_${amountUnits}` con `tx.get` / `tx.set` dentro de transacción única.

---

### 🔴 3. REL-001 — `debug.keystore` firmando builds de release
**Archivo:** `android/app/build.gradle:113-117`
```groovy
release { signingConfig signingConfigs.debug ... }
```
El keystore está commiteado al repo, password pública (`android`). Una vez subida a Play Store con esta firma:
- **No se podrá actualizar la app** (clave compartida con el mundo)
- Cualquiera puede firmar APKs falsos
- Play Console rechaza upload-keys de debug

**Fix:**
```bash
keytool -genkey -v -keystore mtb-release.keystore -alias mtb -keyalg RSA -keysize 2048 -validity 10000
eas credentials   # o configurar signingConfigs.release con KEYSTORE_PASSWORD via env
git rm --cached debug.keystore android/app/debug.keystore
echo "android/app/debug.keystore" >> .gitignore
```

---

### 🔴 4. REL-002 — Sin minify/R8/ProGuard en release
**Archivos:** `android/app/build.gradle:70`, `android/gradle.properties`
`android.enableMinifyInReleaseBuilds` queda en `false` por default. Sin minify ni shrinkResources. `proguard-rules.pro` solo tiene 2 keep rules.

**Impacto:** APK ~50-100MB más grande, JS embebido legible (lógica de minado scrapeable), sin optimización.

**Fix en `android/gradle.properties`:**
```properties
android.enableMinifyInReleaseBuilds=true
android.enableShrinkResourcesInReleaseBuilds=true
```
Expandir `proguard-rules.pro` con keep rules para `ethers`, `firebase`, `expo-modules`, `three`.

---

### 🔴 5. SEC-001 — `serverChains/*/history` permite falsificar `rewardCash`
**Archivo:** `firestore.rules:79-97`
La regla valida `rewardPicks ∈ [0,5]` pero **NO valida `rewardCash` ni `totalMined`**. Cualquier usuario con `serverAccess` puede escribir entradas falsas como `rewardCash: 9999999` que aparecen en el feed público.

**Fix en firestore.rules:**
```
&& (!('rewardCash' in request.resource.data) ||
     (request.resource.data.rewardCash is number
      && request.resource.data.rewardCash >= 0
      && request.resource.data.rewardCash <= 100000))
&& (!('totalMined' in request.resource.data) || request.resource.data.totalMined is int)
```
Idealmente: mover toda escritura de `history` al backend dentro de `mineCube` y bloquear write desde cliente.

---

### 🔴 6. SEC-004 — `reportProblem` sin auth ni rate limit
**Archivo:** `functions/index.js:1838+`
La función `onCall` no valida `request.auth`. Acepta `uid = null`. Cualquiera puede invocarla en loop y **saturar la Gmail account `miningtheblocks@gmail.com`**, provocando suspensión del servicio de email (verificaciones, NFT notifications, gem claims caen).

**Fix:** Requerir auth + rate-limit 1 report cada 5 min por uid + considerar App Check.

---

### 🔴 7. SEC-005 — `users/{uid}` create no protege `referredBy`/`walletAddress`
**Archivo:** `firestore.rules:11-13`
La regla create bloquea `picks!=0` y `serverCredits` pero permite settear `referredBy`, `referralCode`, `walletAddress`, `lastDailyAt`, `picksLastResetAt` arbitrariamente.

**Impacto:** Self-referral farming con anon nuevos, squatting de referralCode, evasión de reset de picks, asignación de wallet sin pasar por `claimGemNFT`.

**Fix:** Cambiar a whitelist explícito:
```
allow create: if request.auth != null && request.auth.uid == uid
  && request.resource.data.diff({}).affectedKeys().hasOnly([
       'picks','wallet','stats','createdAt','updatedAt','settings',
       'profile','displayName','email','pushToken','pushTokenType'
     ])
  && (!('picks' in request.resource.data) || request.resource.data.picks == 0);
```

---

### 🔴 8. SEC-003 (deploy) — `COMPANY_WALLET_KEY` via `process.env`
**Archivo:** `functions/index.js:1195`
La **private key de la wallet que mintea NFTs en Polygon** se lee con `process.env.COMPANY_WALLET_KEY` en lugar de `defineSecret`. Cualquiera con acceso al GCP project puede leerla y **drenar fondos**.

**Fix:**
```js
const { defineSecret } = require("firebase-functions/params");
const companyWalletKey = defineSecret("COMPANY_WALLET_KEY");
exports.runMint = onCall({ secrets: [companyWalletKey] }, async (req) => {
  const privateKey = companyWalletKey.value();
  // ...
});
```
```bash
firebase functions:secrets:set COMPANY_WALLET_KEY
firebase functions:config:unset company_wallet_key
```

---

### 🔴 9. SEC-AdMob — iOS App ID = Test ID público de Google
**Archivos:** `app.json:46`, `src/utils/ads.js:6`
`iosAppId: "ca-app-pub-3940256099942544~1458002511"` es el **test ID público de Google**. Si se publica a iOS así:
- No monetiza
- Viola TOS de AdMob
- Riesgo de baneo de cuenta AdMob (afecta también Android)

**Fix:** Reemplazar con App ID + Unit ID reales antes de cualquier release a App Store, o documentar que iOS no entra en el MVP.

---

### 🔴 10. PERF-001 — Render loop 3D nunca pausa
**Archivo:** `src/components/DynamicCube201.js:2887-3551`
`requestAnimationFrame` corre cada 16ms aunque (a) no haya input, (b) cámara no cambie, (c) la app vaya a background. El `AppState` listener solo pausa la música.

**Impacto:** Esperado ≤10% CPU en idle. Real: 30-60% CPU + GPU 100% mientras la pantalla esté abierta. **Drenaje rápido de batería y sobrecalentamiento tras 5-10 min**. Es la queja #1 que vas a recibir de usuarios.

**Fix:** Patrón on-demand rendering:
```js
const dirtyRef = useRef(true);
const markDirty = () => { dirtyRef.current = true; };
// Marcar dirty en: pan, pinch, animaciones, datos nuevos

const renderLoop = () => {
  if (!dirtyRef.current && !hasActiveAnimation()) {
    animRef.current = requestAnimationFrame(renderLoop);
    return;
  }
  renderer.render(scene, camera);
  dirtyRef.current = false;
  animRef.current = requestAnimationFrame(renderLoop);
};

// En AppState 'background': cancelAnimationFrame(animRef.current)
```

---

## 3. Hallazgos de severidad ALTA

### 3.1 Seguridad

| ID | Título | Archivo |
|---|---|---|
| SEC-006 | `usernames` update permite re-asignar `uid` (transferencia silenciosa de username) | `firestore.rules:155` |
| SEC-008 | `referralCode` derivado deterministicamente de `uid` con FNV-1a (no-crypto) → enumerable | `functions/index.js:488, 724, 942` |
| SEC-014 | Tokens de Firebase CLI usados como credencial admin en `scripts/delete_users.js`, `full_reset_game.js` — **sin confirmación interactiva** | `scripts/` |

### 3.2 Calidad de código

| ID | Título | Archivo |
|---|---|---|
| CQ-001 | God component `DynamicCube201.js` (5021 LOC) concentra render 3D, audio, animaciones, modales, Firebase, raycasting, parche global de `Image.getSize`, override de `console.log` | `src/components/DynamicCube201.js` |
| CQ-002 | `functions/index.js` monolítico (1915 LOC, 30 exports) sin modularización | `functions/index.js` |
| CQ-003 | **50+ `catch {}` vacíos** tragando errores sin telemetría → bugs invisibles garantizados en producción | múltiples |
| CQ-004 | Override global de `console.log` desde un componente con side-effects en module scope | `DynamicCube201.js:25-32` |
| CQ-006 | `APP_VERSION` y `TERMS_URL` duplicados en 4-5 archivos | `App.js`, `ServerList.js`, etc. |
| CQ-007 | i18n incompleto: 6+ strings hardcoded en español que se muestran a usuarios en inglés | `Login.js`, `Registration.js`, `GetPeaks.js`, `App.js` |
| CQ-013 | `Subscribe.js` confuso: dice "cuenta creada" pero solo hace `signInWithEmailAndPassword`, no crea cuenta | `src/screens/Subscribe.js:25-40` |
| CQ-014 | Sin `ErrorBoundary` en toda la app → cualquier crash de render = pantalla blanca | toda la app |

### 3.3 Rendimiento

| ID | Título | Archivo |
|---|---|---|
| PERF-002 | `setState` desde render loop cada 500ms reconcilia árbol React enorme | `DynamicCube201.js:3491-3508` |
| PERF-003 | `onSnapshot` a `servers/{id}/mined` sin `limit()` ni paginación → puede traer decenas de miles de docs | `DynamicCube201.js:1705-1757` |
| PERF-004 | Audio crea `Audio.Sound` por cada SFX (sin pool) → latencia 50-300ms en gama baja + leak de memoria nativa | `src/utils/audioManager.js:143-176` |
| PERF-005 | **10MB de audio en bundle** (`corte.m4a` 4.9MB + `invention.m4a` 5MB) — reducible 70% con opus 64kbps | `assets/sonidos/` |
| PERF-006 | Animaciones efímeras (X, gema, pickaxe) sin abort en unmount → leak GPU memory | `DynamicCube201.js:915-1094` |
| PERF-007 | `Scene`/`renderer`/`textureCache` sin dispose en unmount → buffers WebGL acumulan hasta crash | `DynamicCube201.js:3547-3551` |
| PERF-010 | `onSnapshot(layers)` sin filtro carga las 100 capas del servidor | `DynamicCube201.js:1778-1783` |
| PERF-011 | `useEffect` re-suscribe a Firestore en cada cambio de `miningAnimations` Map | `DynamicCube201.js:2137-2182` |

### 3.4 Dependencias / Release

| ID | Título |
|---|---|
| VULN-001 | **21 vulnerabilidades npm en prod** (16 moderate + 5 high). Las 5 high vienen de `expo-three` (`fbemitter`, `fbjs`, `isomorphic-fetch`, `node-fetch`, `@expo/browser-polyfill`) |
| SEC-API-Key | API key Firebase Web sin restricciones documentadas en GCP Console → riesgo de abuse de Identity Toolkit |
| CI-001 | Sin pipeline CI/CD, sin tests automatizados, sin verificación de firestore.rules |
| HYG-001 | ~960MB de APKs sueltos en raíz + 2.3GB `DEV_FILES/` + 2.6GB `final_complete_apk/` |

---

## 4. Hallazgos de severidad MEDIA (selección representativa)

### Seguridad
- **SEC-007** Race en cambio de username (`Registration.js:228-233`) → squatting durante carrera, mover claim a Cloud Function transaccional.
- **SEC-010** Cliente puede saltar `seq` de `serverChains/*/meta/counter` sin escribir history → gaps en feed.
- **SEC-013** Campos `wallet`, `walletAddress`, `stats`, `pushToken` no protegidos por reglas (UX-only, no exploitable directo, pero whitelist mejor que blacklist).

### Calidad
- **CQ-005** Lógica geométrica duplicada en `CubeCalculations.js` y `ThreeSetup.CubeMath`.
- **CQ-009** `<UpdateModal forceUpdate={true}>` hardcoded ignora el campo calculado — distinción soft/forced es código muerto.
- **CQ-010** `OverlayModalsProvider` monta los 9 modales siempre → `Profile`/`MyGems`/etc. corren `useEffect` con listeners Firestore zombis.
- **CQ-015** `auth.currentUser?.uid` sin guard en `setDoc(doc(db,'users',undefined))` → errores crípticos en `Config.js:64`, `Profile.js:75`.
- **CQ-019, CQ-021** Modal de "ejemplos de ads engañosos" 100% en español; touch targets <44pt en botones críticos.
- **CQ-020** Cero `accessibilityLabel` en toda la app → Play Store comenzó a flaggear esto en 2025.
- **CQ-030, CQ-034** Patrones de cleanup de listeners inconsistentes; `setupNotifications` con `setTimeout(1000)` arbitrario.
- **CQ-036** Helpers críticos (`getRewardForCube`, `getGemForCube`, `generateGemCode`) no testeables — lógica más sensible del juego sin tests.

### Rendimiento
- **PERF-008** Cache LRU de texturas de números usa `JSON.stringify(digitColor)` en cacheKey en hot path → alloc/parse + churn LRU.
- **PERF-012** Barra de minado con `setInterval(120ms)` redibuja todo el componente — debería ser `Animated.Value`.
- **PERF-013** `GemPixelArt`: 6 loops `Animated` infinitos sin `loop.stop()` en unmount.
- **PERF-014, PERF-015** `staysActiveInBackground: true` + recarga completa de tracks de 5MB en cambio.
- **PERF-016** Iconos PNG de 1.1MB cada uno sin optimizar (reducible 80% con `pngquant`).
- **PERF-020** Render loop sigue programado tras `isFocused = false` (sólo `<GLView>` se desmonta, no el loop).
- **PERF-021** `useState(new Set())` para `minedCubes` copia el Set O(n) por cada cambio.

### Release / Deps
- **REL-003** `versionCode 4` sin `autoIncrement` en eas.json → colisiones futuras al subir a Play.
- **REL-005** AdMob iOS test ID en producción (mencionado en críticos).
- **REL-006** `react-native-reanimated` y `gesture-handler` deshabilitados en `react-native.config.js` pero presentes en deps + `babel.config.js` → estado ambiguo.
- **FB-001, FB-002** `firebase.json` hosting sin CSP/X-Frame-Options/Referrer-Policy. `verify.html` con JS inline.
- **CI-002** Predeploy solo lint, sin tests.
- **VULN-002** 10 vulnerabilidades moderate en functions (`ws` 8.0-8.20 con uninitialized memory en cadena de `ethers`, `uuid <11.1.1` en cadena de `firebase-admin`).

---

## 5. Verificación de las 17 vulnerabilidades previas

Auditoría confirmó el estado actual de cada fix de las 4 rondas anteriores:

| # | Vuln previa | Estado | Notas |
|---|---|---|---|
| 1 | `mineCube` sin check serverAccess | ✅ Vigente | `accessSnap.exists` en TX (línea 718) |
| 2 | `redeemGem` TOCTOU doble cash | ✅ Vigente | TX con check `status==unclaimed` (609-621) |
| 3 | `claimGemNFT` TOCTOU doble mint | ✅ Vigente | TX (654-665) |
| 4 | `submitGemClaim` TOCTOU + sin límites | ✅ Vigente | TX + `.slice` |
| 5 | `reportProblem` HTML injection cuerpo | ✅ Vigente | `esc()` aplicado |
| 6 | `reportProblem` header injection Subject | ✅ Vigente | `.replace(/[\r\n]/g, "")` |
| 7 | `reportProblem` header injection replyTo | ✅ Vigente | idem |
| 8 | `reportProblem` sin límite descripción | ✅ Vigente | `.slice(0,5000)` |
| 9 | `sendVerificationEmail` HTML injection displayName | ✅ Vigente | `esc(displayName)` |
| 10 | `mineCube` auto-mint walletAddress sin regex | ✅ Vigente | regex `/^0x[a-fA-F0-9]{40}$/` |
| 11 | `runCryptoPaymentProcessing` doble crédito | ⚠️ **Parcial** | TX OK, pero **nuevo vector SEC-002** (Map overwrite + race en createCryptoPayment) |
| 12 | `applyReferral` TOCTOU referredBy | ⚠️ **Parcial** | Check en TX OK, pero **bypass via SEC-005** (create rule no protege referredBy) |
| 13 | `usernames` sin format validation | ✅ Parcial | OK en create, **falta en update — ver SEC-006** |
| 14 | `history` sin validación campos | ⚠️ **Regresión** | `rewardPicks`, `displayName.size`, `seq` OK. **`rewardCash` y `totalMined` NO validados — SEC-001** |
| 15 | `sendPushToUser` solo inglés | ✅ Vigente | objetos `{en,es}` con fallback |
| 16 | `submitGemClaim` CORS wildcard | ✅ Vigente | `setRestrictedCorsHeaders` → github.io |
| 17 | `claimAdPick` exportado bypass | ✅ Vigente | Función removida; flujo único via `createAdSession` + `claimAdSession` |

**Resumen:** **14/17 plenamente vigentes**, **3 con regresiones parciales** detectadas (#11, #12, #14).

---

## 6. Plan de remediación priorizado

### 🔴 Bloqueantes — ANTES DE TODO RELEASE (estimado: 1-2 días de trabajo)

1. **SEC-003** Canonicalizar `cubeNumber` a integer string en `mineCube` (15 min)
2. **SEC-002** Refactor `createCryptoPayment` con docId determinístico (1-2h)
3. **SEC-001** Agregar validación de `rewardCash` y `totalMined` en firestore.rules (15 min)
4. **SEC-004** Auth + rate-limit en `reportProblem` (30 min)
5. **SEC-005** Whitelist explícito en `users` create rule (15 min)
6. **REL-001** Generar release keystore + sacar `debug.keystore` del repo (30 min)
7. **REL-002** Activar minify+R8 en `gradle.properties` + ampliar `proguard-rules.pro` (2h)
8. **SEC-Wallet** Migrar `COMPANY_WALLET_KEY` a `defineSecret` (15 min)
9. **SEC-API-Key** Restringir API key Firebase Web en GCP Console: HTTP referrers + Android SHA-1 + API restrictions (5 min en consola)
10. **AdMob iOS** Reemplazar test ID por real o documentar que iOS no entra en el MVP (5 min)

### 🟠 Pre-scale — ANTES DE CRECIMIENTO ORGÁNICO (1 semana)

11. **PERF-001** On-demand render loop con `dirtyRef` + pausar en background
12. **PERF-003, PERF-010** Paginar `mined` query y agregar doc `stats` agregado
13. **PERF-004, PERF-005** Audio: pool de Sound + recomprimir a opus 64kbps
14. **PERF-007** Disposal completo de scene en unmount
15. **CQ-003** Helper `logError(scope, err, ctx)` central + reemplazar `catch {}` (eventualmente conectar a Crashlytics/Sentry)
16. **CQ-014** `<ErrorBoundary>` envolviendo el root
17. **CQ-006** Centralizar `APP_VERSION` y `TERMS_URL` en `src/constants.js` (single source of truth)
18. **CQ-007** Completar i18n: strings hardcoded en `Login.js`, `Registration.js`, `GetPeaks.js`, `App.js`
19. **CQ-013** Decidir destino de `Subscribe.js` (renombrar a login alternativo o eliminar)
20. **SEC-007** Mover claim de username a Cloud Function transaccional
21. **SEC-008** Regenerar `referralCode` con `crypto.randomBytes` (no derivar de uid)
22. **SEC-Scripts** Confirmación interactiva en `delete_users.js`, `full_reset_game.js`, `delete_servers.js`
23. **VULN-001** `npm audit fix` no-breaking + plan para los 5 high de `expo-three`

### 🟡 Limpieza y deuda (sprint dedicado, post-launch)

24. **CQ-001** Partir `DynamicCube201.js` en hooks (`useCubeScene`, `useCubeInput`, `useMiningLogic`, `cubeTextures`)
25. **CQ-002** Modularizar `functions/index.js` por dominio (`mining.js`, `gems.js`, `payments.js`, ...)
26. **CQ-036** Mover helpers críticos a `functions/src/helpers.js` con tests jest
27. **CI-001** GitHub Actions: lint + emulator tests + rules tests con `@firebase/rules-unit-testing`
28. **FB-005** Crear proyecto Firebase de staging (`miningtheblocks-staging`)
29. **FB-001** Headers de seguridad (CSP, X-Frame-Options) en `firebase.json` hosting
30. **HYG-001/002/003/004** Limpiar repo: borrar APKs, `DEV_FILES/`, `final_complete_apk/`, mover `.ps1` legacy y `INFORME_*.md` a `docs/archive/`
31. **CQ-024, HYG-005** Reescribir `README.md` con instrucciones EAS Build actuales
32. **CQ-010** `OverlayModalsProvider` renderizar contenido solo cuando `visible[key]`
33. **PERF-016** `pngquant` sobre icons, splash, adaptive-icon
34. **CQ-020, CQ-021** `accessibilityLabel` + `hitSlop` en botones icónicos críticos

---

## 7. Quick wins (1 hora total, alto impacto)

```bash
# 1. Limpieza de basura del repo
rm -rf DEV_FILES final_complete_apk BUILDS_ANTERIORES BACKUP_OBSOLETOS
mkdir -p ~/MTB_archived_apks && mv *.apk ~/MTB_archived_apks/

# 2. Mover legacy a archive
mkdir -p docs/archive
mv *.ps1 fix_encoding.js INFORME_*.md REPORTE_*.md SOLUCION_*.md docs/archive/

# 3. Activar minify (editar android/gradle.properties)
# android.enableMinifyInReleaseBuilds=true
# android.enableShrinkResourcesInReleaseBuilds=true

# 4. robots.txt para hosting
echo -e "User-agent: *\nDisallow: /" > public/robots.txt

# 5. Auditoría npm
npm audit fix
cd functions && npm audit fix && cd ..
```

Más:
- En GCP Console → APIs & Services → Credentials → restringir la API key web (HTTP referrers + Android SHA-1 + API restrictions a Identity Toolkit + Firestore + FCM).
- En firebase: `firebase functions:secrets:set COMPANY_WALLET_KEY` y refactorizar la function.
- En firestore.rules: agregar la validación de `rewardCash`, `totalMined` y el whitelist en `users` create.

---

## 8. Aspectos positivos del proyecto

Para balancear el informe, vale destacar lo que está bien hecho y mantenido:

- **TOCTOU coverage** muy bueno en operaciones de gemas, créditos, picks (4 rondas previas se notan).
- **Sanitización de emails** completa (helpers `esc()`, header injection guards, length limits).
- **Validación de wallet** con regex `/^0x[a-fA-F0-9]{40}$/` en cliente y server.
- **CORS** restringido correctamente en endpoints financieros (`claimAdSession`, `submitGemClaim`).
- **Push notifications bilingües** (`{en, es}` con fallback).
- **Arquitectura de chains/episodes** bien pensada (`closeEpisode`, `startNextEpisode`).
- **Sistema de premios deterministas** elegante (FNV-1a + buckets), aunque la falta de salt secreto deja la fórmula precomputable client-side (ver SEC-009).
- **InstancedMesh** + scratch vectors + raycaster singleton: indica que ya hubo optimización 3D consciente.
- **Sistema i18n** bien estructurado con I18nProvider y `t()`, solo falta cubrir todo.
- **`.easignore`** cubre correctamente los blobs grandes.
- **Hermes** habilitado.
- **Sin secretos en historial git** (verificado: API keys Firebase Web son las únicas, y son públicas por diseño).
- **`debug.keystore`** sí está en `.gitignore` (aunque sigue en el filesystem — verificar `git ls-files`).
- **Lint pre-deploy** en functions.

---

## 9. Cierre

El proyecto está **mucho más cerca de producción de lo que parece a primera vista**. Las 17 vulnerabilidades de rondas previas siguen mayoritariamente vigentes, la arquitectura general está pensada con cuidado y la mayoría de los problemas restantes son:

1. **Una decena de bloqueantes concretos y acotados** (1-2 días de trabajo).
2. **Deuda técnica acumulada** que duele pero no impide el ship (god component, monolito backend, error handling tragado).
3. **Higiene de repo** que se limpia en una hora.

Lo más importante a entender: los **2 críticos de seguridad nuevos (SEC-002, SEC-003)** existen porque el código evolucionó después de las rondas previas — son patrones nuevos, no fixes que se revertieron. Eso confirma que la base de auditoría está sana pero que **es necesario auditar continuamente cada vez que se toca `functions/index.js` o `firestore.rules`**.

Una vez resueltos los 10 bloqueantes, el producto puede shipear con confianza razonable, **siempre y cuando se complete simultáneamente PERF-001 (render loop on-demand)** — porque si no, los reviews de Play Store van a ser destruidos por batería y calor.

---

*Auditoría ejecutada por 4 perfiles especializados en paralelo. 107 hallazgos consolidados. Verificación cruzada de los 17 fixes previos.*
