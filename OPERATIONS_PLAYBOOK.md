# MTB — Operations Playbook

Protocolo de cuidados, revisiones y actualizaciones POST-RELEASE.
Documento de referencia: para ejecutar las revisiones periódicas y mantener la app saludable.

Última actualización: 2026-06-23.

---

## 🎯 Resumen ejecutivo

| Cadencia | Tiempo aprox | Cuándo |
|---|---|---|
| **Diaria** | 0 min (auto) | El sistema lo hace solo |
| **Semanal** | 15-20 min | Lunes a la mañana |
| **Mensual** | 1-2 hs | Primer lunes del mes |
| **Trimestral** | 4-6 hs | Día 1 de cada trimestre |
| **Anual** | 1 día | Aniversario del primer release |
| **Reactivo** | Variable | Cuando dispara un trigger |

---

## 📅 PROTOCOLO DIARIO (automatizado, vos NO hacés nada)

Esto ya corre solo, gracias a Cloud Scheduler + Firebase Functions. Tu único trabajo: **revisar el email cada mañana** si hay alertas.

### Crons activos (verificar 1 vez al mes que SIGUEN activos)

| Job | Schedule | Qué hace |
|---|---|---|
| `cryptoPaymentProcessorScheduled` | Cada 5 min | Detecta Transfer events USDC y acredita créditos a users |
| `mintProcessorScheduled` | Cada 5 min | Mintea NFTs pendientes en `pendingMints` |
| `maticBalanceCheckScheduled` | Cada 30 min | Alerta si MATIC del minter <2 |
| `firestoreBackupScheduled` | Cada día 3am | Export Firestore + alerta si falla |
| `adminActionsAnomalyWeekly` | Lunes 9am | Detecta patrones sospechosos en `adminActions` |
| `errorLogSummaryWeekly` | Lunes 9am | Top errors agrupados por scope |

### Acción tuya cada día

**Revisar inbox `miningtheblocks@gmail.com`** buscando alertas:
- `🚨 [MTB] Firestore backup FALLÓ` → seguir el procedure en RUNBOOK.md
- `[MTB] MATIC balance LOW` → fondear la wallet `nftv2` con ~10 MATIC
- `[MTB] Mint failed after 5 attempts` → investigar el mintId reportado
- Cualquier email con `🚨` → acción inmediata

**Si NO hay emails con 🚨**: todo OK, no hacer nada.

---

## 📅 PROTOCOLO SEMANAL — Lunes 9am (15-20 min)

### 1. Email inbox review (5 min)

- Buscar `from:miningtheblocks@gmail.com to:miningtheblocks@gmail.com` los últimos 7 días.
- Revisar todos los digests:
  - `Resumen semanal de errores cliente` — top 3 scopes con error. Si alguno es nuevo o spike → marcar para investigar.
  - `Resumen semanal de admin actions` — verificar que NO hay actions que no recordás haber hecho.

### 2. Sentry dashboard (5 min)

👉 https://sentry.io/organizations/miningtheblocks/issues/

- Filtrar por `Last 7 days` + `Environment: production`.
- Verificar: ¿hay issues nuevos no triaged?
- Issues con frequency >100 events → investigar a fondo (probable bug real).
- Issues con frequency <10 events → triaje rápido (es bug o ruido?).
- **Asignar un issue** si encontrás algo accionable.

### 3. Firebase Console (5 min)

👉 https://console.firebase.google.com/project/miningtheblocks-669f6/overview

- **Functions** → tab "Logs": buscar errores ERROR/WARNING últimos 7 días.
- **Firestore** → tab "Usage": verificar reads/writes vs. semana anterior. Si spike >2× sin explicación → investigar.
- **Authentication** → tab "Users": cantidad de nuevos vs. semana pasada (tracking growth).
- **Hosting** → tab "Usage": GB transferred + requests. Si spike → investigar (puede ser scrape malicioso).

### 4. Polygon wallets check (3 min)

- **MTB Admin Safe** `0x83a3F5Bd15302F17B7f2e430900F1d2A40F86aCD` — verificar que las 3 signers siguen ahí.
- **Backend MINTER (nftv2)** `0x0a285CA8BaE2FbA3808bd260f936bCa22F06941e` — verificar balance MATIC ≥5.
- **Payment wallet (pagosmtb)** `0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f` — verificar balance USDC (debería crecer con entry fees).

### 5. GitHub repo check (2 min)

