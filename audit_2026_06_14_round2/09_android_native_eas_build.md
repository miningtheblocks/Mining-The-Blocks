# Agente #9 — Android nativo + EAS Build + APK release

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 2 |
| HIGH | 9 |
| MEDIUM | 12 |
| LOW | 13 |
| INFO | 6 |
| **TOTAL** | **42** |

> Scope: `android/`, `app.json`, `eas.json`, `.easignore`, `metro.config.js`, `babel.config.js`, `react-native.config.js`, `expo-autolinking-exclude.json`, `expo-module.config.json`, `index.js`, `MTB-v1.1.0.apk` + `.sha256`, keystore JKS, `src/utils/ads.js`, `src/components/UpdateModal.js`, `src/constants.js`, deep links de `App.js`.

---

## Top 5 críticos

1. **[CRIT-09-01] `UpdateModal` allowlist EXCLUYE el host real de descarga del APK → update flow roto + degradación de seguridad** — `src/components/UpdateModal.js:29-35` + `docs/index.html:599`. El sitio web (canonical landing) entrega el APK desde `https://github.com/miningtheblocks/Mining-The-Blocks/releases/download/v1.1.0/MTB-v1.1.0.apk`. El allowlist del UpdateModal acepta SOLO `miningtheblocks.com`, `www.miningtheblocks.com` y `miningtheblocks.github.io`. Si Firestore `config/app.downloadUrl` apunta al GitHub Release (la opción natural), `safeUrl` cae al fallback `https://miningtheblocks.com/` y el user nunca llega al APK directo — terminan buscando "Mining The Blocks APK" en Google y se exponen a APKs falsos. Fix: agregar `github.com` con path-check (`/miningtheblocks/Mining-The-Blocks/releases/download/`) y `objects.githubusercontent.com` (CDN de release assets).  Confirma indirectamente [ALTO-FE-11] del Agente #4 (la validación faltante de pathname).

2. **[CRIT-09-02] `verifyAppSignature` se puede saltar trivialmente en cualquier APK re-firmado** — `android/app/src/main/java/.../MainApplication.kt:54-97`. La función mata el proceso con `Process.killProcess(myPid())` + `exitProcess(0)` si el SHA-256 de la firma ≠ `84EB85B5F62585C3792716539CD3ED317BF4125CBCFAC78984F074C42C6CD8DF`. Un atacante con `apktool` puede: (a) patch el byte que compara `hash.equals(EXPECTED)` (1 byte en smali), o (b) borrar la llamada a `verifyAppSignature()` del `onCreate`. **R8 con `-keep class com.bissi.miningtheblocks.** { *; }`** (proguard-rules.pro:54) preserva los nombres exactos, haciendo el reverse engineering trivial. Más grave: si el catch genérico (línea 93) atrapa cualquier excepción, el check se NO-OPea silenciosamente — un `Throwable` plantado en `packageManager.getPackageInfo` permite bypass total. Es defense-in-depth débil, no garantía. Para ser real anti-tamper requiere App Check + verificación server-side de install signature via FCM token attestation.

3. **[HIGH-09-03] `enableV1Signing false` puede romper instalación en Android 6 (API 23)** — `android/app/build.gradle:129-132`. Solo V2/V3/V4 habilitados, pero `minSdkVersion=24` (Android 7) — V1 (JAR signing) es opcional desde API 24. Esto es OK funcionalmente, pero comentario "para sideload Android 6/7 mantener V1" no aplica. Lo problemático: AGP 8.x con `enableV1Signing false` + `minSdkVersion=24` está OK; pero si bumpean `minSdkVersion` a 21 (Android 5) para llegar a low-end, el APK NO instalará en API 21-23. Documentar el constraint.

4. **[HIGH-09-04] Intent filter del deep link es scheme-only y sin `autoVerify` → cualquier app puede secuestrar `exp+miningtheblocks://`** — `android/app/src/main/AndroidManifest.xml:32-37`. Sin `<data android:host=...>` ni `android:autoVerify="true"`, otra app maliciosa puede declarar el mismo intent filter; al disparar el link desde `docs/adpick.html:268` (`exp+miningtheblocks://peaks`), Android muestra el chooser y la app maliciosa puede leer el callback. **Por ahora** el handler en `App.js:378` solo abre el modal `peaks` (no procesa params), así que el impacto es bajo, pero el patrón es frágil: si en el futuro se pasan `sid`/`token` por deeplink (como hace `docs/adpick.html`), una app espía registrada con prioridad alta capturaría la sesión. Combinar con `App Links` reales (`https://miningtheblocks.com/peaks` + `assetlinks.json`).

