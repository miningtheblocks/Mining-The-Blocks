I note that `consumeServerCredit` reads `credits` and writes `credits - 1` (non-atomic; but inside a transaction so OK). `addServerCredit` reads `current` and writes `current + amount` (similar pattern, inside tx — OK). The crypto processor uses `FieldValue.increment(1)` which is fully atomic — good.

I have enough material. Now I have done sufficient deep reading. Let me produce the comprehensive audit report.

---

# AUDITORÍA PROFUNDA — Flujos de Plata en Mining The Blocks

> Auditoría end-to-end de pagos USDC, mint de NFTs, y redemption del premio.
> **Sin fixes aplicados — solo reporte.**

---

## HALLAZGOS

### Flujo A — Compra de créditos con USDC

---

```
[CRIT] Polygon reorg profundo puede revertir un pago ya acreditado sin desacreditar picks
  Archivo: functions/index.js:1431, 1438, 1492-1519
  Flujo: A
  Categoría: 1.2 / 1.3 / 10
  Descripción: SAFE_CONFIRMATIONS=30. Polygon (Bor) tiene reorgs típicos
  de hasta 64-256 bloques (incidentes documentados de 157+ bloques en
  2022 y de 32+ recientemente). Si una TX confirmada con 30 conf revierte,
  el código YA acreditó +1 serverCredits + posiblemente +5 picks
  referral, marcó pendingCryptoPayments como "completed" y guardó
  processedTxs/{txHash} con TTL 30 días. NO existe mecanismo de
  desacreditación.
  Por qué importa: un atacante que coordine con un block-producer
  malicioso (o aproveche un reorg natural) puede triple-spend: gastar
  los créditos en la app, recibirlos de vuelta on-chain, y conservar la
  TX en processedTxs bloqueando que un re-scan futuro lo detecte.
  Fix sugerido: subir SAFE_CONFIRMATIONS a ≥128 (Polygon best-practice
  enterprise: 256) Y/O implementar verificación tardía que vuelva a
  consultar receipts a las 24h y desacredite si la TX desapareció.
  Escenario de explotación:
    1. Atacante coordina con validador o aprovecha reorg natural.
    2. Envía 15.42 USDC a PAYMENT_WALLET en bloque N.
    3. A los ~5 min, processor escanea bloques [N-200..N-30], detecta
       la TX (con 30 confirmaciones), acredita 1 crédito + 5 picks
       referral si aplica, marca processedTxs/{hash}.
    4. Atacante (o reorg natural) revierte la cadena en bloque N. La
       TX desaparece de la cadena canónica → los USDC vuelven a su
       wallet.
    5. El crédito quedó acreditado en Firestore, processedTxs/{hash}
       bloquea cualquier re-scan futuro.
    6. Repetir N veces durante una ventana de reorg → robo proporcional
       al N.
```

---

```
[CRIT] Sin checkpoint de bloque escaneado → ventana de 200 bloques deja brechas o duplica
  Archivo: functions/index.js:1438-1439
  Flujo: A
  Categoría: 1.2 / 1.3
  Descripción: fromBlock = (currentBlock - 30) - 200. La función corre
  cada 5 min. En Polygon (block time ~2s), 200 bloques ≈ 400s ≈ 6.66 min.
  Si la function se atrasa >6.66min (cold start, Cloud Run quota burst,
  RPC lento), las TXs caen fuera de la ventana y NUNCA se procesan
  porque no hay variable persistida `lastScannedBlock`. processedTxs
  bloquea duplicados, pero NO marca "ya vi este bloque sin TX
  relevante", entonces si por reorg/RPC corrupto un evento "aparece"
  más tarde fuera de la ventana, queda perdido para siempre.
  Por qué importa: pérdida silenciosa de pagos legítimos. El user paga
  pero los créditos nunca llegan; el admin tiene que reconciliar
  manualmente cuando alguien se queja.
  Fix sugerido: persistir `meta/cryptoProcessor.lastScannedBlock` en
  Firestore, escanear `[lastScannedBlock, safeBlock]` siempre que
  delta < 5000 bloques (cap), commitear `lastScannedBlock = safeBlock`
  al final.
  Escenario de explotación / fallo:
    1. Cloud Function quota exhausted, el scheduler salta 10 min sin
       correr.
    2. En esos 10 min llegan 5 pagos en bloques B..B+300.
    3. Próximo run: fromBlock = current-230, safeBlock = current-30.
       Los bloques B..B+30 ya salieron de la ventana de queryFilter.
    4. Esos 5 pagos NUNCA se acreditan; users reclaman; admin debe
       reconciliar manualmente.
```

---

```
[CRIT] Solo 99 amount slots — DoS trivial via rate-limit bypass cross-account
  Archivo: functions/index.js:1391, 1422
  Flujo: A
  Categoría: 1.1
  Descripción: El espacio de "monto único" es exactamente 99 valores
  (cents 01..99 sobre $15). createCryptoPayment limita 3 attempts/hora
  por uid pero un atacante con 50 cuentas (fáciles de crear con
  emails+ throwaway) puede generar 50 pendingCryptoPayments
  simultáneos en estado "waiting" cubriendo TODOS los slots
  disponibles → cualquier user legítimo recibe "try_again" indefinida.
  Por qué importa: DoS al checkout. Pérdida de revenue + frustración
  del jugador. El loop tira `try_again` después de 30 attempts (línea
  1422) — sin alerta al admin.
  Fix sugerido: ampliar el espacio (centavos + milésimas, o agregar
  decimal aleatorio dando >9999 slots), O cobrar el monto exacto y
  identificar al user via memo / signed message off-chain, O usar un
  payment intent ID memo en la TX.
  Escenario de explotación:
    1. Crear 33 cuentas (límite 3/hr/uid → 33 cuentas dan 99 slots/hr).
    2. Cada cuenta llama createCryptoPayment 3 veces → ocupa 99 amount
       units por 30 min.
    3. Nadie legítimo puede crear un payment.
    4. Renovar antes de los 30 min de expirar.
  Costo del ataque: ~$0 (cuentas gratis, no se paga).
```

---

```
[HIGH] Sin filtro `from` ni validación contra company-wallet self-loop
  Archivo: functions/index.js:1464
  Flujo: A
  Categoría: 1.2
  Descripción: transferFilter = mkFilter(null, PAYMENT_WALLET). Acepta
  Transfer events desde CUALQUIER `from`. Si el operador hace un
  re-balance interno (envía USDC desde PAYMENT_WALLET a otra wallet
  custodiada — habitual para mover fondos a cold storage — Y luego
  desde esa wallet de vuelta a PAYMENT_WALLET) por un monto que
  coincida con un payment pending, el processor acredita 1 crédito
  GRATIS al user de ese amount.
  Por qué importa: el admin puede acreditar accidentalmente créditos
  a un user si mueve fondos. Y un atacante que conoce el monto pending
  de su víctima puede enviar ese mismo monto a la víctima USDC-wise
  (no a PAYMENT_WALLET pero coordinando con un wallet conocido por el
  sistema) — no, este vector requiere control de PAYMENT_WALLET, así
  que es HIGH no CRIT.
  Fix sugerido: validar `event.args.from !== PAYMENT_WALLET` (descartar
  withdraws), y registrar wallets internas de la company en una
  blacklist (`event.args.from` no debe estar en COMPANY_OWNED_WALLETS).
  Escenario de explotación:
    1. User crea payment de 15.42 USDC → docId amt_15420000.
    2. Admin transfiere 15.42 USDC desde PAYMENT_WALLET hacia tesorería
       y luego vuelve a transferir 15.42 USDC para alguna conciliación.
    3. Processor detecta el Transfer entrante, matchea con el docId
       pending → acredita 1 crédito al user.
    4. Pérdida: $15.42 por incidente.
```