- **Issues** → cerrar los que estén resueltos, asignar prioridad a nuevos.
- **Pull requests Dependabot** → revisar (NO mergear ciegamente; major bumps requieren testing).
- **Actions** → último CI verde? Si rojo, investigar.

---

## 📅 PROTOCOLO MENSUAL — Primer lunes del mes (1-2 hs)

Incluye TODO lo del protocolo semanal, más:

### 1. Security review (30 min)

**npm audit en root + functions**:
```bash
cd /run/media/code/datos/MTB && npm audit --omit=dev --audit-level=high
cd functions && npm audit --omit=dev --audit-level=high
```
- Si hay `high` o `critical` → patch dentro de 7 días.
- Si hay `moderate` con CVE recent → evaluar relevance.

**Verificar que las API keys no fueron filtradas en github commits**:
```bash
cd /run/media/code/datos/MTB
git log --all -p --since='1 month ago' | grep -E "AKIA[0-9A-Z]{16}|sk_live_|ghp_|sntrys_" | head
# debe ser vacío (excepto las menciones en código del pre-commit hook)
```

### 2. Cost review (15 min)

👉 https://console.cloud.google.com/billing/

- **Cloud Functions** invocations + GB-seconds del último mes.
- **Firestore** reads/writes del último mes.
- **Hosting** bandwidth.
- **Secret Manager** access count.

**Trigger**: si total >USD 30/mes sin justificación de volumen real → investigar query patterns.

### 3. Smart Contract verificación (10 min)

👉 https://polygonscan.com/address/0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195

- Verificar que el contrato sigue **verified** (Source Code tab).
- Verificar `paused()` está en `false`.
- Verificar role assignments:
  - `DEFAULT_ADMIN_ROLE` = Safe `0x83a3F5...86aCD`
  - `MINTER_ROLE` = `nftv2` `0x0a28...41e`
  - `PAUSER_ROLE` = Safe `0x83a3F5...86aCD`
- Verificar `totalMinted()` matchea tu DB de gemClaims redeemed.

### 4. Tests + Lint (15 min)

```bash
cd /run/media/code/datos/MTB/functions
npm run lint
npm test
# Espera: lint clean + 38/38 tests passing
```

Si algo rompe → investigar inmediato (lib update silencioso, deps drift, etc.).

### 5. Push notifications check (10 min)

- Mandar push test manual desde Firebase Console a tu propio device.
- Si NO llega → debug FCM token registration en el doc del user en Firestore.

### 6. Web pública sanity check (10 min)

```bash
curl -sI https://miningtheblocks.com/ | head -5
# debe: HTTP/2 200, content-type text/html
curl -sI https://miningtheblocks.com/.well-known/assetlinks.json | head -3
# debe: HTTP/2 200, content-type application/json
curl -sI https://miningtheblocks-669f6.web.app/verify | head -3
# debe: HTTP/2 200
```

Si algún 404 / 500 → investigar deploy hosting.

---

## 📅 PROTOCOLO TRIMESTRAL — Cada 3 meses (4-6 hs)

Incluye TODO del mensual, más:

### 1. Test recovery del keystore (30 min)

```bash
mkdir -p /tmp/keystore-test && cd /tmp/keystore-test
cp /run/media/code/datos/keystore-backup-2026-06-23/mtb-release-v2.keystore.gpg .
gpg --output test.keystore --decrypt mtb-release-v2.keystore.gpg
sha256sum test.keystore
# debe matchear con el SHA-256 documentado en RUNBOOK.md
cd / && rm -rf /tmp/keystore-test
```

Si falla el descifrado:
- Verificar password en Bitwarden no cambió.
- Si el password en Bitwarden está bien, el archivo `.gpg` está corrupto → restore desde otro backup (USB Kingston / email off-site).

### 2. Test recovery Firestore (45 min — NO en prod!)

Seguir el procedure documentado en `RUNBOOK.md` sección **"🔧 Procedure detallado — Restore de Firestore"**. En resumen:

```bash
# 1. Listar exports
gsutil ls gs://miningtheblocks-669f6-backups/ | sort -r | head -10

# 2. Import en project de TESTING (NUNCA prod)
gcloud firestore import \
  gs://miningtheblocks-669f6-backups/<LAST_BACKUP>/<EXPORT_PREFIX> \
  --project=mtb-restore-test
```

Verificar que los counts del project de test cuadran con prod. Si no → backups corruptos.

### 3. Dependabot bulk review (1 hora)

Mergear los `patch` y `minor` Dependabot PRs que estén abiertos hace >30 días.
NO mergear `major` sin testing on-device + EAS build de validación.