5. **[HIGH-09-05] `index.js` importa `react-native-gesture-handler` pero está EXCLUIDO del autolinking** — `index.js:3` ↔ `expo-autolinking-exclude.json:3-4` + `react-native.config.js:14-26` + `expo-module.config.json`. El módulo nativo está deshabilitado en `sourceDir: null` para Android **e** iOS, pero el import del root sigue presente. En SDK 54 + new arch, `import 'react-native-gesture-handler'` ejecuta side-effects que requieren el módulo nativo presente — en runtime esto puede tirar un warning silencioso, devolver un no-op stub, o crashear en código `<Drawer>` (`@react-navigation/drawer ^7.5.8` está en deps). Si el Drawer está mounteado en algún screen, `GestureHandlerRootView` esperado y nunca provisto → tap-handlers no funcionan. Inconsistencia que merece resolverse: o se vuelve a habilitar el nativo, o se quita el import del entry-point.

---

## Hallazgos secundarios importantes

### Android Manifest / permisos

- **[HIGH-09-06] AD_ID permission añadido transitivamente por Privacy Sandbox sin declaración en main manifest** — merged release manifest línea 83-86 muestra `com.google.android.gms.permission.AD_ID`, `ACCESS_ADSERVICES_AD_ID`, `ACCESS_ADSERVICES_ATTRIBUTION`, `ACCESS_ADSERVICES_TOPICS` (vienen de `react-native-google-mobile-ads` + Privacy Sandbox AAR). Google Play exige **disclosure explícito** del Advertising ID en Data Safety. Para sideload no hay Play form pero Privacy Policy (`docs/privacy.html`) debe enumerar estos. Verificar.
- **[HIGH-09-07] `CAMERA` permission llega vía expo-image-picker a release sin gating en el flow** — release merged manifest:79. `expo-image-picker` solo se usa en avatar (Profile.js + Registration.js). En Android la permission CAMERA se declara como "instalada" — Play Store mostraría disclosure, en sideload Android puede asustar a users. Si el flow real solo usa Gallery, mover a `requestPermissionsAsync({ camera: false })` y NO incluir `CAMERA` permission (configurar plugin de expo-image-picker para excluir). Mismo issue marcado por [MEDIO-FE-18].
- **[HIGH-09-08] `RECEIVE_BOOT_COMPLETED` + `MY_PACKAGE_REPLACED` + receiver `expo.modules.notifications.service.NotificationsService` programa restart después de reboot** — merged manifest:80, 224-235. La app no tiene scheduled notifications de uso (App.js NO llama `scheduleNotificationAsync`), pero el receiver auto-registrado por expo-notifications quedó en release. En sideload Android sin onboarding educativo el user va a ver "Esta app se inicia al encender" y puede asustar. Si no se usa, deshabilitar via `expo-notifications` plugin config o `<receiver tools:node="remove">`.
- **[MEDIUM-09-09] FOREGROUND_SERVICE granted sin declaración de tipo** — merged manifest:87. Desde Android 14 (API 34, debajo del `targetSdkVersion=36`), foreground services requieren `foregroundServiceType` específico. `expo-notifications` lo trae pero no declara tipo → en API 34+ el SO mata el service silenciosamente al primer uso, así que las funcionalidades dependientes no funcionarán en devices nuevos.
- **[MEDIUM-09-10] `BIND_GET_INSTALL_REFERRER_SERVICE` queryable sin propósito visible** — merged manifest:94. Lo añade `play-services-measurement` / `play-services-ads` para attribution. En sideload (NO Play Store) este install referrer NUNCA va a estar populated. Permission cosmética; cero impacto pero cero valor — `tools:node="remove"` para limpiar la attack surface.
- **[MEDIUM-09-11] 20+ permisos de badge OEM (Samsung/HTC/Huawei/Sony/Oppo/EvMe...) inyectados** — merged manifest:100-115. Vienen de `expo-notifications` para badge counts. Si la app no muestra badges (ver App.js:46 `shouldSetBadge: false`), estos son inútiles y agregan ruido al device permission summary que ven los users tech-savvy. Eliminar via `<uses-permission android:name="..." tools:node="remove"/>`.
- **[MEDIUM-09-12] `CropImageActivity` exported=true sin intent-filter** — merged manifest:307-309 (`com.canhub.cropper.CropImageActivity`). Aunque sin intent-filter no responde a intents externos por nombre simbólico, sí responde a `Intent(component = ComponentName("com.bissi.miningtheblocks", "com.canhub.cropper.CropImageActivity"))`. Una app instalada puede dispararlo y pasar `URIs` arbitrarios — exploración limitada pero técnicamente accesible. Lo correcto sería `exported=false` (es una activity interna del crop flow). Fix via manifest override en `app.json` o `tools:replace`.
- **[MEDIUM-09-13] El intent filter del scheme `exp+miningtheblocks` deja "fingerprint" de DEV** — main manifest:36. El prefijo `exp+` es la convención de Expo Go / dev-client (`exp+<slug>://`). Mantener este scheme en RELEASE deja un canary visible: cualquier static analyzer del APK identifica que es app Expo y aplicar payloads conocidos. Para release "producción" usar `mtb://` o `miningtheblocks://` (sin el prefijo `exp+`).
- **[LOW-09-14] El intent filter de browseable carece de `tools:ignore="AppLinkUrlError"`** — main manifest:32-37. Linter de Android Studio va a reportar "App Link with no host" en cada build local. Cosmético, no afecta runtime.
- **[LOW-09-15] No declarado `<uses-feature android:name="android.hardware.camera" android:required="false"/>`** explícitamente en main manifest — el merged trae `glEsVersion` desde admob, pero CAMERA permission sin uses-feature hace que Play Store (si algún día lo suben) auto-asuma `required=true`. Para sideload no aplica, pero deja la app sin instalar en TVs/wearables si llegan ahí.
- **[LOW-09-16] `enableOnBackInvokedCallback="false"`** desactiva el predictive-back-gesture de Android 13+ — main manifest:20 y 313 (`AdActivity`). Trade-off conocido en RN 0.81 (algunos screens crashean con predictive back). Documentar para que cuando RN soporte bien predictive-back, se reactive.

