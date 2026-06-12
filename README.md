# Mining The Blocks

Juego de minería 3D para Android. Cubos por capas, recompensas deterministas, gemas con NFT en Polygon, y pagos en USDC.

Stack: React Native 0.81 + Expo SDK 54 (managed) · Three.js (expo-gl/expo-three) · Firebase (Auth · Firestore · Functions v2 · Hosting) · ethers.js v6 · AdMob.

## Instalación (usuarios)

Descargá el APK desde [miningtheblocks.github.io](https://miningtheblocks.github.io/Mining-The-Blocks/) o desde la pestaña **Releases** de este repo.

**Antes de instalar — verificar checksum** (recomendado):

```bash
sha256sum -c MTB-v1.1.0.apk.sha256
# debe imprimir: MTB-v1.1.0.apk: OK
```

**Instalación en Android:**

1. Permití "Instalar apps de orígenes desconocidos" para tu navegador o gestor de archivos:
   - Ajustes → Apps → tu navegador → "Instalar apps desconocidas" → activar.
2. Abrí el APK descargado y tocá **Instalar**.
3. La app pide los permisos mínimos: red, audio (notificaciones) y almacenamiento (avatar).
4. Privacy policy: [privacy.html](https://miningtheblocks.github.io/Mining-The-Blocks/privacy.html) · Términos: [terms.html](https://miningtheblocks.github.io/Mining-The-Blocks/terms.html)

## Distribución (mantenedor)

Distribución directa de APK firmado (no Google Play). Build local:

```bash
cd android && ./gradlew assembleRelease
sha256sum app/build/outputs/apk/release/app-release.apk > ../MTB-v$(VERSION).apk.sha256
```

El APK se firma con un keystore propio mantenido por fuera del repo (variables de entorno `MTB_KEYSTORE_PATH`, `MTB_STORE_PASSWORD`, `MTB_KEY_ALIAS`, `MTB_KEY_PASSWORD`). `.gitignore` excluye `*.keystore`, `*.jks`, `.env*`, `credentials.json`.

## Estructura

```
.
├── App.js                          # Entry point, navegación raíz
├── index.js                        # registerRootComponent
├── src/
│   ├── components/                 # UI y render 3D
│   │   ├── DynamicCube201.js      # Cubo principal con expo-three
│   │   ├── ErrorBoundary.js
│   │   └── OverlayModalsProvider.js
│   ├── screens/                    # Pantallas de la app
│   ├── firebase/                   # Cliente Firebase + wrappers de funciones
│   ├── utils/                      # i18n, auth context, server context, logError
│   └── constants.js               # APP_VERSION, URLs, StorageKeys
├── functions/                      # Cloud Functions v2
│   ├── index.js                   # Exports (mining, gems, pagos, email...)
│   ├── constants.js               # Constantes de juego/pagos
│   └── helpers.js                 # Helpers puros (hash, geometría, códigos)
├── firestore.rules                 # Reglas de seguridad Firestore
├── firebase.json                   # Hosting + headers de seguridad
├── public/                         # Hosting estático (verify, claim de gemas)
├── contracts/                      # Contrato MTBGems (Polygon)
└── scripts/                        # Mantenimiento, generadores
```

## Setup

```bash
npm install
cd functions && npm install && cd ..
```

Variables/secrets requeridos en Firebase:
- `COMPANY_WALLET_KEY` (private key de la wallet que mintea NFTs)
- `GMAIL_APP_PASSWORD` (envío de mails de verificación y claims)

```bash
firebase functions:secrets:set COMPANY_WALLET_KEY
firebase functions:secrets:set GMAIL_APP_PASSWORD
```

## Deploy

```bash
# Funciones
firebase deploy --only functions

# Reglas de Firestore
firebase deploy --only firestore:rules

# Hosting (verify.html, claim, robots, etc.)
firebase deploy --only hosting
```

## Build de Android

```bash
eas build -p android --profile production
```

El perfil usa el keystore configurado en EAS. El AAR/APK se descarga al terminar y se sube manualmente al sitio de distribución.

## Seguridad

Auditoría completa en `AUDITORIA_PROFESIONAL.md`. Resumen de medidas implementadas:

- Validación canónica de inputs en cloud functions (cubeNumber, amounts, etc.)
- Pagos crypto con docId determinístico + transacción (anti race-condition)
- Referral codes con `crypto.randomBytes` (no derivados del uid)
- Rate limit y auth en `reportProblem`
- Reglas Firestore con whitelist/blacklist por campo
- Headers HTTP estrictos en hosting (CSP, HSTS, X-Frame-Options DENY)
- Wallet privada via `defineSecret`, nunca en código
- API key de Android restringida en GCP Console (referrers + SHA-1)

## Performance

- ProGuard/R8 minify habilitado en release
- Cache LRU de texturas en `DynamicCube201`
- Render loop pausado en background (AppState)
- Dispose recursivo de scene/renderer/textures al desmontar
- Listeners de Firestore con `limit()` para evitar reads ilimitados
- Modales montados lazy (sólo cuando se abren)

## Licencia

Propietaria. Todos los derechos reservados.