```bash
gh pr list --label dependencies --limit 20
# revisar y mergear o cerrar uno por uno
```

### 4. Code review autoreflexión (30 min)

```bash
cd /run/media/code/datos/MTB
git log --since='3 months ago' --oneline | head -30
```

Pasar por los últimos 30 commits y autoevaluarse:
- ¿Hay alguno que no quedó bien resuelto?
- ¿Quedaron TODOs sin atender?
- ¿Hay regresiones obvias?

### 5. Backups offline del keystore (15 min)

- Verificar físicamente que **USB Kingston** sigue accesible (no perdido / no dañado).
- Verificar que el **email off-site** sigue en inbox del destinatario.
- Si alguno está perdido → re-generar la copia.

### 6. RUNBOOK + PLAYBOOK update (30 min)

Releer ambos documentos. Si algo cambió en el último trimestre (nuevo cron, nuevo endpoint, address del contrato, etc.):
- Actualizar el doc.
- Commitear con tag `docs(ops): Q3 review` por ejemplo.

### 7. User feedback consolidation (1 hora)

- Revisar bug reports recibidos via `miningtheblocks@gmail.com`.
- Revisar emails de soporte.
- Si hay patterns (>3 users reportan lo mismo) → priorizar fix.

---

## 📅 PROTOCOLO ANUAL — Cada aniversario del release (~1 día)

Incluye TODO del trimestral, más:

### 1. Smart Contract audit externo (si volumen aplica)

**Trigger**: si el volumen mensual de mints/redeems acumulado del año >USD 30k.

**Cómo**: contratar Sherlock o Code4rena audit (USD 1-3k contract V2):
- https://sherlock.xyz/contests/submit-contract
- Audit competitivo: 1-2 semanas
- Resultado: report con findings. Aplicar fixes críticos antes de continuar.

### 2. Legal review (cuando aplique)

**Triggers**:
- Vas a abrir a UE/US explícitamente → MICA + Howey consulta.
- Revenue >USD 50k/mes → consulta general.
- Cambios mayores en TOS o modelo → consulta antes de aplicar.

**Cómo**: abogado crypto local (Argentina: Marval, Bruchou, Estudio Beccar Varela). USD 500-2000 consulta inicial.

### 3. Expo SDK upgrade (cuando esté disponible próximo SDK)

**Trigger**: nueva versión major de Expo SDK (cada ~6 meses).

**Cómo**:
- Leer release notes con cuidado.
- `npx expo install --fix` para auto-upgrade compatible.
- Build local con EAS, test on-device intensivo.
- Si pasa → publish v1.X.0.
- Si rompe algo → no actualizar, esperar siguiente versión.

### 4. Rotación de credenciales (anual)

- Generar nueva GPG passphrase del `.gpg` del keystore.
- Generar nuevo `SENTRY_AUTH_TOKEN` en sentry.io/settings/account/api/auth-tokens/.
- Rotar `GMAIL_APP_PASSWORD` (Gmail Settings → Security → App passwords).
- Considerar rotar `SERVER_SEED` en GCP Secret Manager (requiere migración cuidadosa — el HMAC effectiveSeed ya limita blast radius).

### 5. Strategy review (medio día)

- Métricas anuales: users acquired, monthly active, revenue, churn.
- ¿Qué features tuvieron tracción y cuáles murieron?
- ¿Quién es el user real vs. quién pensábamos?
- Decidir 2-3 OKRs para el próximo año.

---

## 🚨 TRIGGERS REACTIVOS — Hacer cuando dispara

| Trigger | Acción inmediata | RUNBOOK ref |
|---|---|---|
| MATIC balance <2 en `nftv2` | Fondear con 10+ MATIC en 24h | `#9` |
| Backup email FAIL | Investigar Functions logs + manual export | `#11` + procedure |
| Sentry crash rate >5% del baseline | Hotfix release dentro de 48h | — |
| Sentry NEW error con >100 events | Investigar + patch dentro de 7 días | — |
| Firestore reads/writes >2× spike sin explicación | Investigar query patterns en logs | `#12` |
| Polygon RPC publicnode.com outage | Esperar o migrar a Alchemy backup | `#10` |
| Pinata IPFS down | Verificar Filebase pinning vivo | `#13` |
| User reporta NFT no llegó | Buscar en `pendingMints` + investigar tx | — |
| User reporta canje no se acreditó | Buscar en `gemClaims` + verificar status | — |
| Reporte de phishing usando `@miningtheblocks` | Verificar SPF+DMARC records, alertar comunidad | — |
| Domain hijack alert | Recovery con Cloudflare backup codes | `#4` |
| GitHub repo compromise alert | Lockdown branches + audit commits | `#5` |
| `COMPANY_WALLET_KEY` filtrado | DR completo del Safe + cambio contrato si necesario | `#1` |