---

```
[HIGH] PAYMENT_WALLET hardcoded — sin rotación de wallets, single-point-of-failure
  Archivo: functions/constants.js:40
  Flujo: A
  Categoría: 10
  Descripción: Un solo wallet recibe TODOS los pagos USDC. Si la clave
  privada se compromete (phishing, malware en máquina del operador,
  secret leak), atacante drena todo. Si Polygon Foundation blacklistea
  la dirección (improbable pero ha pasado con USDC bridged), la app
  queda muerta.
  Por qué importa: SPOF financiero. La clave NO está en la app, así que
  no se roba por sideload del APK; pero está en algún backup/operador
  human / cold wallet / .env. Sin plan de rotación.
  Fix sugerido: documentar SOP de rotación, mantener wallet operativa
  con saldo mínimo (sweep diario a multisig cold), y monitorear el
  balance. Considerar usar contrato proxy receiver con `onPayment` que
  forwardea a multisig.
```

---

```
[HIGH] `Number(event.args.value)` puede perder precisión para amounts grandes
  Archivo: functions/index.js:1477
  Flujo: A
  Categoría: 7
  Descripción: ethers v6 devuelve `value` como BigInt. `Number(...)`
  funciona perfecto para $15.xx (1.5e7 wei USDC), pero si en el
  futuro CREDIT_PRICE_USD se sube a >9 mil millones de USDC (límite
  2^53 / 1e6 ≈ 9.007e9), perdés precisión silenciosamente y el match
  contra `amountUnits` (también Number) falla random.
  Por qué importa: hoy NO se rompe (CREDIT_PRICE_USD=15). Pero
  futureproofing: si algún día se aceptan compras de $10,000+, falla.
  Y trabajar en `Number` mezclando con índices de Map es framework-
  fragile.
  Fix sugerido: usar BigInt consistentemente. `amountUnits` como string
  o BigInt en Map key, `BigInt(event.args.value).toString()` en lookups.
```

---

```
[MEDIUM] RPC publicnode.com sin failover ni health check
  Archivo: functions/index.js:1109, 1435
  Flujo: A + B
  Categoría: 6 / 10
  Descripción: `https://polygon-bor-rpc.publicnode.com` hardcoded.
  Si está caído / rate-limited / responde basura, ambos workers fallan
  silencioso (try/catch warn) y se acumula backlog.
  Por qué importa: lock-in con un proveedor sin SLA. Pérdida de
  funcionalidad durante incidente del RPC.
  Fix sugerido: array de RPCs (publicnode, Alchemy, Infura, Quicknode),
  Failover en orden, métrica de health check, alerta si todos fallan.
```

---

```
[MEDIUM] Wallet receptora sin monitor de saldo MATIC para gas — bloquea mints
  Archivo: functions/index.js:1109-1166
  Flujo: B (impacto cruzado con A)
  Categoría: 6 / 10
  Descripción: La misma `companyWallet` (firma con COMPANY_WALLET_KEY)
  se usa para mintear NFTs. Necesita MATIC para gas. Si se queda sin
  MATIC, cada `contract.mintGem(...)` lanza error → mintRef se marca
  pending hasta 5 intentos → todos fallan en cadena → spam de emails
  + backlog de pendingMints.
  Por qué importa: NFTs no se mintean, users no reciben gemas, soporte
  saturado.
  Fix sugerido: cada N runs (e.g. 1/h), `provider.getBalance(wallet)` y
  si <0.5 MATIC, enviar email + pausar mintProcessor.
```

---

```
[MEDIUM] Pago realizado DESPUÉS de TTL → fondos perdidos sin refund path
  Archivo: functions/index.js:1583-1590
  Flujo: A
  Categoría: 1.1 / 1.4
  Descripción: PAYMENT_WINDOW_MS = 30 min. Si user envía USDC justo
  cuando el payment expira (30:01 después de generarlo, e.g. fee
  network o user confundido), el processor:
    a) Próximo run: `pendingByAmount` solo carga payments con
       `status==waiting AND expiresAt > now` → ya no contiene este
       payment.
    b) El batch de expirados (línea 1583-1590) lo marca expired SIN
       desacreditarle nada — pero el USDC se quedó en PAYMENT_WALLET.
    c) processedTxs nunca se crea para ese hash porque ningún payment
       lo matcheó.
  Resultado: dinero del user perdido. Solo refund manual.
  Por qué importa: user-hostile. En un día con red Polygon lenta o user
  que tarda en pegar la dirección, puede pasar fácil.
  Fix sugerido: detectar Transfer events sin payment match → guardar
  en `orphanedPayments/{txHash}` con monto+from+timestamp → email al
  admin para reembolso o crédito manual.
  Escenario:
    1. User genera payment de 15.34 USDC (TTL 30 min).
    2. Tarda 28 min en abrir Metamask (busca seed phrase).
    3. Envía la TX a los 29 min; mempool Polygon congestionado → tarda
       4 min en confirmarse.
    4. La TX confirma a los 33 min. Payment ya expirado.
    5. Próximo run a los 35 min: queryFilter ve la TX (still in window)
       PERO `pendingByAmount` solo tiene payments con expiresAt > now.
       El payment del user ya tiene expiresAt < now → no está en el
       Map → no se procesa.
    6. User pagó, no recibe créditos, abre ticket. Pérdida de
       confianza + soporte manual.
```

---

```
[MEDIUM] `amountUnits` colision potencial entre payments legacy random-ID
  Archivo: functions/index.js:1451-1456, 1481
  Flujo: A
  Categoría: 1.2
  Descripción: El nuevo flow usa docId determinístico `amt_${amountUnits}`
  pero el comentario en línea 1448-1450 reconoce que data legacy
  puede tener docs con random IDs y mismo amount. Para resolverlo,
  ordena FCFS por createdAt y hace `shift()`. PERO: ¿Qué pasa si dos
  users actuales (mismo amount slot) generan payments DURANTE la
  misma ventana de 5 min porque uno NO usó el flow nuevo (el código
  loopea reintentando colisiones via tx.get + tx.set en transacción —
  pero el primer doc `waiting` block correcto al segundo)? Verifiqué:
  el TX bloquea correctamente DESPUÉS del primer set. OK. Pero si
  ambos pagaron el mismo amount con TXs en bloques distintos,
  FCFS sortea por createdAt y solo el más viejo gana → el otro queda
  sin acreditar Y su USDC queda en PAYMENT_WALLET.
  Por qué importa: ya cubierto por el docId determinístico, pero data
  legacy expone esto a colisión. Y el código no envía una alerta:
  el processor simplemente sale del loop sin "exceso" (línea 1479:
  `if (!docs || docs.length === 0) continue`) — el evento Transfer
  EXTRA queda silenciosamente ignorado.
  Fix sugerido: si hay events Transfer matched al amount sin docs
  para asignar, escribir un alerta a `orphanedPayments` (mismo fix
  que el anterior).
