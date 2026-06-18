# Agente #12 — Performance / Scalability / Cost

## Resumen ejecutivo

Stack: 28 Cloud Functions (Node 22, Firebase Functions v2), Firestore, Polygon NFT, RN/Expo SDK 54. Distribución sideload Android. `setGlobalOptions({ cpu: 0.5, memory: "256MiB", maxInstances: 10 })`.

| Severidad | Cantidad |
|-----------|----------|
| **CRIT**  | 6 |
| **HIGH**  | 11 |
| **MEDIUM**| 13 |
| **LOW**   | 9 |
| **INFO**  | 7 |
| **TOTAL** | **46** |

**Veredicto:** Sobrevive a 1k DAU ($15-20/mes). A **10k DAU salta a $185-205/mes**; pesimista (sin TTL en activityFeed, sin distributed counters, contention storm) hasta **$700/mes**. Hay **3 hot-paths sin caps** que escalan super-linealmente y **double-read activo en producción** entre `ServerList.js:160-167` (onSnapshot) y `exports.getServers` (`functions/index.js:542`).

## Top 5 hot paths (con costos por op)

| # | Hot path | Reads | Writes | Costo/op | Volumen 10k DAU/mes | Cost/mes |
|---|----------|-------|--------|----------|---------------------|----------|
| 1 | `mineCube` TX 5R+~4W + 2 post-TX writes (activityFeed) — contention bomb en `serverRef`/`layerRef` cuando varios users minan mismo server | 5 | 5+ | $0.000014 | 3.68M mines | ~$50-130 |
| 2 | `activityFeed` write+broadcast: 1 write → N×listeners reads. Sin TTL declarada → cumulative growth. **Sin filtro per-server** = global broadcast | 1W amplificado a 100-1000R | — | $0.0006 amp | 2k events × 1000 listeners = 2M | ~$36 |
| 3 | `ServerList` double-read: listener realtime `servers limit(50)` + onCall `getServers` en cada montaje | 50 + delta | — | — | 9M onCall + delta listener | ~$20-40 |
| 4 | `logClientError` = **5 ops por error** (2× rateLimit TX min+day + 1 write). Loops de error en cliente blow up el costo aún rate-limited | 2 | 3 + 2 TX | $0.00002 | 1M (peor) | ~$20 |
| 5 | Schedulers cron `mintProcessorScheduled` + `cryptoPaymentProcessorScheduled` corren cada 5min **aunque queue esté vacía** = 17.3k invocations/mes fijos + RPC calls publicnode | varía | varía | fixed | 17,310/mes | ~$3 + RPC risk |

## Tabla de costos por escala

| Categoría | 100 DAU | 1k DAU | 10k DAU | 100k DAU |
|-----------|---------|--------|---------|----------|
| Firestore reads | $0.50 | $5 | **$80** | **$800** |
| Firestore writes | $0.30 | $3 | $30 | $300 |
| Firestore storage | $0 | $0.05 | $0.50 | $5 |
| Cloud Functions (invoc + CPU) | $0 | $5 | **$60** | **$600** |
| Polygon gas (mints) | <$0.10 | $1-3 | $10-30 | $100-300 |
| Polygon RPC | free | free | free (Alchemy) | $49 (Alchemy Growth) |
| Cloud Storage backups | $0 | $0.10 | $0.50 | $3 |
| Egress (Hosting + APK) | $0 | $0 | $0-2 | $5-10 |
| Push (FCM nativo) | $0 | $0 | $0 | $0 |
| Email (Gmail→AWS SES @100k) | $0 | $0 | $0 | $5 |
| Schedulers fixed | $0.50 | $0.50 | $0.50 | $0.50 |
| **TOTAL/mes realista** | **~$1.50** | **~$15-20** | **~$185-205** | **~$1850-2080** |
| **Optimista (mitigaciones aplicadas)** | $1 | $10 | **$90** | **$850** |
| **Pesimista (sin cambios + viral spike)** | $3 | $40 | **$700** | **$8,000+** |

**Gap optimista vs pesimista = 3-9× — completamente accionable.**

## Bottlenecks identificados (CRIT)

1. **mineCube TX contention bomb** (`functions/index.js:679-788`): lee `serverRef`, `layerRef`, `userRef`, `minedRef`, `accessRef` y escribe a `serverRef`, `layerRef`, `userRef`. 100 users minando el mismo server = 400 writes/sec acercándose al **límite project-wide 500W/sec**. Endgame K=0 (6 cubos) genera contention storm.

2. **activityFeed sin TTL ni filtro** (`functions/index.js:127-133`, `src/screens/ActivityScreen.js:115-126`): cada gem_found/layer_complete/player_joined es 1 write → broadcast a **TODOS los clientes con ActivityScreen abierta**. Crece infinitamente sin cleanup automático.