---

## 📈 KPIs / Métricas a trackear

### Performance
- p95 response time de Cloud Functions (target: <500ms)
- App crash-free rate (target: >99.5% on Android)
- Cube render FPS (target: >45fps mid-range)

### Security
- 0 secrets en git history (verificación mensual)
- 0 HIGH/CRITICAL CVEs en deps prod (verificación mensual)
- Backup success rate (target: 100%)
- Keystore backup verified (target: 1× trimestre)

### Business
- DAU (daily active users)
- MAU (monthly active users)
- Conversion rate: visit → register → first payment
- Average revenue per user
- Churn rate

### Costs
- Firebase total / mes (target: <USD 30 hasta 1k DAU)
- Polygon gas / mes (target: <USD 50 hasta 100 mints/día)
- IPFS pinning (target: <USD 20/mes)

---

## 📋 Backlog técnico — Items NO atendidos del audit

Estos son del audit Round 2 que decidiste no atender ahora, por baja prioridad o por trade-off. Documentados para referencia futura.

### Prioridad baja (atacable cuando haya volumen)
- **HIGH-7 MICA/Howey legal**: abogado crypto, USD 500-2k. Trigger: revenue >USD 50k/mes O expansión EU/US.
- **Audit externo del contrato** (Sherlock): USD 1-3k. Trigger: TVL >USD 10k.
- **Multi-RPC fallback** (`FallbackProvider` con Alchemy + Quicknode): 30 min. Mitiga outage de publicnode.com. Trigger: SLA crítico (>10k DAU).

### Cleanups (cuando tengas tiempo, no urgentes)
- Split de `DynamicCube201.js` (5272 líneas → módulos): 6-8h. Mejora maintainability post-v1.2.x stable.
- Tone mapping ACES + sRGB en renderer: 30 min. Future-proof si agregás PBR materials.
- Raycast result cache (50ms): 2h. Mejora "feel" del long-press.
- Face detection tuple hysteresis: 1.5h. Reduce flicker en grid mode.
- Audio priority queue: 2h. Cuando agregues sonidos simultáneos.
- Render throttle sync con animaciones: 2.5h. Si crack/fragment se ven lentas.
- Viewport culling every 2 frames: 1h. Mejora pan smoothness.

### Mejoras de producto (no son del audit, pero potencial alto)
- **Tutorial / onboarding** modal al primer login (3-4 slides): 2h. Mayor impacto en conversion.
- **Notificaciones de expiración inminente** (7d / 1d antes del expire): 1h. Evita pérdida de premios por olvido.
- **Sistema de logros** simples ("primer NFT", "10 mines", etc.): 3h. Engagement.
- **Landing page mejorada**: 3h. Hero más vendedor + FAQ + testimonios.
- **Analytics integrado**: 1h. Track funnel landing→registro→pago→canje.

---

## 🔄 Cuándo actualizar este playbook

- Cuando agregues un nuevo Cloud Function scheduler.
- Cuando cambies la address de un contrato deployment.
- Cuando rotes credenciales (mencionar la rotación + fecha).
- Cuando agregues un nuevo KPI a trackear.
- Cuando un trigger reactivo dispare y descubras una mejor respuesta.

Commit con tag `docs(ops): playbook update Q{n} {YYYY}`.

---

## 📞 Referencias rápidas

| Doc | Para qué |
|---|---|
| `RUNBOOK.md` | Disaster recovery — qué hacer cuando algo se rompe |
| `OPERATIONS_PLAYBOOK.md` (este) | Mantenimiento periódico — qué hacer rutinariamente |
| `audit_2026_06_21_pre_release/PENDING_FIXES.md` | Estado del audit Round 2 |
| `contracts_build/` | Smart contract V2 source + tests + scripts |
| Bitwarden | Passwords, API keys, recovery codes (NUNCA en código) |
| GitHub Issues | Bug tracking público |
| Sentry | Error monitoring producción |
| Firebase Console | Backend monitoring + Firestore + Hosting |
| Polygonscan | Blockchain verification (contrato + tx) |

---

**Mantené este doc actualizado. Tu yo del futuro te lo va a agradecer.**