### EAS Build / Expo config

- **[HIGH-09-17] `eas.json` profile `production` declara `buildType: app-bundle` (AAB) pero la distribución sideload requiere APK** — `eas.json:24`. Un AAB solo se puede instalar via Play Store o via `bundletool` por el dev. Si el script de release usa EAS production → genera AAB → no se puede sideloadear → confusión. El profile `preview` (que sí genera APK) es internal. Crear un profile `productionApk` o cambiar production a `apk`. Sin esto, cada release manual termina haciendo "que profile uso?" check y aumenta probabilidad de error.
- **[HIGH-09-18] `eas.json` production NO declara `env.STRIP_CONSOLE=1`** — espera, sí lo hace (línea 20). Buena praxis. Pero el profile `preview` (usado para builds internas) **NO** strippa consoles → logs verbosos en Logcat de testers. Si testers comparten Logcat para reportar bugs, info como `auth.currentUser`, `pushToken`, error stack quedan visibles.
- **[HIGH-09-19] `.easignore` excluye `*.apk`/`*.aab`/`.git` pero NO excluye `@miningtheblock__miningtheblocks.jks`** — `.easignore:42`. La línea `*.keystore` cubre `debug.keystore` y `mtb-release.keystore` (patrón estándar), pero el filename actual `@miningtheblock__miningtheblocks.jks` solo es capturado por `*.jks` que NO está en `.easignore` (sí en `.gitignore`, pero `.easignore` es independiente). Si el dev hace `eas build` desde local, EAS sube el contexto que incluye **el JKS** → expone la keystore privada a EAS Cloud. CRIT operacional si el dev no notó esto. Fix: agregar `*.jks` y `*.pkcs12` a `.easignore`.
- **[MEDIUM-09-20] `.env` está committable porque `.gitignore:9` solo cubre el exact name `.env`, pero está en working dir** — `.env` tiene `NODE_ENV=development` (no secrets). OK ahora, pero la convención del repo invita a dev a meter secrets en `.env`; un `git add -A` accidental los committea. Recomendar `.env.example` documentado + `.env` siempre fuera de root.
- **[MEDIUM-09-21] EAS profile `production` no declara `credentialsSource`** — `eas.json:18-27`. Sin esto, EAS usa credentials cloud (genera keystore en su lado). El profile `preview` sí declara `credentialsSource: local`. Resultado: builds de production firman con UNA KEYSTORE DISTINTA de las builds preview → users que actualicen entre ramas (preview→production) tendrían que desinstalar+reinstalar. Si ya hay APKs distribuidos firmados con local, todo build subsiguiente debe usar `credentialsSource: local`.
- **[MEDIUM-09-22] `expo-autolinking-exclude.json` + `react-native.config.js` + `expo-module.config.json` triplican la misma exclusión** — tres archivos manejando exclude de `reanimated`/`gesture-handler`. Mantener tres configs incrementa riesgo de divergencia (uno bumpea, otro queda atrás). Consolidar en `react-native.config.js` y borrar los otros dos, o documentar en `MaintainersGuide.md` cuáles son la fuente de verdad.
- **[MEDIUM-09-23] `metro.config.js` no extiende para SVG transformer pero `react-native-svg-transformer` está en deps** — `package.json:40` + `metro.config.js:1-5`. Si los SVG son procesados como assets (con `expo-asset`) está OK, pero el transformer instalado y NO usado es dead code en deps (~50KB). Si los SVG sí son `import 'foo.svg'`, va a romper en runtime porque el transformer no está conectado. Verificar uso real o limpiar.
- **[MEDIUM-09-24] `react.edgeToEdgeEnabled` declarado tres veces** — `app.json:23` (`android.edgeToEdgeEnabled: true`) + `gradle.properties:53` (`edgeToEdgeEnabled=true`) + `gradle.properties:71` (`expo.edgeToEdgeEnabled=true` con WARNING de deprecación). El propio comentario en gradle.properties:70 advierte que `expo.edgeToEdgeEnabled` será removido en SDK 55. Limpiar antes del bump.