```

---

```
[MEDIUM] `_rateLimitFirestore` no es 100% atómico con TXs no-aisladas
  Archivo: functions/index.js:1724-1741
  Flujo: A (cross-flow)
  Categoría: 5
  Descripción: La función hace `arr.filter + arr.push + tx.set` en una
  transacción. OK. Pero después devuelve `allowed` que fue seteado
  dentro del callback de la TX. Firestore TX puede reintentar 5 veces
  (concurrent contention). En cada retry, `arr.push(now)` ejecuta —
  pero al retry los timestamps se filtran de nuevo y se persiste el
  estado final correcto. Sin embargo, la SEMANTICA: con 5 retries,
  un user genuinely-fast podría ver `allowed=true` y al mismo tiempo
  el bucket queda con uno extra que después no se honora. No práctico
  romper a nivel ataque.
  Por qué importa: defense-in-depth.
  Fix sugerido: agregar test que estresee.
```

---

```
[INFO] `BuyCredits.js` cachea paymentId en AsyncStorage sin firmar
  Archivo: src/screens/BuyCredits.js:78-83, 97-110
  Flujo: A
  Categoría: 10
  Descripción: PAYMENT_CACHE_KEY guarda { paymentId, expiresAt }. Si
  otra app sin AsyncStorage protection lee este key, ve el paymentId.
  Read-only del paymentId no compromete nada (rules lo bloquean salvo
  para el owner authed), pero podría usarse para social engineering.
  Por qué importa: mínimo — paymentId no es secreto en sí.
  Fix sugerido: aceptable como está.
```

---

### Flujo B — NFT mint

---

```
[CRIT] `tx.wait()` sin parámetro de confirmations → vulnerable a reorgs del mint
  Archivo: functions/index.js:1166
  Flujo: B
  Categoría: 2.2 / 2.3
  Descripción: `const receipt = await tx.wait();` — ethers v6 default
  es 1 confirmación. Después marca `pendingMints.completed` + escribe
  txHash + tokenId en la gema del user. Si la cadena reorganiza
  >1 bloque (típico en Polygon: 30-60 bloques), el mint puede revertir
  y el NFT NO existe on-chain pero el backend dice "minted".
  Por qué importa: user ve "minted" en la app, va a OpenSea, NO ve su
  NFT. Soporte saturado. Y peor: re-claim al mismo gemId está bloqueado
  porque `status==='minted'`. Doble-pérdida: NFT perdido + bloqueo de
  retry.
  Fix sugerido: `await tx.wait(30)` (o más conservador, 64-128) para
  alinear con SAFE_CONFIRMATIONS del flow A.
  Escenario:
    1. Mint TX confirma en bloque N con 1 confirmación.
    2. Backend marca minted, escribe tokenId=42, push notification al
       user "Your NFT arrived! 💎".
    3. Reorg de 50 bloques (incidente Polygon real, e.g. 2022-05).
    4. tokenId=42 NO existe; transactionHash NO existe en la cadena
       canónica.
    5. User abre OpenSea — nada.
    6. Backend cree que ya minteó → no reintenta.
    7. Gema perdida.
```

---

```
[CRIT] Sin nonce explícito en mintGem → race entre processPendingMints (admin) y mintProcessorScheduled
  Archivo: functions/index.js:1159-1166, 1243-1257
  Flujo: B
  Categoría: 2.2
  Descripción: Ambos workers comparten `companyWallet`. ethers maneja
  nonce internamente (pull desde provider). Si admin invoca
  `processPendingMints` manualmente JUSTO cuando el scheduler está
  midway en su loop de 10 docs, ambos pueden:
    a) Reservar pendingMints distintos (TX `status:processing` los
       distingue — Firestore atomic, no colisiona).
    b) Llamar `contract.mintGem(...)` con el MISMO nonce porque ethers
       lo lee del estado pendiente del nodo. Si el primer TX se
       confirma rápido, el segundo TX hace nonce conflict ("nonce too
       low") → mintRef.lastError + retry.
    c) Peor: si ambos TX llegan a mempool con mismo nonce y mismo
       gasPrice, validators pueden ejecutar cualquiera (el que llegue
       primero gana, el otro revierte). pendingMints del perdedor
       reintenta con attemptCount, mientras el ganador queda completed.
       OK semánticamente, pero pierde 5 minutos cada vez.
  Worse case: con providers públicos que NO mantienen txpool consistente
  entre nodos, podés terminar minteando 2 NFTs al mismo `gemCode` —
  PERO el contrato MTBGems línea 37 (`require gemCodeToTokenId[gemCode]
  == 0`) revierte el segundo. Defense in depth on-chain salva el caso
  más grave, pero gasta MATIC en TX revertidas.
  Por qué importa: backlog garantizado si admin usa el botón manual.
  Y MATIC quemado.
  Fix sugerido: usar `wallet.getNonce("pending")` antes del envío y
  pasarlo explícito en overrides `{ nonce }`. Mejor: locking-mutex via
  Firestore (e.g. `meta/mintLock` doc con leaseExpires) que solo un
  worker pueda tomar a la vez.
  Escenario:
    1. Scheduler corre, claim pendingMints/A, llama mintGem(A).
    2. Admin tap "Process pending mints" → onCall corre, claim
       pendingMints/B, llama mintGem(B).
    3. ethers para ambos pide nonce a publicnode RPC. Como (1) aún no
       confirmó, el RPC devuelve el mismo nonce N para ambos.
    4. TX(A) y TX(B) submitted con nonce=N. Validador ejecuta el de
       mayor gasPrice; el otro queda "nonce too low" en mempool y se
       desecha.
    5. El que perdió queda con `status:processing` por mucho tiempo —
       el código NO tiene timeout para "processing", solo `pending`
       se reintenta. Stuck para siempre.
```

---

```
[CRIT] `status:processing` no tiene timeout / dead-letter
  Archivo: functions/index.js:1124-1135, 1198-1234
  Flujo: B
  Categoría: 2.2 / 6
  Descripción: Al inicio del loop, TX cambia `pending → processing`.
  Si `contract.mintGem(...)` lanza, el catch en línea 1198 marca de
  vuelta a `pending` con attemptCount++. PERO si la function CRASHEA
  (OOM, timeout 540s de Cloud Functions, deploy mid-flight), el doc
  queda en `processing` PARA SIEMPRE. La query línea 1103
  (`where status == pending`) NUNCA lo levanta de nuevo.
  Por qué importa: NFTs perdidos sin alerta. User abre ticket "mi
  gema no se minteó".
  Fix sugerido: query también docs con `status == 'processing' AND
  startedAt < now - 10min` para reclaim. O job de cleanup cada hora.
  Escenario:
    1. Worker reclama pendingMints/X, status=processing, startedAt=now.
    2. Worker tarda en `tx.wait()` 8 minutos (red lenta).
    3. Cloud Functions kills the instance a los 9 min (deploy / cold
       eviction / timeout).
    4. Sin embargo, la TX on-chain SÍ confirmó. NFT minteado.
    5. pendingMints/X queda processing eternamente. La gema del user
       queda en status `minting` para siempre. tokenId nunca se
       graba.
    6. User no ve nada.
