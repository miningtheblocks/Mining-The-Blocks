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
| Smart contract V2 (activo) | `0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195` (MTBGemsV2, Polygon mainnet, AccessControl) — deploy tx `0x4d7813a702d96bc42bd6549da8c016d34cdcac8ce27f463ee462d2ec037742cb` (2026-06-23) |
| Smart contract V1 (deprecated) | `0x54c2859411afCb51fcfE42054aDcA3484B3f29E6` — Ownable, sin caps, 0 NFTs minteados (audit R2 CRIT-S1/S2/S3) |
| Safe multisig (V2 ADMIN+PAUSER) | `0x83a3F5Bd15302F17B7f2e430900F1d2A40F86aCD` (Gnosis Safe 2-of-3 en Polygon) |
| Backend minter (V2 MINTER_ROLE) | `0x0a285CA8BaE2FbA3808bd260f936bCa22F06941e` (EOA "nftv2"). Private key en Secret Manager `COMPANY_WALLET_KEY` |
| Payment wallet (USDC receiver) | `0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f` |
| Polygon RPC | `https://polygon-bor-rpc.publicnode.com` (sin SLA — migrar a Alchemy antes de 10k DAU) |
| Email notifs | Gmail `miningtheblocks@gmail.com` con app-password en `GMAIL_APP_PASSWORD` |
| Keystore release | `mtb-release-v2.keystore` — path local NO documentado (ver env var `MTB_KEYSTORE_PATH` y Bitwarden entry "MTB keystore path"). NO en git. File SHA-256 `36785fb2...af9f6f64`. Cert SHA-256 `BF:8F:25:AC:C3:CC:CF:9B:DA:F7:63:53:FC:E5:DE:B2:25:11:89:16:9E:1C:32:20:6E:75:52:55:4D:AB:7D:C1`. Password en Bitwarden entry "MTB release keystore — v2 (2026-06-17)". Reemplaza la canonical previa `@miningtheblock__miningtheblocks.jks` cuya password se perdió (2026-06-17 — ver postmortem abajo). **Backups offline (Round 2 audit #9 HIGH-6, 2026-06-23)**: (1) Hitachi `/run/media/code/datos/keystore-backup-2026-06-23/` ✓; (2) USB Kingston DT 101 G2 (extraído, guardar físicamente separado) ✓; (3) OFF-SITE pendiente. Test recovery cada 6 meses (próximo: 2027-Q1). |
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
- 3 copias offline en mediums distintos:
  - **Bitwarden Notes** (cloud, base64 del `.gpg` cifrado AES-256).
  - **Email a `miningtheblocks@gmail.com`** con `.gpg` adjunto (cloud distinto provider).
  - **USB físico cifrado** en lugar distinto del laptop (PENDIENTE — ver task #53).
- Hash file SHA-256 + cert SHA-256 documentados arriba en quick reference + en Bitwarden notes.
- Verificación trimestral: comparar hash de cada backup contra el documentado.
- `keytool -list -v -keystore mtb-release-v2.keystore` impreso en papel guardado en caja fuerte (incluye SHA-1, SHA-256, validity dates).

**Si ocurre (sin backups):**
1. Anunciar end-of-life de la versión actual para users existentes.
2. Generar nueva keystore (`keytool -genkeypair -v -keystore mtb-release-vN.keystore ...`).
3. Publicar nueva major version firmada con nueva cert. Users existentes tienen que uninstall+reinstall.
4. Esperar pérdida de ~30-50% de base (data local perdida + fricción).

**Postmortem 2026-06-17 (keystore v1 → v2):**
- Pre-fix: el password de `@miningtheblock__miningtheblocks.jks` (y de `mtb-release.keystore` viejo) se perdió. Las 2 candidates en Bitwarden no abrieron ninguno. v1.1.0 release en GitHub firmada con cert `84eb85b5...` quedó como "deprecated" — sin posibilidad de update OTA.
- Impacto real: 0 (smoke test fase, sin users reales).
- Root cause: password no guardada inmediatamente al generar el keystore.
- Acción correctiva: el flow nuevo (generar `mtb-release-v2.keystore`) guardó password en Bitwarden **antes** de generar el keystore, evitando el mismo error.

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

### 13. Pinata IPFS down / cuenta suspendida (NFTs sin imagen)

**Detección:** OpenSea / wallets reportan "image not found" para los NFTs. Gateway `gateway.pinata.cloud/ipfs/<cid>` devuelve 404 / 403.

**Impacto:** los NFTs ya minteados muestran imagen rota. Nuevos mints van OK pero quedan huérfanos del lado del CID en metadata.

**Mitigación pre-incident (Agente #3 CRIT-5):** multi-pin a **Filebase** como mirror. Scripts `upload-to-ipfs.js` + `upload-metadata-to-ipfs.js` pinean a ambos providers vía `_ipfs_pin.js` helper. CIDs documentados abajo.

**Failover si Pinata cae permanente:**
1. Actualizar `scripts/generate-nft-metadata.js` → `IMAGE_CIDS` con los Filebase CIDs (Qm... lista abajo).
2. Re-generar metadata JSONs: `node scripts/generate-nft-metadata.js`.
3. Re-uploadear metadata a Filebase (Pinata fuera): `node scripts/upload-metadata-to-ipfs.js` (con `PINATA_*` quitadas del env para que falle Pinata silenciosamente y solo quede Filebase).
4. Actualizar `TOKEN_URIS` en backend con los nuevos metadata CIDs de Filebase.
5. Deploy backend. NFTs nuevos van con tokenURI nuevo. NFTs existentes mantienen su tokenURI viejo apuntando a Pinata (irrecuperable on-chain) — esto es **mitigación parcial** para los ya minteados.

**Failover si Pinata cae temporal (outage 1-24h):**
Los NFTs siguen accesibles vía gateway Filebase: `https://ipfs.filebase.io/ipfs/<filebase-cid>`. Cualquier IPFS gateway (cloudflare, ipfs.io) también sirve el CID de Pinata si el contenido se propagó a la red DHT.

**Filebase mirror CIDs (registrados 2026-06-17, `mtb-nfts` bucket):**

Imágenes PNG:
```
1: QmYqRbuk2aK7sfMvBqoRq1Z9W485kML1BPZjiNcCbgE5Ub
2: QmTmUpootF4yNA7Vo2bXLJ5cSR1HUwkMW4ADf9BAwcfQh3
3: QmdCgbHXbp6eL3PYZ1eV6MoTQRykNZoUa1hbtRM6pK5pUq
4: QmNx85aAsJELxkLMAJzPUQ9UFR1qTMWgRPyfkXB1jykCj1
5: QmeSVneMbgSihe4Ly6rgV6A4sU1NUPNptNFbena7SjiVn3
6: QmP9MEtL8qFTdfevNxUCULrPmo6ZubHgq4q2psLbkQPBG2
7: QmaWJnfW1QtsrmA18xY8vgcbk9MgEgTNotCZGMCoBvD5pt
8: Qmd85qiqc8cE2EqEWe4g1VFwWJN9je3xieYAr68wedt1nx
9: QmPEMFepdxZtQNYH4kbaTa4ZXBNyLq1AKbEq2kQDqMVy4v
```

Metadata JSON:
```
1: QmV9FREcq7XuXpazJ32s8jxTV7LtxxbUXFgbVf3uASDAbQ
2: QmQmLYm56EY2RV2ECodFgiAvXucTFX6CME2sEMY1xTY4No
3: QmanYuTXUDxamqEH182Vt5fCAUFzm9E3d7gWNtPyvpU9Nu
4: QmW2JL3YtUtxo7zhGkm7BUBQo54pLXTqSTEURBm7co6jze
5: QmTweggJegmZuU6WLUzpec6VGeHz8MNjsM29uWnn7Wn5yy
6: QmUQDN834yk6cvouEhWwaKumtVcRy8HoAMmkkqQfxcUyWM
7: QmRZGyvSPKcFxpmWfQRtCwbxhTV7zscPdz8uGpd1cdNGBF
8: QmTpqcThEgwK5dpTqJnaVoj7AoziheKHvHpy3ihL7V7RkJ
9: Qmf5VZhKxqfg8J8R6Vurfnsm2LYeoLmbooy5q5jcNoYoWH
```

**Tiempo a recovery:** < 30 min con `_ipfs_pin.js` + RUNBOOK steps + Filebase access keys en Bitwarden.

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

### Migración a `@react-native-firebase` + App Check con Play Integrity

**Why:** Smoke test 2026-06-16 expuso que el Firebase JS SDK no manda headers
`X-Android-Package` + `X-Android-Cert` necesarios para que las API key
restrictions de tipo "Android apps" (package + SHA-1) funcionen. Result:
durante el smoke test tuvimos que crear una 3ra API key con
`Application restrictions: None` y solo `API restrictions` por servicio. Eso
es lo que hace el 80% de las apps RN con JS SDK y NO es inseguro (las
Security Rules son la defensa real, no la key — que igual va embebida en el
APK), PERO para una app de plata real como MTB el gold standard es:

1. **`@react-native-firebase/app`** + módulos nativos (`/auth`, `/firestore`,
   `/storage`, `/functions`, `/messaging`). El SDK nativo Android usa Play
   Services para attestation automática → la Android-restricted key
   funciona, no necesitás keys "None".
2. **Firebase App Check con Play Integrity provider**. Verifica que cada
   request viene de un APK no-modificado en un device no-rooteado.
   Bloquea bots, emuladores, APKs reempaquetados.
3. **Performance**: SDK nativo (Kotlin/Swift) vs JS bridge. Mejor cold start,
   menos memoria, push notifications nativos sin wrapper.

**Por qué NO se hizo en v1.1.0:** mid-audit Round 2 (349 findings, 32 CRIT)
no es momento para SDK swap — contamina signals de Audit Round 3 y sin E2E
tests automatizados el risk de regression en flujos críticos (auth, mining
claim, USDC payment, NFT mint) es alto. Tracked como deuda explícita post
v1.1.0 release, NO como "algún día".

**Estimado:** 1-2 semanas dedicadas (sprint solo, no mezclar con otra cosa).
Pasos:
1. **Día 1-2 — Setup:**
   - `npx expo install @react-native-firebase/app @react-native-firebase/auth @react-native-firebase/firestore @react-native-firebase/storage @react-native-firebase/functions @react-native-firebase/messaging`
   - Bajar `google-services.json` de Firebase Console (Android app config) → poner en `android/app/google-services.json`.
   - Plugin en `app.json`: `["@react-native-firebase/app", { "android_task_executor_maximum_pool_size": 10 }]`.
   - `expo prebuild --clean` para regenerar android/ con el plugin de Google Services.
   - Verificar que el SHA-1 del keystore release esté en la Android key de GCP (`5E:8F...` debug + el de release).
2. **Día 3-5 — Refactor de imports:**
   - Sed across codebase: `from 'firebase/auth'` → `from '@react-native-firebase/auth'` (y los demás módulos).
   - **Diferencias de API** a manejar a mano (no es 1:1):
     - `getAuth(app)` → `auth()` (call directo, no se pasa app).
     - `signInWithEmailAndPassword(auth, email, pass)` → `auth().signInWithEmailAndPassword(email, pass)`.
     - `onAuthStateChanged(auth, cb)` → `auth().onAuthStateChanged(cb)`.
     - `doc(db, 'users', uid)` → `firestore().collection('users').doc(uid)`.
     - `setDoc(ref, data, { merge: true })` → `ref.set(data, { merge: true })`.
     - `serverTimestamp()` → `firestore.FieldValue.serverTimestamp()`.
     - `httpsCallable(functions, 'name')` → `functions().httpsCallable('name')`.
     - `getStorage(app)` → `storage()`.
   - El archivo más afectado: `src/firebase/client.js` y `src/firebase/functions.js` se rescriben casi enteros.
   - Search ALL files: `grep -rln "from 'firebase/" src/ App.js | wc -l` → estimar scope antes de empezar.
3. **Día 6-7 — App Check setup:**
   - Firebase Console → App Check → Apps → Android → Provider: Play Integrity.
   - En GCP Console: habilitar Play Integrity API en el proyecto.
   - Cliente: `import { firebase } from '@react-native-firebase/app-check'`. En `App.js` o init: `firebase.appCheck().activate('play-integrity', true)`. El `true` es `isTokenAutoRefreshEnabled`.
   - **NO enforce todavía**. Dejar en "Monitor mode" 1-2 semanas para ver métricas de adopción (qué % de tokens válidos llegan).
4. **Día 8-10 — Test E2E manual exhaustivo:**
   - Flujos críticos a probar en orden, **APK release-signed** (no debug):
     - [ ] Cold start, app llega a Login
     - [ ] Sign up con email/password nuevo
     - [ ] Email verification (callable Cloud Function)
     - [ ] Login con email/password existente
     - [ ] Persistencia: kill app, reabrir, sesión recuperada
     - [ ] Forgot password flow completo
     - [ ] Change email con re-auth
     - [ ] Update profile (avatar upload to Storage, username availability check)
     - [ ] ServerList load (Firestore listener)
     - [ ] Mine cubos (callable + Firestore writes con offline cache)
     - [ ] Daily claim + ad reward
     - [ ] Buy credits con USDC (Polygon + Firestore audit log)
     - [ ] NFT mint flow
     - [ ] Withdrawal request
     - [ ] FCM push notification recibido en background
     - [ ] Sign out: AsyncStorage limpio, audio teardown, vuelta a Login
5. **Día 11-12 — Enforce + cleanup:**
   - Una vez App Check monitor reporte >95% tokens válidos: cambiar de Monitor a Enforce en Firebase Console.
   - Borrar la 3ra API key (la "None" restriction) en GCP Console — ya no hace falta.
   - La Android-restricted key vuelve a ser la única.
   - Update `src/firebase/client.js`: cambiar apiKey de vuelta a la Android key (la `AIzaSyAtC4ItAQ5PpyKzzW7O6xIeh1xRkyW3pwo`).
6. **Día 13-14 — Release v1.2.0 con changelog explícito.**

**Criterios de éxito:**
- [ ] Cero crashes durante smoke test en ambos debug y release variant.
- [ ] App Check monitor mode reporta >95% válid tokens en 7 días.
- [ ] Performance: cold start no más lento que v1.1.0 (medir con `adb shell am start-activity -W`).
- [ ] Bundle size: aumento <5MB (los módulos nativos pesan pero JS SDK se va).
- [ ] Push notifications: latency similar o mejor.

**Riesgos a vigilar:**
- Diferencias sutiles en `onAuthStateChanged` timing → podría romper persistencia.
- Error codes de Firestore distintos → catch blocks específicos pueden mismatchear.
- Storage upload progress callbacks tienen API distinta.
- Si el dev del usuario rootea el device, App Check enforce lo bloquea → comunicar en release notes.

**Lo que NO hace falta migrar:**
- Cloud Functions backend (sigue siendo `firebase-functions` v2 + `firebase-admin`).
- Firestore Rules + Indexes.
- Polygon NFT contract.
- Web landing en docs/index.html (es estático, no usa Firebase JS SDK).

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