### AdMob

- **[MEDIUM-09-25] `androidAppId` AdMob hardcoded en `app.json:44` mientras que el comentario CRIT-19 en `src/constants.js:2-3` advierte NO importar `package.json` por leak de info** — `ca-app-pub-4718826806092770~3631324090` queda en bundle JS Y en `AndroidManifest.xml`. El Application ID NO es secreto (es lookuppable via reverse-engineering del APK con cualquier `apktool`), pero el Unit ID `ca-app-pub-4718826806092770/4752834073` (`src/utils/ads.js:7`) sí merece estar fuera del bundle JS: un atacante con el Unit ID puede generar impresiones falsas y agotar tu cuota / suspender la cuenta. Mover a Firebase Remote Config para poder rotar sin redeploy.
- **[LOW-09-26] iOS `bundleIdentifier` ausente en `app.json:15-17`** — `ios: { "supportsTablet": true }` y nada más. Cuando se publique iOS, EAS va a generar un bundleId default que puede no match con el del proyecto Apple Developer. Trivial, pero costoso de fixear post-publicación si se afecta TestFlight.
- **[LOW-09-27] `requestNonPersonalizedAdsOnly: false`** — `src/utils/ads.js:26`. Sin gate por consent CMP. Si el user es UE/GDPR, esto es violación del IAB TCF v2 (incluso fuera de Play Store). Para sideload con users globales, agregar Google UMP CMP (User Messaging Platform) o pasar `true` por defecto. Sin esto, hipotético usuario UE reportando puede bloquear ingresos AdMob globalmente.
- **[INFO-09-28] Test ads en debug** — `src/utils/ads.js:11-13`. Patrón correcto con `__DEV__` + `TestIds.REWARDED`.

### APK release / keystore / sideload

- **[HIGH-09-29] El keystore JKS (`@miningtheblock__miningtheblocks.jks`) está en root del working tree, no en git pero PRESENTE en filesystem** — riesgo operacional. Si dev abre VS Code workspace + agente IA con permisos amplios + Sync/Drive/Backup → la keystore sale del control del dev. Recomendación: moverla a `~/.mtb-keys/` fuera del repo y referenciar por env var `MTB_KEYSTORE_PATH=$HOME/.mtb-keys/...`. La build.gradle ya lo soporta. También: el nombre con prefijo `@` puede confundir a herramientas que tratan `@` como token (npm packages, gradle classpaths, shell expansion).
- **[HIGH-09-30] No hay verificación automatizada del SHA-256 del APK contra el `.sha256` committeado** — `MTB-v1.1.0.apk.sha256` existe pero no hay script de CI que verifique. Manual verification: el SHA en el .sha256 (`b8e585e2c4ae7a7be045f24a837fc7288fbd3aad981c6421e88ab6a8c3a73238`) **SÍ** matchea el SHA computado localmente. Confirmado el archivo no fue corrompido. Pero: para evitar drift, agregar pre-commit hook que recompute y reescriba `.sha256` cada vez que el APK cambie. Sin esto, en el próximo release puede committearse un APK sin `.sha256` actualizado, y users que verifiquen reportarán "el hash no matchea" → pánico social.
- **[MEDIUM-09-31] El sitio web (`docs/index.html`) ofrece el APK pero NO muestra el SHA-256 al user** — confirmado por inspección. Para sideload seguro la UX debe ser: "Descarga + acá el hash + cómo verificarlo". El SHA está disponible (`MTB-v1.1.0.apk.sha256`) pero no surface en HTML. Risk: user descarga, instala sin verificar, y un APK MITM-eado pasaría.
- **[MEDIUM-09-32] `versionCode=5` con `versionName="1.1.0"` (versionCode bump consistente?)** — build.gradle:96-97. La fórmula común es `versionCode = MAJOR*10000 + MINOR*100 + PATCH` o monotónico. `5` es monotónico OK, pero si el user tiene una build "preview" con versionCode más alto, instalar la "production" la BLOQUEA (downgrade). Documentar y mantener `versionCode` independiente entre preview/production o usar `appVersionSource: remote` en `eas.json`.
- **[MEDIUM-09-33] `appVersionSource: local`** — `eas.json:3`. Cada build manual depende de que el dev acuerde de bumpear `versionCode` en `build.gradle`. Si rebuild con mismo `versionCode`, los APKs distribuidos chocan (mismo hash de install no, pero misma version code). Migrar a `appVersionSource: remote` y dejar que EAS lleve el counter — elimina la categoría de error.