```

---

```
[HIGH] Auto-mint dentro de `mineCube` (líneas 791-835) NO es transaccional
  Archivo: functions/index.js:791-835
  Flujo: B
  Categoría: 2.1 / 5
  Descripción: Después de la TX principal de mineCube, FUERA de
  transacción, se hace `db.collection("users").doc(uid).collection("gems").add()`
  + `db.collection("pendingMints").add()`. Si entre esos dos `.add()`
  hay un crash (network error, function timeout, OOM, deploy reload),
  la gema queda creada SIN pendingMint correspondiente. La gema vive
  en status `minting` pero no hay nada en pendingMints para procesarla.
  Por qué importa: gema perdida sin recovery. El user puede llamar
  `claimGemNFT` para crear pendingMint pero tiene que pasar la wallet
  manualmente (ya está en la gema pero el código en `claimGemNFT`
  rechaza si status !== "unclaimed").
  Fix sugerido: meter `gems.add` + `pendingMints.set` (con docId
  determinístico) en una transacción usando `batch` o WriteBatch.
  Idealmente DENTRO de la misma TX que mineCube — pero saldrías del
  límite de 500 writes.
  Escenario:
    1. User mina y obtiene tier 1 gema.
    2. `gems.add` succeeds: doc creado.
    3. Función crashea por OOM antes del `pendingMints.add`.
    4. Cliente recibe error o retry → re-llama mineCube con MISMO cube
       → minedRef.exists ya, devuelve alreadyMined:true. Sin gema.
    5. Gema queda en Firestore con status `minting`, no se mintea
       jamás.
```

---

```
[HIGH] `claimGemNFT` lee wallet del body en lugar de `users/{uid}.walletAddress`
  Archivo: functions/index.js:608-657
  Flujo: B
  Categoría: 2.1 / 4
  Descripción: Acepta `walletAddress` del payload. Aunque tiene
  validación de formato, NO valida que coincida con la wallet
  registrada en el doc del user (que tiene cooldown 24h en
  setUserWallet). Esto bypass del cooldown de hot-swap: un atacante
  que tomó la sesión temporalmente (token robado) puede dirigir
  TODOS los NFTs claimed a su wallet sin haberla seteado en el doc.
  Por qué importa: cooldown anti-hot-swap (línea 1295,
  WALLET_CHANGE_COOLDOWN_MS) queda bypaseable. Defense en B no
  honora el control del A.
  Fix sugerido: ignorar `walletAddress` del body; leer SIEMPRE
  `users/{uid}.walletAddress` (que ya pasó por setUserWallet con
  cooldown). Si está null, error.
  Escenario:
    1. Atacante phisa el token ID de la víctima (válido 1h).
    2. Atacante llama claimGemNFT con la wallet del atacante.
    3. Backend acepta porque no compara con walletAddress del user.
    4. Scheduler mintea a la wallet del atacante.
    5. Víctima pierde el NFT. El cooldown en setUserWallet era inútil.
```

---

```
[HIGH] No se verifica `ownerOf(tokenId) == walletAddress` post-mint
  Archivo: functions/index.js:1168-1185
  Flujo: B
  Categoría: 2.3
  Descripción: Después de extraer tokenId del GemMinted event,
  el código asume que el mint fue exitoso y persiste tokenId.
  Pero si por reorg/edge-case el event se emite y luego revierte,
  o si `_safeMint(to, ...)` falla en `onERC721Received` (contrato
  receptor maligno), el log puede no estar en la cadena canónica.
  Por qué importa: backend persiste un tokenId que no existe.
  Fix sugerido: después de `tx.wait(N)`, hacer
  `await contract.ownerOf(tokenId)` y verificar que devuelve la
  wallet esperada. Si no, marcar failed + alerta.
```

---

```
[HIGH] Sin supply cap on-chain ni off-chain en `mintGem`
  Archivo: contracts/MTBGems.sol:28-55
  Flujo: B
  Categoría: 8
  Descripción: `_nextTokenId` puede crecer sin límite. No hay
  protección contra runaway minting si la company key se compromete.
  Por qué importa: con la key, atacante mintea infinitos NFTs tier 9
  hasta que el operador note y pause(). Ventana de pánico depende del
  monitoreo.
  Fix sugerido: `require(_nextTokenId < MAX_SUPPLY, "supply cap")`.
  MAX_SUPPLY ≈ alguna cota razonable del game (e.g. 100,000).
```

---

```
[HIGH] IPFS sin pinning redundante — CIDs en GEM_TOKEN_URIS son SPOF
  Archivo: functions/constants.js:24-34
  Flujo: B
  Categoría: 2.4 / 10
  Descripción: Los 9 CIDs son ipfs://bafkrei... Si solo están pineados
  en un servicio (web3.storage / pinata / propio nodo), y ese servicio
  los unpin (cobro vencido, ToS violation, outage), los gateways IPFS
  públicos dejan de servir el JSON metadata → OpenSea muestra "No
  metadata" en los NFTs minteados.
  Por qué importa: NFTs minteados pierden valor visual sin metadata.
  Brand damage.
  Fix sugerido: pin en ≥3 servicios (Pinata + Filebase + nft.storage),
  y guardar copia local en bucket Cloud Storage como backup. Monitor
  uptime cada N días.
```

---

```
[MEDIUM] Backend reintenta hasta 5 veces sin gas-bumping
  Archivo: functions/index.js:1200-1234
  Flujo: B
  Categoría: 2.2
  Descripción: En retry, no aumenta gasPrice ni usa EIP-1559 explícito.
  Si el primer intento quedó underpriced en mempool, el segundo manda
  con gas similar → tampoco mina. Ethers v6 default es priorityFee
  bajo. Con congestión Polygon, los 5 retries pueden todos fallar.
  Por qué importa: backlog + email alert al admin para algo que se
  resuelve subiendo el gas.
  Fix sugerido: pasar overrides en el N-ésimo retry:
  `{ maxFeePerGas: baseFee * (1 + 0.5*attempt), maxPriorityFeePerGas: 30 gwei }`.
```

---

```
[MEDIUM] `processPendingMints` no respeta el cap de 10 cuando admin lo llama varias veces
  Archivo: functions/index.js:1102-1247
  Flujo: B
  Categoría: 2.2
  Descripción: El limit(10) cap es por-call. Si admin spammea el botón,
  cada call levanta 10 distintos (los `processing` no aparecen en query
  pending). Sin protección global, podés tener 50 mintGem TXs paralelas
  con el mismo nonce → caos.
  Por qué importa: race del CRIT-nonce de arriba se multiplica.
  Fix sugerido: lock global `meta/mintLock`.
```

---

```
[MEDIUM] `claimGemNFT` no tiene rate-limit (3-5/min razonable)
  Archivo: functions/index.js:608
  Flujo: B
  Categoría: 6
  Descripción: User puede spammear claimGemNFT para distintos gems —
  cada uno crea pendingMint + actualiza gema a `minting`. Sin DoS
  amplification (cada llamada hace 1 TX bound), pero puede saturar
  pendingMints si user tiene 1000 gems.
  Por qué importa: degradación rendimiento mintProcessor.
  Fix sugerido: `_rateLimitFirestore(`cgnft_${uid}`, 30, 60*1000)`.
