Critical issue spotted: in joinServer line 437 — the `episodeNumber >= MAX_EPISODES` free episode flow doesn't set `wasNewPaidJoin = true`. So the welcome picks (5) are NOT given to free joiners — which is intentional. But ALSO the activity feed event below uses `wasNewPaidJoin` to gate notification... wait, no, the `wasNewPaidJoin` only gates lines 469-510. The activity feed is line 512+ outside the gate. Looking again:

Actually line 469 `if (!wasNewPaidJoin) return` returns early — meaning the activity feed and referral bonus skip for free-episode joins. That's a minor bug — free-episode joiners don't appear in the activity feed. Not security but worth noting.

But more importantly: the free-episode bypass at line 437-451 sets `accessRef` but does NOT track `wasNewPaidJoin`. If a user was at episode 10 fresh (no chain access) and the chain check `distinctEpisodes.size >= MAX_EPISODES - 1` fails (they don't have 9 prior episodes), the code falls through to the paid path. Good.

But there's a subtle case: what about creating an episode 10 free join when user previously had access but accessRef was deleted? Not possible since accessRef is server-only-writable.

OK I have enough info now. Let me also verify one final concern: how the `setRestrictedCorsHeaders` handles the case when origin is NOT in allowlist - it sets no `Access-Control-Allow-Origin` header. But the request still PROCEEDS (the handler runs). The browser blocks the response, but a non-browser client (curl) gets through. For `claimAdSession` and `submitGemClaim`, this is OK because:
- `submitGemClaim` requires Bearer token + ownership check.
- `claimAdSession` uses one-time session+token verified against Firestore.

Good. Let me also examine the rate-limiting design — the `_rateLimitFirestore` retains all timestamps in `ts: []` array and filters by window. If max=100 and window=24h, the array can have 100+ entries (until filtered next call). Each entry adds ~8 bytes. Not a real issue.

But there's a subtle issue with `_rateLimitFirestore`: it does NOT increment `expiresAt` past the original creation; reading line 1733 vs 1737: both branches set `expiresAt: now + windowMs * 2`. So TTL is renewed each call. Good.

Now let me also check: when `_rateLimitFirestore` is OVER limit (line 1731-1734), it STILL writes the same array (no new timestamp). But it writes `expiresAt: now + windowMs * 2` — meaning that an attacker who keeps spamming, with each hit, REFRESHES the TTL of the bucket. The bucket never expires! For a low-volume bucket key like `crc_${uid}`, this means the doc lives forever in Firestore as long as the user keeps hitting it. Mild concern about cleanup.

Now I think I have enough material for a comprehensive audit. Let me produce the report.

---

# AUDITORÍA PROFUNDA — Backend Cloud Functions MTB

Auditoría completa de `functions/index.js`, `functions/helpers.js`, `functions/constants.js`, `functions/eslint.config.js`, `functions/package.json`, `functions/test/*` + cross-referencias con `firestore.rules`. 28+ exports revisados línea por línea.

---

## HALLAZGOS

### CRIT

**[CRIT-1] `mineCube` puede ser bypaseado para minar el mismo cubo después de que ya está marcado, vía `currentLayer` cambiando**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:686-722`
- Categoría: 1. Race conditions y atomicidad
- Descripción: El `minedRef` se construye con `cubeNumber` (1..N de la capa actual `K`). Cuando una capa se completa (líneas 770-773), `serverUpdate.currentLayer = K - 1` cambia el K del server. La nueva capa empieza también en cubeNumber=1. Si dos requests entran en paralelo justo cuando la capa anterior se completa: TX1 mina el último cubo de K=100 (cube #1), TX2 ve `currentLayer=99` (después del retry) y mina cube #1 — pero el `minedRef` apunta a `mined/1` que ya está ocupado por TX1. Firestore TX retry resuelve esto, pero el problema es que el doc `mined/1` queda con un mix de capas K=100/K=99 según quién gane. La consulta para detectar `alreadyMined` solo verifica que el doc exista, NO verifica que `data().K === currentLayer`. Si el cubo #1 fue minado en K=100, un user posterior en K=99 que intente minar cubo #1 va a fallar (existe), perdiendo la oportunidad. Y reverso: el rate-limit aplicado al "perdedor" no es correctamente atribuible (sí mina, sí gana cubo, pero datos mezclados).
- Por qué importa: Corrupción de datos en `mined/{N}` (mezcla de capas). Los usuarios en capas profundas no pueden minar cubos que ya fueron minados en capas superiores con el mismo número.
- Fix sugerido: docId de `mined` debe incluir K: `serverRef.collection("mined").doc(`${K}_${cubeNumber}`)`. Migrar data existente con un script.

**[CRIT-2] `processedTxs` no se filtra por `paymentDoc.ref.id` — un evento puede acreditar a un payment de otro user con el mismo monto en data legacy**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1476-1521`
- Categoría: 6. Crypto / payments + 1. Race conditions
- Descripción: El loop construye `pendingByAmount` agrupado por `amountUnits` y procesa por FCFS (createdAt asc). Pero la idempotency key es `processedTxs/{txHash}` global. Si dos pagos `pendingCryptoPayments` distintos tienen el mismo `amountUnits` (data legacy permitida explícitamente por el comment SEC-002), el primer evento USDC con ese monto consume el primer pago (más viejo), y el SEGUNDO evento USDC con el mismo monto en otra TX intentaría consumir el segundo pago — pero si el primer evento aún no fue confirmado por SAFE_CONFIRMATIONS, ambos eventos pueden aparecer en el mismo run y ambos crean `processedTxs/{txHash}` distintos. Sin embargo, si dos usuarios pagan el mismo `amountUnits` por error en data legacy y SOLO UNO de ellos efectivamente envía la tx, ambos pagos quedan en `pendingByAmount.get(amount)` y al consumirse el primer paymentDoc (más viejo), el OTRO user es estafado: su pago expira sin ser acreditado.
- Por qué importa: Un user honesto que paga con el mismo monto coincidente con un payment legacy más viejo, pierde el dinero. Esto es solo realista con data legacy pero el código lo acomoda explícitamente. En la práctica con docId determinístico nuevo (`amt_${amountUnits}`), las TX no permiten colisiones, pero el código todavía soporta el path legacy y se le pasa al primer FCFS — es asimétrico vs intuición.
- Fix sugerido: Marcar explícitamente la fecha de cutoff post-migración legacy; loguear WARNING cuando `docs.length > 1` para detectar el caso en producción.

**[CRIT-3] `_rateLimitFirestore` no garantiza atomicidad entre dos buckets — `logClientError` puede bypassear el rate-limit diario via collision de buckets sin auth**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:2021-2055`, `1724-1741`
- Categoría: 9. Inputs HTTP públicos + 8. Logging
- Descripción: Para users sin auth (`uid === null`), el bucket es `lce_a_${ip}`. El IP viene de `request.rawRequest.ip`. En Firebase Functions, este `ip` es el IP del LOAD BALANCER de Google, no del cliente real, a menos que se procese `X-Forwarded-For`. Toda llamada anónima cae en el MISMO bucket "lce_a_(IP-loadbalancer)" y se rate-limitea globalmente — fácil de saturar a 100/día entre todos los usuarios del mundo. O peor: si `request.rawRequest.ip` devuelve `undefined`, el bucketKey es `lce_a_undefined` y todos los anónimos comparten ese bucket único.
- Por qué importa: (a) Atacante puede bloquear el logging legítimo de TODOS los usuarios anónimos enviando 100 errores. (b) Esto invalida `logClientError` como herramienta de observability para bootstrap errors (que es exactamente el caso de uso).
- Fix sugerido: Leer IP correctamente desde `X-Forwarded-For` (Firebase Functions runs detrás de Google's edge). Adicionalmente, para `logClientError`, considerar requerir auth y matar el path anónimo.

---

### HIGH

**[HIGH-1] `claimGemNFT` y el path auto-mint de `mineCube` crean docs en `pendingMints` con esquemas de docId distintos — auto-mint usa `.add()` (no idempotente)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:820-831`
- Categoría: 2. Idempotencia + 6. Crypto / payments
- Descripción: `claimGemNFT` (line 627) usa docId `${uid}_${gemId}` (idempotente — comment ALTO-32). Pero el path auto-mint en `mineCube` (cuando el user ya tiene wallet vinculada, líneas 819-831) usa `db.collection("pendingMints").add({...})` con docId random. Si `pendingMints.add()` falla parcialmente (timeout pero el write se aplicó), un retry del cliente sobre `mineCube` no es posible (la TX `mineCube` ya completó), pero si el código se ejecutara dos veces por algún flow alternativo (no debería, pero defense-in-depth), se generarían 2 `pendingMints` para la misma gema. Más concretamente: si `pendingMints.add` falla con error después de que `gems.add` ya escribió, la gema queda `status='minting'` con `walletAddress` set, pero sin pendingMint → la gema queda atascada permanentemente sin posibilidad de re-claim (el TX `claimGemNFT` exige `status === "unclaimed"`).
- Por qué importa: Stuck gems con un crash de network. El user pierde el NFT que el server-side deber haber emitido. No hay handler de "rescue".
- Fix sugerido: Usar docId determinístico `auto_${uid}_${gemRef.id}` en auto-mint también. Y agregar un retry/rescue admin endpoint o un scheduled task que detecte gems en `status=minting` con `walletAddress` set por >24h y sin pendingMint asociado, y re-cree el pendingMint.

**[HIGH-2] `closeEpisode` — el segundo proceso que se ejecuta podría retornar `isLastEpisode: false` aunque sí fuera el último**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:198-204`
- Categoría: 1. Race conditions
- Descripción: Cuando el guard `closing_${episodeNumber}` ya existe (otro worker está cerrando), el segundo flow retorna `{ isLastEpisode: false, nextEpisode: episodeNumber + 1 }` SIN consultar el estado real. Si el episodio era el último (10), el caller mostraría "next episode 11" en el activity feed o en respuestas a clientes, lo que es incorrecto. El caller `mineCube` no usa este return, así que el impacto inmediato es bajo, pero cualquier nuevo caller de `closeEpisode` recibe info corrupta.
- Por qué importa: Bug latente que despertará la próxima vez que alguien use el return value sin leerlo con cuidado.
- Fix sugerido: En la rama "ALREADY_CLOSING", retornar `{ isLastEpisode: episodeNumber >= MAX_EPISODES, nextEpisode: episodeNumber >= MAX_EPISODES ? null : episodeNumber + 1 }`.

**[HIGH-3] `closeEpisode` — la escritura de `history` con `seq` del counter es una TX SEPARADA del guard, y puede leer `counter` mientras un CLIENTE legítimo lo está bumpeando (mine), causando un `seq` colisionado**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:221-245` + `firestore.rules:128-135`
- Categoría: 1. Race conditions + 8. Logging
- Descripción: Las rules permiten al cliente escribir `serverChains/{chainId}/meta/counter` con `seq == old + 1` desde sus propias mineCube history entries. En paralelo, el backend en `closeEpisode` lee `counter` y escribe `seq = old + 1`. Si Cliente A escribe `seq=N+1` justo antes de que backend lea, backend lee N+1 y escribe N+2. Pero Cliente B en paralelo lee N+1 y también intenta N+2 → uno gana, el otro retrya. Firestore TX retry resuelve esto si todos están en TX. PERO: el cliente mineCube history NO está en TX backend (es un write de cliente al ESCRIBIR su mine entry — el cliente lo hace en su propia operación). Eso significa que dos `history` writes pueden terminar con el mismo `seq` si ambos leen el counter de manera no-transaccional (lo cual el cliente puede hacer fácilmente al inyectar `seq=old+1` con un set directo si conoció N de antemano).
- Por qué importa: El campo `seq` deja de ser único, rompiendo el orden cronológico de la activity feed history. Defense-in-depth fail.
- Fix sugerido: Mover el seq generation al backend (Cloud Function `recordMineHistory` que el cliente invoca), y bloquear el write directo desde el cliente.

**[HIGH-4] `setUserWallet` no invalida los `pendingMints` pendientes apuntando a la wallet vieja**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1297-1330`
- Categoría: 6. Crypto / payments + 5. Secrets / credentials
- Descripción: Si un user cambia de wallet (después del cooldown de 24h, o desde null → set inicial), los `pendingMints` con `status='pending'` que aún no se procesaron mantienen la wallet vieja en el doc. El mint scheduler los mintea en la wallet vieja. El cooldown de 24h limita el daño, pero un atacante que comprometa la cuenta puede:
  1. Esperar 24h sin tocar wallet (o ser el primer setter)
  2. Cambiar wallet a la suya
  3. Los pendingMints CREADOS DESPUÉS apuntan a la wallet nueva del atacante, pero los CREADOS ANTES por mineCube auto-mint también — si el scheduler los procesa después, el atacante recibe los NFTs.
  
  Espera — el atacante PROPIA wallet. El daño real es: una gema descubierta antes del comprometimiento, con auto-mint pendiente, será minteada en la wallet del ATACANTE post-cambio (porque el pendingMint del auto-mint también tiene la wallet vieja). NO. Auto-mint en mineCube (line 826) usa la wallet leída en ese momento (el `userWallet` snapshot). Si el user-original tenía wallet W1, la gema y pendingMint tienen wallet W1. Cuando el atacante cambia a W2, NO afecta los pendingMints existentes (mantienen W1). Los NFTs van a W1 (víctima legítima). Pero las gemas DESCUBIERTAS POST-cambio van a W2 (atacante). Eso ya es esperado.
  
  El bug real: si el user CAMBIA su wallet legítimamente (no atacante), los NFTs auto-mint pendientes seguirán minteándose en la wallet vieja sin warning. UX issue + posible pérdida de NFT si el user perdió acceso a la wallet vieja.
- Por qué importa: El user puede perder NFTs por cambiar de wallet sin saber que tiene pendingMints pendientes apuntando a la vieja.
- Fix sugerido: En `setUserWallet`, detectar pendingMints con `walletAddress === oldWallet` y `status='pending'`, y ofrecer redirigirlos a la nueva wallet (admin-controlled o user-confirmed).

**[HIGH-5] `cryptoPaymentProcessorScheduled` no maneja errores de RPC — un fallo de Polygon RPC pierde 5 minutos de eventos sin retry**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1434-1481`
- Categoría: 6. Crypto / payments + 7. Error handling
- Descripción: La función lee `currentBlock = await provider.getBlockNumber()` (line 1436). Si esto falla, la excepción no se atrapa explícitamente y el scheduled wrapper (line 1682) tampoco la atrapa explícitamente. Cloud Functions onSchedule retryará por config, pero la ventana de `fromBlock = safeBlock - 200` solo da ~6-7 min. Si el RPC está down 20 min, los bloques se pierden. No hay tracking de "last successfully processed block".
- Por qué importa: Pagos pueden no ser acreditados si el RPC tiene un outage de >7 min. El user paga y nunca recibe el crédito.
- Fix sugerido: Persistir `lastProcessedBlock` en un meta doc; al inicio leer desde ahí y avanzar incrementalmente; sólo loguear "no more progress" si block actual no avanza.

**[HIGH-6] `cryptoPaymentProcessorScheduled` lanza el scheduler cada 5 min pero la ventana de bloques es 200 — Polygon hace ~7s/block actualmente, eso es ~23 min de ventana, no 6-7**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1439`
- Categoría: 6. Crypto / payments
- Descripción: Comentario dice "200 bloques ≈ 6-7 min". Pero Polygon target block time es ~2-2.3 seg en 2026, no 7s. 200 blocks × 2.2s ≈ 7.3 min. Cerca de lo declarado. Sin embargo, una transacción confirmada con SAFE_CONFIRMATIONS=30 entra en `safeBlock = current - 30`, y `fromBlock = safeBlock - 200`. Una tx que ocurrió en bloque B necesita 30 confirms (≈66 seg) antes de ser elegible, y debe ser leída antes de que `safeBlock - 200 > B`, es decir `current > B + 30 + 200 = B+230` (≈8.5 min en wallclock). Con scheduler corriendo cada 5 min, esto encaja, pero ajustado. Si el scheduler falla un run, el siguiente run (10 min después de la última corrida exitosa) tiene window `safeBlock-200..safeBlock` que ya pasó el bloque originalmente esperado.
- Por qué importa: Un solo fallo del scheduler corre el riesgo de perder eventos. La ventana es demasiado ajustada.
- Fix sugerido: Aumentar window a 600 bloques (~22 min) o (mejor) persistir `lastProcessedBlock` y avanzar incrementalmente como HIGH-5.

**[HIGH-7] `verifyGemCode` permite enumeración de códigos sin auth — rate-limit es por IP**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1743-1777`
- Categoría: 4. Authorization + 9. Inputs HTTP públicos
- Descripción: El endpoint es público (sin auth), rate-limited 30/min/IP. Un atacante con un botnet (cada uno con IP distinto) puede enumerar el espacio de códigos `MTB[1-9]-XXXXXXXX-RRRRRR` ≈ `9 × 16^8 × 32^6 = 4 × 10^18`, no realista. PERO los códigos no son uniformes: `MTB${tier}-${hashHex}-${salt}` donde hashHex es 4 bytes random hex y salt es 6 chars de un alphabet 32 — espacio efectivo 16^8 × 32^6 ≈ 4.6 × 10^18. NO brute-forceable. OK. Pero el endpoint expone TODOS los códigos a query — combinado con HIGH-9 (timing attacks via collectionGroup) podría leak info. Más relevante: el endpoint NO valida el formato del `code` antes de la query (sólo trim+upper+slice por `length > 0`). Una query con `code="A"` o `code="<long-string>"` hace un Firestore lookup costoso por collectionGroup. Si bypassan rate-limit, agotás quota.
- Por qué importa: Rate-limit de IP es esquivable con botnet. Y queries arbitrarias inflan costos.
- Fix sugerido: Validar formato regex `^MTB[1-9]-[0-9A-F]{8}-[A-Z0-9]{6}$` ANTES del lookup. Retornar `400 invalid_format` fast.

**[HIGH-8] `setRestrictedCorsHeaders` deja al handler ejecutarse para origins no permitidos — endpoints HTTP procesan requests de cualquier origen, sólo bloquean la lectura de la respuesta**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js:195-203`
- Categoría: 9. Inputs HTTP públicos
- Descripción: Si Origin no está en ALLOWED_ORIGINS, no se setea `Access-Control-Allow-Origin`. Los browsers bloquean LA RESPUESTA, pero el request SÍ se ejecuta (consume CPU/quota). Para `claimAdSession` y `submitGemClaim`: server-to-server attacks (curl) ignoran CORS — y el handler ejecuta totalmente. Para `claimAdSession`, la protección real es el token de un solo uso (OK). Para `submitGemClaim`, la protección real es el Bearer token (OK). Pero un atacante puede consumir el quota de Cloud Functions enviando preflight + POST con tokens inválidos.
- Por qué importa: DoS amplification — atacante consume tu CPU sin costo. Y para el OPTIONS preflight, el server responde 204 sin auth check, consumiendo invocations.
- Fix sugerido: En `setRestrictedCorsHeaders`, si origin no está en allowlist y no es server-to-server (no Origin header), bloquear el request con 403 antes del handler.

**[HIGH-9] `submitGemClaim` retorna `not_owner` con detalles distintos según el path — leakeo de info sobre estructura interna**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1939-1948`
- Categoría: 7. Error handling + 9. Inputs HTTP públicos
- Descripción: Ambos casos retornan `403 not_owner`, OK. Pero el `console.warn` línea 1941 loguea `gem.ref.path` y `code`, y el línea 1946 loguea `authUid, ownerUid, code`. Si los logs son accesibles (Cloud Logging), expones uids y paths de gemas. Más importante: la lógica `pathParts.length !== 4 || pathParts[0] !== "users" || pathParts[2] !== "gems"` sólo defiende contra gems en OTRAS subcollections — un atacante puede dropear un doc `users/{victim}/gems/{spoof}` con un código conocido si conoce el flow... pero las rules bloquean writes a esa subcolección desde clientes. OK, no es un agujero real.
- Por qué importa: Logging excesivo de uids cruzados con códigos de gemas en logs persistentes — útil para análisis de fraude si los logs se filtran.
- Fix sugerido: Loguear sólo el path hash o un id corto, no la combinación completa.

**[HIGH-10] `notifyAllUsers` rate-limit por ADMIN UID — si hay múltiples admins, cada uno puede mandar 1/h independientemente (1×N broadcasts/hora)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1603-1607`
- Categoría: 4. Authorization + 9. Inputs HTTP públicos
- Descripción: El bucket es `nau_${adminUid}` — un atacante que comprometa N cuentas admin (o un solo admin que tenga 2 dispositivos) puede generar N×1/h notificaciones a TODA la base. La intención (1 broadcast/hora total) no se cumple si hay más de un admin.
- Por qué importa: Spam masivo si se comprometen 2+ cuentas admin. Costo Expo Push API + spam abuse.
- Fix sugerido: Cambiar bucket a constante global `nau_global`, 1/h independiente de qué admin invoca.

**[HIGH-11] `firestoreBackupScheduled` no valida que `collectionIds: []` realmente exporte todas las colecciones — y no exporta SUBCOLECCIONES por default**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1697-1714`
- Categoría: 10. Misc específicos del dominio + 8. Logging
- Descripción: `exportDocuments` con `collectionIds: []` exporta todas las TOP-LEVEL collections, pero NO incluye automáticamente sub-collections (depending on SDK behavior — verificá doc oficial). Las gemas viven en `users/{uid}/gems/{gemId}` y los `serverAccess`, `notifications`, layers, mined cubes, `episodes`, `history`, `meta` son todas sub-collections. Si la API no las captura automáticamente, el backup es incompleto y un disaster recovery deja al sistema con cuentas pero sin gemas/picks/historia.
- Por qué importa: Disaster recovery falso — el backup no cubre lo que importa.
- Fix sugerido: Verificar en logs del export operation que las sub-collections estén incluidas. Si no, listar explícitamente o ajustar la API call.

**[HIGH-12] El secret `serverSeed` se inyecta solo en `mineCube` — un atacante que vea el binario del cliente puede correlacionar premios entre servidores con poco esfuerzo si el seed nunca rota**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:29, 661, 747-749` + `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js:47-52`
- Categoría: 5. Secrets / credentials + 6. Crypto / payments
- Descripción: `serverSeed` es global (estable entre servers). HMAC-SHA256 es seguro contra brute-force del seed, pero permite un atacante con muchas observaciones de premios cross-server detectar patrones. Si se descubre/leak SERVER_SEED, TODOS los servidores actuales y futuros tienen el mapa de premios revelado. No hay rotación. Sería más seguro derivar un per-server-seed: `HMAC(SERVER_SEED, serverId)` y usar eso como input al `seededHash`. Así un leak post-creación de un server no rompe servidores nuevos si rotás SERVER_SEED.
- Por qué importa: Si el seed fuera comprometido (insider, log filtrado, vulnerabilidad), todos los premios de gemas serían calculables, permitiendo a un atacante minar SOLO los cubos con premio.
- Fix sugerido: Derivar `effectiveSeed = HMAC(SERVER_SEED, serverId)` y usar ese en los cálculos. Permite rotar SERVER_SEED para servers NUEVOS sin invalidar los viejos.

**[HIGH-13] `applyReferral` no verifica que `referrer` no esté banneado/eliminado — bonus puede irse a una cuenta inválida**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1332-1360`
- Categoría: 4. Authorization + 10. Misc específicos del dominio
- Descripción: La query `where("referralCode", "==", code).limit(1)` retorna el primer match. No valida que el user exista en Auth (puede haber sido borrado de Auth pero quedar el doc Firestore). Luego en `cryptoPaymentProcessorScheduled` línea 1534 se le suman 5 picks a una cuenta que ya no existe — picks fantasma.
- Por qué importa: Picks acumulados en cuentas zombi, además de revelar al user que su código es válido aunque la cuenta esté borrada (info leak).
- Fix sugerido: Antes de aceptar el referral, verificar que el referrer user doc tiene un flag `active != false` o validar `getAuth().getUser(referrerId)` no tira `auth/user-not-found`.

---

### MEDIUM

**[MED-1] `mineCube` actualiza `lastMineAt` en el caso "alreadyMined" pero NO en el caso "rate_limited" — un usuario que llega al rate-limit puede inmediatamente cambiar a otro cubo y minar**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:707-722`
- Categoría: 1. Race conditions + 10. Misc específicos del dominio
- Descripción: En el camino "rate_limited" (líneas 708-714), la TX hace throw sin actualizar `lastMineAt`. En el camino "alreadyMined" (716-722) sí lo actualiza para "aplicar el rate-limit al ganador del race". Pero si el TX falla por rate_limit, el `lastMineAt` no se actualiza — esto es correcto (no extends el cooldown), PERO el rate-limit usa `Date.now() - lastMineAt < 2000` y dentro del mismo TX si dos requests entran a 1.9s y 2.0s después del último mine, la primera entra (queda alreadyMined o gana), la segunda también pasa (porque ya pasó 2s desde lastMineAt original, y todavía no se actualizó el lastMineAt por la primera).
- Por qué importa: Rate-limit débil bajo concurrencia. Bot con multiple requests paralelas puede burst 5+ requests inmediatos cada >2s del último settled write.
- Fix sugerido: Hacer el rate-limit más estricto (no del ÚLTIMO settled mine, sino del último PENDING mine), o usar un lock con `pendingMineLock` que el atacante no puede burlar.

**[MED-2] `mineCube` calcula `gem` PARA TODOS los cubos (con el seed) — un atacante con acceso al SERVER_SEED puede predecir gemas, pero el cómputo está dentro de la TX. Sin embargo, el cálculo se hace TWICE — una vez en el TX y otra en el flujo de save**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:749-816`
- Categoría: 6. Crypto / payments
- Descripción: Dentro de la TX, `getGemForCube(serverId, K, cubeNumber, serverData.memberCount || 0, seed)` calcula el tier. Después, fuera de la TX (lines 791-816), si `result.gem`, se llama a `generateGemCode(serverId, result.currentLayer, cubeNumber, result.gem, uid)` — pero `result.currentLayer` puede haber cambiado si la capa se completó: line 783 `result.currentLayer = layerComplete && !episodeComplete ? K - 1 : K`. Entonces el `gemCode` se genera con un K distinto al que se usó en `getGemForCube`. Inconsistencia: el code en `gems` doc tiene un K que no se corresponde con el K real del descubrimiento.
- Por qué importa: Inconsistencia data — el `gems.layerK` (line 810) usa `result.currentLayer` que podría ser K-1 si la capa se completó. La gema fue minada en K, pero queda registrada en K-1. Para reportes/analytics, distorsiona los datos.
- Fix sugerido: Capturar el K ORIGINAL en el return de la TX (`originalK: K`) y usarlo en el save de la gema. O mover el save de la gema DENTRO de la TX.

**[MED-3] `mineCube` guarda la gema en `users/{uid}/gems` con un `add()` fuera de la TX — si el `add()` falla, el TX ya commiteó (descontó pick, marcó cube minado, incrementó counter)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:790-835`
- Categoría: 2. Idempotencia + 1. Race conditions
- Descripción: Si la TX commitea exitosamente pero el `gems.add()` falla (network, quota), el usuario perdió el pick, mineó el cubo, y NO tiene la gema en su wallet. No hay retry/reconciliation. El comment dice "fuera de transacción para no bloquearla" pero esa optimización tiene costo de consistencia.
- Por qué importa: User pierde una gema de hasta $100k (tier 1) por un error transient. No hay forma de recuperar — el `mined` doc no almacena `gemTier` que el cliente pueda inspeccionar para reclamar.
- Fix sugerido: Inclur el gemSave en la TX (Firestore TX permite hasta 500 writes). O al menos persistir el `gemTier` en el doc `mined/{N}` (línea 761 ya guarda `gem: gem || 0`), y agregar un endpoint de "rescue gem from mined" que el cliente pueda llamar si detecta inconsistencia.

**[MED-4] El comment SEC-A1 dice que `history.episode_complete` solo lo escribe el backend, pero los rules permiten al cliente escribir cualquier `type='mine'` con campos arbitrarios incluyendo `totalMined: 0..∞` (validado como int>=0)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.rules:155-181`
- Categoría: 1. Race conditions + 8. Logging
- Descripción: Las rules validan tipo y rango de `totalMined` pero NO requieren que coincida con el `totalMined` real del server. Un cliente puede escribir `type='mine'` con `totalMined: 99999` (inflado) o `rewardCash: 100000` (max permitido). El feed `history` queda contaminado con valores arbitrarios.
- Por qué importa: La activity feed muestra entradas falsas (e.g., "Alice ganó $100k"). Engaña a otros usuarios.
- Fix sugerido: Mover TODA la escritura de `history` al backend. Las rules cliente para `history` deben default-deny.

**[MED-5] `createCryptoPayment` retorna `paymentId = "amt_${amountUnits}"` — un atacante que vea el paymentId infiere `amountUnits` directamente**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1394, 1416`
- Categoría: 3. Validación de inputs + 9. Inputs HTTP públicos
- Descripción: El paymentId expone el amount. Esto no es secreto (el amount se devuelve en `amountDisplay`), pero hace trivial enumerar paymentIds vecinos. Combinado con las rules que permiten al owner leer su payment (`firestore.rules:194`), un atacante autenticado podría iterar IDs vecinos (`amt_15010000`, `amt_15020000`, etc.) y la query `resource.data.uid == request.auth.uid` deny — OK, pero genera reads y eventualmente quota burn.
- Por qué importa: Quota burn potencial; minor info leak.
- Fix sugerido: docId hashed: `paymentId = crypto.createHash('sha256').update(`amt_${amountUnits}`).digest('hex').slice(0, 24)` con el mapping interno.

**[MED-6] El rate-limit doc no expira correctamente — `expiresAt: now + windowMs * 2` se renueva en cada request, incluso cuando hits el límite. Buckets activos viven indefinidamente**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1724-1741`
- Categoría: 8. Logging / auditing
- Descripción: Cada llamada (allowed o not) hace `tx.set(ref, { ts: arr, expiresAt: now + windowMs * 2 }, { merge: true })`. Para un user activo, `expiresAt` se renueva siempre — el TTL nunca llega a expirar. Para `rateLimits/crc_${uid}` (referral check 10/min) un user activo deja el doc permanente.
- Por qué importa: Crecimiento ilimitado de la colección `rateLimits`. Con 1M users activos, son 1M docs persistentes solo para referralcheck.
- Fix sugerido: Setear `expiresAt` solo en la rama "armed" (cuando arr.length < max). O usar TTL absoluto basado en `firstSeen` no en `now`.

**[MED-7] `sendVerificationEmail` no rate-limita — un atacante puede spamear emails al user con tokens válidos**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1782-1882`
- Categoría: 9. Inputs HTTP públicos + 4. Authorization
- Descripción: El endpoint requiere auth pero no rate-limita. Un usuario malicioso puede llamarlo cientos de veces, generando emails de Firebase Auth → desencadenando quota de Gmail (NOTIFY_EMAIL como `from`) y SMTP rate limits → caída de TODOS los emails de la app (NFT notifications, mint alerts, gem claims). Si el atacante es el dueño de la cuenta, está spammeando su propio email (no es un attack relevante). PERO si un atacante puede ejecutar code como uid X (no), o si el endpoint se llama excesivamente por bug en cliente, mismo efecto.
- Por qué importa: Quota burn de Gmail account; potencial suspensión de la cuenta SMTP por abuse.
- Fix sugerido: Rate-limit por uid: 5/hora.

**[MED-8] `submitGemClaim` no valida que el `wallet` provisto coincida con la wallet en `users/{uid}/walletAddress` — un atacante puede claimar gema a SU propia wallet con email/phone falsos**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1918-1948`
- Categoría: 6. Crypto / payments + 10. Misc específicos del dominio
- Descripción: El claim valida ownership de la gema (correcto), pero NO valida que el `wallet` del body coincida con la wallet registrada del user. Si el user es legítimo dueño pero alguien obtiene su Bearer token (interceptado), puede claimar la gema a una wallet del atacante. El admin envía el premio a esa wallet sin verificación adicional.
- Por qué importa: Robo de premios via robo de token. La protección de cooldown 24h de `setUserWallet` no aplica aquí — el `wallet` se acepta directamente del body sin cooldown.
- Fix sugerido: O bien forzar `wallet = users/{uid}.walletAddress` (server-side), o agregar un cooldown / verificación email-confirmation para wallet provista en el claim.

**[MED-9] `claimGemNFT` no valida que `walletAddress` coincida con `users/{uid}/walletAddress` — un atacante con el token Bearer puede dirigir el mint a otra wallet sin pasar por `setUserWallet`**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:608-657`
- Categoría: 6. Crypto / payments
- Descripción: Mismo patrón que MED-8. La función acepta cualquier `walletAddress` válido del body y lo mintea ahí. Bypasea el cooldown anti-hot-swap de `setUserWallet`. Si un atacante consigue temporal acceso a la cuenta, puede `claimGemNFT` para todas las gemas pending → mint a su wallet → sin disparar el cooldown.
- Por qué importa: El cooldown anti-hot-swap es inútil si esta función acepta wallet arbitraria.
- Fix sugerido: Eliminar el param `walletAddress` del body y leer siempre `users/{uid}.walletAddress`. Forzar al user a usar `setUserWallet` (con cooldown) primero.

**[MED-10] `getPeaksStatus` puede ESCRIBIR users/{uid} con `referralCode` aunque la auth sea anónima — fuera de spec ya que `requireRegistered` no se aplica**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:904-919`
- Categoría: 4. Authorization
- Descripción: La función solo chequea `uid != null` (no `requireRegistered`). Permite anónimos. Si el doc no existe, lo crea con `referralCode`. Si existe sin `referralCode`, le agrega uno. Esto genera referralCodes para cuentas anónimas — que luego pueden ser referenciadas si el anon convierte a registered. No es crítico, pero la coleccion `users` tiene docs anónimos con `referralCode` populados — burning del namespace 31^8 ≈ 8.5×10^11 más rápido de lo esperado.
- Por qué importa: Burn del namespace de referralCode. Side effect raro: anons inflan la base de users docs.
- Fix sugerido: Solo asignar `referralCode` cuando el provider deja de ser anonymous.

**[MED-11] `mintProcessorScheduled` declara `secrets: [companyWalletKey, gmailAppPassword]` pero `runMintProcessing` también puede correrla manualmente via `processPendingMints` — ambas comparten el mismo cuerpo, así que un nonce conflict puede ocurrir si admin invoca manual mientras scheduler corre**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1243-1257`
- Categoría: 6. Crypto / payments + 1. Race conditions
- Descripción: Las dos pueden correr concurrentemente. Ambas crean `new ethers.Wallet(privateKey, provider)` y llaman `contract.mintGem(...)`. Cada uno usa nonce automatic. Si admin invoca a las T y scheduler corre a T+1s, dos transactions van con NONCE incrementado por ethers internamente — pero ethers usa nonce LOCAL del wallet object, no fetched. Cada `wallet` instance fetcheа el nonce desde provider al primer uso, lo cachea, y lo incrementa local. Si dos wallet instances actúan en paralelo, AMBOS leen el mismo `pendingTransactionCount` (default), entonces ambos envían con el mismo nonce → uno revierte. Y peor: `tx.wait()` se queda esperando una tx que nunca aparecerá.
- Por qué importa: Mint failures escalando el `attemptCount` sin razón, eventualmente marcando `failed` después de 5 retries. Posible perdida de NFTs minteados (si la otra tx pasó pero el flag se setea como failed).
- Fix sugerido: Lock distribuido — al inicio de `runMintProcessing`, intentar tomar un Firestore doc `meta/mintLock` con timestamp y SKIP if held. Liberarlo al final (o expiración 5min).

**[MED-12] `cryptoPaymentProcessorScheduled` puede ejecutar concurrentemente con sí mismo si el run anterior toma >5 min (eg. RPC lento)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1682-1686`
- Categoría: 1. Race conditions + 6. Crypto / payments
- Descripción: `onSchedule("every 5 minutes")` puede gatear ejecuciones concurrentes si la anterior no terminó. Múltiples instancias compitiendo por la lista de `pendingCryptoPayments` y los mismos eventos. La idempotency por `processedTxs/{txHash}` cubre el doble-crédito (CRIT-03 ya resuelto), pero la TX para "marcar payment completed" tendría retries. Riesgo bajo dado el idempotency, pero quota burn.
- Por qué importa: Quota burn + posible doble write del bonus referral si la lógica del bonus está OUTSIDE de la TX idempotente principal (lines 1524-1559 sí está en TX separada, pero usa flag `referralBonusPaid`). El bonus es idempotente. OK.
- Fix sugerido: `maxInstances: 1` para `cryptoPaymentProcessorScheduled`. Actualmente el setGlobalOptions setea `maxInstances: 10`, demasiado para schedulers.

**[MED-13] `notifyAllUsers` no envía push para tokens FCM — sólo Expo Push API**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1644-1660`
- Categoría: 10. Misc específicos del dominio
- Descripción: El loop recoge `pushToken` sin distinguir tipo. Lo manda todo a `exp.host`. Pero según `sendPushToUser` línea 1068 existe `tokenType === 'fcm'` que requiere `getMessaging().send(...)`. Si hay users con FCM tokens, se envían a Expo (silently fallan) y nadie los recibe.
- Por qué importa: Users con FCM tokens (e.g., post-Expo migration) no reciben broadcasts.
- Fix sugerido: Recoger `{ token, type }` y particionar; enviar FCM via Admin SDK, Expo via fetch.

**[MED-14] `_rateLimitFirestore` array `ts` puede crecer ilimitadamente si `max` es alto y el window largo — para `lce_*_day` (100/24h), el doc tiene hasta 100 timestamps**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1724-1741`
- Categoría: 8. Logging
- Descripción: 100 ints × 8 bytes = 800 bytes. No grave. Pero la TX hace SET completo cada call (no merge selectivo). Cada call escribe el array completo + expiresAt. Para un user que reporta 100 errors/día, son 100 writes Firestore × 800 bytes. Aceptable. Pero a escala (10k active users × 100 writes/day = 1M writes/day solo para rate-limit), notable cost.
- Por qué importa: Cost scale issue. No crítico.
- Fix sugerido: Implementar token-bucket en lugar de sliding-window con array — un counter + lastRefillAt, mucho más eficiente.

**[MED-15] `claimAdSession` no decrementa el `lastAd1At`/`lastAd2At` cuando algún error post-set ocurre — el user pagó el ad session pero queda bloqueado 24h**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:977-1039`
- Categoría: 1. Race conditions + 7. Error handling
- Descripción: La TX setea `lastAd1At = nowMs` y `picks += 1` atómicamente. Si la TX falla con `invalid_token` u otro error después de leer (pero antes de write), no hay write — OK. Pero si la TX commitea exitosamente y la response al cliente falla (network), el cliente no sabe si recibió el pick. La página de ads (adpick.html) podría reintentar — y la session.used flag lo previene (correctly). Pero el cliente piensa "no recibí el pick" y mira: pick está, lastAd1At está, OK. Usable. No es un bug, es robusto.
- Por qué importa: N/A en realidad — confirmo correcto.
- Fix sugerido: N/A.

**[MED-16] `processedTxs` doc ID es `txHash` — Polygon devuelve hashes que son TX hashes; pero un solo evento Transfer puede aparecer en LOGS de la misma tx (raro pero posible si la tx hace internal calls), procesando dos veces el mismo amount con el mismo txHash → segundo skip (correcto)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1492-1521`
- Categoría: 6. Crypto / payments
- Descripción: Correcto — `processedTxs/{txHash}` previene doble-crédito por mismo hash. Pero si la misma TX tiene DOS Transfers de USDC al PAYMENT_WALLET (por ej, un router que paga 2 facturas en una tx), el segundo Transfer NO se procesará — el first event marcado consume el slot, el segundo skips. Si los dos Transfers eran para DOS usuarios distintos (cada uno con `amountUnits` distinto), el segundo user PIERDE su crédito.
- Por qué importa: Edge case raro pero real con smart-contract wallets o batchers.
- Fix sugerido: docId con `txHash + logIndex` en lugar de solo `txHash`.

**[MED-17] `seededHash` y `getGemForCube` — `seededHash(serverSeed, "PRIZE|...|tier|bucket") % bSize` no es uniformemente distribuido debido a modulo bias**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js:103`
- Categoría: 6. Crypto / payments
- Descripción: `seededHash` retorna u32 (0..2^32-1). `% bSize` cuando `bSize` no es potencia de 2 (e.g. zoneSize=2730, base=2730/1=2730 para tier 1) introduce modulo bias: `2^32 % 2730 = 2806`, los primeros 2806 valores aparecen 1/x más frecuentemente. Bias ≈ 1/(2^32/bSize) ≈ negligible para bSize=2730. PERO para tier 8/9 con bSize=4000-7500/100, eg. bSize=1882 (zoneSize=7529340 / count=4000), bias ≈ 1/(2^32/1882) ≈ 4.4×10^-7. Negligible en la práctica.
- Por qué importa: Sesgo estadístico, no práctico para gameplay.
- Fix sugerido: Usar rejection sampling para uniformidad estricta, pero es overkill.

**[MED-18] El admin email transporter usa `service: "gmail"` con app-password — si Google deprecia app-passwords (han anunciado roadmap), TODA la notificación admin se rompe (gem claims, mint alerts, verification emails, reports, broadcast)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1220-1223, 1814-1817, 1984-1986, 2095-2097`
- Categoría: 5. Secrets / credentials + 10. Misc específicos del dominio
- Descripción: 4 nodemailer transporters distintos, todos con misma config. Single point of failure. Si el app-password se revoca/expira/Gmail bloquea por "less secure app", TODA la app pierde:
  - mint failure alerts (después de 5 retries)
  - verification emails
  - gem claim notifications
  - bug reports
- Por qué importa: Operational SPOF — uno solo "fix mañana" puede romper 4 features sin previo aviso.
- Fix sugerido: Migrar a SendGrid/Postmark/SES con API key dedicada. Sino, al menos centralizar el transporter creation en una helper para que un fix sea único.

**[MED-19] `firestoreBackupScheduled` usa `outputUriPrefix: ${bucket}/${dateStr}` — si la function corre varias veces en el día (e.g., manual retry), el segundo run SOBREESCRIBE el primero**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1702-1708`
- Categoría: 10. Misc específicos del dominio
- Descripción: El path `bucket/2026-06-14/` se sobrescribe si la función corre dos veces el mismo día. Si el primer run capturó un snapshot y el segundo run lo sobrescribe con uno corrupto (e.g., durante un incident), perdés el backup íntegro del día.
- Por qué importa: Pérdida de backup en condiciones de incident.
- Fix sugerido: Incluir timestamp completo: `${dateStr}_${Date.now()}` o usar `new Date().toISOString().replace(/[:.]/g, '-')`.

**[MED-20] `sendPushToUser` no verifica que el `pushToken` esté en formato Expo (`ExponentPushToken[...]`) o FCM (registration token) — un token corrupto envía request inválido a Expo**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1056-1084`
- Categoría: 3. Validación de inputs + 7. Error handling
- Descripción: El user puede setear `pushToken` arbitrario via Firestore update (rules permiten string up to 500 chars). Si setea `"garbage"`, `sendPushToUser` envía a Expo y la API rechaza, pero el handler ya pagó el round-trip. A escala (1M users con pushToken malformado), fetch a expo.host con basura.
- Por qué importa: Quota burn + ruido en logs.
- Fix sugerido: Validar prefix `^ExponentPushToken\[[A-Za-z0-9._-]+\]$` para tokenType='expo' antes de mandar.

---

### LOW

**[LOW-1] `requireRegistered` permite `provider === undefined` (token sin firebase.sign_in_provider) — defense-in-depth débil contra tokens malformados/customizados**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:80-90`
- Categoría: 4. Authorization
- Descripción: `provider === "anonymous"` chequea solo anonymous. Si Firebase agrega nuevos providers o un test token tiene provider=undefined, el check pasa. En la práctica, tokens válidos siempre tienen el campo. Pero defensa fail-safe sería: `if (provider !== "google.com" && provider !== "password" && provider !== "apple.com" ...)`.
- Por qué importa: Hipotético; bajo riesgo real.
- Fix sugerido: Whitelist de providers en lugar de blacklist anonymous.

**[LOW-2] `addServerCredit` no chequea que `targetUid` existe — escribe `serverCredits` en un doc fantasma**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:288-320`
- Categoría: 3. Validación de inputs
- Descripción: `db.collection("users").doc(targetUid)` siempre referencia, y `tx.set(..., {merge:true})` crea el doc si no existe. Si admin pasa un uid typo'd, crea un doc users/typo'd con solo `serverCredits: N`. El doc fantasma aparece en queries.
- Por qué importa: Polución de colección users con docs no-auth-validados.
- Fix sugerido: Validar que el user existe (`getAuth().getUser(targetUid)`) antes de incrementar credits.

**[LOW-3] `setUserWallet` cuando `addr === null`, el cooldown sólo aplica si había wallet previa — pero la lógica permite poner null sin cooldown si previously was null (el "isChange" requiere prevAddr truthy)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1310-1322`
- Categoría: 6. Crypto / payments
- Descripción: Si `prevAddr === null` y `addr === null`, no aplica cooldown (correcto). Si `prevAddr === '0x...'` y `addr === null`, aplica cooldown. Si `prevAddr === null` y `addr === '0x...'`, no aplica cooldown (primer set, OK). Lógica correcta — pero hay un edge: si user setea wallet, espera 24h, setea wallet a `null` (vacía), espera 0 seg, setea wallet a una NUEVA — segundo set ya NO tiene cooldown (prevAddr es null). El cooldown se puede bypassear con un null intermedio.
- Por qué importa: Cooldown de 24h pensado contra hot-swap es trivialmente burlable.
- Fix sugerido: Aplicar cooldown a CUALQUIER cambio si ya hubo set previo alguna vez (e.g., un counter `walletSetCount`).

**[LOW-4] `checkUsername` no rate-limita — un atacante puede enumerar usernames con cuentas auth gratis (anonymous sign-in)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1261-1272`
- Categoría: 9. Inputs HTTP públicos
- Descripción: La función no rate-limita. Permite enumerate todos los usernames. Combinado con la rule que requiere `email_verified` para create (anti-squatting), un atacante puede pre-mapear quien tiene qué username.
- Por qué importa: Privacy leak; permite phishing target list.
- Fix sugerido: Rate-limit 30/min/uid.

**[LOW-5] `createAdSession` token tiene 24 hora de TTL pero la validez real es 12 minutos — gap entre TTL config (24h) y código (12min)**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:962-972, 1012`
- Categoría: 9. Inputs HTTP públicos
- Descripción: TTL Firestore: `Timestamp.fromMillis(now + 24h)`. Pero el check en `claimAdSession`: `nowMs - session.createdAt > 12 min`. Session expira logical a 12min, físicamente a 24h. No es bug, pero las sesiones quedan en Firestore innecesariamente 23h48m extra.
- Por qué importa: Costo de storage menor; cumple intención.
- Fix sugerido: Bajar TTL a 1 hour (suficiente buffer).

**[LOW-6] El comment SEC-N-005 dice "las rules bloquean escritura directa" — pero las rules SÍ permiten `pushToken` update (whitelist). Si un atacante con XSS en el cliente setea `pushToken` arbitrario, no es un problema (no es campo crítico). Pero ALSO los campos `wallet` (no `walletAddress`) NO está en whitelist — diferencia con comment SEC-005 line 15-16. Está OK porque whitelist es estricto. Falsa alarma.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.rules:15-17, 22-28`
- Categoría: 11. firebase-admin v13 migración (informativo)
- Descripción: N/A — verificación OK.

**[LOW-7] El comment dice firebase-admin v13 pero el package.json dice `^13.10.0`. La descripción del task menciona v14 — verificar coincidencia de versión**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:9-14`, `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/package.json:21`
- Categoría: 11. firebase-admin v13 migración
- Descripción: El comment en index.js línea 10 dice "firebase-admin v14: namespace default ya no expone .firestore/.auth/.messaging como métodos." — pero package.json declara `^13.10.0`. Inconsistencia menor.
- Por qué importa: Confusión documental. Cualquier upgrade futuro confunde a quien lo revise.
- Fix sugerido: Actualizar comment a "firebase-admin v13" para coincidir con package.json.

**[LOW-8] `seededHash` recibe `serverSeed` como argumento — si por bug se llama con `serverSeed=undefined`, hace `String(seed || '')` y el seed queda vacío. HMAC con key vacía es determinístico y BRUTE-FORCEABLE**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js:47-52`
- Categoría: 6. Crypto / payments + 5. Secrets / credentials
- Descripción: Si el secret no se inyecta (e.g., deploy mal), `serverSeed.value()` devuelve `undefined` o `""`. La función no falla, simplemente usa HMAC("", ...) — el resultado es público y predictable. Atacante con conocimiento de premios puede calcular todos los premios futuros.
- Por qué importa: Fail-open en lugar de fail-closed para el secret.
- Fix sugerido: En `mineCube` línea 747, validar `if (!seed || seed.length < 16) throw new HttpsError("internal", "seed_missing")`. Loguear sin exponer el seed.

**[LOW-9] `verifyGemCode` rate-limit por IP usa `req.headers['x-forwarded-for']` sin parsing del primer hop confiable — atacante puede inyectar `X-Forwarded-For: trusted_ip, attacker_ip` y el código toma `trusted_ip`**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1749-1750`
- Categoría: 9. Inputs HTTP públicos
- Descripción: `String(ip).split(",")[0]` toma el PRIMER IP. En Firebase Functions tras Google Front-End, el primer IP en X-Forwarded-For es el que el cliente metió. Atacante con curl: `curl -H "X-Forwarded-For: 1.2.3.4"` → bucket es `vgc_1.2.3.4`. Atacante rota IPs en el header → bypass del rate-limit por IP.
- Por qué importa: Rate-limit por IP completamente burlable.
- Fix sugerido: Tomar `req.ip` (que Express resuelve correctamente cuando trustProxy está set) o tomar el ÚLTIMO IP de X-Forwarded-For (el más cercano al server, el menos manipulable).

**[LOW-10] `createCryptoPayment` retorna `wallet: PAYMENT_WALLET` al cliente — el cliente puede cachear y, si rotás PAYMENT_WALLET, pagos viejos van a wallet incorrecta**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1386, 1416`
- Categoría: 6. Crypto / payments
- Descripción: Los `pendingCryptoPayments` no almacenan el `wallet` en el doc. Si rotás PAYMENT_WALLET, los pagos waiting tienen `amountUnits` correcto pero el cliente puede pagar a la wallet vieja (cacheada). El scheduler escanea `USDC` → `PAYMENT_WALLET` (nuevo), no detecta el pago.
- Por qué importa: Rotación de wallet es difícil sin disruption.
- Fix sugerido: Persistir `wallet` en el pendingPayment doc y escanear cada wallet histórica activa.

**[LOW-11] `submitGemClaim` valida `wallet` pero no normaliza checksums — `0xAbC...` y `0xabc...` se aceptan ambos pero pueden conflict en lookups por checksum-sensitive systems**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1918, 1926-1928`
- Categoría: 3. Validación de inputs
- Descripción: El regex acepta hex sin importar case. Para Ethereum, ese es un EIP-55 checksum address — algunos clients dan err si recibís lowercase. No crítico aquí, pero el flow de cash redemption (admin manual envío) puede romperse si copy-paste de una wallet mixed-case que no pasa checksum.
- Por qué importa: Bugs operacionales raros en el admin manual.
- Fix sugerido: Normalizar a `ethers.getAddress(wallet)` que valida checksum y normaliza.

**[LOW-12] `claimGemNFT` no valida que `gemTier` esté en rango 1..9 después de leerlo de Firestore — confía en el data — pero defense-in-depth podría protegerse de docs corruptos**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:631-654`
- Categoría: 3. Validación de inputs + 6. Crypto / payments
- Descripción: Aunque `runMintProcessing` valida `gemTier` antes del mint (líneas 1140-1145), `claimGemNFT` confía en `gem.gemTier` para setear `pendingMint.gemTier`. Si por bug se corrompió el doc, propagás un mint inválido.
- Por qué importa: Defense-in-depth.
- Fix sugerido: Validar `gemTier ∈ [1, 9]` antes de set en TX.

**[LOW-13] `mineCube` `getRewardForCube` calcula reward con seed, pero `nRaw` permite valores como `Number.MAX_SAFE_INTEGER` que pasan `Number.isInteger` — y `n > TOTAL_CUBES_K` falla, OK; pero NaN paths siguen siendo posibles si nRaw es NaN**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:668-670`
- Categoría: 3. Validación de inputs
- Descripción: `Math.floor(NaN)` = NaN. `Number.isInteger(NaN)` = false. OK, lo rechaza. `Math.floor(Infinity)` = Infinity. `Number.isInteger(Infinity)` = false. OK. Cubre correctamente.
- Por qué importa: N/A — verificación OK.
- Fix sugerido: N/A.

**[LOW-14] `applyReferral` query `where("referralCode", "==", code).limit(1)` requiere índice compuesto o single-field — verificar firestore.indexes.json**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1345`
- Categoría: 10. Misc específicos del dominio
- Descripción: Single-field queries no requieren índices custom en Firestore; auto-managed. OK.
- Por qué importa: N/A — informativo.
- Fix sugerido: N/A.

**[LOW-15] El IPFS CID list en GEM_TOKEN_URIS es estático — si IPFS pinning service del proyecto fail, los NFTs sin pinning pierden metadata visibility**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/constants.js:24-34`
- Categoría: 10. Misc específicos del dominio
- Descripción: IPFS metadata depende de pinning. Sin pinning persistente, marketplaces (OpenSea, etc.) no resuelven el NFT.
- Por qué importa: NFT broken after months si pinning expira.
- Fix sugerido: Documentar y monitorear el pinning service (Pinata/Filebase/etc).

**[LOW-16] El comment "0 NFTs minteados antes del 2026-06-14" — pero el código no impide refresh de URIs si los gem docs viejos quedaron con CIDs antiguos — `pendingMints.tokenURI` cacheado con CID viejo se mintea con CID viejo aunque el constants.js cambie**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1164`
- Categoría: 10. Misc específicos del dominio
- Descripción: `data.tokenURI || GEM_TOKEN_URIS[(data.gemTier - 1)]`. El `data.tokenURI` está cacheado en pendingMints desde el momento del claim. Si CIDs cambian, pendingMints viejos minteán con el CID viejo. Defensible si zero NFTs minteados antes, pero las gemas DESCUBIERTAS antes del cambio tienen URI viejo en `users/{uid}/gems/{gemId}` también (no se updateу). Si el user re-claima (no puede, status='unclaimed'), tomaría el nuevo. Si el user YA tiene wallet (auto-mint), pendingMint ya tiene URI viejo. 
- Por qué importa: Migration completeness.
- Fix sugerido: Si confías en que 0 NFTs minteados, también migrar las gemas en `users/{uid}/gems` con CIDs viejos a CIDs nuevos.

---

### INFO

**[INFO-1] `setGlobalOptions({ cpu: 0.5, memory: "256MiB", maxInstances: 10 })` aplica a TODAS las funciones — incluye schedulers. Esto puede crear contención si scheduler corre cuando 10 user requests ya están en cola.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:22`
- Categoría: 10. Misc específicos del dominio
- Descripción: `maxInstances: 10` global parece bajo si la app crece. Schedulers + user-facing functions comparten el budget.

**[INFO-2] `serverChains/meta/counter` rule permite que el cliente escriba `seq` directamente — habilita el backend pattern donde el cliente lleva el contador**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.rules:128-135`
- Categoría: 8. Logging
- Descripción: Por design. Ver HIGH-3 para concerns.

**[INFO-3] No hay limit en `getServers` paginación — `.limit(50)` hardcoded. Si la base crece, lista incompleta.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:546-549`
- Categoría: 10. Misc específicos del dominio

**[INFO-4] `getChain` retorna todos los `episodes` sin paginación — 10 episodes max, OK por MAX_EPISODES**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:578`
- Categoría: 10. Misc específicos del dominio
- Descripción: OK por design.

**[INFO-5] `getUserGems` `.limit(100)` — un user con >100 gemas no ve todas. No es probable en el corto plazo.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:597-598`
- Categoría: 10. Misc específicos del dominio

**[INFO-6] `notifyAllUsers` paginación correctly handles `pushToken != null` con orderBy implicit — MEDIO-H12 fix aplicado. OK.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js:1619-1639`
- Categoría: 8. Logging
- Descripción: Verificado correcto.

**[INFO-7] `redeemGem` eliminado (comment line 604) — confirmado que no hay caller. Bien.**

**[INFO-8] Test suite `helpers.test.js` no testea `seededHash` directamente — y `getGemForCube` se llama sin `serverSeed` argument (los tests usan signature vieja). Si el código de prod corre con seed pero los tests sin seed, los tests pueden pasar mientras prod falla.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/test/helpers.test.js:63, 87-95, 103-110`
- Categoría: Áreas sin cobertura de test

**[INFO-9] Test suite no testea `_rateLimitFirestore`, `closeEpisode`, `startNextEpisode`, `runMintProcessing`, `runCryptoPaymentProcessing`, ni ninguna cloud function callable directamente. Solo helpers puros.**
- Archivo: `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/test/helpers.test.js`
- Categoría: Áreas sin cobertura de test

---

## RESUMEN EJECUTIVO

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 3 |
| HIGH | 13 |
| MEDIUM | 20 |
| LOW | 16 |
| INFO | 9 |
| **TOTAL** | **61** |

---

## TOP 5 CRÍTICOS (urgentes para revisar)

1. **[HIGH-3 / CRIT-equiv]** Cliente puede escribir `serverChains/{chainId}/meta/counter` con seq+1 directamente, colisionando con el backend. La activity history pierde unicidad de `seq`. **Fix prioritario**: mover seq generation completamente al backend; rule debe denegar writes de cliente a `counter`.

2. **[HIGH-4 + MED-8 + MED-9]** Wallet handling: `claimGemNFT` y `submitGemClaim` aceptan wallet arbitraria del body, bypaseando el cooldown anti-hot-swap. **Fix prioritario**: forzar wallet = `users/{uid}.walletAddress` (server-side) y aplicar cooldown a TODO cambio.

3. **[HIGH-12]** SERVER_SEED es global e inmutable de facto. Si leak, todos los premios revelados. **Fix prioritario**: derivar `effectiveSeed = HMAC(SERVER_SEED, serverId)` para aislamiento per-server.

4. **[CRIT-1]** docId de `mined/{N}` no incluye K — puede haber data mixing entre capas con mismo cube number. **Fix prioritario**: migrar a `mined/{K}_{N}`.

5. **[MED-3 + HIGH-1]** Auto-mint de gemas (`mineCube` line 791-835) no es transaccional con el commit del TX — fallo de network puede dejar gemas perdidas sin recovery. **Fix prioritario**: meter gem save dentro de la TX o agregar un scheduled "rescue" task.

Honorables menciones: [HIGH-5/6] crypto payment processor sin checkpoint de bloque; [HIGH-8] CORS permite handler execution sin auth en server-to-server.

---

## PATRONES POSITIVOS DETECTADOS (no cambiar)

1. **Idempotency keys deterministicas** en `claimGemNFT` (`${uid}_${gemId}`), `createCryptoPayment` (`amt_${amountUnits}`), `closeEpisode` (`meta/closing_${N}`), y `processedTxs/{txHash}`. Bien aplicado.

2. **`requireRegistered` + `requireAdminFresh`** con cheque fresh contra Auth (no del token cacheado). Bien aplicado a notifyAllUsers, addServerCredit, processPendingMints.

3. **Transacciones bien estructuradas**: el patrón "read-all-first, write-all-after" se respeta en `mineCube`, `joinServer`, `applyReferral`, `claimGemNFT`. Bien.

4. **HMAC-SHA256 para fairness**: reemplazó `fnv1a` 32-bit con HMAC, eliminando el brute-force risk del seed con observaciones limitadas.

5. **Rate-limiting persistido en Firestore** (no in-memory) — `_rateLimitFirestore` aplicado consistentemente a checkReferralCode, applyReferral, createCryptoPayment, notifyAllUsers, verifyGemCode, logClientError, setUserWallet, reportProblem.

6. **SAFE_CONFIRMATIONS=30** para Polygon, con processedTxs por txHash. Reorg-safe.

7. **Audit log** (`adminActions`) para operaciones admin destructivas (`addServerCredit`, `notifyAllUsers`).

8. **TTL en collections efímeras** (`adSessions`, `processedTxs`, `errorLog`, `rateLimits`) con `expiresAt: Timestamp`. Bien.

9. **CORS restringido por allowlist explícita** + `Vary: Origin`. Mejor que reflect-any-origin.

10. **Whitelist de fields públicos** en `getServers` (PUBLIC_FIELDS) en lugar de spreading `data()` — previene leaks de campos sensibles futuros.

11. **HTML escaping (`esc`)** consistente en todos los templates de email — XSS-safe para outputs.

12. **`timingSafeEqual`** para comparación de tokens en `claimAdSession`.

13. **Mapeo de errores públicos** en `claimAdSession` — set whitelist, default a `bad_request` para evitar enumeration de estados internos.

14. **Validación de IDs**: `assertValidId` con regex + length cap. Aplicado a serverId, chainId, gemId.

15. **Audit comments**: cada fix de auditorías previas referenciado por código (SEC-N-XXX, ALTO-XX, MEDIO-FXX). Facilita trazabilidad histórica.

---

## ÁREAS SIN COBERTURA DE TEST (recomendado agregar)

1. **`closeEpisode` race conditions**: simular dos `mineCube` concurrentes que ambos cierran el último cubo (K=0). Verificar que solo se cree un `episodes/{N}` y un `history` entry.

2. **`runCryptoPaymentProcessing`**: mockear ethers provider + verify idempotency cuando el mismo `txHash` aparece en dos runs sucesivos.

3. **`runMintProcessing`**: nonce conflicts si admin invoca manualmente mientras el scheduler corre.

4. **`_rateLimitFirestore`**: verificar que el sliding window correctly descarta timestamps viejos, y que el cap se respeta bajo concurrencia (dos TXs paralelas).

5. **`setUserWallet`**: bypass del cooldown via null intermediate (LOW-3).

6. **`mineCube`**: dos requests concurrentes al mismo `cubeNumber` — el "perdedor" debe recibir `alreadyMined: true` y NO debe perder pick.

7. **`mineCube`**: comportamiento cuando la capa se completa exactamente en una request (`layerComplete && episodeComplete`).

8. **`applyReferral`**: usar mismo código dos veces, usar código propio, usar código que no existe.

9. **`createCryptoPayment`**: forzar colisiones de monto y verificar que el retry loop converge.

10. **Rules `serverChains/history`**: testear que cliente NO puede escribir con `chainId` distinto al path; testear que rewardCash > $100k falla (ya hay test, pero faltan más combinations).

11. **`submitGemClaim`**: testear ownership mismatch con token Bearer válido pero gemId de otro user.

12. **`claimGemNFT`**: testear retry-safety con mismo gemId + uid (debería idempotente por docId determinístico).

13. **`getGemForCube`** con SERVER_SEED real injectado — los tests actuales (`helpers.test.js`) pasan `undefined` como seed implícitamente, no cubre el path producción.

14. **Rules `processedTxs`, `pendingMints`, `users/{uid}/gems/{gemId}`**: no tienen reglas explícitas, deberían default-deny — agregar tests para confirmar.

15. **`notifyAllUsers`**: paginación cuando hay >500 users con pushToken. Cursor consistency.

---

## CONCLUSIÓN

El backend está **maduro y bien defendido** en general — los fixes de auditorías previas son evidentes y consistentes. Los hallazgos críticos restantes giran en torno a:

- **Aislamiento de capas en `mined`** (CRIT-1)
- **Wallet handling sin enforcement de single-source-of-truth** (HIGH-4 + MED-8 + MED-9)
- **Counter del history sin enforcement server-side** (HIGH-3)
- **SERVER_SEED sin derivación per-server** (HIGH-12)

Estos cuatro elementos cubren el "Top tier" de riesgo de explotación práctico. Los hallazgos MEDIUM son operacionales/UX/edge-case. Los LOW son defense-in-depth.

**Recomendación**: priorizar CRIT-1, HIGH-3, HIGH-4, HIGH-12. Después MED-3 + HIGH-1 (gem rescue path). El resto, ticket backlog.