### Network / cleartext / backup

- **[LOW-09-34] Pinning de Google CAs documentado pero comentado** — `network_security_config.xml:23-34`. Decisión razonable (Google rota), pero merece doc operacional: "fallback si users reportan SSL pinning errors → revisar `pki.goog`".
- **[LOW-09-35] `data_extraction_rules.xml` solo excluye `cloud-backup` y `device-transfer`, no declara qué pasa con `include` para "approved" backups** — al ser todo `exclude`, está OK. Pero la doc de Android recomienda explicit `<include domain="..." />` para archivos seguros (e.g. game settings). Para `mtb` no aplica (no hay nada seguro de respaldar), pero queda como gap conceptual.
- **[LOW-09-36] Debug variants (`debug`, `debugOptimized`) tienen `SYSTEM_ALERT_WINDOW`** — `AndroidManifest.xml` (debug):4. Esto permite a la app dibujar over otras apps. Necesario para react-native dev menu. **Verificar que `usesCleartextTraffic=true` y `SYSTEM_ALERT_WINDOW` NUNCA se filtren a release** — el manifest merge ya los excluye porque solo viven en `src/debug/` y `src/debugOptimized/`. OK.

### ProGuard / R8

- **[MEDIUM-09-37] ProGuard `-keep class com.bissi.miningtheblocks.** { *; }`** — `proguard-rules.pro:54`. Esto KEEPSEA todo el package interno (MainActivity + MainApplication) **incluyendo `verifyAppSignature`**, lo que hace trivial parchear el bytecode con `apktool`. Cambiar a `-keep class com.bissi.miningtheblocks.MainActivity { *; }` + `-keep class com.bissi.miningtheblocks.MainApplication { void onCreate(); }` y dejar que R8 ofusque el resto, especialmente `verifyAppSignature`. Combinar con `-allowaccessmodification` y `-repackageclasses ''`.
- **[LOW-09-38] `-keepattributes LineNumberTable` mantenido**: facilita retrace pero también deja crash analytics legibles para un atacante. Trade-off operacional. OK por ahora.
- **[INFO-09-39] `-keep class com.google.firebase.** { *; }` excesivo pero estándar** — proguard-rules.pro:28. Vale la pena revisar si SOLO se necesitan Firestore + Auth + Functions + FCM (admite `-keep class com.google.firebase.{firestore,auth,functions,messaging}.** { *; }`). Reducir = menos código que mantener vivo en R8 = mejor minify + ofuscación.

### Misc

- **[LOW-09-40] `metro.config.js` no setea `transformer.minifierConfig.compress.drop_console`** — relies en babel plugin. Cinturón sin tirantes: si babel cache stale, consoles quedan. Belt-and-braces: agregar también minifier config.
- **[INFO-09-41] `babel.config.js` usa `api.cache.using` con `STRIP_CONSOLE` env var** — patrón correcto, evita el bug "cache pinned siempre off".
- **[INFO-09-42] `versionCode=5` y `versionName="1.1.0"` matchea `package.json` y `FALLBACK_APP_VERSION` en `src/constants.js:9`** — sync correcto.

---

## Patrones positivos detectados (15)