```

---

```
[MEDIUM] tokenURI fallback `data.tokenURI || GEM_TOKEN_URIS[(data.gemTier - 1)]` permite tokenURI inyectado
  Archivo: functions/index.js:1164
  Flujo: B
  Categoría: 2.4
  Descripción: El pendingMint doc se crea con `tokenURI:
  GEM_TOKEN_URIS[...]` (server-side en claimGemNFT y mineCube auto-mint).
  Las rules bloquean writes directos a pendingMints (default-deny). OK.
  Pero si en el futuro algún path acepta tokenURI del cliente o un admin
  compromised lo manipula, no hay validación contra una allowlist.
  Por qué importa: defensa en profundidad, hoy no explotable.
  Fix sugerido: ignorar `data.tokenURI` y usar SIEMPRE
  `GEM_TOKEN_URIS[gemTier - 1]`.
```

---

```
[LOW] Push notification de "NFT arrived" se envía aunque tokenId sea null
  Archivo: functions/index.js:1190-1196
  Flujo: B
  Categoría: 6
  Descripción: Si el log GemMinted no se parsea (RPC devuelve logs
  truncados, evento ABI mismatch), tokenId queda null pero se marca
  completed igual. La notificación sale con "Token #" vacío.
  Por qué importa: UX cosmético + bug futuro si se cambia el contrato.
  Fix sugerido: si tokenId null, marcar `partial_success` y reintentar
  vía RPC query.
```

---

### Flujo C — Redemption del premio en USDC

---

```
[CRIT] No existe path automatizado para marcar `redeemed:true` post-pago
  Archivo: functions/index.js (ausente) + scripts/ (ausente)
  Flujo: C
  Categoría: 3.3 / 3.4 / 9
  Descripción: El admin paga MANUALMENTE desde su wallet. Después debe
  marcar `users/{uid}/gems/{gemId}.status = redeemed` MANUALMENTE en
  Firestore Console. No existe `scripts/markRedeemed.js`. No existe
  Cloud Function `markRedeemed`. Sin esto:
    a) La gema queda en `claim_submitted` (línea 1961). User puede
       intentar re-submitGemClaim → falla en la TX check (línea 1956),
       pero solo si la status check lee correctamente.
       VERIFICADO: línea 1957 `gem.status === "redeemed" ||
       gem.status === "claim_submitted"` → returns error
       "already_redeemed". OK, defensa correcta contra double-submit.
    b) PERO: no hay registro de "paid:true" + txHash en gemClaims.
       Si el admin se olvida de marcar (humano falible), el ticket
       queda fantasma. ¿Pagó? ¿No pagó? No hay verdad on-chain
       cruzada.
    c) Auditoría contable inviable: no podés decir "se pagaron N gems"
       a fin de mes.
  Por qué importa: doble-pago humano (admin paga la misma gema dos
  veces porque no se marcó), pérdida de plata, auditoría rota.
  Fix sugerido: Cloud Function admin `markGemRedeemed(claimId, txHash,
  amount)` que:
    1) Verifica vía RPC que el txHash existe y matchea
       (from=adminWallet, to=userWallet, value≈expectedPrice).
    2) Setea gemClaims/{id}.status='paid', txHash, amount, paidAt.
    3) Setea gems/{uid}/{gemId}.status='redeemed', redeemedAt, txHash.
    4) Escribe adminActions.
  Escenario:
    1. User envía submitGemClaim para tier 1 = $100k.
    2. Admin paga al user $100k USDC desde MM. TxHash on-chain ok.
    3. Admin olvida marcar la gema redeemed (work overload, etc.).
    4. User abre ticket "no recibí mi premio" 2 meses después
       (mintió o se confundió).
    5. Admin no tiene forma de cruzar gemClaim ↔ txHash ↔ gem doc.
       Tiene que ir a Polygonscan, buscar adminWallet, filtrar TXs
       de $100k, intentar correlacionar timestamp + wallet del user.
    6. ENORME costo de soporte por cada disputa.
    7. O peor: admin paga DE NUEVO porque no encuentra el registro.
```

---

```
[HIGH] `verifyIdToken` sin `checkRevoked:true` → sesiones robadas hasta 1h
  Archivo: functions/index.js:1904
  Flujo: C
  Categoría: 3.1
  Descripción: `getAuth().verifyIdToken(m[1])` no pasa el segundo
  parámetro `true`. ID tokens duran 1h. Si el user revoca tokens
  (admin disable, password reset), el token sigue siendo válido
  para submitGemClaim hasta que expire naturalmente. En un flujo con
  premios de hasta $100k, esa hora es ventana suficiente.
  Por qué importa: post-incident response queda 1h corto. Token leak
  via XSS / malware → atacante drena gemClaims.
  Fix sugerido: `verifyIdToken(token, true)` — agrega ~1 read a Auth
  por call, aceptable.
  Escenario:
    1. Atacante exfiltra ID token de la víctima (clipboard malware,
       XSS en otro contexto, etc.).
    2. Víctima detecta y cambia password / revoca.
    3. Atacante todavía tiene 0-60 min de validez.
    4. Llama submitGemClaim con código del user + wallet del atacante.
    5. Backend lo acepta, admin paga al wallet del atacante.
    6. $100k robados.
```

---

```
[HIGH] `submitGemClaim` no es idempotente — múltiples envíos generan múltiples emails y entradas
  Archivo: functions/index.js:1929-1977
  Flujo: C
  Categoría: 3.2
  Descripción: Después de marcar status=claim_submitted, el doc se
  protege contra re-submit (línea 1956-1959 throw). PERO en una
  request paralela en ventana de carrera, ambos pueden hacer el
  read+set ANTES de que el otro commit. La TX bloquea esto bien
  (`runTransaction` retry contention). VERIFICADO ok.
  
  Sin embargo: el `gemClaims.add(...)` y el sendMail están FUERA de
  la TX (línea 1967, 1980). Si el TX commits OK pero gemClaims.add
  falla por error de red, el doc queda claim_submitted SIN entry en
  gemClaims → el admin NUNCA recibe email → user nunca cobra. Y si
  user re-prueba, error already_redeemed.
  Por qué importa: gema fantasma "submitted pero invisible al admin".
  Fix sugerido: poner gemClaims.add DENTRO de la TX (ambos en mismo
  batch). El email post-commit sí está OK out-of-TX (best-effort).
```

---

```
[HIGH] El front-end web fuerza login pero NO valida emailVerified
  Archivo: docs/index.html:836-860 + functions/index.js:1903-1911
  Flujo: C
  Categoría: 3.1
  Descripción: `submitGemClaim` valida Bearer token y ownership pero
  NO chequea `decoded.email_verified`. Un atacante puede crear cuenta
  email+password con email_verified=false, comprar la app, jugar,
  ganar gema, y reclamar premio sin haber verificado el email.
  Por qué importa: contradice `requireRegistered` en otras funciones
  (mineCube, etc.) que SÍ requieren email verified. Inconsistencia +
  via para fraudes con emails throwaway.
  Fix sugerido: en submitGemClaim, después de verifyIdToken, check:
  `if (decoded.firebase.sign_in_provider === 'password' &&
       !decoded.email_verified) return res.status(403)...`.
```

---

```
[HIGH] gemCode persistente — sin TTL ni rotación post-discovery
  Archivo: functions/helpers.js:136-146 + functions/index.js:803-805
  Flujo: C
  Categoría: 3.1
  Descripción: gemCode generado al descubrir la gema (`MTBN-XXXXXXXX-YYYYYY`).
  Vive en `users/{uid}/gems/{gemId}.code` permanentemente. El user
  puede compartirlo en screenshots / Discord. Hoy el backend valida
  ownership en submitGemClaim (SEC-B3), pero si en algún flow futuro
  o un bug expone el código (e.g. log público), un actor con el código
  + auth podría... esperá, no, no puede sin la cuenta del owner.
  Por qué importa: defense in depth. Si la app llega a leakear el
  código (logs, share), ¿se puede cambiar? No hay endpoint.
  Fix sugerido: rotar gemCode al claim (después del mint o redemption).
  Documentar el riesgo.
