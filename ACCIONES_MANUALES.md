# 📋 Acciones manuales pendientes (post-auditoría exhaustiva 2026-06-13)

Tareas que **no se pueden hacer desde el código** y requieren intervención humana, acceso a consolas web, o decisiones de producto.

Hacé todas al final, cuando termine el bloque de fixes en código.

---

## 🔴 Pre-release blockers (acción inmediata)

### 1. Verificar resolución de NFT metadata en IPFS
Los CIDs hardcoded en `functions/constants.js:21-29` (`GEM_TOKEN_URIS`) deberían resolver a los JSON corregidos en `assets/gems/metadata/`.

**Cómo verificar:**
```bash
# Para cada tier (1..9), debe devolver el JSON con valores correctos
for cid in bafkreiazqr5ll6frb27jxl6n6pp7c7jrfy2stcezwl7r3hr4iyyqxctl5m \
           bafkreiggojefjwtthfjpxg454euhzf3zajjadlw3q6nv3tttorvu3frndq \
           bafkreif4ysa3pwnrpuqqmtk4647a26vfwyfp3tbpe5ypcivjytptr3b7he \
           bafkreicc4vvma5xb3u65poxnncqj63z3jke5q3zo53s2vfc3vzjcxpefaa \
           bafkreiggrq4ipierqj2eyfzg7qm4gfuyl5ve6hhpknqvjnqzy7vg6ijpdm \
           bafkreigxc6uqc7co6qcu4mzaq2tnkqwcsngfet63eczmmgwfzbyhmmpogq \
           bafkreidex4rj7rofevpe45u2sdvvnq5hkovxulqjtpjjj2xjakxvuzpbi4 \
           bafkreiaujynahu64ui75bihvggjh5thoesn7ewgjqgqgafjf24osdb4lci \
           bafkreiabkbvz5g3b3alkh3omymgg2urw47bgtal3sd7kudxtebohk2pzta; do
  echo "=== $cid ==="
  curl -s "https://ipfs.io/ipfs/$cid" | head -5
done
```

**Si resuelven a valores viejos ($500/$200/...)**: hay que re-pinear con los nuevos JSON y actualizar `functions/constants.js:GEM_TOKEN_URIS`. Ya tenés `PINATA_API_KEY` configurado.

```bash
node scripts/upload-metadata-to-ipfs.js  # sube assets/gems/metadata/*.json
# Pegar los nuevos CIDs en functions/constants.js:GEM_TOKEN_URIS
# firebase deploy --only functions
```

### 2. ¿Poseés el dominio `miningtheblocks.com`?
Si **NO** lo poseés, compralo YA. Razón: los JSON viejos tenían `external_url: https://miningtheblocks.com`. OpenSea/wallets abren ese link al ver el NFT. Si un atacante lo registra, puede phishear holders.

Los JSON nuevos apuntan a `miningtheblocks.github.io` (que sí poseés), pero los NFTs ya minteados pueden tener referencia al viejo si el tokenURI on-chain resuelve a un JSON cacheado.

### 3. Restringir Web API key en GCP Console
Key: `AIzaSyDRCpXkNWupz2PmoOG6XcuFENYaU5xIUps`

1. https://console.cloud.google.com/apis/credentials?project=miningtheblocks-669f6
2. Click en la Browser key
3. **Application restrictions** → HTTP referrers:
   - `https://miningtheblocks-669f6.web.app/*`
   - `https://miningtheblocks-669f6.firebaseapp.com/*`
   - `https://miningtheblocks.github.io/*`
4. **API restrictions** → Restrict key → seleccionar solo:
   - Identity Toolkit API
   - Cloud Firestore API
   - Firebase Installations API
   - Firebase Cloud Messaging API
   - Cloud Functions API
5. Guardar. Esperar ~5 min para propagación.

### 4. Verificar SERVER_SEED existe como secret
```bash
firebase functions:secrets:access SERVER_SEED 2>&1 | head -3
# Si dice "Secret SERVER_SEED does not exist", crearlo:
openssl rand -hex 32 | firebase functions:secrets:set SERVER_SEED
firebase deploy --only functions
```

⚠️ **NO LOGUEES EL VALOR** — si cambia, todos los hashes de premios cambian (fairness break).

### 5. Configurar Firestore TTL policies
Las siguientes colecciones tienen campo `expiresAt` pero no se purgan automáticamente. Configurar TTL en Firebase Console:

