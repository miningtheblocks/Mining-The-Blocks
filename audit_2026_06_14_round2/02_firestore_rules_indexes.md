# Agente #2 — Firestore Rules + Indexes

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 1 |
| HIGH | 5 |
| MEDIUM | 7 |
| LOW | 4 |
| TOTAL | 17 |

## Top 5 críticos

1. **[CRIT] `minedAt` vs `ts` schema mismatch** — backend escribe `ts`, cliente ordena por `minedAt`. El feed realtime de cubos minados ESTÁ ROTO (siempre devuelve 0 docs). Index compuesto `[K, minedAt]` sin uso real.
   - `functions/index.js:761` escribe `ts` / `DynamicCube201.js:1756-1761` ordena por `minedAt` / `firestore.indexes.json:21-27` index sobre `minedAt`.

2. **[HIGH] settings/profile/pushNotifications sin validación de tipo ni tamaño** — `firestore.rules:22-38` (create) y `49-75` (update). Cliente puede escribir `settings: <string 900KB>` o `pushNotifications: <map gigante>` y aproximarse al límite de 1MB por doc.

3. **[HIGH] usernames.create permite bypass con anonymous auth** — `firestore.rules:258-266`. Si Anonymous Auth está enabled en Console, atacante puede squat usernames sin email_verified. Cambiar a whitelist explícita.

4. **[HIGH] activityFeed y servers/mined sin cap de read → cost amplification** — `firestore.rules:188-190, 99-104`. Cliente authed puede `getDocs(collection)` sin limit y descargar todo, inflando bill.

5. **[HIGH] Index faltante para notifyAllUsers** — `[pushToken !=null, orderBy pushToken, orderBy __name__]` casi seguro requiere composite no declarado. La primera ejecución va a fallar con `failed-precondition`.

## Otros hallazgos importantes

- **[HIGH]** Cliente lee `servers/{id}` directamente bypaseando `PUBLIC_FIELDS` whitelist de `getServers` — `createdBy` (uid del creador) es público.
- **[MED]** `serverChains/{id}/history` puede ser spam-eado por usuarios con acceso a episodios pasados.
- **[MED]** Auto-mint en `mineCube` (functions/index.js:820) usa `add()` en lugar de docId determinístico → puede generar 2 NFT minted si Cloud Functions reintenta.
- **[MED]** `usernames.update` sin merge rompe `createdAt` en re-claims (Registration.js:216).
- **[MED]** `meta/counter` permite crear contadores en chains inexistentes (orphan).
- **[MED]** `updatedAt` sin validación de tipo en `users.{create,update}`.
- **[BAJO]** Storage rule: jpg pattern + png contentType (cosmético).

## Patrones positivos detectados (11)
- `meta/counter` con seq+1 (defensive)
- `history` rule con doble check serverAccess + chainId match
- Whitelist en users.update (fail-safe)
- `usernames` rule bloquea reasignación de uid en update
- `closeEpisode` idempotency + meta/counter restrictivo
- `pendingCryptoPayments` con `resource.data.uid` check (no `request.resource.data.uid`)
- `gemClaims/adminActions/errorLog/rateLimits/adSessions/userMeta` admin-only
- `requireAdminFresh` con Admin SDK getUser
- `generateGemCode` y `generateReferralCode` con `crypto.randomBytes`
- CORS allowlist con reflection del Origin

## Gaps de test en rules.test.js
- 15 paths sin test (validación de tipos/tamaños, anonymous bypass, history cross-chain, meta orphan, etc.)
- Recomendado agregar 20+ tests cubriendo type/size validations y path-based checks