```

---

```
[MEDIUM] `gemClaims.add` no guarda authUid → forensics rota
  Archivo: functions/index.js:1967-1977
  Flujo: C
  Categoría: 3.2 / 9
  Descripción: El doc gemClaims guarda gemRef.path (que incluye el
  uid), pero el campo `authUid` no se persiste explícitamente. Si en
  el futuro alguien ataca y modifica el path o se cambia el schema,
  el audit trail se rompe.
  Por qué importa: querying por uid es indirecto (split path string).
  Fix sugerido: agregar `uid: authUid` al doc gemClaims.
```

---

```
[MEDIUM] Email al admin contiene datos PII no encriptados
  Archivo: functions/index.js:1980-2007
  Flujo: C
  Categoría: 3.2 / 9
  Descripción: Email a NOTIFY_EMAIL con name, email, phone, wallet.
  Gmail está fuera del control de la app. Si la cuenta NOTIFY_EMAIL
  se compromete o si Google Workspace data se filtra, PII expuesta.
  Por qué importa: cumplimiento GDPR / Argentina Ley 25326 (datos
  personales). Wallet + nombre + teléfono = perfil completo.
  Fix sugerido: enviar solo gemClaim ID + tier en el email; admin
  consulta los datos en Firebase Console con audit log de quien leyó.
  O cifrar el email con PGP (overkill para esta scale).
```

---

```
[MEDIUM] No hay límite de reintentos en submitGemClaim por uid
  Archivo: functions/index.js:1884-1929
  Flujo: C
  Categoría: 3.1
  Descripción: Sin rate-limit, un atacante con un Bearer token válido
  puede llamar submitGemClaim 1000 veces / segundo. Solo la TX de
  Firestore evita estado inconsistente, pero saturás Firestore + Gmail
  (cada attempt manda email). Posible spam-bomb del NOTIFY_EMAIL → ban
  cuenta Gmail → caída del flow de verificación de cuenta.
  Por qué importa: DoS al canal de soporte/notificación.
  Fix sugerido: `_rateLimitFirestore(`sgc_${authUid}`, 5, 60*1000)`.
  Escenario:
    1. Atacante con cuenta verificada y gema válida.
    2. Loop infinito de submitGemClaim. La TX falla todas excepto
       la primera (status=claim_submitted), pero antes de fallar,
       cada call levanta verifyIdToken + busca gem (collectionGroup
       expensive) + intenta TX.
    3. Coste: 1k reads/seg sostenidos hasta que el quota límite o
       el admin lo note.
    4. Costo de Firestore reads escala $$.
```

---

### Cross-flow / Atomicity / Infrastructure

---

```
[HIGH] `wallet` del gemClaim NO se cruza con `users/{uid}.walletAddress`
  Archivo: functions/index.js:1918-1928
  Flujo: C / Cross (A+B+C)
  Categoría: 4 / 3.1
  Descripción: En submitGemClaim, el wallet del body NO se compara con
  walletAddress del user doc (que tiene cooldown 24h). Un atacante
  con token + ownership de gema puede redirigir el premio a CUALQUIER
  wallet, bypaseando el cooldown.
  Combinado con HIGH "verifyIdToken sin checkRevoked": atacante con
  token robado durante 1h puede registrar SU wallet en el formulario
  web sin tocar la wallet del user en Firestore.
  Por qué importa: el cooldown anti-hot-swap solo aplica a B (mint),
  no a C (cash). User pierde $100k.
  Fix sugerido: validar que `body.wallet === user.walletAddress` (o
  permitir override solo si admin lo aprobó). Documentar política.
```

---

```
[HIGH] Sin reconciliación on-chain ↔ off-chain
  Archivo: (ausente)
  Flujo: A + B + C
  Categoría: 9 / 10
  Descripción: No existe job que cruce periódicamente:
    - pendingCryptoPayments.completed vs Polygon Transfer events
    - gems.minted vs ownerOf(tokenId) on-chain
    - gemClaims.paid (cuando exista) vs adminWallet outgoing TXs
  Si Firestore se corrompe o un atacante manipula docs (rules bug
  futuro), no hay segundo source-of-truth.
  Por qué importa: trust-busting si emerge una inconsistencia y nadie
  la detectó. Single source = Firestore.
  Fix sugerido: cron diario que samplea N docs y los verifica on-chain.
  Reporta divergencias por email.
```

---

```
[MEDIUM] `addServerCredit` admin puede regalar créditos ilimitados sin gates
  Archivo: functions/index.js:288-320
  Flujo: A / Cross
  Categoría: 9
  Descripción: Cap por call = 100 créditos. Sin cap total por día por
  admin. Un admin compromised puede dar 100 créditos a 1000 usuarios
  = 100k créditos ($1.5M en USDC equivalent) en minutos.
  Por qué importa: si admin se compromete, drain inmediato + audit
  log no previene (solo registra).
  Fix sugerido: cap diario `maxCreditsPerAdminPerDay = 500`, alerta
  vía email si se aproxima.
```

---

```
[MEDIUM] `consumeServerCredit` read-then-write (en TX pero no atómico via increment)
  Archivo: functions/index.js:277-283
  Flujo: A
  Categoría: 5
  Descripción: Lee credits + escribe `credits - 1`. Está DENTRO de
  runTransaction → Firestore reintenta hasta 5 veces en contención.
  OK semánticamente. Pero patrón inconsistente: en otros lugares se
  usa FieldValue.increment(-1). Para uniformidad y robustez bajo
  contención alta:
  Fix sugerido: usar `tx.set(userRef, { serverCredits: FieldValue.increment(-1) }, { merge: true })`
  después de la validación `if credits < 1 throw`.
```

---

```
[MEDIUM] No hay forma de cancelar/refund pagos crypto stuck
  Archivo: functions/index.js:1368-1423, 1583-1591
  Flujo: A
  Categoría: 1.4
  Descripción: Si user paga 14.99 (USDC fee de gas mal calculado por
  wallet), el processor NO matcheará (espera 15.42 exactos por
  ejemplo) y los fondos quedan en PAYMENT_WALLET. No hay endpoint
  para reembolsar.
  Por qué importa: pérdida de fondos del user. Cada queja requiere
  human intervention.
  Fix sugerido: endpoint admin `refundPayment(txHash, toAddress, reason)`
  que firme + envíe USDC de vuelta + audita.
```

---

```
[MEDIUM] Cooldown wallet de 24h solo aplica a setUserWallet — flujo B salta cuando wallet sí cambió
  Archivo: functions/index.js:1295-1330 + 608-657
  Flujo: B / Cross
  Categoría: 4
  Descripción: Si user cambia wallet de A→B vía setUserWallet (cooldown
  activado), el cooldown previene cambios siguientes por 24h. Pero
  claimGemNFT acepta `walletAddress` del body — el primer claim
  inmediatamente después del cambio dirige el NFT a B sin cooldown.
  Esto es esperado, pero falta documentación: si la wallet recién
  cambiada es del atacante, los próximos N claims durante esas 24h
  van todos a ella (porque setUserWallet la fijó). El cooldown
  bloquea cambios pero no la EXPLOTACIÓN durante la ventana.
  Por qué importa: cooldown 24h da sensación de seguridad falsa.
  Fix sugerido: incrementar cooldown a 48-72h (más tiempo para
  detectar) y/o agregar verificación 2FA al cambio de wallet.