3. **`maxInstances: 10`** soft caps backend a ~10 RPS sostenido. A 10k DAU con notification spike → backpressure visible.

4. **DynamicCube201 layers listener sin limit** (`src/components/DynamicCube201.js:1825`): subscribe a TODA la colección `servers/{id}/layers`. Servers progresados tienen hasta 101 docs. Cada layer update = 1 read × players viendo.

5. **`rateLimits` colección sin TTL** activado: array de timestamps por bucket × N buckets per uid → cumulative storage growth.

6. **Schedulers always-on**: 288 invocations/día cada uno aún con queue vacía + RPC calls `publicnode.com` sin SLA.

## Top 5 optimizaciones por ROI

1. **TTL en `activityFeed` + filtro por chainId/serverId** — Esfuerzo 2h, ahorro $30-100/mes @10k DAU, atajo trivial. Backend ya tiene patrón (errorLog, processedTxs). Agregar `expiresAt: Timestamp.fromMillis(now + 7*86400e3)` en `writeActivity` + activar TTL en Console.

2. **Eliminar double-read de `servers`** — 1h, $20-50/mes ahorro. Elegir: (a) eliminar listener realtime, dejar `getServers` pull-once con refresh, o (b) eliminar `exports.getServers` y mejorar cap del listener. Recomiendo (a).

3. **Self-throttle schedulers** — 30 min, ahorra ~$5/mes fijos + reduce risk RPC ban:
   ```js
   const pending = await db.collection("pendingCryptoPayments").where("status","==","waiting").limit(1).get();
   if (pending.empty) return { skipped: true };
   ```

4. **Distributed Counter en `layerRef.stats.mined`** — 4-6h, no ahorra $ pero **evita timeout cascada en endgame** (último episodio K=0). Necesario UX-wise antes de 50+ members/server.

5. **Migrar a Alchemy free tier + alert MATIC balance** — 2h, evita silent failures + customer support cost. `provider.getBalance(wallet.address)` antes de mintear, warning si <1 MATIC.

## Hallazgos secundarios relevantes

- **Index `mined(K, minedAt DESC)`** declarado en `firestore.indexes.json` pero backend escribe `ts` (no `minedAt`) en mineCube línea 761. Index unused — confirmado por Agent #2 CRIT. Frontend `DynamicCube201.js:1759` ordena por `minedAt` que no existe → realtime feed roto silently.
- **`getPeaksStatus` llamado en cada navegación** — sin caching client-side. 30M reads/mes @10k DAU = $12/mes.
- **Gmail SMTP 500 emails/día limit** — `sendVerificationEmail` + `reportProblem` + `submitGemClaim` + mint-failed alerts. A 100k DAU rompe verification flow → app-password suspendido. Migrar a AWS SES ($0.10/1000) antes de 50k DAU.
- **APK hosting GitHub Pages** soft cap 100 GB/mes (~5k installs/día APK 20MB). Migrar a R2 si crece.
- **FCM nativo (no Expo Push)** = $0 unlimited. **Patrón positivo.**
- **3D Cube201**: cross-ref Agent #5 — `addDarkPatch` (línea 1251) crea 2-3 THREE.Mesh + Sprite por celda sin `dispose()` = memory leak en sesiones largas. Battery drain ~5-10%/hora.
- Gems se sirven desde bundle local (`assets/gems/`), **no fetch IPFS en runtime** = 0 bandwidth en gem render.

## Pre-launch checklist

Antes de 1k DAU:
- [ ] TTL Console: `activityFeed`, `errorLog`, `processedTxs`, `adSessions`, `rateLimits`
- [ ] `maxInstances: 50` mínimo
- [ ] Self-throttle schedulers
- [ ] Alert MATIC balance < 1
- [ ] Docs/script para `gsutil lifecycle set` en bucket backup

Antes de 10k DAU:
- [ ] Migrar email a AWS SES
- [ ] Migrar RPC a Alchemy
- [ ] Opt-in push (Agent #4 CRIT-FE-01)
- [ ] Eliminar double-read servers
- [ ] Distributed counter en `layerRef.stats.mined`
- [ ] Cap o filter en `DynamicCube201` layers listener

Antes de 100k DAU:
- [ ] `minInstances: 1-3` en mineCube + getServers
- [ ] APK hosting → Cloudflare R2
- [ ] Activity feed paginado (no live broadcast)
- [ ] Distributed counter en `serverRef.totalMined`
- [ ] Redis Memorystore para `getServers`/`getChain`
- [ ] Sentry (o equivalente) para errores en lugar de `logClientError`
