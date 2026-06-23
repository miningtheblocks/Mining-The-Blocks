# MTB v1.1.0 — Fixes pendientes pre-release

Anotaciones de la auditoría del 2026-06-21 (10 agentes). Aplicar antes o post-release según prioridad.

---

## 📍 ESTADO ACTUAL (último update sesión 2026-06-23)

### ✅ Cerrado en sesión 2026-06-21

**CRITs aplicados automáticamente**:
- ✅ #9 CRIT-1, #10 CRIT-1, #8 CRIT-1/2/3 (5 CRITs)

**Smart contract V2 preparado**:
- ✅ Contrato refactorado + tests 17/17 + Safe 2-of-3 creado en Polygon

### ✅ Cerrado en sesión 2026-06-23

**Smart contract V2 — migración completa**:
- ✅ Swap Signer 1 del Safe completado (Safe 1/2/3 = `0xaca6...`, `0x53E5...`, `0xAabd...`; sin colisión con MINTER)
- ✅ Deploy a Polygon mainnet: **`0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195`** (tx `0x4d7813...742cb`)
- ✅ Verificado en Polygonscan ([source code](https://polygonscan.com/address/0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195#code))
- ✅ `functions/constants.js` → V2, `functions/index.js` ABI + llamada actualizados (mintGem 3 args)
- ✅ Roles on-chain verificados (Safe=ADMIN+PAUSER, nftv2=MINTER, nftv2 ≠ ADMIN)
- ✅ Test mint exitoso (tokenId #1 → pagosMTB, tokenURI canónico del contrato verificado)
- ✅ RUNBOOK.md actualizado (V1 deprecated, V2 activo, Safe doc)

**23 HIGHs cerrados en 3 batches**:

| Batch | HIGHs |
|---|---|
| Batch 1 (1-line) | #9 H1/3/4/7/8, #5 H5, #8 H2, #2 H2, #10 H5 (9 fixes) |
| Batch 2 (medianos) | #3 H1/2, #5 H2/3/4, #8 H1/8, #10 H6/7/8 (10 fixes) |
| Batch 3 (backend) | #2 H1 (cross-attr USDC), #4 HM1 (gem-loss TX), #4 HR1 (referrer cap), #3 MED4 (Sentry PII scrubber) |

Total: 5 CRITs + 23 HIGHs + smart contract V2 migration + verificación + test mint.

### ⏸️ Pendiente — acción manual del user

#### A) Comandos de terminal (5 min)

```bash
cd /run/media/code/datos/MTB/functions && npm install
```
Aplica bump nodemailer 8 → 9 + overrides ws/undici.

```bash
cd /run/media/code/datos/MTB && firebase deploy --only functions
```
Hace ir a producción el ABI nuevo del V2 + los fixes del backend.

```bash
cd /run/media/code/datos/MTB && firebase deploy --only hosting
```
Cierra **CRIT Web #3** (verify.html disponible públicamente).

#### B) GitHub Settings (1 click)

**Enforce HTTPS**: GitHub repo → Settings → Pages → ✓ "Enforce HTTPS". Cierra **CRIT Web #2**.

#### C) DNS records (5 min en Cloudflare)

```
SPF:   miningtheblocks.com.        TXT   "v=spf1 -all"
DMARC: _dmarc.miningtheblocks.com  TXT   "v=DMARC1; p=reject;"
CAA:   miningtheblocks.com.        CAA   0 issue "letsencrypt.org"
```
Cierra **#10 HIGH-10** (SPF/DMARC) + **#10 HIGH-11** (CAA).

#### D) Sentry source maps (30 min)

```bash
npx @sentry/wizard@latest -i reactNative
```
Después configurar `SENTRY_AUTH_TOKEN` como GitHub Actions secret. Cierra **#9 HIGH-2**.

#### E) HIGHs grandes que requieren tu decisión

- **#5 HIGH-1** expo-three replacement: 1-2h refactor `src/components/DynamicCube201.js` reemplazando el `Renderer` con `THREE.WebGLRenderer` + `GLView` de expo-gl.
- **#8 HIGH-3** KYC threshold ≥$500: requiere diseñar admin queue para review manual.
- **#8 HIGH-4** geo-blocking 13 países: requiere IP geolocation service o licencia gaming.
- **#8 HIGH-6** EU cookie consent: elegir biblioteca (CookieBot/Osano) o bloquear adpick.html para IPs EU.
- **#8 HIGH-7** análisis MICA + Howey: consulta abogado crypto (USD).
- **#9 HIGH-5** rotar keystore con 2 passwords distintas: migración cuidadosa con tu firma.
- **#9 HIGH-6** keystore backups offline 3+ copias separadas: USB físicos.

### 🔐 Addresses finales

| Rol | Address | Notas |
|---|---|---|
| **Contrato V2 (activo)** | `0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195` | Polygon mainnet, verified |
| Contrato V1 (deprecated) | `0x54c2859411afCb51fcfE42054aDcA3484B3f29E6` | 0 NFTs minteados, no migrar |
| **Safe multisig (ADMIN+PAUSER)** | `0x83a3F5Bd15302F17B7f2e430900F1d2A40F86aCD` | Gnosis Safe 2-of-3 |
| Safe signer 1 | `0xaca6ab64239238358B85B053A7f0E85d5380C1FF` | (Bitwarden "safe1") |
| Safe signer 2 | `0x53E5B70ff9B121190B89454A453d1532b0A15525` | (Bitwarden "safe2") |
| Safe signer 3 | `0xAabd35645F5C9D3D28cAc7387e14960a7755A4E1` | (Bitwarden "safe3", reemplazó nftv2) |
| **Backend MINTER (V2)** | `0x0a285CA8BaE2FbA3808bd260f936bCa22F06941e` | Bitwarden "nftv2", `COMPANY_WALLET_KEY` |
| Payment wallet | `0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f` | "pagosmtb", USDC receiver |

---

## #1 — Secrets & Credentials

✅ **APLICADO**: husky pre-commit + CI bloquean `credentials.json` + `mtb-admin-cli*.json` + `*.runtimeconfig.json` + `.p12/.pfx/.pem`
✅ **APLICADO**: `.env.example` creado
✅ **APLICADO**: `RUNBOOK.md` ya no expone path del keystore

### Pendientes
- (opcional, futuro) Rotar keystore con 2 passwords distintas para keystore vs key alias

---

## #2 — Firestore Rules + Cloud Functions Security

### HIGH-1: Cross-attribution attack en pagos USDC
- **File**: `functions/index.js` runCryptoPaymentProcessing (~línea 1681-1909)
- **Qué**: el procesador matchea Transfer event por `to + value`, NO por `from`
- **Riesgo**: si un tercero envía exactamente $X USDC al wallet por otra razón, se acredita al usuario con el pending de $X
- **Mitigación actual**: rate-limit 3/h/uid + ventana 30min + requiere víctima externa
- **Fix recomendado**: pedir `senderWalletAddress` en `createCryptoPayment` y bindear el `from` del Transfer event
- **Esfuerzo**: ~30min código + testing

### HIGH-2: `rateLimits/*` no se limpia por TTL
- **File**: `functions/index.js:2300-2317` (función `_rateLimitFirestore`)
- **Qué**: `expiresAt: now + windowMs * 2` guarda number, TTL policy requiere Timestamp
- **Riesgo**: solo costo de storage a largo plazo, NO security
- **Fix**: cambiar a `expiresAt: Timestamp.fromMillis(now + windowMs * 2)`
- **Esfuerzo**: 2min, 1 línea

### MED-1: Índice composite faltante para `notifyAllUsers`
- **File**: `firestore.indexes.json`
- **Qué**: la query `where('pushToken','!=',null).orderBy('pushToken').orderBy(documentId()).limit(BATCH)` requiere índice no presente
- **Riesgo**: primer broadcast falla, Firebase devuelve link para auto-crear
- **Fix**: agregar a `firestore.indexes.json`:
  ```json
  { "collectionGroup": "users", "queryScope": "COLLECTION",
    "fields": [{"fieldPath":"pushToken","order":"ASCENDING"},{"fieldPath":"__name__","order":"ASCENDING"}] }
  ```
- **Esfuerzo**: 3min

### MED-2: `mineCube` puede perder un gem ante crash entre TX commit y gem.add()
- **File**: `functions/index.js` mineCube ~línea 894-926
- **Qué**: TX commitea picks/rewards/mined, pero gem creation + auto-pendingMint corren DESPUÉS
- **Riesgo**: process death entre medio → usuario tiene reward picks pero gem perdido (tier-1 = ~$100k)
- **Fix recomendado**: mover gem creation DENTRO del TX con docId determinístico (`${serverId}_${K}_${cubeNumber}`)
- **Esfuerzo**: ~15min código + testing

### MED-3: `verifyGemCode` expone enumeration oracle
- **File**: `functions/index.js` verifyGemCode ~línea 2319-2360
- **Qué**: 3 errores distinguibles (`not_found`, `already_redeemed`, `already_minted`) + 200 valid:true
- **Riesgo**: teórico — keyspace 2^60 + rate-limit 30/min/IP lo hace inalcanzable
- **Fix**: colapsar todos los errores a `400 invalid`, solo devolver 200 valid:true
- **Esfuerzo**: 10min

### MED-4: `getChain` expone uids de creator y winners
- **File**: `functions/index.js` getChain ~línea 637-656
- **Qué**: devuelve `chain.createdBy` y `episodes[].winner` (uids)
- **Riesgo**: bajo — ya son públicos en history feed
- **Fix**: whitelist como `getServers` PUBLIC_FIELDS
- **Esfuerzo**: 10min

### MED-5: `meta/counter` permite write de clientes (path muerto)
- **File**: `firestore.rules:144-151`
- **Qué**: regla permite incrementar counter +1 monotónico, pero solo Admin SDK lo escribe en realidad
- **Riesgo**: cliente podría bumpar el counter creando gaps en seq
- **Fix**: `allow write: if false`
- **Esfuerzo**: 2min

### LOW (cosmético, opcional)
- LOW-1: Storage filename `.jpg` ext pero permite PNG content (cosmético)
- LOW-3: `mineCube` auto-pendingMint usa `.add()` no determinístico
- LOW-4: Lock TTL 10min < máx runtime v2 (60min) — autocorregido por TX precondition
- LOW-5: notifyAllUsers loggea admin uid full (intencional, audit trail)
- LOW-6: referralCode uniqueness best-effort (acceptable hasta 100M users)

---

## #3 — Frontend Security (XSS, Injection, RN risks)

### HIGH-1: `verify.html` usa `'unsafe-inline'` en CSP script-src
- **Files**: `public/verify.html:12` + `firebase.json:35` (header global)
- **Riesgo**: defense-in-depth débil ante futuro slip a inline script
- **Fix**: extraer `<script>` inline a `public/verify.js`, sacar `'unsafe-inline'`
- **Esfuerzo**: 10min

### HIGH-2: `el()` helper en `verify.html` acepta HTML raw
- **File**: `public/verify.html:117-124`
- **Qué**: branch `opts.html → node.innerHTML` es footgun latente
- **Fix**: eliminar el branch, usar `textContent` con `'✅'` y `'❌'`
- **Esfuerzo**: 5min

### MED-1: Push notifications `data.url` sin allowlist de hosts
- **File**: `App.js:105-114`
- **Fix**: agregar allowlist `peaks|gems|mygems|profile|buycredits|config|servers` antes de `Linking.openURL`
- **Esfuerzo**: 5min

### MED-2: `docs/js/app.js` no re-sanitiza referral leído de localStorage
- **File**: `docs/js/app.js:101-109`
- **Fix**: aplicar `replace(/[^A-Z0-9]/g, '')` al path de localStorage también
- **Esfuerzo**: 2min, 1 línea

### MED-3: APK download URL sin certificate pinning
- **File**: `src/components/UpdateModal.js`
- **Qué**: 3 hosts allowlisted pero sin pinning + SHA-256 publicado pero no verificado in-app
- **Fix**: shipear SHA-256 esperado en Firestore config/app + verificar in-app post-download
- **Esfuerzo**: ~30min (no urgente — Play Store es la solución de largo plazo)

### MED-4: Sentry sin `beforeSend`/`beforeBreadcrumb` PII scrubber
- **File**: `src/utils/sentry.js:24-64`
- **Qué**: `sendDefaultPii:false` está, pero unhandled exceptions bypasean `logError` y van directo a Sentry
- **Fix**: agregar `beforeSend(event)` y `beforeBreadcrumb(crumb)` que corran los `_PII_VALUE_RES` de logError.js sobre event.message, event.exception.values[].value, crumb data
- **Esfuerzo**: 15min

### MED-5: `avatarUrl` writes no restringen dominio
- **Files**: Profile.js, Registration.js, Config.js
- **Qué**: `users/{uid}.avatarUrl` no exige `https://firebasestorage.googleapis.com/...`
- **Riesgo**: hoy bajo (avatars solo se muestran al propio user). Sube si avatars se exponen cross-user
- **Fix**: agregar regex check en firestore.rules
- **Esfuerzo**: 5min

### LOW
- LOW-1: Firebase Web API key embedded (esperado, public by design)
- LOW-2: verify.html expone primeros 32 chars del Identity Toolkit error code
- LOW-3: `MTB-v1.1.0.apk.sha256` no se consume in-app (Play Store es la solución)
- LOW-4: docs/index.html CSP falta `https://www.googleapis.com` en connect-src (fallback legacy)

---

## #4 — Anti-Cheat / Game Integrity / Smart Contract

### 🔴 CRIT-S1: Contrato en mainnet (0x54c2...29E6) es la VERSIÓN VIEJA
- **Estado**: El repo tiene CEI + nonReentrant + pausable + renounce disabled. EL DEPLOYADO NO.
- **Vector**: COMPANY_WALLET_KEY compromise → mint ilimitado tier-1 ($100k c/u) + transferOwnership(atacante) permanente
- **Pérdida potencial**: $10M+ y proyecto inviable
- **Fix**: redeploy con AccessControl + Gnosis Safe 2-of-3 como DEFAULT_ADMIN_ROLE, backend EOA como MINTER_ROLE
- **Ventana ideal**: AHORA (0 NFTs minteados, migration sin holders)
- **Plan detallado**: `audit_2026_06_14_round2/03_smart_contract.md` § Multisig Migration Plan
- **Esfuerzo**: 1-2 días (refactor contrato + deploy + actualizar functions/constants.js con nueva address + testing)

### 🔴 CRIT-S2: No hay supply cap por tier on-chain
- **File**: `contracts/MTBGems.sol:28-55` mintGem
- **Qué**: `gemCodeToTokenId[gemCode] == 0` solo enforza unique gemCode, no scarcity
- **Vector**: backend compromiso o bug → 10000 tier-1 NFTs minted aunque whitepaper diga 1
- **Fix**: `mapping(uint8 => uint256) tierMinted` + caps `[0,1,1,5,50,100,500,1000,4000,10000]` (ajustar según whitepaper real)
- **Esfuerzo**: incluido en CRIT-S1 redeploy

### 🔴 CRIT-S3: Single EOA custodia mint authority + payment processing
- **Component**: `COMPANY_WALLET_KEY` usado en `runMintProcessing` Y `maticBalanceCheckScheduled` (misma EOA paga gas + firma mints)
- **Fix**: separar minting key (sin fondos) de gas wallet, o usar Safe + sponsored transactions
- **Esfuerzo**: incluido en CRIT-S1 redeploy

### 🟠 HIGH-S1: Ownable (no Ownable2Step) → typo en migración = bricked
- **Fix**: usar AccessControl con grantRole explícito (incluido en CRIT-S1 redeploy)

### 🟠 HIGH-M1: Gem-loss window en mineCube (REPRIORIZADO de MED a HIGH)
- **File**: `functions/index.js:867` (mined.gem inside TX) vs `:909-922` (users.gems.add OUTSIDE TX)
- **Vector**: process crash entre TX commit y gems.add() → user pierde gem (tier-1 = ~$100k)
- **Fix**: mover gem creation DENTRO del TX con docId determinístico `${serverId}_${K}_${cubeNumber}`
- **Esfuerzo**: ~30min código + testing del flujo de mining

### 🟠 HIGH-R1: Sin cap de referrer = farm-friendly
- **Vector**: 1000 referrals → 5000 picks → eventualmente NFTs tier-1
- **Fix**: cap referrer bonus en 50 referrals OR diminishing returns + documentar en TOS
- **Esfuerzo**: ~20min

### 🟡 MED-S1: tokenURI pasado unvalidated del backend al contrato
- **File**: `functions/index.js:1360` `data.tokenURI || GEM_TOKEN_URIS[tier-1]`
- **Riesgo**: bug o tamper → mint con URI arbitraria (claim "$1M" metadata)
- **Fix**: (a) drop `tokenURI_` del contract API, store `mapping(uint8 => string) canonicalURI` set via Safe; OR (b) backend usa `GEM_TOKEN_URIS[tier-1]` siempre (remover fallback)
- **Esfuerzo**: opción b = 5min; opción a = parte del CRIT-S1 redeploy

### 🟡 MED-P1: Single RPC endpoint para payments + mints
- **Risk**: publicnode.com outage = ambos flujos fallan
- **Fix**: `ethers.FallbackProvider([publicnode, alchemy, quicknode])`
- **Esfuerzo**: 30min + obtener API keys

### LOW
- LOW-W1: Episode winner sin push notification (UX, no security)
- LOW-W2: Auto-pendingMint en mineCube usa `.add()` no determinístico
- LOW-N1: cents usa `Math.random()` (acceptable para 99 slots)
- LOW-C1: Pragma `^0.8.20` (caret) en vez de pinned version

---

## #5 — Dependencies & Supply Chain

### 🟠 HIGH-1: `expo-three@8.0.0` arrastra cadena abandonada (8 paquetes con CVEs)
- **Usado en**: `src/components/DynamicCube201.js` (solo el export `Renderer`)
- **CVEs**: node-fetch@1.7.3 (CVSS 8.8), fbjs, fbemitter, isomorphic-fetch, uuid@8.3.2
- **Explotabilidad real**: LOW (polyfill no corre en RN runtime)
- **Fix**: reemplazar con `THREE.WebGLRenderer` + expo-gl GLView (~30-50 LOC)
- **Esfuerzo**: 1-2 horas

### 🟠 HIGH-2: `nodemailer@8.0.10` con CVE SSRF (NO explotable)
- **File**: `functions/package.json`
- **Qué**: CVE requiere user-controlled `raw:`, código nunca lo usa
- **Fix**: bumpar a `"nodemailer": "^9.0.1"` (major, verificar API)
- **Esfuerzo**: 10min

### 🟠 HIGH-3: `ws` <8.21.0 + `undici` <6.27.0 via firebase-admin
- **Riesgo**: server interno, no expuesto público
- **Fix**: esperar firebase-admin patch O agregar `npm overrides` para `ws@^8.21.0` y `undici@^6.27.0`
- **Esfuerzo**: 5min con overrides

### 🟠 HIGH-4: CI `npm audit` gate incompleto (solo functions, no root)
- **File**: `.github/workflows/ci.yml:113-115`
- **Fix**: agregar step de `npm audit --omit=dev --audit-level=high` en root
- **Esfuerzo**: 5min

### 🟠 HIGH-5: `@cyclonedx/cdxgen@latest` sin pin en CI
- **File**: `.github/workflows/ci.yml:134, 136`
- **Riesgo**: supply chain — si cdxgen es comprometido, código malicioso corre en CI
- **Fix**: pinear a versión específica (ej `@cyclonedx/cdxgen@11.x.y`)
- **Esfuerzo**: 2min

### 🟡 MED-1: Expo SDK 54 patch-level drift (8 paquetes)
- **Fix**: `npx expo install --fix`
- **Esfuerzo**: 5min

### 🟡 MED-2: `expo-av` deprecated upstream
- **Fix**: migrar a `expo-audio` antes de SDK 55 (no urgente para v1.1.0)
- **Esfuerzo**: 1-2h en `src/utils/audioManager.js`

### 🟡 MED-3: `firebase` web SDK en docs/ 14 minors atrás
- **File**: `docs/index.html` carga firebase@10.13.2
- **Fix**: bumpar a 12.15.0 + regenerar SRI hashes
- **Esfuerzo**: 15min

### 🟡 MED-4: `babel-preset-expo` duplicado en deps y devDeps
- **File**: `package.json`
- **Fix**: dejar solo en devDeps
- **Esfuerzo**: 1min

### 🟡 MED-5: `@aws-sdk/client-s3` 70MB para 1 script admin
- **Fix**: mover a `optionalDependencies` o subscript con su propio package.json
- **Esfuerzo**: 10min

### 🟡 MED-6: Posiblemente unused: `@expo/vector-icons`, `react-native-svg`
- **Fix**: verificar con clean rebuild, remover si confirmado unused
- **Esfuerzo**: 10min

### 🟡 MED-7: `@react-native-async-storage` major behind (2.2.0 → 3.1.1)
- **Fix**: defer a v1.2 (breaking changes)

### 🟡 MED-8: `@sentry/react-native` major behind (7.2.0 → 8.15.1)
- **Fix**: defer post-release (major)

### LOW
- LOW-1: `functions/node_modules` missing local (CI ok)
- LOW-2: `three@0.166.1` pinned 18 minors atrás (lockeado por expo-three)
- LOW-3: `expo-file-system` peer warning de expo-three (dead code)

---

## #6 — Dead Code / Duplicates / Obsolete (cleanups, no blockers)

### Cleanup #1: Bloque muerto en DynamicCube201.js
- **File**: `src/components/DynamicCube201.js:4451-4514` (63 líneas)
- **Qué**: bloque self-marked como `TODO: eliminar este bloque entero — código muerto`. Escribe a `users/{uid}/mines`, `users/{uid}/rewards`, stats — todas bloqueadas por Firestore rules
- **Esfuerzo**: 5min

### Cleanup #2: 12 unused imports + 5 unused exports
- Files: App.js, Config.js, MyGems.js, Profile.js, Registration.js, ReportProblem.js, DynamicCube201.js, src/constants.js, src/utils/gems.js, src/utils/logError.js, src/firebase/functions.js
- **Esfuerzo**: 10min (idealmente con eslint-plugin-unused-imports)

### Cleanup #3: Styles legacy `zoomBar*` (30 líneas)
- **File**: `src/components/DynamicCube201.js:4927-4956`
- **Esfuerzo**: 2min

### Cleanup #4: Fix `.easignore` (ahorra ~500KB por EAS upload)
- **File**: `.easignore`
- Remover líneas 19-24 (referencias stale)
- Agregar: `audit_2026_06_14_round2/`, `audit_2026_06_21_pre_release/`, `ACCIONES_MANUALES.md`, `ARCHITECTURE.md`, `AUDITORIA_SIDELOAD.md`, `RUNBOOK.md`, `*.sha256`
- **Esfuerzo**: 5min

### Cleanup #5: DRY version-check duplicado
- **Files**: `App.js:136-187` vs `src/screens/ServerList.js:58-120`
- **Fix**: extraer a `src/utils/useVersionCheck.js` hook (~50 líneas saved)
- **Esfuerzo**: 30min código + testing

### Menores

- Mojibake en 111 líneas de comentarios (UTF-8 doble-encoded) en DynamicCube201.js. Cosmético, fix con `iconv` o `sed`.
- **Páginas legales drift**: `docs/privacy.html` (14.5KB) vs `public/privacy.html` (12.2KB). **Riesgo legal medio** — pick canonical source (recomendado: `public/` como source, `docs/` como copia generada en CI).
- `expo-av` deprecated upstream (ya en #5 MED-2)

---

## #7 — Performance / Optimization (todos cleanups, no blockers)

### Win #1: 🎯 Borrar `assets/assets/` (14 MB duplicado)
- **Path**: `/run/media/code/datos/MTB/assets/assets/`
- **Qué**: carpeta nested con duplicados de icon/splash/sonidos
- **Verificado**: 0 referencias en código
- **Saving**: -14 MB raw APK, -5-8 MB compressed
- **Comando**: `rm -rf assets/assets/`
- **Esfuerzo**: 30 seg

### Win #2: Optimizar `assets/gems/gem_*.png` (1000x1000 RGBA)
- 9 PNGs, 328 KB total
- **Verificar si se usan**: posible que `GemPixelArt.js` los genere procedurally y los PNGs sean unused
- **Fix**: resize a 256x256 + convertir a WEBP, o eliminar si unused
- **Saving**: 200-300 KB
- **Esfuerzo**: 10min

### Win #3: Lazy-load modal screens
- **File**: `src/components/OverlayModalsProvider.js:4-11`
- **Qué**: 8 screens eagerly imported (Profile, Config, GetPeaks, Registration, MyGems, HowToPlay, BuyCredits, ReportProblem)
- **Fix**: `React.lazy(() => import(...))` + `<Suspense>`
- **Saving**: 50-100 KB initial parse, ~100-200ms más rápido cold start
- **Esfuerzo**: 30min

### Win #4: Memoize renderItem en FlatLists
- **Files**: `ServerList.js:301,354` (renderActiveItem, renderFinishedItem), `MyGems.js:91` (renderGem)
- **Fix**: `useCallback` + `React.memo` en child component
- **Saving**: 5-10% smoother scroll
- **Esfuerzo**: 20min

### Win #5: Drop x86/x86_64 architectures de production
- **File**: `android/gradle.properties:43`
- **Cambiar**: `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64` → `reactNativeArchitectures=armeabi-v7a,arm64-v8a`
- **Saving**: AAB upload más chico, CI más rápido
- **Esfuerzo**: 1 min + EAS rebuild

### Win #6: `react-native-reanimated` está en deps pero NO se usa
- **Decisión**:
  - (a) Usarlo: PanResponder en UI thread = cube súper suave. Gran ganancia de smoothness.
  - (b) Removerlo: -500 KB native lib del APK
- **Esfuerzo**: (a) 2-4h reescribir PanResponder, (b) 5min

### Win #7: Cache `httpsCallable` instances
- **File**: `src/firebase/functions.js`
- **Qué**: cada `callXyz()` crea fresh httpsCallable
- **Fix**: hoist a constantes module-level
- **Esfuerzo**: 10min

### Win #8: Migrar `<Image>` a `expo-image`
- **Files**: `Profile.js:199`, `Registration.js:432`, MyGems
- **Saving**: better caching, progressive loading, lower memory
- **Esfuerzo**: 15min (1.2 win, no blocker)

### Otros wins menores
- Win #9: ServerList audio init ya es non-blocking, low impact
- Win #10: PickaxeFromPNG.js inline pixel data (-20-40 KB JS) — mover a binary asset

---

## #8 — Privacy / Legal / Compliance (3 CRIT bloqueantes, 20 min total)

### 🔴 CRIT-1: Privacy policy drift docs/ vs public/
- **File A**: `docs/privacy.html` (14.5 KB, actualizado, bilingüe ES/EN, incluye SCC, Sentry, Better Stack, Filebase)
- **File B**: `public/privacy.html` (12.5 KB, **stale**, todavía menciona Google AdMob)
- **Fix**: `cp docs/privacy.html public/privacy.html` + redeploy Firebase Hosting
- **Esfuerzo**: 2 min

### 🔴 CRIT-2: No validación ≥18 contra birthday
- **File**: `src/screens/Registration.js`
- **Qué**: birthday colectado (DD/MM/YYYY) pero nunca validado contra edad ≥18. Solo checkbox de self-attest.
- **Fix**: en `onSave`, parsear birthday, computar edad, rechazar si <18 o año implausible
- **Esfuerzo**: 10 min

### 🔴 CRIT-3: Privacy policy NO linkeada en la app
- **File**: `src/screens/Registration.js:564`
- **Qué**: `PRIVACY_URL` definido en constants.js:18 pero nunca usado
- **Requerido** por Google Play, App Store y GDPR Art. 13
- **Fix**: agregar `<TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)}>` junto al de Terms (también en Config.js si querés mostrarlo desde ajustes)
- **Esfuerzo**: 5 min

### 🟠 HIGH-1: Retention period inconsistente
- Privacy dice 90d logs + cuenta lifetime; Terms §13.3 dice 5 años AML/KYC
- **Fix**: reconciliar — actualizar privacy para mencionar 5y AML retention
- **Esfuerzo**: 5 min

### 🟠 HIGH-2: Governing law undefined
- **File**: `docs/terms.html` §20
- **Qué**: "the jurisdiction where the Company operates" sin nombrarla
- **Fix**: nombrar la jurisdicción explícitamente (Argentina si operás desde ahí)
- **Esfuerzo**: 2 min

### 🟠 HIGH-3: KYC threshold ≥$500 no implementado
- **File**: `functions/index.js` submitGemClaim
- **Qué**: TOS §9.4 dice ID obligatoria para prizes ≥$500 PERO submitGemClaim acepta cualquier claim
- **Fix**: si gem tier ≤ tier de $500 → auto-process; sino flag para review manual
- **Esfuerzo**: 30 min código + admin queue

### 🟠 HIGH-4: No geo-blocking enforcement
- **Qué**: TOS §4 lista 13 países restringidos PERO no hay check técnico
- **Fix**: Cloud Function geo-IP check en `createCryptoPayment` bloqueando países restricted
- **Esfuerzo**: 1-2h (IP geolocation + lista de bloqueos)
- **Alternativa**: obtener licencia de gaming (Curaçao / Malta / Anjouan) — conversación de USD con abogado

### 🟠 HIGH-5: DOB sanity check missing
- **Fix**: incluido en CRIT-2 (mismo lugar)

### 🟠 HIGH-6: `adpick.html` sin EU cookie consent banner
- **File**: `docs/adpick.html`
- **Qué**: embebe `effectivecpmnetwork.com` sin consent
- **Fix opción A**: agregar cookie consent banner (CookieBot, Osano, etc.)
- **Fix opción B**: bloquear adpick.html por IP a usuarios EU
- **Esfuerzo**: 1-2h

### 🟠 HIGH-7: MICA + Howey analysis pendiente
- **Riesgo**: NFT con valor USD garantizado → puede ser security under SEC, también issues con MICA EU
- **Fix**: consulta con abogado especializado en crypto (USD para escala)
- **Mitigación temporal**: la TOS §4 banea US explícitamente (pero sin enforcement = riesgo)

### 🟠 HIGH-8: Apple/Google sign-in clarificación
- **Qué**: Apple/Google sign-in NO está implementado (verificado: solo email+password)
- **Fix**: aclarar en TOS y privacy que solo se usa email+password (o implementar OAuth providers)
- **Esfuerzo**: 5 min (actualizar docs) o 2-4h (implementar OAuth)

### 🟡 MEDs
- MED-1: GDPR Art. 6 lawful basis no enumerada
- MED-2: TOS §5.1 menciona anonymous flow que ya no existe en v1.1.0
- MED-3: Coinzilla verification meta tag no disclosed en sub-processors
- MED-4: Helpline list le falta EU/Spanish-LATAM coverage; lista US a pesar del US ban
- MED-5: 90d log retention promised pero sin Firestore TTL configurado (overlap con #2 HIGH-2 rateLimits)
- MED-6: 5-year AML retention asserted pero sin scheduled hard-delete

### LOW
- LOW-1: privacy policy sin version number (terms tienen v2.0)
- LOW-2: no postal address en contact section (GDPR Art. 13 requirement)
- LOW-3: no "Do Not Sell My Info" page (visible CCPA marker, opcional)
- LOW-4: DSAR sin formulario estructurado (solo Gmail)

---

## #9 — Build / Distribution / Signing (1 CRIT + 8 HIGH pre-build mandatorios)

### 🔴 CRIT-1: `gradle.properties` ABIs regresionaron de 2 a 4
- **File**: `android/gradle.properties:37`
- **Actual**: `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64`
- **Debería**: `reactNativeArchitectures=armeabi-v7a,arm64-v8a` (como v1.1.0)
- **Si rebuildás ahora**: AAB ~50MB más grande + SHA-256 mismatch con `MTB-v1.1.0.apk.sha256`
- **Esfuerzo**: 30 seg (1 línea)

### 🟠 HIGH-1: `eas.json` production sin `credentialsSource: "local"`
- **File**: `eas.json` profile `production`
- **Riesgo**: EAS usa keystore REMOTE → anti-tamper kills app al arrancar
- **Fix**: agregar `"credentialsSource": "local"` al profile production
- **Esfuerzo**: 1 min

### 🟠 HIGH-2: NO Sentry source map upload pipeline
- **Qué falta**: `sentry.properties`, `SENTRY_AUTH_TOKEN`, CI step, `withSentryAndroid` plugin
- **Consecuencia**: crashes obfuscados por R8 → inactionable
- **Fix**: `npx @sentry/wizard@latest -i reactNative` o configurar manualmente
- **Esfuerzo**: 30 min

### 🟠 HIGH-3: `app.json` sin `android.versionCode`
- **File**: `app.json`
- **Riesgo**: EAS puede auto-bumpar o default a 1
- **Fix**: agregar `"android": { "versionCode": 5, ... }`
- **Esfuerzo**: 1 min

### 🟠 HIGH-4: `app.json` sin `runtimeVersion`
- Academic hoy (OTA off), bloqueante si OTA se enciende
- **Fix**: agregar `"runtimeVersion": { "policy": "appVersion" }`
- **Esfuerzo**: 1 min

### 🟠 HIGH-5: Keystore + key comparten mismo password
- **File**: `credentials.json`
- **Riesgo**: 1 leak = full compromise
- **Fix**: rotar key alias con password distinta (requiere generar nuevo .keystore alias - cuidado con la migración)
- **Esfuerzo**: 1-2h con migración cuidadosa

### 🟠 HIGH-6: Backups del keystore insuficientes
- **Estado actual**: 1 copia activa + 1 GPG, ambas en el MISMO disco
- **Riesgo**: disk failure = bricked release line FOREVER (mismo modo de falla del v1 keystore perdido)
- **Fix**: 3+ copias offline en medios físicamente separados (USB, cloud encrypted, papel impreso con sha256)
- **Esfuerzo**: 30 min físicos
- **PRIORIDAD CRITICA** dada la lección aprendida del v1

### 🟠 HIGH-7: SHA-256 no publicado en miningtheblocks.com
- **File**: `MTB-v1.1.0.apk.sha256` está solo en repo root, no en docs/
- **Fix**: `cp MTB-v1.1.0.apk.sha256 docs/MTB-v1.1.0.apk.sha256` + attach a GitHub Release asset
- **Esfuerzo**: 2 min

### 🟠 HIGH-8: `docs/index.html` hardcodea URL v1.1.0
- **Fix**: cambiar a `https://github.com/miningtheblocks/Mining-The-Blocks/releases/latest` (igual que `docs/app/index.html`)
- **Esfuerzo**: 2 min

### 🟡 MEDs
- MED-1: `eas.json` cli.version `>=12.0.0` unpinned ceiling
- MED-2: `EXPO_PUBLIC_SENTRY_DSN` no declarada en eas.json production → Sentry no-op
- MED-3: `submit.production` profile vacío
- MED-4: No `scheme` declared en app.json
- MED-5: No `permissions` array en app.json (manifest hand-managed)
- MED-6: `credentials.json` plaintext passwords en working tree (mover a ~/.mtb-keys/)
- MED-7: Archive v1 keystore en mismo disco
- MED-8: Debug variants con `cleartextTraffic=true` + SYSTEM_ALERT_WINDOW (verificar nunca mergeen a release)
- MED-9: Dead AdMob ProGuard rules
- MED-10: No CHANGELOG.md
- MED-11: No `scripts/bump-version.sh` atómico
- MED-12: CI nunca produce un APK/AAB
- MED-13: `@cyclonedx/cdxgen@latest` unpinned (overlap con #5 HIGH-5)
- MED-14: `assets/assets/` 14MB duplicate (overlap con #7 Win #1)
- MED-15: verificar `STRIP_CONSOLE` se aplica en EAS bundle
- MED-16: No `scripts/verify-release.sh` post-build
- MED-17: No formal hotfix/rollback runbook section

### LOW
- LOW-1: production buildType=app-bundle pero distribuyen APK (mismatch)
- LOW-2: New architecture + reanimated + worklets — verificar on-device
- LOW-3: App Check / Play Integrity no wired (overlap con #4)
- LOW-4: `android.suppressUnsupportedCompileSdk` no set
- LOW-5: No `-keep class BuildConfig` explícito
- LOW-6: Tags inconsistentes (v1.0, v1.01, MTBv1.02, v1.1, v1.1.0)
- LOW-7: versionCode monotonic invariant no documentado
- LOW-8: npm audit no corre en root (overlap con #5 HIGH-4)
- LOW-9: No CI artifact SHA-256 archive
- LOW-10: Single SHA-256 en assetlinks.json (no rotation overlap support)

---

## #10 — Web (miningtheblocks.com) Security + SEO + Performance

### 🔴 CRIT-1: `assetlinks.json` retorna 404 → App Links broken
- **Root cause**: Jekyll strip dot-dirs por default en GitHub Pages
- **Fix**: `touch docs/.nojekyll` + commit
- **Esfuerzo**: 30 seg
- **Verificar después**: `curl -I https://miningtheblocks.com/.well-known/assetlinks.json` → 200 + `application/json`

### 🔴 CRIT-2: HTTP no redirige a HTTPS
- **Fix**: GitHub repo → Settings → Pages → **enable "Enforce HTTPS"** checkbox
- También habilita el HSTS header automáticamente (max-age=31536000)
- **Esfuerzo**: 1 click

### 🔴 CRIT-3: Firebase Hosting NO deployed
- `https://miningtheblocks.web.app/verify.html` → 404 (email verification dead-end)
- **Fix**: `firebase deploy --only hosting` desde repo root
- **Esfuerzo**: 2 min (build + deploy)

### 🟠 HIGH-4: No HSTS header en apex
- Auto-fixed por CRIT-2

### 🟠 HIGH-5: No X-Frame-Options real
- **Problema**: meta `X-Frame-Options` y `frame-ancestors` via meta CSP son IGNORADOS por browsers
- **Riesgo**: site puede ser embebido en iframe (clickjacking)
- **Fix opción A**: agregar JS frame-buster en landing (`if (top !== self) top.location = self.location`)
- **Fix opción B**: migrar sitio público de GitHub Pages → Firebase Hosting (que tiene los headers configurados)
- **Esfuerzo**: A=5min, B=2-3h

### 🟠 HIGH-6: robots.txt + sitemap.xml missing
- **Fix**: crear `docs/robots.txt` (allow + sitemap reference) y `docs/sitemap.xml` (~5 URLs)
- **Esfuerzo**: 15 min

### 🟠 HIGH-7: No OG/Twitter Card/canonical tags
- Crucial para previews en Discord/Twitter/Telegram (target audience crypto)
- **Fix**: agregar ~15 líneas de meta tags a las 4 páginas principales
- **Esfuerzo**: 20 min

### 🟠 HIGH-8: Form inputs sin `<label for="...">`
- **File**: `docs/index.html:367, 388, 392, 416, 420, 424, 428`
- **Qué**: usan `<div class="claim-label">` pero no label association
- **Riesgo**: WCAG 2.1 AA fail, screen readers no anuncian field names
- **Fix**: cambiar `<div class="claim-label">` a `<label for="...">`
- **Esfuerzo**: 10 min

### 🟠 HIGH-9: `icon.png` 1.1MB (LCP element)
- Display a 96x96 pero file de 1,140,842 bytes
- **Fix**: resize a 96x96 + convertir a WebP (target ≤30KB)
- Agregar `fetchpriority="high"` al logo
- Agregar `loading="lazy"` a otros no-LCP images
- **Esfuerzo**: 10 min (incluye Lighthouse boost ~60→90)

### 🟠 HIGH-10: No SPF / DMARC / MX records
- Cualquiera puede spoofear `@miningtheblocks.com` emails
- **Fix DNS** (registra TXT records):
  - SPF: `v=spf1 -all` (hard-fail si no usás email del dominio)
  - DMARC: `_dmarc.miningtheblocks.com TXT "v=DMARC1; p=reject;"`
- **Esfuerzo**: 5 min en panel DNS

### 🟠 HIGH-11: No CAA record
- Cualquier CA puede emitir cert para el dominio
- **Fix DNS**: `miningtheblocks.com. CAA 0 issue "letsencrypt.org"`
- **Esfuerzo**: 2 min

### 🟡 MEDs
- MED-12: `X-Content-Type-Options` missing (mitigated by CRIT-2/HIGH-5 fix)
- MED-13: Permissions-Policy missing en production domain (deploy Firebase)
- MED-14: Section labels usan `<div>` no `<h2>` (SEO + a11y penalty)
- MED-15: Single SHA en assetlinks (overlap con #9)
- MED-16: Age-gate modal sin ARIA / focus trap
- MED-17: Touch targets 26px (vs 48px recomendado WCAG 2.5.5)
- MED-18: Description meta español en `<html lang="en">` (mismatch signal)
- MED-19: No structured data JSON-LD

### LOW
- LOW-20: No PWA manifest (icons existen, falta manifest.json)
- LOW-21: `.dl-sub` contrast 4.0:1 fails AA (subir opacity)
- LOW-22: No `prefers-reduced-motion`
- LOW-23: No custom 404 page
- LOW-24: `<meta name="theme-color">` missing