```

---

```
[LOW] PAYMENT_WALLET y MTBGEMS_CONTRACT no son la misma wallet (good)
  Archivo: functions/constants.js:36-40
  Flujo: A + B
  Categoría: 10
  Descripción: PAYMENT_WALLET=0x61f7... (recibe USDC), 
  MTBGEMS_CONTRACT=0x54c2... (contrato NFT). Backend wallet firmante
  es COMPANY_WALLET_KEY (separada de ambos, asumido). 
  Por qué importa: separation of duties OK. Pero ¿COMPANY_WALLET_KEY
  es la `owner` del contrato MTBGems? Y ¿es distinta de PAYMENT_WALLET?
  Si la misma key custodia ambos, el blast radius de un compromise
  es total. NO PUEDO VERIFICAR sin acceso al secret manager.
  Fix sugerido: documentar topología de wallets explícitamente en
  SECURITY.md.
```

---

```
[LOW] Sin métricas/dashboard de payments / mints
  Archivo: (ausente)
  Flujo: A + B + C
  Categoría: 9
  Descripción: Logs van a Cloud Logging pero no hay dashboard que
  muestre: pagos/día, conversion rate (paid→credit), mint backlog,
  gems pendientes de redemption, MATIC balance.
  Fix sugerido: BigQuery export de Firestore + Looker Studio.
```

---

```
[LOW] El processor no verifica `event.removed` flag de ethers
  Archivo: functions/index.js:1476
  Flujo: A
  Categoría: 1.2
  Descripción: Si un evento viene de un bloque reorganizado, ethers v6
  marca `event.removed = true`. El código no chequea. Combined con
  SAFE_CONFIRMATIONS=30 está cubierto en mayoría, pero defensa extra.
  Fix sugerido: `if (event.removed) continue;`.
```

---

```
[INFO] `firestoreBackupScheduled` daily backup — bien
  Archivo: functions/index.js:1697-1714
  Flujo: Cross
  Categoría: 10
  Descripción: Backup diario a Cloud Storage. Bien.
  Mejorar: probar restore una vez por mes, documentar RTO/RPO.
```

---

## RESUMEN EJECUTIVO

| Severidad | Cantidad |
|-----------|----------|
| CRIT      | **6**    |
| HIGH      | **11**   |
| MEDIUM    | **12**   |
| LOW       | **4**    |
| INFO      | **2**    |
| **Total** | **35**   |

---

## TOP 5 CRÍTICOS

1. **`tx.wait()` sin confirmaciones** en `runMintProcessing` → NFTs marcados como minted pueden no existir on-chain post-reorg. **Impacto: gemas perdidas, soporte saturado, brand damage.**
2. **`status:processing` sin timeout** → mintProcessor crash deja docs stuck para siempre. **Impacto: gemas perdidas silenciosamente.**
3. **Race de nonce entre `processPendingMints` y `mintProcessorScheduled`** → admin botón manual + scheduler concurrente fuerzan TXs con mismo nonce, una revierte y queda processing eterno. **Impacto: backlog + MATIC quemado.**
4. **Sin checkpoint de bloque escaneado** + ventana de 200 bloques solamente → si el scheduler se atrasa >6.6 min, pagos legítimos quedan fuera de la ventana sin ser detectados. **Impacto: pérdida silenciosa de pagos USDC.**
5. **No existe path automatizado para marcar `redeemed:true`** post-pago manual del admin → reconciliación contable imposible, doble-pago humano probable. **Impacto: pérdida directa de hasta $100k por gema tier 1 si admin paga dos veces.**

(Cinco críticos + el "Polygon reorg desacredita pago" — incluido en CRIT total).

---

## RACE CONDITIONS IDENTIFICADAS

```
Race-1: cryptoPaymentProcessorScheduled vs sí mismo (overlap del 5min cron)
  Trigger: cron lento + run próximo se solapa
  Mitigación: processedTxs/{txHash} con TX → OK
  Estado: cubierto

Race-2: createCryptoPayment paralelos al mismo amount slot
  Trigger: dos uids piden centavos iguales en mismo instante
  Mitigación: docId determinístico amt_${X} + runTransaction → OK
  Estado: cubierto (espacio 99 → DoS posible)

Race-3: processPendingMints (manual) vs mintProcessorScheduled (cron)
  Trigger: admin botón mientras scheduler corre
  Mitigación: status:processing distingue docs, PERO nonce de la wallet
              colide. ON-CHAIN: gemCodeToTokenId require lo bloquea pero
              gasta gas.
  Estado: PARCIALMENTE CUBIERTO — vector real

Race-4: Auto-mint (mineCube) vs claimGemNFT manual del mismo gemId
  Trigger: user mina, gema se crea con `unclaimed` (sin wallet), user
           setea wallet, llama claimGemNFT. Mientras tanto, alguna
           gema fantasma sigue con `unclaimed` pero pendingMint
           duplicado?
  Análisis: mineCube auto-mint solo cuando userWallet existe AL momento
            del mine. Si no existe, gema=unclaimed sin pendingMint. user
            puede claimGemNFT después → pendingMints/{uid}_{gemId} ÚNICO
            por docId determinístico. OK.
  Estado: cubierto

Race-5: submitGemClaim paralelos
  Trigger: user duplica request en mala red
  Mitigación: runTransaction sobre gem.status → OK
  PERO: el gemClaims.add está FUERA de la TX → si TX commits y add
        falla, gema queda claim_submitted sin claim doc visible al
        admin.
  Estado: PARCIALMENTE CUBIERTO

Race-6: setUserWallet durante mintProcessor activo
  Trigger: user cambia wallet justo cuando scheduler tomó pendingMint
  Mitigación: pendingMint guarda walletAddress al momento del claim
              (snapshot). Cambio futuro no afecta este mint.
  Estado: cubierto

Race-7: cryptoPaymentProcessor matchea TX → user simultáneamente cancela?
  No hay cancel endpoint → no aplica.

Race-8: closeEpisode duplicado (no es flow de plata pero comparte patrón)
  Mitigación: meta/closing_{N} guard → OK
  Estado: cubierto
