# Agente #11 — Operacional: backups, DR, secrets, monitoring, CI/CD, incident response

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 6 |
| HIGH | 11 |
| MEDIUM | 14 |
| LOW | 9 |
| INFO | 5 |
| **TOTAL** | **45** |

> Scope cubierto: `functions/index.js` (backup scheduler, secrets, audit logs, error log), `firestore.rules` (TTL collections), `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/*.js` (credentials, audit fields), `.env`, `.gitignore`, `.easignore`, `firebase.json`, `.firebaserc`, keystore JKS file presence, `README.md`, `SECURITY.md`, `ACCIONES_MANUALES.md`, `AUDITORIA_SIDELOAD.md`.
>
> Cross-refs principales: Agente #1 backend, #3 contract (CRIT-1 owner EOA, CRIT-5 IPFS), #6 auth (CRIT-1 email rate-limit, grant_admin token, App Check), #8 payments, #9 keystore + .easignore, #10 grant_admin token + audit operator spoof, #12 cost monitoring + RPC sin SLA.

---

## Top 5 críticos

1. **[CRIT-11-01] Backup de Firestore declarado pero NUNCA verificado — restore es teórico** — `functions/index.js:1697-1714` + `ACCIONES_MANUALES.md`. `firestoreBackupScheduled` corre 03:00 daily y llama `client.exportDocuments(...)` a `gs://miningtheblocks-669f6-backups/<YYYY-MM-DD>`. Pero:
   - El bucket NO está garantizado a existir — los comments dicen "si no existe, loguea error y no falla" (líneas 1689-1696, 1710-1713). El catch global se traga el error: el operador solo ve el problema buscando manualmente "firestoreBackupScheduled error" en Cloud Logging, NO hay alert (CRIT-11-02).
   - **NUNCA se documentó un restore test**. El whole point de un backup es restaurarlo. Si el bucket no existe, lifecycle rule borra >30 días incorrectamente, IAM se rotó, o el formato cambió (Google deprecó v1 en algún punto), el operador se entera en el momento de la crisis. RPO real = 24h, RTO real = **DESCONOCIDO** (probablemente 2-6h por export+import + reindexing + retesting auth claims).
   - El `collectionIds: []` (línea 1707) exporta TODO incluyendo PII no scrubeada (emails, phones del flow de gem claim, wallet addresses) — el bucket es Standard, sin **CMEK** ni **encryption-at-rest declarado** (default-server-side encryption Google, no customer-controlled). Si la cuenta GCS se compromete, el atacante tiene snapshot diario fresco de TODA la base.
   - **Sin verificación de integridad**: el operador NO sabe si el export tiene 0 bytes, está truncado, o tiene corrupción de metadata Firestore. Fix mínimo: un follow-up function que lea el `LATEST` marker, valide tamaño mínimo, y escriba a `adminActions` con `action: 'backup_verified'` o `'backup_failed'` + envíe email si falla 2 días seguidos.

