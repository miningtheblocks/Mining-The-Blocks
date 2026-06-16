# Mining The Blocks — Operations Runbook

Documento operacional para incident response, disaster recovery y tareas
manuales recurrentes. Pensado para single-operator (1 dev).

**Última actualización:** 2026-06-15 (post Audit Round 2, commits Tier 1 → J).

---

## Quick reference

| Recurso | Ubicación / contacto |
|---|---|
| Firebase project | `miningtheblocks-669f6` ([console](https://console.firebase.google.com/project/miningtheblocks-669f6)) |
| Domain | `miningtheblocks.com` (Cloudflare Registrar) |
| GitHub repo | `miningtheblocks/Mining-The-Blocks` |
| APK download | `github.com/miningtheblocks/Mining-The-Blocks/releases/latest` |
| Smart contract | `0x54c2859411afCb51fcfE42054aDcA3484B3f29E6` (MTBGems, Polygon mainnet) |
| Company wallet (NFT owner) | EOA, private key en Secret Manager `COMPANY_WALLET_KEY` |
| Payment wallet (USDC receiver) | `0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f` |
| Polygon RPC | `https://polygon-bor-rpc.publicnode.com` (sin SLA — migrar a Alchemy antes de 10k DAU) |
| Email notifs | Gmail `miningtheblocks@gmail.com` con app-password en `GMAIL_APP_PASSWORD` |
| Keystore release | `@miningtheblock__miningtheblocks.jks` (NO en git, en working tree + 3 backups offline) |
| Secrets en GCP | `COMPANY_WALLET_KEY`, `GMAIL_APP_PASSWORD`, `SERVER_SEED` |
| Contact email ops | `miningtheblocks@gmail.com` |

## Detección de incidentes

Señales automáticas (vía email a `NOTIFY_EMAIL`):

- **Subject `⛏️ [MTB OPS] LOW MATIC`** → balance company wallet bajo `maticBalanceCheckScheduled` cada 6h.
- **Subject `[MTB] Mint failed after 5 attempts`** → mint falló las 5 retries en `runMintProcessing`.
- **Subject `📊 [MTB] errorLog weekly`** → digest semanal lunes 08:00 ART (`errorLogSummaryWeekly`).
- **Subject `🚨 [MTB] adminActions ANOMALY`** → 1+ admin con >50 ops/sem (`adminActionsAnomalyWeekly`, lunes 08:30 ART).
- **Subject `[MTB] problem report:`** → user reportó algo desde la app (`reportProblem`).

Señales manuales:

- Cloud Logging (Firebase Console → Functions → Logs): grep `severity>=ERROR`.
- Firestore `errorLog`/`adminActions` (read solo via Admin SDK desde Console).
- Polygon scan: `https://polygonscan.com/address/<wallet>` para mints + balance MATIC.

## Matriz de DR — escenarios y action plans

### 1. `COMPANY_WALLET_KEY` filtrado / smart contract owner comprometido

**Detección:** mints inesperados en PolygonScan del contrato MTBGems, o `transferOwnership` desde otra wallet, o cambio en `owner()`.

**Impacto:** atacante puede mintar tier-1 ($100k nominal) infinitamente, hacer `pause()`, transferir ownership.

**Tiempo a recovery:** N/A — irreversible si no se actuó pre-incident.

**Mitigación pre-incident (ÚNICA defensa):** Migrar owner a Gnosis Safe multisig 2-of-3. Pre-launch obligatorio (Agente #3 CRIT-1).

**Si ocurre:**
1. Inmediato: con la company wallet actual (si todavía la controlás) llamar `pause()` desde Etherscan/script. Para `unpause` luego.
2. Anunciar status via banner en `docs/index.html` + redes.
3. Rotar `COMPANY_WALLET_KEY` en Secret Manager:
   ```bash
   firebase functions:secrets:set COMPANY_WALLET_KEY
   # pegar nueva private key
   firebase deploy --only functions
   ```
4. Deploy NUEVO contrato MTBGems con el owner de la nueva wallet. Actualizar `MTBGEMS_CONTRACT` en `functions/constants.js` + redeploy.
5. Migrar `pendingMints` pendientes al nuevo contrato (re-mintear desde el nuevo address).
6. Comunicar a holders existentes (vía OpenSea metadata + email outreach a los que tengan email registrado).

---

### 2. `firebase-tools.json` / SA Owner filtrado (developer machine pwn)

**Detección:** login desde IP desconocida en Google Account → Security → Activity, O actividad inusual en `adminActions` (`adminActionsAnomalyWeekly` flag), O cargo inesperado en billing.

**Impacto:** atacante puede leer Secret Manager (drena company wallet + payment wallet via `addServerCredit`), borrar Firestore, mintear NFTs, modificar reglas, ejecutar cualquier CF.

**Tiempo a recovery:** N/A — pwn total irreversible si no se actuó pre-incident.

**Mitigación pre-incident:**
- Cambiar de OAuth refresh token global a SA dedicado con rol mínimo. Ver sección "Setup operacional → Service Account migration" más abajo.
- 2FA security key (FIDO2) en Google Account.

**Si ocurre:**
1. Inmediato: `https://myaccount.google.com/permissions` → revocar acceso de "Firebase CLI" y de cualquier SA sospechoso.
2. `https://console.cloud.google.com/iam-admin/iam` → revisar IAM y revocar permisos a cuentas no propias.
3. Rotar TODOS los secrets (`COMPANY_WALLET_KEY`, `GMAIL_APP_PASSWORD`, `SERVER_SEED`).
4. `firebase deploy --only functions` para invalidar el cache.
5. Restore Firestore desde el último backup pre-compromise: `gcloud firestore import gs://miningtheblocks-669f6-backups/<YYYY-MM-DD>`.
6. Audit `adminActions` para entender qué se hizo + revertir.
7. Reset password de Google Account + 2FA hardware key.

---

### 3. Keystore JKS pérdida o corrupción

**Detección:** `apksigner verify` falla, O hash sha256 difiere del documentado, O signing en EAS Build falla.

**Impacto:** **NO se pueden shipear updates a los users existentes**. Android rechaza APK firmado con cert distinto. Continuidad del producto comprometida.

**Tiempo a recovery:** N/A — recovery imposible sin backup intacto.

**Mitigación pre-incident (CRÍTICA):**
- 3 copias offline en USB/cloud encryptados:
  - USB VeraCrypt en cajón físico.
  - Servicio cloud personal con encryption (rclone + age, Bitwarden Send con expiración).
  - Familiar de confianza (USB encriptado).
- `sha256sum @miningtheblock__miningtheblocks.jks > KEYSTORE_HASH.txt` guardado en password manager (NO en git).
- Verificación trimestral: comparar hash de cada backup contra el documentado.
- `keytool -list -v -keystore @miningtheblock__miningtheblocks.jks` impreso en papel guardado en caja fuerte (incluye SHA-1, SHA-256, validity dates).

**Si ocurre (sin backups):**
1. Anunciar end-of-life de v1.x.x para users existentes.
2. Generar nueva keystore (`keytool -genkeypair -v -keystore mtb-release-v2.keystore ...`).
3. Publicar v2.0.0 firmada con nueva cert. Users existentes tienen que uninstall+reinstall.
4. Esperar pérdida de ~30-50% de base (data local perdida + fricción).

---

### 4. Cloudflare account comprometido / DNS hijack

**Detección:** `dig miningtheblocks.com` apunta a IP no conocida, O alert de Cloudflare "new sign-in", O users reportan que la web se ve distinta.

**Impacto:** atacante puede servir APK falso desde el dominio. La firma de keystore protege users que NO desinstalen (Android rechaza APK firmado con cert distinto), pero los users que descarguen+instalen v2 fresh con cert atacante = pwn local.

**Tiempo a recovery:** 30min-4h dependiendo de soporte Cloudflare.

**Mitigación pre-incident:**
- 2FA security key (FIDO2) en cuenta Cloudflare.
- Recovery codes guardados offline.
- Email account asociado con 2FA distinta + alert "new login from unknown IP".
- Cloudflare Registry Lock activado (impide cambios DNS sin contacto manual con Cloudflare).

**Si ocurre:**
1. Recover Cloudflare via recovery codes o contacto con soporte.
2. Revoke all API tokens en Cloudflare dashboard.
3. Audit DNS records → restaurar.
4. Verificar SSL cert no rotó.
5. Anunciar incidente via Twitter/Discord/canal alternativo (no via el sitio comprometido).

---

### 5. GitHub account compromise / APK falso en Releases

**Detección:** release v1.x.x con timestamp inesperado, O hash del APK ≠ al documentado en `.sha256`, O users reportan que la app comportó raro post-update.

**Impacto:** users que descargan via el sitio (que apunta al GitHub Release) instalan APK con malware. La firma keystore protege NO instalación entre versiones, pero un user que uninstall+reinstall = pwn local.

**Tiempo a recovery:** 1-2h.

**Mitigación pre-incident:**
- 2FA security key en GitHub.
- Branch protection en `master` (ver sección "Setup operacional").
- Required signed commits.
- Audit log de GitHub.

**Si ocurre:**
1. Recover GitHub via recovery codes.
2. Eliminar release(s) falso(s) del Releases page.
3. Force-push real master desde local (cuidado: revisar antes que el atacante no haya rebaseado).
4. Revoke all PAT (Personal Access Tokens) en Settings → Developer settings.
5. Verificar workflows / secrets de GitHub Actions no modificados.
6. Anunciar issue via Twitter + email a los que tengan email registrado.

---

### 6. Gmail compromise / `GMAIL_APP_PASSWORD` rotation

**Detección:** verify emails dejan de llegar, O reports de soporte vacíos, O alert "new sign-in" del Gmail account.

**Impacto:** outage de TODOS los emails (verify + claim + reportProblem + mint alerts). User signup blocked. Password reset blocked.

**Tiempo a recovery:** 15-30min con runbook.

**Mitigación pre-incident:** rate-limit ya implementado (`sendVerificationEmail` 5/h/uid + `requestPasswordReset` 3/h/email — Commits Tier 1 + B).

**Si ocurre:**
1. Recover Gmail via security key / recovery codes.
2. `https://myaccount.google.com/apppasswords` → revoke el app password comprometido + generar uno nuevo.
3. Actualizar secret:
   ```bash
   firebase functions:secrets:set GMAIL_APP_PASSWORD
   # pegar el nuevo app password
   firebase deploy --only functions
   ```
4. Audit recent activity → revertir si hubo modificaciones a settings de filters/forwarding.
5. Para Google Account ops: setear recovery email DISTINTO de `miningtheblocks@gmail.com` + 2FA security key.

---

### 7. `SERVER_SEED` filtrado (no rotable por diseño)

**Detección:** spike anormal de gemas tier-1 minteadas en un período corto, O un user reporta strategía "lucky" que devolvió 10× gemas en 1 sesión.

**Impacto:** atacantes pre-calculan posiciones de gemas tier-1 ($100k) y minan estratégicamente. Drenaje de $50k-500k antes de detectar.

**Tiempo a recovery:** N/A — no se puede rotar sin romper fairness commitment del juego en curso.

**Mitigación pre-incident:** **YA APLICADA en Commit C** — `effectiveSeed = HMAC(SERVER_SEED, "mtb-seed-v1|serverId|ep:N")` limita el blast radius a (server, episode) en curso, no toda la historia.

**Si ocurre post-Commit C:**
1. Detectar via dashboard: gemas tier-1/2/3 minteadas vs expected rate.
2. Pausar el juego: setear `config/app.maintenance = true` (todavía no implementado — feature gap).
3. Rotar SERVER_SEED para el próximo episodio: cambiar prefix de `mtb-seed-v1|` a `mtb-seed-v2|` en `functions/helpers.js` + `firebase functions:secrets:set SERVER_SEED`.
4. Los servers/episodes activos siguen con v1 (compromise ya ocurrido, fairness ya rota); los próximos episodes usan v2.
5. Considerar refund USDC a buyers afectados (decidir caso por caso).

---

### 8. `pendingMints` stuck en `processing` (gemas perdidas silenciosamente)

**Detección:** user reporta "minteé una gema pero no apareció en mi wallet", O query Firestore admin: `pendingMints where status=='processing' AND createdAt < now-3600s`.

**Impacto:** gemas no minteadas on-chain, user sin NFT + sin trail para reclamo.

**Tiempo a recovery:** 5-15min por incidente.

**Mitigación pre-incident:** Commit C agregó `tx.wait(SAFE_CONFIRMATIONS=30)` + lock distribuido. El primer fix reduce reorgs; el segundo elimina race nonce. Pero falta un timeout sweeper que detecte mints stuck >1h.

**Si ocurre:**
1. Query admin:
   ```js
   db.collection('pendingMints')
     .where('status', '==', 'processing')
     .where('startedAt', '<', Date.now() - 3600 * 1000)
     .get()
   ```
2. Para cada doc stuck:
   - Verificar PolygonScan si la tx finalmente se minó (puede haber sido procesada pero el writeback al doc falló).
   - Si SÍ se minó: marcar `status='completed'` manualmente con el txHash.
   - Si NO: revertir a `status='pending'` para que el próximo cron retome.

---

### 9. MATIC balance llega a 0 en company wallet

**Detección:** email `⛏️ [MTB OPS] LOW MATIC` cada 6h cuando balance < 2 MATIC (`maticBalanceCheckScheduled`).

**Impacto:** mints fallan inmediatamente con "insufficient gas". 5 retries × ~30s antes de marcar failed + email separado.

**Tiempo a recovery:** 5-30min (depende de comprar MATIC).

**Si ocurre:**
1. Comprar MATIC en CEX (Binance/Coinbase) o swap USDC→MATIC en QuickSwap.
2. Enviar a la company wallet (~5-10 MATIC para cubrir 100-200 mints).
3. Verificar `pendingMints where status='failed' AND error LIKE '%insufficient%'` y promover a status='pending' para re-mintear.

---

### 10. Polygon RPC `publicnode.com` outage

**Detección:** mints + paymentProcessor fallan, logs muestran `connect ECONNREFUSED` o timeouts.

**Impacto:** mints atrasados, payments crypto no procesan. No se pierde data (idempotency via `processedTxs` + checkpoint en Commit C).

**Tiempo a recovery:** 5-15min con runbook.

**Mitigación pre-incident:** Migrar a Alchemy free tier antes de 10k DAU (Agente #12). Cambiar RPC URL + redeploy.

**Si ocurre:**
1. Editar `functions/index.js` → cambiar URL a Alchemy/Ankr/QuickNode.
2. `firebase deploy --only functions:mintProcessorScheduled,functions:cryptoPaymentProcessorScheduled,functions:maticBalanceCheckScheduled,functions:runMintProcessing` (note: helper funcs no se redeployan solo el caller scheduler — better: full deploy).
3. `firebase deploy --only functions` (full deploy).
4. Verificar logs que el new RPC responde.

---

### 11. Firestore corruption / accidental delete via `full_reset_game.js` en prod

**Detección:** `full_reset_game.js` corre con confirmación pero contra el project equivocado, O `delete_users.js` con typo en uid → borra wrong users, O code change inserta `.delete()` malicioso vía dependencia comprometida.

**Impacto:** pérdida de TODOS los users + serverAccess + history.

**Tiempo a recovery:** 2-4h (depende de tamaño del export y testing).

**Mitigación pre-incident:**
- `_confirm.js` triple-gating: requiere typear el nombre del project + flag `--i-confirm-full-prod-wipe` (Commit Tier 1 audit ronda 6).
- Staging environment (TODO — sin esto no hay test del restore).
- Backup verificado (TODO — sin restore test no garantiza viabilidad).

**Si ocurre:**
1. Pausar TODOS los schedulers para evitar que escriban mientras restorás:
   ```bash
   firebase functions:delete cryptoPaymentProcessorScheduled mintProcessorScheduled maticBalanceCheckScheduled
   ```
2. Listar backups: `gsutil ls gs://miningtheblocks-669f6-backups/`.
3. Importar:
   ```bash
   gcloud firestore import gs://miningtheblocks-669f6-backups/<YYYY-MM-DD>
   ```
4. Verificar counts esperados (users, servers, history).
5. Redeploy schedulers: `firebase deploy --only functions`.
6. Anunciar maintenance window terminado.

---

### 12. DDoS / cost explosion (Firebase budget alert)

**Detección:** GCP budget alert email (TODO — configurar manualmente en Console).

**Impacto:** $100-1000+/día factura silenciosa.

**Mitigación pre-incident (manual operacional):**
1. GCP Console → Billing → Budgets → Create budget.
2. Amount thresholds: $50 (warning), $100, $200, $500 (catastrophic).
3. Notification: `miningtheblocks@gmail.com`.

**Si ocurre:**
1. Identificar function culprit en Cloud Logging.
2. Pausar function: `firebase functions:delete <function>` o setear `maxInstances: 0` en el código + redeploy.
3. Deploy fix.

---

## Setup operacional pendiente (NO código — pasos manuales para vos)

### Service Account dedicado para scripts admin

**Why:** Agente #11 CRIT-11-03 — pre-fix, `scripts/grant_admin.js` + `delete_users.js` + `full_reset_game.js` usan `firebase-tools.json` con OAuth refresh token = `roles/owner` del proyecto entero. Un compromise = pwn total.

**Steps:**
1. GCP Console → IAM & Admin → Service Accounts → Create.
2. Nombre: `mtb-admin-cli`. Description: "Limited admin SA for grant_admin + deletes".
3. Roles **mínimos**:
   - `Firebase Authentication Admin`
   - `Cloud Datastore User`
   - (sin Owner, sin Editor, sin billing, sin Secret Manager)
4. Create Key (JSON) → guardar en `~/.mtb-keys/mtb-admin-cli.json` (FUERA del repo).
5. Update scripts/grant_admin.js etc. para leer de `process.env.MTB_ADMIN_SA` con fallback a `~/.mtb-keys/...`:
   ```js
   const saPath = process.env.MTB_ADMIN_SA || path.join(os.homedir(), '.mtb-keys', 'mtb-admin-cli.json');
   const serviceAccount = require(saPath);
   admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
   ```
6. Documentar uso: `MTB_ADMIN_SA=~/.mtb-keys/mtb-admin-cli.json node scripts/grant_admin.js <uid>`.

### Branch protection en `master`

**Why:** Agente #11 HIGH-11-30 — sin esto, force-push puede reescribir history y los hooks de CI son opcionales.

**Steps (gh CLI):**
```bash
gh api -X PUT repos/miningtheblocks/Mining-The-Blocks/branches/master/protection \
  -F required_status_checks='{"strict":true,"contexts":["lint-and-test","security-checks"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":0,"dismiss_stale_reviews":true}' \
  -F restrictions=null \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

### TTL en Firestore Console

**Why:** Agente #12 + Agente #11 HIGH-11-39 — sin TTL, `errorLog`, `rateLimits`, `processedTxs`, `adSessions` crecen indefinidamente. `activityFeed` también necesita TTL pero falta agregar `expiresAt` field al writeActivity (TODO code).

**Steps:**
1. Firebase Console → Firestore → TTL → Create.
2. Por cada collection:
   - `errorLog`: field `expiresAt`.
   - `rateLimits`: field `expiresAt`.
   - `processedTxs`: field `expiresAt`.
   - `adSessions`: field `expiresAt`.
3. Activar policy → confirmar.

### Budget alerts en Firebase Console

Ver sección "12. DDoS / cost explosion" arriba.

### 3 backups offline del keystore JKS

Ver sección "3. Keystore JKS pérdida" arriba.

### Multisig migration del contrato

**Why:** Agente #3 CRIT-1 — owner EOA único es el SPOF más crítico financiero.

**Estimado:** 1-2 semanas pre-launch real. Pasos:
1. Deploy Gnosis Safe en Polygon con 2-of-3 signers (vos + 2 trusted: socio + custodian hardware wallet).
2. Deploy nuevo MTBGems contract con owner = Safe address.
3. Migrar IPFS pinning (Pinata + Web3.Storage + Filebase multi-pin para evitar SPOF de Pinata).
4. Actualizar `MTBGEMS_CONTRACT` en `functions/constants.js`.
5. Migrar pendingMints pendientes.
6. Test signing flow: cualquier `mintGem()` ahora requiere 2 firmas → cron solo lo hace si el flow está preparado.

### Sentry RN integration

**Why:** Agente #11 HIGH-11-23 — sin APM, errores en prod son ofuscados (R8) y sin breadcrumbs.

**Estimado:** 3-4h. Pasos:
1. Crear cuenta en `sentry.io` (free tier: 5k events/mes).
2. Crear project React Native, copiar DSN.
3. `npm install @sentry/react-native`.
4. Setup config plugin en `app.json`:
   ```json
   "plugins": [["@sentry/react-native/expo", {"organization": "...", "project": "..."}]]
   ```
5. En `App.js` top-level:
   ```js
   import * as Sentry from '@sentry/react-native';
   Sentry.init({
     dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
     enableInExpoDevelopment: false,
     environment: __DEV__ ? 'dev' : 'prod',
   });
   ```
6. Wrap el ErrorBoundary existente para enviar a Sentry:
   ```js
   componentDidCatch(error, errorInfo) {
     Sentry.captureException(error, { extra: errorInfo });
   }
   ```

### App Check (anti reverse-engineering)

**Why:** Agente #6 CRIT — sin App Check, APK reverse-engineering trivial → atacante puede llamar Cloud Functions sin la app.

**Estimado:** 2-3h. Pasos:
1. Firebase Console → App Check → register App.
2. Google Play Integrity provider (gratis para apps Play Store) o reCAPTCHA Enterprise (~$1/1000 assessments).
3. En cada CF crítica agregar `enforceAppCheck: true` en options.
4. En el cliente: `import { initializeAppCheck } from 'firebase/app-check'`.

### Status page público

**Why:** Agente #11 HIGH-11-24 — sin esto, durante incidente users no saben si es la app o internet.

**Estimado:** 1h. Pasos:
1. `betterstack.com` (free tier) → create status page.
2. Configurar 3 monitors: app Cloud Functions (HTTP ping), Polygon RPC, Firestore.
3. Subdomain: `status.miningtheblocks.com` (CNAME en Cloudflare).
4. Linkear desde la app en `Login.js` → "¿Problemas? Status".

---

## Tareas recurrentes

### Trimestral (cada 3 meses)

- [ ] Verificar los 3 backups offline del keystore JKS (`sha256sum`).
- [ ] Rotar `GMAIL_APP_PASSWORD` (no es estrictamente necesario pero hygiene).
- [ ] Revisar IAM permissions en GCP — borrar lo que no se use.
- [ ] `firebase login --reauth` para refrescar el OAuth token de firebase-tools.
- [ ] Auditar `adminActions` últimos 3 meses — cualquier patrón sospechoso.

### Anual

- [ ] Test de restore real desde backup en un staging project temporal.
- [ ] Renew dominio Cloudflare (auto-renew on, pero confirmar).
- [ ] Renovar SSL cert si manual (Cloudflare lo hace auto).

### Por release

- [ ] `apksigner verify --print-certs MTB-vX.Y.Z.apk` — verificar firma con cert esperada.
- [ ] `sha256sum MTB-vX.Y.Z.apk > MTB-vX.Y.Z.apk.sha256` + commit.
- [ ] Subir APK a GitHub Release.
- [ ] Actualizar `config/app.latestVersion` + `downloadUrl` en Firestore.
- [ ] Smoke test: instalar el APK en un device limpio + signin + un mineo + un payment.

---

## Comandos útiles

```bash
# Ver últimos errores backend
firebase functions:log --limit 50

# Tail logs en tiempo real
firebase functions:log --only mineCube --follow

# Lista de secrets
firebase functions:secrets:list

# Ver value de un secret (CUIDADO — solo en máquina segura)
firebase functions:secrets:access COMPANY_WALLET_KEY

# Trigger manual de un scheduled
firebase functions:shell  # → mintProcessorScheduled.run({})

# Deploy solo un set de functions
firebase deploy --only functions:mineCube,functions:claimGemNFT

# Rules test (offline, requiere emulator)
cd functions && npm run test:rules

# APK verification
apksigner verify --print-certs MTB-v1.1.0.apk
sha256sum MTB-v1.1.0.apk
```

---

## Cierre de Audit Round 2

Después de Tier 1 + Commits A-J:

- **51 CRIT del audit** → ~30 cerrados (los críticos técnicos + compliance + operacional + DX).
- **~20 items pendientes** son operacionales fuera del repo (este runbook los enumera) o defense-in-depth de menor prioridad.
- **Patrones aplicados:** soft-delete con anonimización, lock distribuido con TTL backup, checkpoint persistido, helper `assertFreshToken` reusable, motor i18n con interpolación + warnings, multi-channel push Android, accessibilityLabel + State en funnel crítico, scrub PII por valor + por key.

**Próximas auditorías deberían enfocarse en:**
1. **Profile/GetPeaks/MyGems a11y completo** (Commit E dejó solo Login+Registration+BuyCredits).
2. **i18n migration de los 15 call sites con `.replace('{x}', y)` al nuevo motor** `t(key, vars)`.
3. **Dead code removal** (~1200 LOC + 650KB deps, Agente #4+#5).
4. **Tests cliente RN** (jest + RTL) — actualmente 0.
5. **Operacionales listed above:** multisig, App Check, Sentry, status page, staging restore test.