- `processedTxs.expiresAt` (NUEVO, agregado por CRIT #1-3) — TTL 30d
- `rateLimits.expiresAt` — TTL 7d
- `adSessions.expiresAt` — TTL 24h
- `errorLog.expiresAt` (si tiene) — TTL 30d

**Cómo:**
1. Firebase Console → Firestore → TTL
2. Add Policy → Collection ID + Field name (`expiresAt`)
3. Aplicar a cada una

### 6. Deploy todos los cambios
```bash
# Tests previos en local
cd functions && npm run lint && npm test && npm run test:rules && cd ..

# Deploy backend
firebase deploy --only functions

# Deploy rules (incluye fix cross-chain F-02 y meta/closing F-01)
firebase deploy --only firestore:rules

# Deploy hosting (incluye CSP headers en docs/, fix XSS verify.html)
firebase deploy --only hosting

# Si modificaste indexes:
firebase deploy --only firestore:indexes
```

### 7. Sync `docs/` con `public/` (GitHub Pages)
Los archivos en `docs/` se sirven por GitHub Pages, no por Firebase Hosting. Si modificás privacy/terms/etc., asegurate que `docs/` y `public/` queden sincronizados.

```bash
# Si privacy.html cambia en docs/, copiá:
cp docs/privacy.html public/privacy.html  # o al revés según el flow
git add docs/ public/ && git commit -m "sync docs+public"
git push origin master
```

### 8. EAS Build production para Android
```bash
eas build -p android --profile production
# Descargar el APK, verificar:
sha256sum MTB-v1.1.1.apk > MTB-v1.1.1.apk.sha256
# Subir al sitio de distribución + actualizar config/app.latestVersion + downloadUrl
```

### 9. Test en device real
Antes de anunciar release:
- Login con cuenta existente
- Mining un cubo (con y sin recompensa)
- Crypto payment (use_testnet=true antes de probar real)
- Claim de NFT
- Daily pick
- Restricciones de API key activas (no debe romper login/Firestore)

### 10. Backup del release keystore
Si todavía estás con `debug.keystore`, **generá el release keystore propio AHORA** antes de tener usuarios reales que no podrás actualizar sin él.

```bash
keytool -genkeypair -v -keystore mtb-release.keystore -alias mtb \
  -keyalg RSA -keysize 4096 -validity 25000
# Guardar 3 copias offline (USB encriptado, lugar físico distinto, password manager)
# Setear env vars MTB_KEYSTORE_PATH / MTB_STORE_PASSWORD / MTB_KEY_ALIAS / MTB_KEY_PASSWORD
```

---

## 🟠 Acciones de mediano plazo

### 11. Smart contract MTBGems — migración a multisig
El contrato actual (`0x54c2859411afCb51fcfE42054aDcA3484B3f29E6`) tiene **owner único EOA** controlado por `COMPANY_WALLET_KEY`. Si la key se filtra, atacante mintea infinitos NFTs tier 1 ($100k c/u).

**Migración recomendada** (requiere redeploy):
1. Crear Gnosis Safe en Polygon (multisig 2-of-3)
2. Modificar `MTBGems.sol` para usar `AccessControl` con `MINTER_ROLE`
3. Compilar + deploy nueva versión
4. Actualizar `functions/constants.js:MTBGEMS_CONTRACT` con nueva address
5. Decisión: ¿migrar NFTs existentes? (probablemente sí — sino quedan 2 contratos confundiendo OpenSea)

**Fix parcial ya aplicado en código** (sin redeploy): `renounceOwnership` deshabilitado, reentrancy guard, CEI. Esto solo vale para el próximo redeploy.

### 12. Bumpear dependencias outdated

**Hechos (2026-06-14):**
- ✅ `jest` 29 → 30 — funcionó out-of-the-box
- ✅ `@firebase/rules-unit-testing` 3 → 5 — 42/42 tests pasan
- ❌ `firebase-admin` 12 → 14 — **REVERTED**. Breaking changes: v14 no expone
  `admin.firestore`/`admin.auth` como métodos directos del namespace default,
  rompe todo el código que usa `admin.firestore.Timestamp.fromMillis()`,
  `admin.firestore.FieldValue.increment()`, `admin.firestore.FieldPath.documentId()`,
  `admin.auth().getUser()`, etc. Migración requiere refactor a imports
  modulares: `import { getFirestore, Timestamp, FieldValue, FieldPath } from
  'firebase-admin/firestore'`. ~2-3h de refactor + tests.

**Pendiente futuro:**
```bash
cd functions
npm i eslint@^9 --save-dev  # requires flat config migration (eslint.config.js)
# firebase-admin@14: scope grande, postergar hasta tener tiempo dedicado

# Cliente — bloqueado por Expo SDK 54. Agendar bump a Expo SDK 55+ cuando esté estable
cd ..
npm outdated
```

### 13. Agregar `eslint-plugin-security`
```bash
cd functions && npm i --save-dev eslint-plugin-security
# Editar .eslintrc.js: agregar "plugin:security/recommended" a extends
# Bumpear ecmaVersion a 2022 o 'latest'
```

### 14. Crear `.github/dependabot.yml`
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /functions
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

### 15. Crear `SECURITY.md`
Política de disclosure: email + SLA + scope.

### 16. Branch protection en GitHub
- Settings → Branches → Add rule → `master`
- ☑ Require pull request before merging
- ☑ Require status checks (`lint-and-test`, `security-checks`)
- ☑ Include administrators

### 17. Configurar 2FA en GitHub (cuenta miningtheblocks)
Si todavía no está activo.

---

## 🟡 Mejoras opcionales

### 18. Reemplazar `effectivecpmnetwork.com` — **WON'T FIX (justificado)**
Decisión 2026-06-14: la app NO va a stores, solo distribución directa. AdSense/
Ezoic/redes mainstream rechazan gambling + sideload. Las alternativas reputables
para este caso son:
- **Coinzilla** (top sugerida): cripto/gambling, ads relevantes para audiencia
  que ya paga en USDC. Pagan en cripto. https://coinzilla.com
- **Adsterra / PropellerAds**: similares mercado, mejor anti-malware policy
- **AdGate / OfferToro**: ofertas en vez de ads (encuestas, instalar otra app)
  — mejor UX para gambling

Mitigación actual implementada: `sid`/`token` movidos a sessionStorage antes
de cargar el script externo + URL limpiada via `history.replaceState`. Cubre
el riesgo de exfiltración de credenciales. Los ads engañosos siguen visibles
pero no comprometen la sesión del usuario.

Si la app crece y la reputación importa, migrar a Coinzilla.

### 19. Mover gemas a Firestore `config/gems` — **WON'T FIX (justificado)**
Decisión 2026-06-14: los precios/quantities/unlocks de gemas son **fijos por
diseño** (los premios son los que son, no se rebalancean). El refactor a
single source of truth en Firestore solo agregaría:
- Latencia extra en cada operación crítica
- Riesgo de Firestore offline = backend no opera
- Complejidad sin valor

Mantener el triplo (`src/utils/gems.js` + `functions/constants.js` +
`assets/gems/metadata/*.json`) es aceptable porque los 3 nunca cambian.

### 20. Audit semanal de deps
Programar un cron mensual:
```bash
cd functions && npm audit --omit=dev --audit-level=high
cd .. && npm audit --omit=dev --audit-level=high
```

### 21. Generar release keystore propio + publicar SHA-256
Si todavía usás debug.keystore para release (revisar `android/app/build.gradle:101`).

### 22. Setup EAS secrets
Mover env vars de keystore (`MTB_KEYSTORE_PATH`, `MTB_STORE_PASSWORD`, etc.) a EAS secrets en lugar de plaintext:
```bash
eas secret:create --scope project --name MTB_STORE_PASSWORD --value <password> --type string
# repetir para los otros
```

### 23. Pinear AGP + Kotlin classpath versions
`android/build.gradle:9,11` tiene los classpaths SIN versión:
```gradle
classpath('com.android.tools.build:gradle')          // sin versión
classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')  // sin versión
```
Gradle resuelve "lo más conveniente" desde el BOM de Expo. Para reproducibilidad:
1. Correr `cd android && ./gradlew dependencies | grep -E "android.tools.build:gradle|kotlin-gradle-plugin"` y ver qué versión está resolviendo.
2. Pinear explícito: `classpath('com.android.tools.build:gradle:8.7.3')` (o lo que sea).
3. Probar build local antes de pushear.

### 24. Mover debug.keystore al ubicación correcta
Existe `/MTB/debug.keystore` (root del proyecto) + `/MTB/android/app/debug.keystore` (donde lo necesita Gradle). El primero es confusión visual y riesgo de uso accidental para release.

```bash
# Verificar
git ls-files | grep debug.keystore
ls -la debug.keystore android/app/debug.keystore

# Si el del root no está en git tracked, simplemente eliminarlo:
rm debug.keystore
# Si está tracked: git rm --cached debug.keystore + commit + .gitignore
```

### 25b. Instalar babel-plugin-transform-remove-console
Para que el strip de console.* en production funcione (ya pre-configurado en `babel.config.js` opt-in via STRIP_CONSOLE=1):
```bash
npm i --save-dev babel-plugin-transform-remove-console
# Y en eas.json:production agregar "env": { "STRIP_CONSOLE": "1" }
```

### 26. Eliminar `.eas.json` fantasma
Hay un `.eas.json` (oculto) que define un projectId distinto al de `app.json`. Eliminarlo si es residual.

```bash
rm .eas.json
# Verificar: eas project:info
```

---

## 📊 Resumen estado post-fixes en código

| Categoría | Fixes en código | Acción manual |
|---|---|---|
| Crypto payments | ✅ confirmations + idempotency | Deploy functions |
| Firestore rules | ✅ cross-chain + meta scope | Deploy rules |
| 3D performance | ✅ 7 fixes (TDZ, leaks, dispose) | Build + test device |
| Web XSS | ✅ verify.html + CSP docs | Deploy hosting + sync docs |
| Smart contract | ✅ reentrancy + renounce + CEI | Redeploy (decisión) |
| Scripts admin | ✅ gating + audit log + paginación | Generar SA dedicado |
| NFT metadata | ✅ valores + external_url | Re-pin IPFS + verify |
| CI/CD | ✅ permissions + concurrency + audit | Branch protection |

---

**Fecha de la auditoría:** 2026-06-13
**Hash del commit base (antes de los fixes):** ver `git log --before=2026-06-13`