2. **[CRIT-11-02] CERO alerting operacional — outages se descubren via Twitter del cliente** — barrido completo + grep. La app emite logs a `errorLog` (Firestore) y `adminActions` (Firestore) y `console.error` (Cloud Logging), pero NO existe NINGÚN alerting:
   - Backup falla silenciosamente (`console.error` solo).
   - MATIC balance en `COMPANY_WALLET_KEY` queda en 0 → mints fallarán por "insufficient gas" 5 veces, marcan `failed`, y solo entonces sale email (`functions/index.js:1217-1233`). Para entonces el holder ya está enojado. Confirmado por Agent #12: ningún `provider.getBalance()` pre-mint.
   - `pendingMints` con `status: processing` >1h (Agent #8 CRIT-2) — gemas perdidas — NO se alerta.
   - Spike de `sendVerificationEmail` (Agent #6 CRIT-1) — bombing → Gmail suspended → outage TOTAL de emails — NO se alerta.
   - Budget alerts en Firebase Console: **no documentados** en `ACCIONES_MANUALES.md`. Agente #12 estimó pesimista $700/mes a 10k DAU; sin budget alert, una explosión por bug en bucle (`logClientError` errores en loop, o `getServers` ratel sin cap) factura $1k antes de que el operador note. Sin tarjeta de crédito con cap, Google Cloud sigue ejecutando.
   - RPC `polygon-bor-rpc.publicnode.com` (`functions/index.js:1109, 1435`) sin SLA — si cae, mint + paymentProcessor fallan silently y errores quedan en logs.
   - Backup que falla, NO se alerta. Combinado con CRIT-11-01: backup roto durante 30+ días = pérdida silenciosa de capacidad de DR.
   
   Fix mínimo P0: Google Cloud Monitoring alerts en (a) `severity >= ERROR` en `firestoreBackupScheduled` por 2 días seguidos, (b) custom metric MATIC balance < 1, (c) custom metric `count(pendingMints where status='processing' and createdAt < now()-3600s) > 0`, (d) budget alerts en $50/$100/$200/$500 con email + SMS.

3. **[CRIT-11-03] Compromise de `firebase-tools.json` = pwn total del proyecto, sin separación de roles ni audit defensivo** — `scripts/grant_admin.js:25`, `delete_users.js:8`, `full_reset_game.js:19`. (Ya cubierto por Agente #6 HIGH + Agente #10 CRIT-10-05.) Ángulo nuevo operacional:
   - **Sin separación**: ese token tiene `roles/owner` heredado del `firebase login` user. Owner == puede leer Secret Manager (`gcloud secrets versions access COMPANY_WALLET_KEY` → drena la wallet onchain), puede leer todos los backups (CRIT-11-01) descargando snapshot de `gs://*-backups`, puede pausar billing alerts (CRIT-11-02), puede ejecutar `gcloud projects delete miningtheblocks-669f6` (irreversible). El developer NO tiene cuenta separada de "developer normal" vs "billing admin" vs "auth admin". Una sola compromise = pérdida total.
   - **Sin alerting de uso**: no hay alert "se usó el access_token desde un nuevo IP en las últimas 24h" — Google Workspace tiene sign-in alerts pero el developer no está en Workspace, está en Gmail consumer (asumido por `miningtheblocks@gmail.com`). Detección post-mortem únicamente.
   - **`operator: process.env.USER`** (`grant_admin.js:87`, `delete_users.js:124`, `delete_servers.js:50`, `full_reset_game.js:208`) spoofeable trivialmente — Agente #10 ya lo marcó. Agrego: una vez comprometida la máquina del dev (RAT, malware, comprometed npm package, agente IA con permisos amplios), el atacante tiene 60min para drenar todo antes que cualquier `adminActions` audit log refleje su identidad real.
   - **Fix operacional (no código)**: (1) crear un service account JSON dedicado `mtb-admin-cli` con SOLO `roles/firebaseauth.admin` + `roles/datastore.user`. (2) Reemplazar `firebase-tools.json` por `GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json node scripts/...`. (3) Loguear `operator` con `os.userInfo().username + '@' + os.hostname() + '|' + pid`. (4) Habilitar audit logs de Cloud KMS / Secret Manager en GCP Audit (gratis, queda en Cloud Logging). (5) Auth dev en una cuenta de workspace separada — costo ~$6/mes/user — con security key obligatorio.

4. **[CRIT-11-04] Keystore JKS sin backup offline documentado — pérdida = end of life del producto** — `@miningtheblock__miningtheblocks.jks` en root del repo (2193 bytes, presente en filesystem, NO en git, confirmado por Agent #9 HIGH-09-29). Para sideload el keystore es **el** secret más crítico:
   - Sin él, **NO se puede shipear ningún update**. Android rechaza APK firmados con signature distinta — los users existentes quedan en la versión vigente PARA SIEMPRE.
   - Si en el momento de la pérdida hay un bug de seguridad activo, **NO HAY FIX POSIBLE** para usuarios existentes. Hay que pedir a TODA la base que desinstale + reinstale con nueva keystore — pérdida de datos locales + retención + reputación.
   - El `ACCIONES_MANUALES.md` línea 92 dice "3 copias offline" como recomendación pero NO declara ubicaciones, frecuencia de verificación, ni runbook de "perdí el keystore — qué hago".
   - El nombre `@miningtheblock__miningtheblocks.jks` tiene `@` prefijo (Agent #9 LOW): shell expansion en zsh con globbing puede romper paths; el doble `__` sugiere un typo (`miningtheblock` vs `miningtheblocks`) — error de naming temprano puede haberse propagado a copias offline. Verificar que el offline matche bit-a-bit con `sha256sum` documentado.
   - **Fix runbook**: (1) `sha256sum @miningtheblock__miningtheblocks.jks > KEYSTORE_HASH.txt` guardar en password manager (no en repo). (2) 3 copias offline: USB encriptado VeraCrypt en cajón físico + servicio cloud personal encriptado (rclone+age) + casa de un familiar. (3) Quarterly: cuando salga release, verificar las 3 copias siguen leyendo el mismo hash. (4) Documentar pasos para emergencia.

5. **[CRIT-11-05] `SERVER_SEED` no rotable por diseño — leak es permanente** — `functions/index.js:29, 747`. El seed alimenta `HMAC(SERVER_SEED, blob)` para `getGemForCube` y `getRewardForCube` (lottery determinism + fairness). Hay un trade-off de seguridad inherente a este diseño:
   - **No-rotation**: si rotás SERVER_SEED, **todos los premios calculados a futuro cambian respecto a los pre-rotation**. Los usuarios que minaron sin recibir gema todavía esperan que las gemas estén en posiciones específicas (calculables si tienen acceso al seed). Rotar = romper la fairness commitment del juego ("gemas en posición X determinístico").
   - **Leak es catastrófico operacionalmente**: si malware en la máquina del dev (vía firebase-tools.json access_token leído + `gcloud secrets versions access SERVER_SEED`) extrae el seed, el atacante puede **pre-calcular qué celdas tienen gemas tier-1 ($100k)** y enfocar su mineo allí. NO hay forma de detectar el leak hasta que el dev vea que un user "lucky" tiene 10 gemas tier-9 — y el tiempo se mide en horas, no semanas.
   - **Agent #1 HIGH-12** ya proponía `effectiveSeed = HMAC(SERVER_SEED, serverId)` para limitar el blast radius por server. Combinado con la opción de rotar **por server** al finalizar episodio (el seed nuevo afecta solo el próximo episode), el leak de un seed compromete UN server-episode, no toda la economía.
   - **Fix runbook P0**: (a) implementar `effectiveSeed = HMAC(SERVER_SEED, serverId + episodeNumber)` AHORA — pre-launch real. (b) documentar que SERVER_SEED es **append-only** (versionar `SERVER_SEED_v1`, `v2`...) y que cada server-episode usa una versión específica. (c) audit logs de cada `gcloud secrets versions access` en GCP audit logs + alert si lee desde IP nueva.

---

## Hallazgos secundarios importantes

### 1. Backups y disaster recovery (BDR)

- **[HIGH-11-06] `firestoreBackupScheduled` exporta a un bucket cuyo nombre se construye sin verificar** — `functions/index.js:1702`. `gs://${projectId}-backups`. El export GCS API devuelve `operation.name` (cosa de Long-Running Operation) pero el code NO verifica que la operation termine con éxito — solo loguea el inicio. Si la operation se cae a los 30min con `FAILED_PRECONDITION` por IAM faltante, el `console.error` NO se ejecuta porque el promise ya retornó. Fix: poll de `operation.metadata.endTime` antes de loguear "success", o usar `operation.promise()` que sí espera.

- **[HIGH-11-07] Sin lifecycle rule documentada en `gs://miningtheblocks-669f6-backups`** — `functions/index.js:1695` comment dice "Bucket lifecycle: borrar exports >30 días para no acumular costos" pero es DOC, no código. Sin lifecycle, después de 1 año: 365 exports × ~50-500MB cada uno = 18-180GB Standard storage = ~$4-40/mes acumulado para algo que solo necesita los últimos 30 días. Más grave: 365 días de exports = 365 días de PII histórica accesible si el bucket se compromete. Agente #12 lo cubrió como costo. Operacional: documentar el comando exacto en `RUNBOOK.md`:
  ```
  gsutil lifecycle set <(echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}') gs://miningtheblocks-669f6-backups
  ```

- **[HIGH-11-08] Restore procedure NO documentado en ningún lado** — no hay `RUNBOOK.md` ni `DR.md`. El equipo de 1 persona, ante un evento real, va a tener que improvisar:
  ```
  gcloud firestore import gs://miningtheblocks-669f6-backups/<YYYY-MM-DD>
  ```
  pero las consecuencias operacionales NO están documentadas: (a) restore en (default) database **OVERWRITE** lo existente — hay que decidir si restorear a una nueva database y luego point-to-point migrar; (b) restore tarda hours en bases >1GB; (c) los Cloud Functions schedulers siguen corriendo durante el restore → race conditions silenciosas; (d) hay que pausar manualmente `mintProcessorScheduled` + `cryptoPaymentProcessorScheduled` antes (no hay flag para esto). Fix: documentar el procedure paso a paso + crear un flag Firestore `config/maintenance.frozen = true` que los schedulers chequeen al inicio.

- **[HIGH-11-09] Sin staging environment — restore solo se puede testear pisando producción** — `.firebaserc:3` define solo `default: miningtheblocks-669f6`. Ningún proyecto `mtb-staging` o `mtb-test`. Test de restore real (= la única forma de saber si tus backups funcionan) requiere otro proyecto que importe el backup y se valide con tests automatizados. Sin staging:
  - El primer restore real será durante un incident → improvisación.
  - Cualquier migration de schema (índices, nuevas colecciones) se prueba directo en prod.
  - Code que escribe `console.log("uid=...")` se descubre en prod logs.
  Recomendación: crear `miningtheblocks-staging`, runbook que copie 1 día de backup a staging, restorear allí, correr tests E2E. Costo: $0-5/mes si se usa Free tier.

- **[MEDIUM-11-10] Backup NO incluye Cloud Storage ni Auth users** — `firestoreBackupScheduled` solo exporta Firestore. Pero el proyecto también tiene: (a) Auth users (los UIDs son los keys de toda la app — si se pierden, los datos Firestore están sueltos con UIDs huérfanos). (b) Cloud Storage `storage.rules` apunta a un bucket implícito con avatars (probably `gs://miningtheblocks-669f6.firebasestorage.app/`). El export NO los toca. Solución parcial: `gcloud identity-toolkit export-users` mensual + `gsutil rsync gs://avatars-bucket gs://avatars-backups/<date>/`.

- **[MEDIUM-11-11] Smart contract recovery NO existe — pause() es defensivo pero atacante con la key cierra antes** — `contracts/MTBGems.sol` + Agent #3 CRIT-1. Si `COMPANY_WALLET_KEY` se compromete, el atacante puede llamar `pause()` o `transferOwnership(attacker)` ANTES que el dev. El recovery "natural" sería pause() + redeploy + migration — pero como nunca se hizo, no hay procedure documentado. Si ocurre, el dev va a tener que improvisar: deploy un nuevo contrato, escribir Function que mintea las gemas pendientes en el nuevo address, actualizar `MTBGEMS_CONTRACT` en `functions/constants.js`, comunicar a los users de OpenSea (imposible — solo holders verificados pueden ser contactados via reservoir/etherscan). Fix: pre-launch real, hacer la migración a multisig (Agent #3 CRIT-1) — convertir un "single point of total failure" en "single point of slow failure".

- **[MEDIUM-11-12] Cloudflare account compromise = DNS hijack = sirve APK malicioso** — `miningtheblocks.com` está en Cloudflare Registrar (memoria de proyecto). Si la cuenta Cloudflare se compromete, atacante: (a) cambia DNS para apuntar a su servidor que sirve un APK con malware; (b) los usuarios de v1.1.0 actualizando descargan via `UpdateModal` (que validó allowlist solo en `miningtheblocks.com` host — Agent #4 ALTO-FE-11 + Agent #9 CRIT-09-01); (c) instalan APK firmado con keystore distinta — Android NO instala. Pero si Cloudflare AT THE SAME TIME ofrece APK firmado con la keystore real (que el atacante no tiene), el ataque falla. La barrera de la firma protege contra Cloudflare hijack — **PERO** solo si el operador no expone también la keystore en otra brecha. Fix runbook: (1) 2FA con security key (FIDO2) en Cloudflare. (2) Recovery codes guardados offline. (3) Email account de la cuenta Cloudflare con 2FA + alert "new login from unknown IP". (4) Cloudflare Registry Lock activado (impide cambios DNS sin contacto manual con Cloudflare support).

- **[MEDIUM-11-13] GitHub account compromise = APK falso en Releases** — repo `miningtheblocks/Mining-The-Blocks`, distribución via Releases. Si la cuenta GitHub se compromete, atacante sube un APK con malware como `v1.2.0` y los users que vienen del sitio (que apunta al GitHub Release) descargan e instalan. La firma de keystore NO protege porque el atacante puede generar un APK no firmado con un package distinto si los users no chequean. **Mitigantes existentes**: `MTB-v1.1.0.apk.sha256` está en git, README enseña verificación (`sha256sum -c`). Pero (a) los users no verifican mayoritariamente; (b) el sitio `docs/index.html` NO muestra el SHA-256 (Agent #9 MEDIUM-09-31). Fix runbook: 2FA con security key en GitHub + branch protection con required signed commits + GitHub releases requieren approval del owner.

- **[LOW-11-14] Sin `git tag` por release** — `git log` no muestra tags. Sin tag, un atacante con commit access puede force-push sobre history y reescribir qué commit fue v1.1.0. Recommendation: `git tag -s v1.1.0 <commit> && git push origin v1.1.0` con tags signed GPG.

### 2. Secrets management

- **[HIGH-11-15] Solo 3 secrets en Secret Manager — superficie mínima, pero no hay rotation procedure** — `functions/index.js:27-29`. `COMPANY_WALLET_KEY`, `GMAIL_APP_PASSWORD`, `SERVER_SEED`. Análisis por secret:
  - `COMPANY_WALLET_KEY`: si se rota → hay que (1) generar nueva EOA; (2) `contract.transferOwnership(newAddress)` desde la vieja; (3) fondear nueva con MATIC; (4) `firebase functions:secrets:set COMPANY_WALLET_KEY <newKey>`; (5) `firebase deploy --only functions`. El procedure NO está documentado. **Tiempo a recovery**: 30-60min con todo a mano; 4h+ improvisando.
  - `GMAIL_APP_PASSWORD`: si se rota → hay que (1) en Google Account → App passwords → generar; (2) revocar la vieja; (3) `secrets:set`; (4) deploy. El procedure es trivial pero la consecuencia operacional NO está pensada: durante los ~10min entre revocar la vieja y propagar la nueva, todos los flows que mandan email (verify, claim, reportProblem, mint alert — Agent #6 CRIT-1) **fallan**. Solo el dev sabe que hay maintenance — los users ven errores genéricos. Fix: documentar window de maintenance + considerar 2 secrets `GMAIL_APP_PASSWORD_A` + `GMAIL_APP_PASSWORD_B` para zero-downtime rotation.
  - `SERVER_SEED`: **NO rotable por diseño** (ver CRIT-11-05). Mitigación parcial: si se filtra, el daño es retroactivo y futuro hasta que se haga el fix de `effectiveSeed = HMAC(SERVER_SEED, serverId+episode)`.

- **[HIGH-11-16] Smart contract owner EOA private key vive en Secret Manager — punto único** — `COMPANY_WALLET_KEY`. Si Secret Manager es comprometida (vía firebase-tools access_token → `gcloud secrets versions access`), tiene control del contrato + balance MATIC para gas + capacidad de mintear cualquier tier. Multi-sig (Agent #3 CRIT-1) lo soluciona: la wallet backend solo tendría `MINTER_ROLE` (mintea pero no transfiere ownership ni saca fondos). Reiterando como hallazgo operacional: el "owner" es una sola signature en una sola key, sin hardware wallet, sin air-gap, sin 2-of-3.

- **[MEDIUM-11-17] Sin `gcloud auth` audit ni `firebase login --reauth` periódico** — `firebase-tools.json` cargado por scripts (`grant_admin.js:25`, etc.) usa un **refresh token de larga duración**. Google rota Workforce identity tokens cada hora pero los OAuth refresh de `firebase login` son válidos hasta que el user lo revoca explícitamente. Si el dev clona el repo en una máquina nueva, copia `~/.config/configstore/firebase-tools.json`, **el viejo token sigue funcionando**. No hay procedure de "renew quarterly". Fix: documentar `firebase login --reauth` cada 90 días + revocar tokens viejos en Google Account → Security → Third-party apps.

- **[MEDIUM-11-18] `.env` en root (49 bytes, `NODE_ENV=development` + `EXPO_PUBLIC_ENV=development`) es inocuo pero invita a futuro footgun** — Agent #9 MEDIUM-09-20 lo marcó. Ángulo operacional: si en el futuro el dev quiere agregar `PINATA_JWT=...` o `WEB3_STORAGE_TOKEN=...` o `ETHERSCAN_API_KEY=...` (todos plausibles para scripts de mantenimiento), el path of least resistance es agregarlo al `.env`. El `.gitignore:9` cubre `.env` exact name, pero el archivo está en `working tree` y el dev podría hacer `git add -f .env` por error. CI `.github/workflows/ci.yml:74-80` chequea que `.env` no esté committeado — bien. Pero no hay `.env.example` documentando qué vars son válidas — el patrón se va a propagar mal. Fix: agregar `.env.example` con TODO los nombres permitidos + `pre-commit` hook (no instalado) que falle si hay `git diff --cached -- .env`.

- **[MEDIUM-11-19] `service-account*.json` y `firebase-adminsdk-*.json` están en `.gitignore` pero NO en `.easignore`** — `.easignore:38-46` cubre `*.keystore` y `.env*` pero NO `service-account*.json` ni `*-adminsdk-*.json`. Si el dev pone un SA dedicado (fix de CRIT-11-03) en root del repo (e.g. `service-account-mtb-admin.json`), `eas build` lo SUBE a EAS Cloud — el mismo bug que Agent #9 HIGH-09-19 marcó con `.jks`. Fix idéntico: agregar a `.easignore`.

- **[LOW-11-20] `NOTIFY_EMAIL` hardcoded en `functions/constants.js`** — los mint failure alerts (línea 1226) van a `NOTIFY_EMAIL`. Si esa cuenta se compromete o el operador cambia de email, hay que redeployar functions. Fix: leer de `process.env.NOTIFY_EMAIL` con fallback hardcoded, así un `firebase functions:config:set ops.notify_email=...` lo cambia sin redeploy.

### 3. Monitoring, alerting, observability

- **[HIGH-11-21] `errorLog` Firestore collection es WRITE-only desde regla pero NO TIENE READER** — `firestore.rules:239-241` `allow read, write: if false;`. Solo Admin SDK puede leer. **Quién lo lee?** Nadie programáticamente. El dev tiene que ir a Firebase Console → Firestore → errorLog → scroll. No hay dashboard ni summary. Para una app con 0 tests cliente (Agent #4) y app instalada en sideload sin Play Console crashes report, **`errorLog` es la única señal de problemas en producción**, y nadie la mira. Fix mínimo: una scheduled function que cada lunes a las 8am scane `errorLog` últimos 7 días, agrupe por `scope`, y mande email con top 10 errores + counts.

- **[HIGH-11-22] `adminActions` similar: write-only en regla, sin reader programático** — `firestore.rules:245-247`. Audit log que nadie mira == no-op. Si una cuenta admin se compromete y el atacante hace 50 `grant_admin` + `addServerCredit` operations, el log existe pero el operador no se entera hasta hacer auditoría manual mensual (que no está agendada). Fix: scheduled function "anomaly detection": >5 ops en 1h del mismo `adminUid` → email.

- **[HIGH-11-23] Sin sentry / datadog / Crashlytics — APP NO tiene APM** — confirmado grep. `App.js` no importa Sentry, ni `firebase/crashlytics`. `logError` → `logClientError` → Firestore `errorLog` es el único sink. Limitaciones serias:
  - No source-maps automáticas, los stacks vienen ofuscados por R8.
  - No grouping (Firestore es key-value lineal — no `count(message) GROUP BY day`).
  - No alertas en thresholds (Sentry alerta cuando un error nuevo aparece o spike >100/min).
  - Sin breadcrumbs (qué hizo el user los últimos 30 segundos).
  - Sin device context (model, OS version, RAM) más allá del que pase explícito.
  - Cuando un user reporta "la app me crashea" via `reportProblem`, el dev tiene QUE pedirle al user "intentá de nuevo y mandanos el screenshot del error" porque NO hay forma de correlacionar el report con un error específico en `errorLog`. Costo de soporte ALTO.
  Fix: integrar Sentry RN (free tier 5k events/mes, suficiente para 1k DAU). Esfuerzo: 2-3h. ROI altísimo.

- **[HIGH-11-24] Sin status page público — usuarios no saben si es la app o internet** — no hay `status.miningtheblocks.com` ni Twitter/Discord donde el operador anuncie incidentes. Cuando Firebase cae (raro pero ocurre), o RPC `publicnode.com` cae (probable), los users ven errores genéricos sin contexto. Fix simple: usar `betterstack.com` free tier o `instatus.com` free tier. Cuesta $0 y rebaja drásticamente la fricción de soporte.

- **[MEDIUM-11-25] `console.warn` / `console.error` en backend NO escruben PII**: `functions/index.js:1147` loguea `{ mintId }` (OK), pero `1806` loguea `{ prefix: verificationLink.slice(0, 80) }` (URL contiene `oobCode` y `email`), `1946` loguea `{ authUid, ownerUid, code }`. Todo va a Cloud Logging con retención 30 días default. Si Cloud Logging es comprometido, hay PII y secrets parciales. (Agent #6 MED-25 cubrió el lado cliente; este es backend.) Fix: scrubear oobCode antes de loguear; UID es OK; gemCode es OK loguearlo (no es secret).

- **[MEDIUM-11-26] Sin métricas custom de negocio** — no se tracea KPI en GCP Monitoring (mints exitosos, payments procesados, errores por tipo). Si un cambio de código causa que el % de mint success caiga de 95% → 70% (Agent #8 CRIT-2), no hay dashboard que lo muestre. Fix mínimo: `console.log('METRIC mint_success_total=1 server_id=...')` parseable por Cloud Logging metric extractor, después dashboards en Cloud Monitoring.

- **[MEDIUM-11-27] Función `reportProblem` envía email a `NOTIFY_EMAIL` con descripción del user** — `functions/index.js:2057+`. Cada email es una "alerta" potencial. PERO: si Gmail filtra muchos como spam (común con `[MTB]` en subject + sender `<noreply>@gmail.com`), el operador NO se entera. Fix: configurar Gmail filter "from: NOTIFY_EMAIL" → Star → Important. Mejor: usar transactional email service (Mailgun, SES) con webhooks de delivery + Slack notifs.

- **[LOW-11-28] Cloud Functions logs retention default es 30 días** — para audit forensic post-incidente, 30 días es corto. Si un user reporta "hace 2 meses me robaron créditos" no hay trail. Fix: configurar Cloud Logging Sink → BigQuery (storage barato, queries SQL) con retención ilimitada para auditos selectos (adminActions, mint, payment).

### 4. CI/CD

- **[HIGH-11-29] CI no construye APK ni firma — solo lint + tests + secret scan** — `.github/workflows/ci.yml`. Hay 2 jobs: `lint-and-test` (lint, jest, rules tests) y `security-checks` (no committed keystores, no docs/verify.html, hardcoded secrets scan, npm audit). Lo que **NO** corre:
  - Build de APK (probablemente porque requiere EAS Cloud o keystore en CI).
  - Build del frontend React Native (no se verifica que `expo prebuild` pase o que TypeScript compile — no hay TS pero aún así).
  - Tests de cliente RN — Agent #4 confirmó 0 tests cliente.
  - Deploy automático (cada deploy es manual `firebase deploy`).
  Consecuencias: un commit que rompe el build del cliente RN pasa CI verde, deja master roto, y EAS production build falla horas más tarde — el dev no se entera hasta que lanza el release. Fix: agregar job `cd . && npm install --legacy-peer-deps && npx expo prebuild --platform android --no-install` que valide al menos la generación nativa.

- **[HIGH-11-30] Branch protection NO está confirmada para `master`** — `ACCIONES_MANUALES.md:206-209` la lista como pendiente; no hay forma de verificarla desde el filesystem. Sin branch protection, el dev (o atacante con commit access) puede force-push sobre master, saltarse el CI, mergear PRs sin review (single-person team, no hay reviewers reales). Combinado con compromise de GitHub account (HIGH-11-13), un atacante puede push directo. Fix manual (gh CLI):
  ```
  gh api -X PUT repos/miningtheblocks/Mining-The-Blocks/branches/master/protection \
    -f required_status_checks='{"strict":true,"contexts":["lint-and-test","security-checks"]}' \
    -f enforce_admins=true -f required_pull_request_reviews='{"required_approving_review_count":0}'
  ```
  (review count 0 porque es single-operator, pero el resto de la barrera ya ayuda.)

- **[HIGH-11-31] Sin pre-commit hooks — `.husky/` no existe** — confirmado por `ls`. Cualquier `git commit` directo del dev puede committear: secrets accidentales (`.env` con secrets), keystore, archivos binarios, `console.log` de debug con PII. El CI los pesca DESPUÉS del push (y solo algunos — el `security-checks` scan no es exhaustivo). Fix: `npm install --save-dev husky lint-staged` + `npx husky init` + hook que: (a) corre `eslint --max-warnings 0` solo en files cambiados, (b) chequea con `gitleaks detect --staged` o similar.

- **[HIGH-11-32] Sin gitleaks / trufflehog — secret leak scan es DIY** — `.github/workflows/ci.yml:93-105` tiene un grep manual de Base64 strings. Falla open: si un secret no matchea la regex `(['\"])[A-Za-z0-9+/]{40,}\1`, pasa. Modern leak detectors (gitleaks, trufflehog, ggshield) tienen ~700 rules para keys de AWS, Stripe, GitHub PAT, ETH private keys (0x[64 hex chars]), etc. Agent #2 / #3 mencionaron 0x[40hex] como excluido — bien — pero 0x[64hex] (private key) NO está excluido y ese ES un secret crítico. Si un dia el dev commita `COMPANY_WALLET_KEY=0xabc...64hex` al `.env.example` por error, el grep manual NO lo pesca (40-char limit). Fix: agregar `gitleaks` action en CI con custom rules para wallet private keys.

- **[MEDIUM-11-33] `npm audit` es `continue-on-error: true` — vulns no bloquean merge** — `.github/workflows/ci.yml:111-112`. La justificación está en el comment ("vulns transitivas en dev-deps"). Pero el `--omit=dev` flag YA excluye dev-deps. Si una vuln HIGH/CRIT aparece en prod deps, lo correcto es bloquear. Fix: cambiar a `continue-on-error: false` + `audit-level=critical` con exclude-list explícito para falsos positivos conocidos.

- **[MEDIUM-11-34] Dependabot solo cubre `npm` y `github-actions`** — `.github/dependabot.yml`. No cubre: (a) `gradle` (`android/build.gradle` dependencies), (b) docker images (no hay Dockerfile, OK), (c) `pip` (no aplica). Para Android nativo, vuln en AGP/Kotlin/play-services-* requiere watch manual de bulletins. Fix: agregar `package-ecosystem: gradle` con `directory: /android`.

- **[MEDIUM-11-35] CI usa `firebase-tools` global install — versión no pinneada** — `.github/workflows/ci.yml:41` `npm install -g firebase-tools`. Sin version pin, el cambio mayor de firebase-tools puede romper `firebase emulators:exec` silenciosamente. Fix: `npm install -g firebase-tools@^13`.

- **[MEDIUM-11-36] Sin SBOM (Software Bill of Materials) generado** — para una app que maneja dinero real, los compliance frameworks (SOC2, ISO27001 si crece) requieren SBOM. CycloneDX o SPDX. Esfuerzo: `npm install -g @cyclonedx/cyclonedx-npm && cyclonedx-npm --output-file sbom.json` en CI. ROI bajo hoy pero infrastructure-only-once.

- **[LOW-11-37] Workflow NO firma artifacts de release** — cuando se sube APK a GitHub Release, no hay paso de "firmar con cosign/sigstore" o "incluir SLSA provenance". El SHA-256 está presente (Agent #9) pero la chain of custody es débil. Para crypto+gambling, una `provenance.intoto.jsonl` adjunta da credibilidad. Esfuerzo medio.

- **[LOW-11-38] No hay deploy workflow — `firebase deploy` es manual** — el dev corre `firebase deploy --only functions` desde su máquina con `firebase-tools.json` (CRIT-11-03). Cada deploy depende de la máquina del dev. Si está en vacaciones y aparece una vuln HIGH, no hay forma de deployar el fix. Fix: workflow `deploy.yml` que use Workload Identity Federation con un SA dedicado, triggerable por `workflow_dispatch` (manual) o `push` a tag `v*`.

### 5. Retention, PII, GDPR

- **[HIGH-11-39] TTL NO configurado en Firestore Console** — confirmado por `ACCIONES_MANUALES.md:71-82` y Agent #12 CRIT. Las collections con campo `expiresAt`: `processedTxs`, `rateLimits`, `adSessions`, `errorLog`. NINGUNA tiene policy TTL activada (no es código, es config Console). Sin policy:
  - `errorLog` crece infinitamente. 100k DAU × 50 errores/día → 5M docs/día × 30 días = 150M docs nunca borrados.
  - `rateLimits` crece infinitamente con buckets por uid × bucket type.
  - `processedTxs` crece infinitamente.
  - `adSessions` crece infinitamente.
  Costo Firestore storage = 18-100GB en un año si la base crece. Fix: 5 clicks en Console por collection. (Cubierto pero requiere ejecución manual.)

- **[HIGH-11-40] `activityFeed` SIN `expiresAt` ni TTL** — Agent #12 CRIT. `functions/index.js:127-133` `writeActivity` solo escribe `{ type, ts, ...data }`. Ningún `expiresAt`. Activity feed crece para siempre. Fix: agregar `expiresAt: Timestamp.fromMillis(Date.now() + 7*24*3600*1000)` + configurar TTL policy.

- **[MEDIUM-11-41] PII en `errorLog`**: Agent #6 MED-25 ya lo marcó. Ángulo nuevo: el scrub de `logError` es por **key name** (`/(password|passwd|token|secret|wallet|...)/i`). Si el cliente pasa email/phone como VALOR de una key llamada `userInfo` o `formData`, NO se escruba. Ejemplo `logError('Registration.failed', e, { formData: { email: 'a@b.com', phone: '+541234' }})` → email queda en plain text en `errorLog`. Fix: scrub por regex de valor (`/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}/i` para email, `/\+?\d{10,}/` para phone).

- **[MEDIUM-11-42] Backups GCS no tienen lifecycle rule garantizada (HIGH-11-07) ni encryption-at-rest CMEK** — los exports incluyen PII completa (emails, phones, wallets de gem claims, etc.). Para GDPR strict, transferir/almacenar PII de UE → USA requiere SCC; Cloudflare/GitHub/Google son sub-processors no enumerados (Agent #10 HIGH-10-36 marcó). Fix mínimo: (a) configurar bucket con `--location=us-central1` (ya está), pero documentarlo en privacy.html. (b) Considerar BYO-KMS key.

- **[MEDIUM-11-43] Sin self-serve account deletion → `terms.html` promete "<30 días" pero depende de inbox humano** — Agent #6 MED-15 + Agent #10 HIGH-10-38. Operacional: si llegan 100 requests de borrado en 1 día (e.g. tras una crisis), el dev (single-operator) NO escala. Fix: Cloud Function `deleteMyAccount` con reauth + delete in transaction. Esfuerzo 3-4h.

### 6. Incident response

- **[HIGH-11-44] CERO runbook escrito** — confirmado `ls`. No hay `RUNBOOK.md`, `OPERATIONS.md`, `INCIDENT.md`, ni docs/runbook/. Para un single-operator en un dominio adversarial (crypto + gambling + sideload + dinero real), esto es el gap operacional más grande. Cada uno de estos requiere runbook:
  - "Wallet `COMPANY_WALLET_KEY` está comprometida" → pasos para pause(), redeploy contract, migrar pendingMints.
  - "Gmail app password está bloqueado" → pasos para generar nuevo, actualizar secret, deployar.
  - "Backup falló N días seguidos" → pasos para correr manual `gcloud firestore export`.
  - "Un user reporta NFT minted on-chain pero no aparece en MyGems" → query Firestore + Polygon + reconcile.
  - "MATIC balance bajo" → pasos para topear desde exchange.
  - "Firebase budget alert disparó" → pasos para identificar culprit function.
  - "User pide GDPR right-to-erasure" → checklist de qué borrar en qué collection.
  - "Reorg de Polygon revertió un mint" → cómo detectarlo + remediar.
  Fix: crear un `RUNBOOK.md` mínimo con los 5 incidentes más probables. Aún 1 página por escenario es mejor que cero.

- **[MEDIUM-11-45] Sin canal oficial in-app de comunicación durante incidente** — la app no tiene "Anuncios" screen ni link a Discord/Twitter/Telegram. `notifyAllUsers` existe pero está roto (Agent #10 CRIT-10-01). Durante un incidente, los users no tienen forma de enterarse del estado. Fix corto: agregar `config/app.statusMessage` que la app fetchee + display en banner si no-empty.

- **[MEDIUM-11-46] Sin procedure para "logout everywhere"** — Agent #6 MED. Si un user reporta "creo que me hackearon la cuenta", el operador no tiene UI ni script para `auth.revokeRefreshTokens(uid)`. Quedaría usando el Firebase Console manualmente. Fix: agregar a `scripts/` un `revoke_tokens.js <uid>` con confirmDestructive.

- **[MEDIUM-11-47] Sin procedure para suspender un user (`disabled: true` en Auth)** — sin script ni UI admin. Para un user que abusa (e.g. crear cuentas masivas para farmear daily picks), el operador tiene que ir manualmente a Firebase Console → Auth → user → disable. Para 5 abusers OK; para 50 no escala. Fix: `scripts/disable_user.js <uid> --reason=...` + audit log.

### 7. Cost monitoring

- **[HIGH-11-48] Sin Firebase budget alerts confirmados** — ya cubierto en CRIT-11-02. Re-emfatizo: el modelo de costo es 3-9× pesimista vs optimista (Agent #12). Sin budget alert, una vuln que cause `getServers` en bucle por bug cliente factura $100-1000/día silenciosamente. Fix manual en Console:
  ```
  GCP Console → Billing → Budgets → Create budget
  Amount: $50 (warning), $100, $200, $500 (catastrophic)
  Send to: miningtheblocks@gmail.com + SMS
  ```

- **[MEDIUM-11-49] Sin MATIC balance monitoring** — Agent #12 cubrió: 0 `provider.getBalance(wallet.address)` antes de mintear, mints fallan, 5 retries, email. La latencia operacional es: 5 mints fallidos × 5 retries c/u × 5min = 2h+ de holders esperando. Fix: scheduled function (Cloud Schedule) cada 6h que chequee balance y mande email si <2 MATIC.

- **[MEDIUM-11-50] Gmail quota 500 emails/día sin tracking** — sendVerificationEmail + reportProblem + submitGemClaim + mintFailed. A 1000 DAU con 5% verification rate → 50/día verify + 30/día claims + 5/día reports + 0-5/día mint alerts → 90/día baseline, OK. A 10k DAU → 900/día → suspended. Fix: contador en Firestore `meta/gmailQuota = { count, day }` que `sendMail` chequee + tirar warning a >400/día. Mejor: migrar a SES antes de 5k DAU.

- **[LOW-11-51] Sin AdMob revenue tracking** — no se tracea cuánto ingresa por ads vs cuánto cuesta operar. Decisión de costos a ciegas. Fix: Google AdMob → Reporting → API a Sheets semanal.

### 8. Documentation gap

- **[MEDIUM-11-52] README.md (4769 bytes) — adecuado para developers, vacío para operadores** — `README.md` cubre instalación, distribución, setup, deploy, security básico, performance. Lo que NO cubre y debería ser operacional: runbook (HIGH-11-44), DR procedure (HIGH-11-08), monitoring setup, on-call rotation (N/A para single-op pero la sección debería decirlo), incident severity matrix. Fix: agregar sección "Operations" al README con links a `RUNBOOK.md` (a crear).

- **[MEDIUM-11-53] Sin `ARCHITECTURE.md`** — single-operator hoy, pero si en el futuro contrata o si pasa el proyecto a otro humano, el ramp-up es muy duro sin documentación de "por qué `mineCube` no es transaccional con auto-mint" etc. Recomendado para resiliencia operacional.

- **[LOW-11-54] `SECURITY.md` (1755 bytes) es adecuado para reporters de vulns** — verificado. Tiene scope, in-scope/out-scope, SLAs, contact. Patrón positivo. Lo único que falta: PGP key para encrypted reports. Para crypto, no esencial.

- **[LOW-11-55] `ACCIONES_MANUALES.md` (12988 bytes) — funciona como mini-runbook embrionario** — bien organizado por prioridad (P0/P1/P2). Pero NO se actualiza con el estado de cada acción (qué se hizo, qué no). Sin un campo `[ESTADO: pendiente|hecho|N/A]` ni revisión periódica, las acciones se acumulan y se olvidan. Fix: convertirlo a checklist con check-marks; revisar mensualmente.

---

## Matriz de DR (Disaster Recovery)

> **Cómo leer**: cada fila es un compromise/loss scenario. Probabilidad subjetiva. "Tiempo a recovery" asume single-operator improvisando (todo "??" = no hay procedure documentado). "Action plan" es lo que el operador debería tener en `RUNBOOK.md`.

| Compromise / Loss | Probabilidad | Impacto $ | Pérdida operacional | Tiempo a recovery (sin runbook) | Tiempo con runbook | Mitigación pre-incident | Action plan post-incident |
|---|---|---|---|---|---|---|---|
| **`COMPANY_WALLET_KEY` leak** (smart contract owner EOA) | BAJA-MEDIA | $1M+ (mints infinitos tier-1 dumped en OpenSea + drain MATIC) | Pérdida total del contrato; reputación catastrófica | **N/A — irreversible** | Solo prevenible: redeploy con multisig (Agent #3 CRIT-1) | Multisig 2-of-3 + key en hardware wallet + access logs Secret Manager | (1) pause() inmediato desde otra wallet con MINTER_ROLE; (2) anunciar via status page; (3) redeploy nuevo contrato + migración |
| **`firebase-tools.json` / SA Owner leak** (developer máquina) | MEDIA | $1.5M+ (drainage PAYMENT_WALLET via addServerCredit→sell credits→drain USDC; leak SERVER_SEED + COMPANY_WALLET_KEY) | Pérdida total Firestore + Auth + Secret Manager | **N/A — pwn total** | Solo prevenible | SA dedicado con rol mínimo (CRIT-11-03); 2FA hardware en Google Account; aircraft mode si malware sospechado | (1) revocar refresh tokens en Google Account → Security; (2) rotar TODOS los secrets; (3) re-deploy functions; (4) restore Firestore desde backup pre-compromise (CRIT-11-01); (5) audit `adminActions` para entender qué se hizo |
| **Keystore JKS pérdida** (disco roto, ransomware, robo) | MEDIA | End of life para users existentes — pueden quedarse sin updates para siempre | Continuidad del producto (catastrófica) | **N/A — no recovery** | Solo prevenible: 3 copias offline | 3 backups offline verificados quarterly (CRIT-11-04); `sha256sum` documentado | (1) Si ningún backup funciona: anunciar end-of-life para v1.1.0; (2) generar nueva keystore; (3) publicar v2.0.0 firmada distinta, los users hacen uninstall+reinstall; (4) pérdida ~30-50% de base |
| **Compromise dominio Cloudflare** | BAJA | Phishing APK malicioso a users de v1.1.0 que tapean "Actualizar"; pero firma keystore protege si users no des-installan | Reputación + soporte spike | 2-4h si 2FA recovery funciona | 30-60min: revoke API tokens, change pwd, contact CF support | Cloudflare Registry Lock + 2FA security key (FIDO2) + recovery codes offline | (1) reset Cloudflare via recovery codes; (2) revoke all API tokens; (3) audit DNS records; (4) verificar SSL cert no rotó; (5) announce via Twitter |
| **Compromise GitHub account** | BAJA | APK falso en Releases v1.2.0; users con `UpdateModal` allowlist bypass instalan malware (Agent #4 + #9) | Reputación + users infectados | 2-6h | 1h | 2FA security key + branch protection + required signed commits | (1) recover GitHub via recovery codes; (2) delete releases falsos; (3) force-push real master; (4) revoke all PAT; (5) verificar workflows/secrets no modificados; (6) anunciar issue |
| **Compromise Gmail `miningtheblocks@gmail.com`** | BAJA-MEDIA | Password reset emails interceptados (60min window account takeover, Agent #6 CRIT-3) en users que solicitan; recovery email de Cloudflare/GitHub/Google si está apuntando a Gmail | Cascada: + Cloudflare + GitHub + Google Account si recovery va a Gmail | 1-2h | 30min | 2FA hardware en Gmail; recovery email distinta + 2FA distinta; passkey | (1) recover via security key; (2) revoke app passwords (rota `GMAIL_APP_PASSWORD`); (3) cambiar recovery email; (4) audit últimos 30 días de actividad |
| **Firestore corruption / accidental delete via `full_reset_game.js` en prod** | MEDIA | Pérdida de TODOS los users + serverAccess + history | Outage total + DR test | 4-8h (si backup OK, untested!) | 2-4h | `--i-confirm-full-prod-wipe` gating ya implementado (Agent #10); staging env (HIGH-11-09); backup verificado (CRIT-11-01) | (1) `gcloud firestore import gs://...-backups/<YYYY-MM-DD>` (latest); (2) verificar conteos; (3) restart schedulers; (4) anunciar maintenance window |
| **Polygon RPC `publicnode.com` outage** | MEDIA | Mints + paymentProcessor fallan; no se pierde data, solo se atrasa | Atraso de mints (~horas) | 1-2h (cambiar RPC URL + deploy) | 15min | Multi-RPC fallback en `runMintProcessing` + `runCryptoPaymentProcessing`; Alchemy free tier (Agent #12) | (1) editar `functions/index.js` → cambiar URL a Alchemy o ankr; (2) `firebase deploy --only functions:mintProcessorScheduled,functions:cryptoPaymentProcessorScheduled`; (3) processPendingMints manual para drain queue |
| **MATIC balance llega a 0 en company wallet** | ALTA (no monitoreado) | Mints fallan silenciosamente 5x antes de email (HIGH-11-49) | Holders esperan horas | 30min (topear wallet) | 5min con alert | Scheduled balance check + alert (MEDIUM-11-49) | (1) recibir alert; (2) `cast send` USDC→MATIC en QuickSwap o comprar MATIC directo; (3) verificar processPendingMints corrige los failed (no — están en status:failed, hay que re-promover a pending manualmente) |
| **`SERVER_SEED` leak** (vía Secret Manager pwn) | BAJA | Atacantes pre-calculan posiciones gemas tier-1; minan estratégicamente; +$50k-500k drenados como gemas legítimas | Fairness break catastrófico (irreversible si users notan) | **N/A — diseño inherente** | Solo prevenible: fix `effectiveSeed = HMAC(seed, serverId+episode)` (CRIT-11-05) | Versionado de seeds + rotación por episodio | (1) detectar via spike anormal de gemas tier-1; (2) si confirmado: anunciar pausa del juego; (3) rotar seed para próximo episodio (no afecta los actuales — break ya ocurrido); (4) considerar refund USDC a buyers afectados |
| **`GMAIL_APP_PASSWORD` bombing (Agent #6 CRIT-1)** | MEDIA | Gmail suspende app password; verify + claim + reportProblem + mint alerts OFFLINE | Outage de emails (UX broken para new signups) | 1-2h | 15min | Rate-limit en `sendVerificationEmail` (Agent #6 P0 fix); SES/Mailgun migration | (1) Google Account → Security → revoke comprometido app password; (2) generate new; (3) `secrets:set GMAIL_APP_PASSWORD`; (4) deploy functions; (5) announce via status page |
| **`pendingMints` stuck en `processing` (Agent #8 CRIT-2)** | ALTA (no monitoreado) | Gemas perdidas silenciosamente | UX horrible; soporte spike | 1-2h por incidente | 15min con alert | Timeout + monitor (Agent #8 P0); CRIT-11-02 alerts | (1) query `pendingMints where status='processing' AND createdAt < now-3600s`; (2) revertir a 'pending' o forzar reprocess; (3) si NFT ya minteado on-chain pero doc dice failed: marcar 'completed' manualmente |
| **Reorg Polygon profundo (>30 blocks) post-mint** | MUY BAJA | NFT marked complete pero no en chain (Agent #3 CRIT-6, #8 CRIT) | $15-100k por gema | N/A si no detectado | 30min | `tx.wait(30)` (Agent #3 CRIT-6 fix); checkpoint de bloque | (1) verify `provider.getTransactionReceipt(txHash)` retorna null; (2) re-mint con nuevo nonce; (3) actualizar txHash en Firestore |
| **DDoS / abuse del backend (cost explosion)** | BAJA-MEDIA | Cloud Functions cost spike $$$ (Agent #12) | $100-1000+/día factura | N/A si no detectado hasta facturación | 1h con budget alert (CRIT-11-02) | Budget alerts + rate-limits ya parciales | (1) ver budget alert; (2) identificar function culprit en logs; (3) pausar function (`firebase functions:delete`) o setear `maxInstances: 0`; (4) deploy fix |
| **`pendingCryptoPayments` 99 slots full (Agent #8 DoS)** | BAJA | Pagos legítimos retornan `try_again` 429 | Revenue/hora perdido | 5min | 5min | Rate-limit existing (`ccp_${uid}` 3/hora) | (1) wait window 30min para que slots expiren naturalmente; (2) o manual delete de slots expired-not-yet-cleaned |

**Resumen de exposición operacional**: 4 escenarios "**N/A — irreversible**" (CONTRACT, ALL-SECRETS, KEYSTORE, SEED leak) — todos prevenibles SOLO con pre-incident hardening. 9 escenarios reversibles con runbook (no existe) requieren entre 15min y 8h. **El single-operator está expuesto a 13 escenarios concurrentes sin documentación de qué hacer en cada uno.**

---

## Patrones positivos detectados (12)

- **Backup automatizado configurado** (`firestoreBackupScheduled`) — pocos sideload apps lo tienen; el patrón está, falta tuning (verificación + lifecycle + restore test).
- **Secrets en Secret Manager (no en código)** — `defineSecret` correcto, scoped por función con `{ secrets: [...] }`.
- **`adminActions` audit log** en `addServerCredit`, `notifyAllUsers`, `grant_admin` — base sólida.
- **`errorLog` con dedupe + cap diario + TTL** (Agent #6 patrón positivo; el problema es nadie lo lee — HIGH-11-21).
- **`requireAdminFresh`** con `getUser()` no cacheado para custom claims.
- **`scripts/_confirm.js`** doble gating manual + `--yes-i-am-sure` para CI — patrón excelente.
- **`full_reset_game.js`** triple-gating: `--yes-i-am-sure` bloqueado + `--i-confirm-full-prod-wipe` requerido + confirmDestructive interactivo (Agent #10 patrón positivo).
- **`.gitignore` cubre keystores, JKS, service accounts, `.env*`, ProGuard mapping, `mtb-release.*`** — defensivo.
- **CI `security-checks` job** rechaza commits de keystore, `.env`, `docs/verify.html`, secrets hardcoded.
- **Dependabot configurado** para `npm` (`/functions` + `/`) y `github-actions`; semanal + agrupar security-only PRs.
- **`SECURITY.md` con SLAs y scope explícito** — pocas apps lo tienen.
- **CI permissions least-privilege** (`contents: read`), `concurrency` para cancelar runs duplicados, `timeout-minutes` por job.

---

## Conclusión

La postura operacional de Mining The Blocks es **mejor que el promedio para un single-operator sideload**, pero tiene **4 fallas estructurales que un evento aislado puede convertir en pérdida total irreversible**: (1) keystore JKS sin backup verificado documentado, (2) `COMPANY_WALLET_KEY` controlando el contrato sin multisig, (3) `firebase-tools.json` con scope `roles/owner` reutilizado para todos los scripts admin, y (4) `SERVER_SEED` no rotable por diseño. Ninguna de las cuatro requiere fixes de código complejos — son cambios operacionales + decisiones de producto.

El **gap operacional más grande no es técnico, es informacional**: existe backup pero no hay restore documentado; existe audit log pero nadie lo lee; existe `errorLog` pero no alerta; existen scripts destructivos pero el operador comparte el OAuth token con `firebase-tools` que da Owner del proyecto entero. Para un dominio con $100k tiers-1 y wallet hot del backend tocando USDC del PAYMENT_WALLET, la asimetría entre "preparación pre-incidente" y "improvisación durante el incidente" es enorme. La matriz de DR de este reporte muestra 4 escenarios **irreversibles** y 9 **recoverables con runbook (que no existe)**: el dev va a improvisar bajo presión, con clientes enojados en Twitter, sin sleep, sin equipo, durante el primer incidente real.

**Prioridad de remediación**: 

- **P0 (antes del primer flujo de dinero real):**
  - Verificar TTL en Console (`activityFeed`, `errorLog`, `rateLimits`, `processedTxs`, `adSessions`) — 15min
  - Service Account dedicado para scripts admin (rol `Firebase Auth Admin` + `Datastore User`) — 1h (CRIT-11-03 + #6 + #10)
  - 3 backups offline verificados del keystore JKS + sha256 documentado (CRIT-11-04) — 1h
  - Budget alerts en Firebase Console (CRIT-11-02) — 15min
  - MATIC balance alert scheduled function (HIGH-11-49) — 2h
  - `effectiveSeed = HMAC(SERVER_SEED, serverId+episode)` (CRIT-11-05) — 3h
  - Multisig migration del contrato (Agent #3 CRIT-1) — 1-2 semanas, pre-launch real
  
- **P1 (antes del marketing push):**
  - RUNBOOK.md con los 5-8 escenarios más probables (HIGH-11-44) — 4-6h
  - Sentry RN integration (HIGH-11-23) — 3h
  - Status page público (HIGH-11-24) — 1h
  - Restore test E2E con staging environment (HIGH-11-08, 11-09) — 1 día
  - Branch protection en `master` (HIGH-11-30) — 15min
  - Self-throttle schedulers (Agent #12) — 30min
  - `.easignore` excluye `*.jks` + `service-account*.json` (HIGH-11-19) — 5min
  
- **P2 (calidad operacional):**
  - Pre-commit hooks con husky + gitleaks (HIGH-11-31, 11-32) — 2h
  - Workflow `deploy.yml` con Workload Identity Federation (LOW-11-38) — 4h
  - SBOM CycloneDX generado en CI (MEDIUM-11-36) — 1h
  - Weekly `errorLog` summary scheduled function (HIGH-11-21) — 2h
  - Weekly `adminActions` anomaly detection (HIGH-11-22) — 2h
  - Documentar restore procedure paso a paso (HIGH-11-08) — 2h

El producto tiene **fundamentos técnicos buenos** y un developer disciplinado (la cantidad de comments SEC-/CRIT-/ALTO- en código y los tests son evidencia). La frontera entre "shipeable" y "responsable" para este dominio es operacional — y se cierra con ~2-3 semanas de focused work documental + un par de fixes pequeños. Sin esos pasos, el producto es **shipeable pero un solo evento adverso puede ser terminal**.