- **AppManifest hardening completo**: `allowBackup=false` + `fullBackupContent=false` + `dataExtractionRules` + `tools:replace` para no perder los flags si una lib transitiva los pone a true.
- **`networkSecurityConfig` con cleartext=false + solo CAs del sistema** → MITM con cert root del user no funciona en release.
- **`maxSdkVersion=28` en READ/WRITE_EXTERNAL_STORAGE** → permisos obsoletos no aparecen en API 29+ (granular media).
- **`enableV1Signing false` + V2/V3/V4 enabled** → footprint mínimo, no jar-signing legacy. Alineado con `minSdkVersion=24`.
- **`signingConfigs.release` falla early si faltan env vars** (build.gradle:117-123) cuando se tipea task `:assembleRelease` → previene el footgun "AGP 8 produciendo APK unsigned utilizable via `adb install -r`".
- **`tools:replace="android:value"` en `APPLICATION_ID`** garantiza que el AdMob App ID no sea sobreescrito por una lib transitiva.
- **`expo.modules.updates.ENABLED=false`** explícito en manifest → no hay OTA channel que comprometer.
- **`.gitignore` cubre `*.keystore`, `*.jks`, `mtb-release.*`, service accounts, ProGuard mapping** → keystore JKS está local pero no en history.
- **Anti-tamper signature check en `MainApplication.onCreate`** — aunque bypasseable, sube barrera. Defense in depth.
- **`screenOrientation="portrait"` + `launchMode="singleTask"`** → previene re-launch en multiple instances + UX consistente.
- **`R8/minify` + `shrinkResources` + `crunchPngs` activos en release** → APK ofuscado y minimo footprint.
- **ProGuard keeps específicos para Reanimated/Worklets/GestureHandler/Hermes/Expo Kotlin** evitan crashes runtime por reflection.
- **`-renamesourcefileattribute MTB`** elimina filenames originales del stack trace de release.
- **Babel `transform-remove-console` con `exclude: ['error','warn']`** preserva diagnostic info legítima en release.
- **APK SHA-256 publicado** (`MTB-v1.1.0.apk.sha256`) + computed hash matchea → APK distribuido no corrupto.

---

## Conclusión

El stack Android está **bien endurecido en lo estructural**: manifest tiene allowBackup/cleartext/dataExtractionRules en orden, signing config falla early si faltan env vars, ProGuard mantiene reflection correcta, network_security_config razonable. Las decisiones documentadas con comentarios SEC-A*/REL-* muestran disciplina post-auditoría. Para sideload sin Play Integrity, el hardening visible es del orden de lo posible sin App Check.

**Lo que bloquea release suave** son dos issues acoplados:

1. **CRIT-09-01** — el UpdateModal NO acepta el host real de descarga del APK (`github.com`). En producción, cuando llegue una nueva versión, los users de la v1.1.0 instalada van a apretar "Descargar", terminar en la landing en lugar del APK, buscar "MTB APK" en Google, e instalar lo que sea que aparezca. Fix triviallines: agregar `github.com` con path-check al allowlist. Mismo bug también en sentido contrario: si decidieran cambiar la distribución a `miningtheblocks.com/releases/x.y.z/MTB.apk`, el código actual SÍ funcionaría — pero el sitio web sigue apuntando a GitHub. Sincronizar.

2. **HIGH-09-19** — `.easignore` NO excluye `*.jks`. Si el dev corre `eas build` desde la máquina con la keystore JKS en el working dir, EAS Cloud recibe el JKS como parte del contexto. Trivial de fixear (una línea), crítico operacional.

**Defense-in-depth (no bloquea, vale la pena cerrar antes del ramp-up de marketing):**

- Reducir permisos transitivos inútiles (BIND_GET_INSTALL_REFERRER_SERVICE, badge OEM, RECEIVE_BOOT_COMPLETED si no hay scheduled notifications).
- Mover AdMob Unit ID a Remote Config para poder rotar sin redeploy.
- Ofuscar `verifyAppSignature` con ProGuard restrictivo (no `keep` todo el package interno).
- Migrar deep link a App Links reales (`autoVerify=true` + `assetlinks.json`) cuando se confirme `miningtheblocks.com` HTTPS estable.
- Mostrar el SHA-256 del APK en la landing page + instrucciones de verificación.
- Resolver el triple-source de exclusión de `reanimated`/`gesture-handler` y el import roto en `index.js`.

El cuerpo del trabajo es bueno. Las brechas son del último 10% — pulido y operaciones, no fundamentos.