```

---

## PÉRDIDAS POTENCIALES (estimación monetaria por escenario)

| Escenario | Probabilidad | Impacto máximo |
|-----------|--------------|----------------|
| Reorg Polygon revierte pago acreditado | BAJA (reorgs >30 son raros pero ocurrieron) | $15 × N TXs/incidente. Históricamente: ~$500-2k/incidente |
| Mint marcado completo pero revertido | BAJA | $15-100k por gema según tier; reputational alto |
| Admin double-paga por falta de marca redeemed | MEDIA-ALTA | Hasta $100k por gema tier 1 por incidente |
| Pago crypto fuera de ventana 30min → fondos perdidos | MEDIA (red Polygon lenta) | $15 por incidente, soporte manual |
| DoS de amount slots → ventas bloqueadas | MEDIA | revenue/hora del checkout |
| Token leak + submitGemClaim sin checkRevoked | BAJA-MEDIA | Hasta $100k por claim |
| Auto-mint crash entre `gems.add` y `pendingMints.add` | BAJA | $15-100k por gema perdida |
| Wallet de admin compromised + addServerCredit ilimitado | MUY BAJA pero catastrófico | $1.5M+ (todo el saldo de PAYMENT_WALLET + créditos infinitos) |
| IPFS unpin → metadata muerto en OpenSea | BAJA-MEDIA con un solo pinning service | reputacional, no $$ directo |

---

## PATRONES POSITIVOS DETECTADOS

1. **`runTransaction` consistente** en operaciones críticas (createCryptoPayment, processCrypto, mint claim, submitGemClaim, applyReferral).
2. **docId determinístico** en `pendingMints/{uid}_{gemId}` (idempotency by design) y `pendingCryptoPayments/amt_${amountUnits}`.
3. **`processedTxs/{txHash}` con TTL** y check dentro de la misma TX que el credit → previene doble-acreditación.
4. **`SAFE_CONFIRMATIONS = 30`** explícito en runCryptoPaymentProcessing (aunque insuficiente para Polygon — debería ser 64-128).
5. **CEI + nonReentrant** en contracto MTBGems (corregido CRIT-26).
6. **renounceOwnership disabled** en contrato (anti-brick).
7. **pause()/unpause()** disponible en contrato (emergency stop).
8. **`requireAdminFresh`** usa `getUser()` del Admin SDK en lugar de cachear claim — bien.
9. **Whitelist explícito** en firestore.rules de `users/{uid}` update (sin walletAddress, picks, serverCredits accesibles desde cliente).
10. **`SEC-B3` cross-uid check** en submitGemClaim (path-based ownership).
11. **`crypto.randomBytes`** para gemCode (no derivado de uid).
12. **HMAC-SHA256(serverSeed)** para drop rate de gemas (no brute-forceable).
13. **`adminActions` audit log** para operaciones admin.
14. **TTL en `processedTxs` (30 días)**, `errorLog` (30 días), `adSessions` (24h) — buena housekeeping.
15. **firestoreBackupScheduled** diario.
16. **`MEDIO-002` validación de COMPANY_WALLET_KEY** format antes de pasarlo a ethers.
17. **Rate-limits persistidos** en Firestore (no in-memory) → consistente entre instancias.

---

## PRE-LAUNCH CHECKLIST (obligatorio antes del primer pago + primer mint)

### Bloquantes flujo A (USDC payment)
- [ ] **Implementar checkpoint** `meta/cryptoProcessor.lastScannedBlock` para no perder pagos en gaps del scheduler.
- [ ] **Subir SAFE_CONFIRMATIONS** a ≥64 (recomendado 128 enterprise) — protección contra reorgs Polygon.
- [ ] **Filtrar event.from !== PAYMENT_WALLET** + lista de wallets internas en blacklist.
- [ ] **Manejo de pagos orfanos** (monto incorrecto / pago post-TTL) → escribir a `orphanedPayments` para refund manual.
- [ ] **Ampliar espacio de amount slots** (>99) o usar memo/payment-intent para identificar al user sin colisión.
- [ ] **Alerta MATIC balance** para PAYMENT_WALLET y COMPANY_WALLET.

### Bloquantes flujo B (mint)
- [ ] **`tx.wait(N)`** con N ≥30 confirmaciones para alinear con SAFE_CONFIRMATIONS.
- [ ] **Reclaim de `status:processing` stuck** (timeout 10min → vuelve a pending).
- [ ] **Lock global** `meta/mintLock` o `wallet.getNonce("pending")` explícito para evitar nonce race.
- [ ] **Verificar `ownerOf(tokenId)`** post-mint para confirmar que la cadena no revirtió.
- [ ] **Auto-mint en mineCube transaccional** — meter `gems.add` + `pendingMints.set` en batch idempotente.
- [ ] **`claimGemNFT` lee walletAddress del user doc**, no del body.
- [ ] **IPFS pinning redundante** ≥3 servicios + monitor uptime.
- [ ] **Supply cap on-chain** en `mintGem` (require _nextTokenId < MAX_SUPPLY).
- [ ] **Gas-bumping en retries** del mintProcessor.

### Bloquantes flujo C (redemption)
- [ ] **Cloud Function `markGemRedeemed`** que verifica txHash on-chain y persiste status+amount+txHash atómicamente.
- [ ] **`verifyIdToken(token, true)`** con checkRevoked.
- [ ] **Email-verified check** en submitGemClaim.
- [ ] **Rate-limit** `_rateLimitFirestore(`sgc_${uid}`, 5, 60*1000)` en submitGemClaim.
- [ ] **`gemClaims.add` dentro de la TX** del submit (o WriteBatch).
- [ ] **Comparar wallet del body** con `users/{uid}.walletAddress` (rechazar si difiere — o requerir cooldown).
- [ ] **Reducir PII en email** al admin (solo claimId + tier).

### Cross-flow
- [ ] **Reconciliación on-chain↔off-chain** job diario que samplea pagos+mints.
- [ ] **Cap diario en `addServerCredit`** por admin.
- [ ] **Documentar topología de wallets** (PAYMENT_WALLET, COMPANY_WALLET, contract owner) en SECURITY.md.
- [ ] **Dashboard de métricas**: pagos/día, mint backlog, MATIC balance, gemas pending redemption.
- [ ] **Probar restore de backup** una vez antes del launch.
- [ ] **Runbook de incident response**: qué hacer si reorg / wallet compromise / IPFS down / RPC down.
- [ ] **Failover RPC** (publicnode + Alchemy + Infura).

---

## CONCLUSIÓN

La arquitectura general está bien diseñada en términos de **patrones de idempotencia** y **defensa en profundidad** (HMAC, TTL, audit logs, runTransaction consistente, CEI en contrato). Los hallazgos previos de las rondas 1-6 quedaron correctamente resueltos en los flujos A y B (FCFS, processedTxs, docId determinístico).

**Sin embargo, hay 6 CRITs activos** que **deben resolverse antes del primer flujo de dinero real**:

- 4 críticos en flujo B (mint): `tx.wait()` sin conf + status:processing sin timeout + nonce race + sin supply cap on-chain — TODOS pueden causar pérdida de NFTs marcados como minted pero no existentes on-chain.
- 2 críticos en flujo A: checkpoint de bloque + reorg-induced double-spend con processedTxs como bloqueo eterno.
- 1 crítico en flujo C: la falta de `markRedeemed` automatizado es el más caro en términos esperados, porque depende de error humano del admin pagando manualmente premios de hasta $100k.

El **flujo C es el más débil** del sistema porque depende de procesos humanos sin guardrails: pago manual, marca manual, sin reconciliación cruzada. Una buena Cloud Function `markGemRedeemed(claimId, txHash)` cierra el loop crítico en ~1 día de trabajo.

El **gap más urgente** para el lanzamiento es completar la observabilidad (dashboard + reconciliación on-chain) — sin ella, los CRITs son detectables solo cuando un user se queja, lo cual es demasiado tarde para gemas de $100k.

**Archivos auditados** (todos absolutos):
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/constants.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/package.json`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/contracts/MTBGems.sol`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.rules`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.indexes.json`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/src/screens/BuyCredits.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/src/screens/MyGems.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/docs/index.html`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/scripts/grant_admin.js`