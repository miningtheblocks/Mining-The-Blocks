Veo que `pendingMints` no tiene un match dedicado (cae al default-deny). Las gems (subcolección `users/{uid}/gems`) no tienen rule explícita tampoco — solo admin SDK escribe. Excelente.

Tengo todo el contexto necesario. Ahora genero el reporte exhaustivo.

---

# AUDITORÍA DE SMART CONTRACT MTBGems — REPORTE EXHAUSTIVO

**Auditor:** Solidity Senior — auditoría adversarial round 1
**Fecha:** 2026-06-14
**Contrato:** `contracts/MTBGems.sol` (105 líneas, Solidity ^0.8.20)
**Red:** Polygon PoS (chainId 137)
**Address deployada:** `0x54c2859411afCb51fcfE42054aDcA3484B3f29E6`
**Estado:** 0 NFTs minteados — pre-launch real.
**OpenZeppelin:** no se pudo determinar versión exacta (no hay `node_modules/@openzeppelin` ni `hardhat.config` en el repo — el contrato fue compilado/deployado fuera del repo, probablemente vía Remix). Las APIs usadas (`_increaseBalance(address, uint128)`, `_update(address, uint256, address)`, `Ownable(initialOwner)` con constructor argumental, `ERC721Pausable`) son **OpenZeppelin v5.x**.

---

## Hallazgos

### CRÍTICOS

```
[CRIT-1] Owner es EOA único — single point of total compromise
  Archivo: contracts/MTBGems.sol:14, constructor línea 23
  Categoría: 2. Access Control + 5. Secrets / credentials
  Descripción: El contrato hereda `Ownable` (single owner) y `onlyOwner` protege
    `mintGem`, `pause`, `unpause` y `transferOwnership`. La key del owner es
    `COMPANY_WALLET_KEY` (Firebase secret), una EOA secp256k1 estándar.
    Si esa key se filtra (insider, log de Cloud Run, dump de secrets, attacker
    con admin GCP), el atacante puede:
      • mintear infinitos NFTs tier 1 ($100.000 USD nominal cada uno) y dumpearlos
        en marketplaces antes que nadie note el ataque
      • pausar el contrato indefinidamente (denial of service del juego)
      • `transferOwnership` a su propia wallet — pérdida total de control
    El comentario del propio código lo admite (línea 5, 58-59).
  Por qué importa: P(leak) > 0 en un proyecto solo-developer; impacto = total.
    El pendiente está reconocido en ACCIONES_MANUALES.md #11 pero NO mitigado.
  Fix sugerido: Pre-launch (ANTES del primer mint), redeploy con:
      • OpenZeppelin AccessControl + MINTER_ROLE separado de DEFAULT_ADMIN_ROLE
      • Gnosis Safe (2-of-3) como DEFAULT_ADMIN_ROLE
      • EOA backend solo tiene MINTER_ROLE (revocable)
      • DEFAULT_ADMIN_ROLE controla `pause`, `grantRole`, `revokeRole`
    Como hay 0 NFTs minteados, el redeploy NO requiere migración. Costo: ~$10
    de gas en Polygon. Esta acción es la #1 obligatoria pre-launch.
  PoC: filtra COMPANY_WALLET_KEY → `cast send 0x54c2...e6 "mintGem(address,uint8,string,string)"
       <attacker_wallet> 1 "MTB1-FAKE-FAKE" "ipfs://..."` × N veces.

[CRIT-2] No hay supply cap on-chain — el owner puede mintear más que la economía declarada
  Archivo: contracts/MTBGems.sol:28-55 (mintGem)
  Categoría: 10. Manual mint specifics + 1. Economía / dominio
  Descripción: El whitepaper / metadata declara cantidades fijas por tier:
    tier 1 = 1 unidad, tier 2 = 1, tier 3 = 5, ..., tier 9 = 10000
    (ver scripts/generate-nft-metadata.js:31-41 y attribute "Quantity/Server").
    El contrato NO enforce supply cap por tier. El owner puede mintear 1.000.000
    tier-1 NFTs si quiere — el `gemCodeToTokenId` solo evita duplicar el MISMO
    gemCode, no la cantidad total por tier.
    Adicionalmente, el backend genera `gemCode` con 4-bytes random + 6-char
    salt — espacio enorme, garantiza unicidad pero NO escasez.
  Por qué importa: El valor implícito del NFT depende de la escasez declarada
    en metadata. Si la key se compromete o el dueño actúa de mala fe, puede
    diluir infinitamente. Como el modelo es lotería + canje off-chain (Firestore),
    el operador puede argumentar "el mint no garantiza canje" — pero los buyers
    secundarios en OpenSea no saben eso, demanda legal posible.
  Fix sugerido: Agregar en mintGem:
      mapping(uint8 => uint256) public tierMinted;
      uint256[10] private TIER_CAPS = [0,1,1,5,50,100,500,1000,4000,10000];
      require(tierMinted[gemTier] < TIER_CAPS[gemTier], "Tier supply exhausted");
      tierMinted[gemTier]++;
    Si el modelo de negocio prevé MÁS gemas con el tiempo (otro servidor), el
    cap debe ser per-server-episode, no global. Decisión de producto.
  PoC: owner llama mintGem 100 veces con tier=1 y distintos gemCodes — pasa.

[CRIT-3] tokenURI es mutable post-mint (vía redeploy/upgrade no, pero owner puede no haberlo seteado bien)
  Archivo: contracts/MTBGems.sol:51 (_setTokenURI llamado en mint)
  Categoría: 8. Token URI integrity
  Descripción: ERC721URIStorage de OpenZeppelin v5 expone `_setTokenURI` como
    internal. El contrato lo llama UNA vez en mint y NO expone función pública
    para cambiar URI. ESO ES BUENO. Sin embargo, NO hay una afirmación on-chain
    "URI is immutable" (event o flag). Más relevante: como el owner controla TODO,
    si en un futuro alguien forkea el contrato e introduce `setTokenURI`, los
    holders no tienen garantía contractual de inmutabilidad.
    Adicionalmente, el `tokenURI_` es pasado por el backend en cada llamada y
    NO se valida on-chain que coincida con el tokenURI canónico esperado para
    ese `gemTier`. El backend puede pasar cualquier string (ipfs://, https://,
    "garbage", incluso string vacío — `_setTokenURI` no valida).
  Por qué importa: Si el backend tiene un bug o un atacante con COMPANY_WALLET_KEY
    mintea un NFT con tokenURI apuntando a contenido fraudulento (eg. "este NFT
    vale $1M") y luego vende → fraud. El holder secundario no puede revertirlo.
  Fix sugerido: Opción A (estricta, recomendada para pre-launch):
      mapping(uint8 => string) public canonicalURI; // setable solo por admin
      // En mintGem:
      _setTokenURI(newId, canonicalURI[gemTier]);
      // mintGem ya NO recibe tokenURI_ del caller.
    Opción B: validar que tokenURI_ comience con "ipfs://" y largo >= 50.
  PoC: backend bug — `data.tokenURI || GEM_TOKEN_URIS[(data.gemTier-1)]` en
       functions/index.js:1164. Si `data.tokenURI` se setea por error con un
       valor de otro tier (race en client), el NFT mintea con URI incorrecto
       irreversiblemente.

[CRIT-4] Nonce race condition entre processPendingMints (manual) y mintProcessorScheduled
  Archivo: functions/index.js:1110, 1243-1257
  Categoría: 11. Backend integration + 1. Race conditions
  Descripción: Ambas exports usan `new ethers.Wallet(privateKey, provider)` y
    llaman `contract.mintGem(...)` SIN gestión explícita de nonce. ethers v6
    por defecto fetchea `pendingTransactionCount` la PRIMERA vez y luego
    incrementa local. Si manual + scheduled corren simultáneamente (admin
    aprieta el botón mientras el scheduler tickeа):
      • ambos Wallet instances leen el MISMO nonce inicial
      • ambos envían tx con el MISMO nonce
      • la segunda tx revierte por "nonce too low" o "replacement underpriced"
      • el bucle de retry incrementa attemptCount y eventualmente marca FAILED
        un mint que SÍ se ejecutó (la otra tx lo procesó) — el holder no recibe
        notificación de éxito y el doc Firestore queda corrupto
    Esto YA está documentado en audit_2026_06_14_round2/01_backend_cloud_functions.md
    [MED-11] pero clasificado como MED. Lo subo a CRIT porque:
      • destruye la integridad estado-chain
      • puede causar mints "perdidos" (NFT existe on-chain pero gem queda en
        status 'failed' en Firestore — UX horrible)
      • peor: el atacante puede provocarlo a propósito si tiene acceso al onCall
  Por qué importa: 1 mint perdido = 1 user enojado pidiendo refund. A escala,
    erosiona confianza y abre puerta a soporte abusivo.
  Fix sugerido: Implementar lock distribuido en Firestore:
      doc("meta/mintLock") con {holder, expiresAt}; tomar lock al inicio de
      runMintProcessing con TX atómica; release al final. TTL 10 min para
      auto-liberación si crash. Alternativamente: setear maxInstances:1 en el
      scheduler Y deshabilitar processPendingMints manual (o gateado por flag
      Firestore "mintMaintenance"). Adicionalmente, gestionar nonce explícito:
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      await contract.mintGem(...args, { nonce });
  PoC: 1) admin llama processPendingMints; 2) en el mismo segundo, scheduler
       triggea; 3) si ambos toman el mismo doc pendingMint (no debería por la
       TX en línea 1124, OK), pero si toman docs distintos, ambos envían con
       mismo nonce.

[CRIT-5] Sin protección contra metadata IPFS unpinning — pérdida total del NFT a largo plazo
  Archivo: scripts/upload-to-ipfs.js + scripts/upload-metadata-to-ipfs.js + functions/constants.js:24-34
  Categoría: 8. Token URI integrity
  Descripción: TODO el `image` + metadata vive en IPFS pinned vía Pinata (cuenta
    única, paid). Si:
      • la cuenta Pinata expira / la tarjeta vence / Pinata cierra
      • el desarrollador deja el proyecto
      • Pinata recibe takedown notice (DMCA aleatorio)
    Los NFTs minteados quedan con `tokenURI` apuntando a un CID que ya no se
    sirve. IPFS NO replica automáticamente — solo si OTRO peer lo pineó.
    Adicionalmente, las imágenes mismas (referenciadas DENTRO del JSON) tienen
    su propio CID separado — son DOS puntos de falla independientes.
  Por qué importa: NFTs sin imagen = NFT muertos en marketplaces. Reputación
    catastrófica + posible demanda por "perdieron mi inversión de $100k".
  Fix sugerido:
    1) Pinear los 9 JSON + 9 imágenes en MÚLTIPLES servicios:
       Pinata + Filebase + web3.storage + nft.storage (los gratuitos).
    2) Documentar los CIDs en README del repo público (cualquiera puede
       re-pinearlos si la empresa desaparece).
    3) Considerar Arweave (permanent storage, pago único ~$0.01/file) como
       backup oficial. Cambiar URIs a "ar://<txid>" para los próximos deploys.
    4) Pre-launch: pin desde 3 servicios y guardar credenciales en bóveda.
  PoC: no requiere — falla pasiva temporal.

[CRIT-6] El backend confirma mints con `tx.wait()` SIN especificar confirmations — vulnerable a reorgs en Polygon
  Archivo: functions/index.js:1166
  Categoría: 12. Polygon-específicos
  Descripción: `await tx.wait()` con default es 1 confirmation. Polygon PoS
    tiene reorgs de profundidad 10-20 bloques (documentado oficialmente, y mucho
    más profundo durante incidents — hubo uno de >100 bloques en 2022). El
    código de PAGOS sí usa `SAFE_CONFIRMATIONS = 30` (línea 1431) — pero el de
    MINTS no. Si el mint se incluye en un bloque que luego es reorganizado:
      • Firestore marca status='completed' con un txHash que ya no existe
      • el NFT NO está realmente minteado on-chain
      • el push notification "Your NFT arrived!" sale; user revisa OpenSea: nada
      • el bucle de retry NO se ejecuta porque status ya está 'completed'
  Por qué importa: NFTs reportados como minteados pero inexistentes. Especialmente
    para tier-1 ($100k declarado), un usuario afectado puede demandar.
  Fix sugerido: `const receipt = await tx.wait(30);` — igual que pagos. Considerar
    que esto agrega ~3-5 min de latencia al mint, lo que es aceptable para una
    operación de minutos/horas no-tiempo-real. Alternativamente, post-confirm:
    re-verificar on-chain via `provider.getTransactionReceipt(tx.hash)` y validar
    que `receipt.confirmations >= 30` antes de marcar completed.
  PoC: forzar reorg en Polygon es no-trivial pero histórico — confirmar con
       `cast tx 0x... | grep -i status` después de minteo y check de blocknum.
```

---

### HIGH

```
[HIGH-1] Sin Ownable2Step — transferOwnership single-step a address errónea = pérdida total
  Archivo: contracts/MTBGems.sol:14 (Ownable, no Ownable2Step)
  Categoría: 2. Access Control
  Descripción: `Ownable.transferOwnership(newOwner)` transfiere inmediatamente.
    Si el actual owner (EOA backend) llama transferOwnership a una address
    typeada mal o controlada por error, no hay forma de recuperar. Con
    Ownable2Step, el nuevo owner debe llamar `acceptOwnership()` confirmando
    que controla la key.
  Por qué importa: Riesgo operacional concreto durante la migración a multisig
    (CRIT-1). Un typo en el Safe address = contrato bricked.
  Fix sugerido: Cambiar import a `@openzeppelin/contracts/access/Ownable2Step.sol`
    y herencia. Pero ya planeás migrar a AccessControl — directamente saltar
    Ownable2Step y usar AccessControl con grantRole pendiente de aceptación
    (implementar pattern Pull para cambio de admin si crítico).
  PoC: owner llama transferOwnership(0x0000...dead) — owner = dead, no hay onlyOwner functions accesibles.

[HIGH-2] supportsInterface no declara IERC721Pausable ni ningún otro adicional
  Archivo: contracts/MTBGems.sol:98-103
  Categoría: 3. ERC-721 compliance
  Descripción: El contrato hereda ERC721, ERC721URIStorage y ERC721Pausable.
    Pero `supportsInterface` solo overridea ERC721 + ERC721URIStorage. ERC721Pausable
    no tiene su propio interfaceId estándar (OZ no lo expone), entonces this is OK.
    PERO: el contrato implementa eventos custom (`GemMinted`) que cazadores de
    interfaces no detectan. Más importante: si en el futuro se agrega un módulo
    (e.g., ERC2981 royalties), olvidarse el override → marketplaces no detectan
    royalties.
  Por qué importa: Hoy NO hay royalties → OpenSea/Magic Eden no envían fee al creador.
    Para tier-1 $100k, perder 5% en cada secundary = -$5k cada flip.
  Fix sugerido:
    • Pre-launch: agregar OZ ERC2981 con `_setDefaultRoyalty(treasury, 500)` (5%).
      Esto exige sumar el interfaceId al supportsInterface.
    • Decisión de producto si queremos royalties.
  PoC: opensea.io/0x54c2.../1 — no aparece "Creator earnings 5%" en UI.

[HIGH-3] `_safeMint` ejecuta callback `onERC721Received` ANTES de `_setTokenURI`
  Archivo: contracts/MTBGems.sol:50-51
  Categoría: 1. Reentrancy + 3. ERC-721 compliance
  Descripción: Orden actual:
      gemCodeToTokenId[gemCode] = newId;  // OK
      tokenTier[newId] = gemTier;          // OK
      tokenGemCode[newId] = gemCode;       // OK
      _safeMint(to, newId);  // ← invoca onERC721Received en `to` si es contract
      _setTokenURI(newId, tokenURI_);  // ← se setea DESPUÉS del callback
    Un receiver malicioso (contract en `to`) puede, durante onERC721Received,
    leer `tokenURI(newId)` y obtener "" (string vacío) porque ERC721URIStorage
    no tiene baseURI seteado. La función `tokenURI` viewer return "" antes del
    set. Esto NO es exploit directo (ya quedó minteado con balance correcto y
    el URI se setea inmediatamente después), pero rompe la invariante "si
    onERC721Received fue llamado entonces el token tiene URI".
    `nonReentrant` previene reentry a mintGem, pero NO previene que el receiver
    haga otras llamadas (e.g., listar el NFT en un marketplace ANTES de que el
    URI esté seteado).
  Por qué importa: Caso edge raro (la mayoría de mints van a EOAs), pero un
    bot agresivo que automatice listings inmediatamente en onERC721Received
    puede listar un NFT sin metadata, confundiendo a buyers.
  Fix sugerido: Setear URI ANTES del safeMint:
      _setTokenURI(newId, tokenURI_); // pre-mint hook funciona — _setTokenURI
                                       // solo escribe mapping interno, no requiere
                                       // que el token exista (verificar OZ v5 doc)
      _safeMint(to, newId);
    En OZ v5, `_setTokenURI` NO requiere ownership previa. Confirmar en docs:
    https://docs.openzeppelin.com/contracts/5.x/api/token/erc721#ERC721URIStorage-_setTokenURI
  PoC: deploy MaliciousReceiver con onERC721Received que hace
       `IERC721Metadata(msg.sender).tokenURI(tokenId)` → return "".

[HIGH-4] No hay batchMint — operaciones masivas requieren N transactions = costoso y lento
  Archivo: contracts/MTBGems.sol (ausencia)
  Categoría: 7. Gas optimization + 10. Manual mint specifics
  Descripción: Si el dueño tiene 50 winners para mintear (después de un episodio
    grande), envía 50 transactions independientes. Polygon gas ~30 gwei × ~120k
    gas/mint × 50 = ~$0.20-2 (aceptable hoy, costoso en spikes). Más relevante:
    cada tx puede fallar individualmente (RPC dropped, gas estimation off,
    nonce conflict — ver CRIT-4). UX/ops degradado.
  Por qué importa: Costo de operación + riesgo de fallos parciales en payouts
    masivos (gem found en pico de tráfico = N mints simultáneos).
  Fix sugerido: Agregar batchMint protegido por onlyOwner + nonReentrant + cap:
      function batchMintGem(
          address[] calldata tos,
          uint8[] calldata tiers,
          string[] calldata codes,
          string[] calldata uris
      ) external onlyOwner nonReentrant {
          uint256 len = tos.length;
          require(len == tiers.length && len == codes.length && len == uris.length, "len");
          require(len <= 50, "batch too large"); // cap para evitar gas-bomb DoS
          for (uint256 i = 0; i < len; i++) {
              _mintGemInternal(tos[i], tiers[i], codes[i], uris[i]);
          }
      }
    El backend agruparía los pendingMints por batches. Atomicidad mejor —
    si uno falla en el batch (e.g., gemCode duplicado), todo revierte → no hay
    partial state.
  PoC: backend con 50 winners; medir 50 txs vs 1 batch tx; latencia + costo.

[HIGH-5] `gemCodeToTokenId == 0` check es bypaseable si _nextTokenId comenzara desde 0
  Archivo: contracts/MTBGems.sol:37, 39
  Categoría: 1. Reentrancy + 4. Integer
  Descripción: El check `require(gemCodeToTokenId[gemCode] == 0, "Gem already minted")`
    asume que tokenId nunca es 0. El contrato usa `++_nextTokenId` (pre-increment),
    así que el PRIMER mint es tokenId=1 y la asunción se cumple. ESTO ES CORRECTO
    HOY pero frágil: si en una refactor futura se cambia a `_nextTokenId++`
    (post-increment, devuelve 0 primero), el primer mint sería tokenId=0 y
    rompería todo el sistema de unicidad de gemCode.
    Adicionalmente, `tokenTier[0]`, `tokenGemCode[0]` quedan con valores default,
    indistinguibles de "tier 0 / no code". Cualquier código que itere desde 0
    se confunde.
  Por qué importa: Trampa para futuras refactors. Defense-in-depth mínimo.
  Fix sugerido: Reemplazar el check por una sentinel boolean explícita:
      mapping(string => bool) public gemCodeUsed;
      require(!gemCodeUsed[gemCode], "Gem already minted");
      gemCodeUsed[gemCode] = true;
      gemCodeToTokenId[gemCode] = newId;  // sigue siendo útil para lookup
  PoC: hipotético — solo si alguien cambia el pre-increment.

[HIGH-6] El backend NO valida que `walletAddress` en pendingMint coincida con users/{uid}/walletAddress
  Archivo: functions/index.js:608-657 (claimGemNFT) + 1146 (validación processor)
  Categoría: 11. Backend integration
  Descripción: claimGemNFT acepta `walletAddress` del body sin chequear que
    coincida con la wallet registrada (cooldown 24h en setUserWallet). El user
    crea su pendingMint con cualquier wallet válida. El processor solo valida
    formato (`/^0x[a-fA-F0-9]{40}$/`) — no que sea la wallet del user.
    Esto YA está documentado en audit_2026_06_14_round2/01 como [MED-9].
    Lo elevo a HIGH (en contexto del contrato): bypasea el control anti-hot-swap
    que era el ÚNICO mecanismo defensivo en caso de account takeover.
  Por qué importa: Si atacante obtiene token Bearer (intercepta, XSS, malware
    en cliente), puede claimar TODAS las gemas pending hacia su wallet sin
    pasar por setUserWallet — el cooldown 24h es inútil.
  Fix sugerido: En claimGemNFT, eliminar el param `walletAddress` del body:
      const walletAddress = userSnap.data().walletAddress; // forced server-side
      if (!walletAddress) throw HttpsError("failed-precondition", "wallet_not_set");
    El user DEBE haber pasado por setUserWallet (con cooldown) primero.
  PoC: en consola del cliente con Bearer activo:
       firebase.functions().httpsCallable('claimGemNFT')({
         gemId: '...', walletAddress: '0xATTACKER...' })

[HIGH-7] Sin RPC failover — un solo endpoint público para todo el sistema
  Archivo: functions/index.js:1109, 1435
  Categoría: 11. Backend integration + 12. Polygon-específicos
  Descripción: `new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com")`
    hardcoded. publicnode.com es free pero:
      • rate-limit estricto (10 req/s, sin guarantías)
      • puede caer sin previo aviso
      • respuestas inconsistentes durante reorgs (free providers no garantizan
        block freshness)
    Cuando se cae:
      • mintProcessorScheduled falla todos sus mints
      • cryptoPaymentProcessorScheduled deja de detectar pagos
      • TODOS los attemptCounts suben → mints marcados failed después de 5
        retries seguidos (~25 minutos de outage)
  Por qué importa: Operational risk concreto y recurrente.
  Fix sugerido: Provider fallback chain con FallbackProvider:
      const providers = [
        new ethers.JsonRpcProvider("https://polygon-rpc.com"),
        new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com"),
        new ethers.JsonRpcProvider(`https://polygon-mainnet.infura.io/v3/${INFURA_KEY}`),
      ];
      const provider = new ethers.FallbackProvider(providers, 137);
    Y agregar INFURA_KEY (o Alchemy) como Firebase secret. Mejor: pagar $50/mes
    a Alchemy o QuickNode para SLA garantizado.

[HIGH-8] La key del owner (COMPANY_WALLET_KEY) no tiene plan de rotación
  Archivo: contract MTBGems.sol + functions/index.js:1088
  Categoría: 5. Secrets / credentials + 2. Access Control
  Descripción: El owner del contrato es la EOA derivada de COMPANY_WALLET_KEY.
    Para rotar la key hay que llamar `transferOwnership(newAddress)` desde la
    actual EOA. PERO:
      • si la key actual se compromete, no podés rotarla — el atacante también
        puede llamar transferOwnership PRIMERO
      • no hay timelock, no hay multisig, no hay confirmación 2-step (ver HIGH-1)
      • el repo no documenta cuándo/cómo rotar
  Por qué importa: Best practice de secret management = rotar cada 90 días.
    Acá es imposible sin un redeploy o sin pasar por AccessControl con
    grantRole(MINTER_ROLE, newKey) + revokeRole(MINTER_ROLE, oldKey).
  Fix sugerido: Otra razón para CRIT-1 (migrar a AccessControl). Con MINTER_ROLE
    revocable desde admin (Gnosis Safe), la rotación es:
      safe.grantRole(MINTER_ROLE, newMinterEOA);
      safe.revokeRole(MINTER_ROLE, oldMinterEOA);
    Costo: 2 txs de Safe. Sin downtime.
  PoC: intentar rotar hoy = redeployar contrato.

[HIGH-9] Sin gas price strategy explícita — vulnerable a "underpriced/stuck" transactions
  Archivo: functions/index.js:1160 (contract.mintGem sin opciones)
  Categoría: 11. Backend integration
  Descripción: ethers por default usa `provider.getFeeData()` para sugerir
    EIP-1559 fees. En Polygon, durante congestion (e.g., MEV bots), este default
    puede quedar muy bajo y la tx se queda 'pending' hasta que el pool la dropea.
    No hay:
      • mecanismo de reemplazo (replace tx con +20% gas)
      • escalación de fees por retry (el retry usa default de nuevo, MISMO problema)
      • cap superior de gas (puede pagar 1000 gwei en un spike, drain del wallet)
  Por qué importa: Operational. Mints quedan stuck por horas. attemptCount sube,
    mint marca failed pero on-chain SÍ se ejecutó tarde = inconsistencia.
  Fix sugerido:
      const feeData = await provider.getFeeData();
      const maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n; // 30% buffer
      const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 150n) / 100n; // 50% tip
      const GAS_CAP_GWEI = 500n;
      const cap = GAS_CAP_GWEI * 1000000000n;
      const tx = await contract.mintGem(...args, {
        maxFeePerGas: maxFeePerGas < cap ? maxFeePerGas : cap,
        maxPriorityFeePerGas,
      });
    Y en el retry, escalar 20% más cada intento.

[HIGH-10] Sin verificación post-tx de que el event GemMinted realmente ocurrió on-chain
  Archivo: functions/index.js:1166-1177
  Categoría: 11. Backend integration
  Descripción: El código parsea `receipt.logs` para extraer tokenId. SI el
    parse falla (e.g., el log tiene formato distinto, o el contrato fue
    upgrado/cambiado entre tanto y devuelve diferente evento), `tokenId`
    queda null y se marca status='completed' igual. El doc dice tokenId:null
    y txHash:<x>. El user recibe push con "Token #" (vacío).
    Adicionalmente, si la tx revierte SILENCIOSAMENTE (raro pero posible con
    revert sin mensaje), tx.wait() devuelve receipt con status=0 — el código
    NO chequea receipt.status.
  Por qué importa: NFTs reportados como minteados pero el evento no existe
    on-chain — corrupción del estado Firestore vs blockchain.
  Fix sugerido:
      const receipt = await tx.wait(30);
      if (receipt.status !== 1) throw new Error("tx reverted on-chain");
      // parse logs
      if (tokenId === null) throw new Error("GemMinted event not found in receipt");
      // double-check on-chain:
      const ownerOnChain = await new ethers.Contract(MTBGEMS_CONTRACT,
        ["function ownerOf(uint256) view returns (address)"], provider)
        .ownerOf(tokenId);
      if (ownerOnChain.toLowerCase() !== data.walletAddress.toLowerCase()) {
        throw new Error("ownership mismatch — possible reorg or attack");
      }
```

---

### MEDIUM

```
[MED-1] `_nextTokenId` arranca en 0 — tokenIds son secuenciales y predecibles
  Archivo: contracts/MTBGems.sol:15, 39
  Categoría: 5. Front-running / MEV
  Descripción: tokenId 1, 2, 3... predecible. Para un sistema de lotería con
    drops random (cubo aleatorio), saber el próximo tokenId no da ventaja MEV
    real porque el receiver lo determina el backend (`to=walletAddress`). Pero
    si en el futuro alguien hace un "claim mint" donde el user firma la tx,
    saber el próximo tokenId podría usarse para front-run (e.g., approve flow).
  Por qué importa: Hoy NO es exploit. Futuro-proofing.
  Fix sugerido: Mantener secuencial está bien para auditabilidad. Documentar
    explícitamente que tokenId no debe usarse como random seed para nada.

[MED-2] `_increaseBalance` no se usa en el path actual pero el override es ruidoso
  Archivo: contracts/MTBGems.sol:81-85
  Categoría: 6. Storage / state
  Descripción: El override solo llama super. ERC721 base lo invoca durante
    operaciones internas (transfer batch, etc.). El override es necesario porque
    OZ v5 lo declara `virtual`. No hay bug, pero podría considerarse if el
    override debería bloquear si paused (defense in depth).
  Por qué importa: Cosmetic.
  Fix sugerido: Dejar como está. Documentar por qué existe.

[MED-3] Pause bloquea TRANSFERS pero no `approve`/`setApprovalForAll`
  Archivo: contracts/MTBGems.sol:74-79 (override _update only)
  Categoría: 9. Pausable
  Descripción: ERC721Pausable.pause solo pausa `_update` (que cubre mint,
    transfer, burn). NO pausa:
      • approve(spender, tokenId)
      • setApprovalForAll(operator, true)
    Si un atacante hackea la wallet de un holder y queremos pausar el contrato
    para protegerlo, el atacante puede aún:
      1) setApprovalForAll(MarketplaceMalicioso, true) — pasa
      2) Cuando unpause, marketplace ejecuta transfer inmediato
    No es pánico, pero el "pause" no es escudo completo.
  Por qué importa: Si confías en pause para frenar exploits, sabé que approvals
    siguen funcionando.
  Fix sugerido: Override approve/setApprovalForAll para usar whenNotPaused:
      function approve(address to, uint256 tokenId) public override(ERC721, IERC721) whenNotPaused {
          super.approve(to, tokenId);
      }
      function setApprovalForAll(address operator, bool approved) public override(ERC721, IERC721) whenNotPaused {
          super.setApprovalForAll(operator, approved);
      }
    Importar Pausable's whenNotPaused modifier explicitly. Considerá si esto es
    deseable — bloquear approvals afecta usuarios legítimos también.

[MED-4] No hay event Paused/Unpaused custom — ERC721Pausable usa los de Pausable
  Archivo: contracts/MTBGems.sol:66-71
  Categoría: 3. ERC-721 compliance + 8. Storage / state
  Descripción: OZ Pausable.sol emite `Paused(address account)` / `Unpaused(address)`.
    OK, está cubierto.
  Por qué importa: No problema.
  Fix sugerido: N/A.

[MED-5] tokenURI strings en storage cuestan caro
  Archivo: contracts/MTBGems.sol:51 (_setTokenURI por token)
  Categoría: 7. Gas optimization
  Descripción: Cada mint guarda ~70 bytes en storage (string IPFS CID). A 21k
    gas por SSTORE de slot nuevo y ~5k por slot 32-bytes adicional, cada mint
    cuesta ~50-70k gas extra solo por el URI. Alternativa: baseURI + tokenId.
    Pero porque tokenURI por tier difiere (mismo URI para todos los tier 1, mismo
    para todos los tier 2, etc.), no funciona baseURI directo.
    Patrón eficiente:
      mapping(uint8 => string) private _tierURI;  // 9 slots fijos, set 1 vez
      function tokenURI(uint256 tokenId) public view override returns (string memory) {
          return _tierURI[tokenTier[tokenId]];
      }
    Ahorra ~50k gas por mint × 16.000 mints futuros = ~$0.40 × 16k = $6400 de gas
    a 30 gwei. Marginal pero real.
  Por qué importa: $6k de gas ahorrable + arquitectónicamente más limpio.
  Fix sugerido: En el redeploy pre-launch, eliminar `_setTokenURI` per-token
    y usar mapping per-tier. Eliminar también ERC721URIStorage de la herencia
    (no se necesita).
  Bonus: si querés cambiar metadata de un tier (fix typo, mejorar imagen, ANTES
  de mints), podés setear vía setTierURI(tier, newURI) — útil pre-launch.

[MED-6] `gemCodeToTokenId(string)` mapping cuesta caro por key
  Archivo: contracts/MTBGems.sol:17
  Categoría: 6. Storage / state + 7. Gas optimization
  Descripción: keccak256(abi.encodePacked(gemCode)) para cada lookup. Cada mint
    almacena el gemCode string en `tokenGemCode[newId]`. El mapping inverso
    (gemCodeToTokenId) es OK porque solo escribe key=string→value=uint, pero
    `tokenGemCode[newId] = gemCode` guarda el string completo en storage —
    ~30-40 bytes × 16k mints = ~500kb de storage on-chain.
    Si el gemCode es derivable off-chain (es generated by helpers.js:136 — random),
    NO hay necesidad de almacenarlo on-chain para auditabilidad PORQUE el evento
    `GemMinted(tokenId, to, tier, gemCode)` ya lo emite — los eventos viven en
    los logs, NO en storage (mucho más barato).
  Por qué importa: ~$0.50 extra por mint en gas (negligible per-mint, sumable).
  Fix sugerido: Eliminar `tokenGemCode` mapping. La info está en el evento
    GemMinted (indexable off-chain via getLogs). Dejar solo gemCodeToTokenId
    como anti-duplicate index. Mejor: hash el gemCode y usar bytes32:
      mapping(bytes32 => uint256) public gemCodeHashToTokenId;
      bytes32 codeHash = keccak256(bytes(gemCode));
      require(gemCodeHashToTokenId[codeHash] == 0, "...");
      gemCodeHashToTokenId[codeHash] = newId;
    Menos storage que string→uint.

[MED-7] `_pause` y `_unpause` son función pública para owner — pero el comentario sugiere "exploit detectado" como uso
  Archivo: contracts/MTBGems.sol:66-71
  Categoría: 9. Pausable
  Descripción: OK funcionalmente. El comentario "ALTO-80" sugiere que el contexto
    es defensivo. Pero el owner EOA (CRIT-1) puede pausar a voluntad. Sin
    multisig, esto es punto único de denial-of-service: si la key se compromete,
    atacante pausea indefinidamente → ningún user puede recibir gemas hasta
    que el dueño legítimo (sin la key) interventa via redeploy.
  Por qué importa: DoS. Misma raíz que CRIT-1.
  Fix sugerido: AccessControl PAUSER_ROLE separado de MINTER_ROLE; PAUSER_ROLE
    solo a Gnosis Safe (manual response, no a backend EOA).

[MED-8] No hay timelock en operaciones admin sensibles
  Archivo: contracts/MTBGems.sol (ausencia)
  Categoría: 2. Access Control
  Descripción: Si en el futuro se agrega setBaseURI, setRoyalty, etc., todas
    son instant-effect. Para holders en marketplaces secundarios, esto significa
    cero ventana para reaccionar a cambios maliciosos. Best practice de DeFi:
    TimelockController de OZ con 48h delay para operaciones de admin.
  Por qué importa: Trust scoring. Buyers savvy revisan si el contrato tiene
    timelock. Aumenta valor secundario.
  Fix sugerido: Post-launch, mover ownership/admin del contrato a TimelockController
    cuyo proposer sea el Gnosis Safe. Delay 48h. Solo aplica a operaciones del
    DEFAULT_ADMIN_ROLE (granting MINTER_ROLE, set royalty, etc.). MINTER_ROLE en
    sí no necesita timelock (mints son por-acción, no globales).

[MED-9] Sin verificación que el contrato esté verificado en PolygonScan
  Archivo: meta / deployment
  Categoría: 14. Upgradability / immutability
  Descripción: No hay scripts/verify*.js ni hardhat config para verify en
    PolygonScan. Si el contrato deployed NO está verificado, marketplaces y
    holders no pueden inspeccionar el source code — gran red flag para buyers.
  Por qué importa: Trust. OpenSea avisa "Contract not verified" → buyers se
    asustan → no compran → no hay mercado secundario.
  Fix sugerido: Verificar en PolygonScan ahora. Si fue deployed con Remix,
    usar el flow "Verify and Publish" de PolygonScan con flattened source.
    Mejor: pre-launch redeploy via Hardhat con `npx hardhat verify` automatizado.
  Comprobación manual obligatoria: visitar
    https://polygonscan.com/address/0x54c2859411afCb51fcfE42054aDcA3484B3f29E6#code
    Si dice "Contract Source Code Verified" → OK. Si no → ALTA prioridad.

[MED-10] El evento GemMinted incluye `string gemCode` no indexed — costoso para queries
  Archivo: contracts/MTBGems.sol:21
  Categoría: 7. Gas optimization
  Descripción: `event GemMinted(uint256 indexed tokenId, address indexed to, uint8 tier, string gemCode)`.
    Solo 2 indexed params, gemCode es bulk data. Cost OK. Para filtrar por
    gemCode off-chain, hay que iterar todos los logs (ineficiente). Si esto
    se necesita (search "where is gem MTB1-1234-5678?"), agregar como indexed
    requiere usar el HASH del string (Solidity limita indexed strings a hash).
  Por qué importa: Cost de logs es bajo. Solo afecta query eficiency.
  Fix sugerido: Si necesitás query por gemCode:
      event GemMinted(uint256 indexed tokenId, address indexed to, uint8 indexed tier, bytes32 gemCodeHash, string gemCode);
    Indexed bytes32 = queryable; string gemCode = human-readable in receipt.

[MED-11] CIDs en GEM_TOKEN_URIS (constants.js) son bafkrei... → CIDv1 sha256 sin prefijo de codec — verificar
  Archivo: functions/constants.js:25-33
  Categoría: 8. Token URI integrity
  Descripción: Los CIDs son CIDv1 con multihash sha2-256. `bafkrei` prefix
    indica raw data leaves (no dag-pb). Esto es correcto para JSON files
    subidos via Pinata `pinataOptions.cidVersion: 1`. OK funcionalmente.
    PERO: no hay validación en CI que estos CIDs hagan resolve a JSON parseable
    con shape esperado. Si alguien rota un CID en un PR, no se detecta.
  Por qué importa: Bug latente: copy-paste de CID errado en constants.js → mint
    de NFT con metadata distinta → buyer compra "Diamante rojo" recibe "Esmeralda".
  Fix sugerido: Test en functions/test/ que fetchea cada CID de IPFS gateway
    y valida JSON shape:
      describe('GEM_TOKEN_URIS integrity', () => {
        GEM_TOKEN_URIS.forEach((uri, i) => {
          test(`tier ${i+1} resolves with correct tier`, async () => {
            const cid = uri.replace('ipfs://', '');
            const res = await fetch(`https://ipfs.io/ipfs/${cid}`);
            const json = await res.json();
            const tierAttr = json.attributes.find(a => a.trait_type === 'Tier');
            expect(tierAttr.value).toBe(i + 1);
          });
        });
      });
    Correr en CI pre-deploy.

[MED-12] processedTxs cubre PAGOS USDC pero NO MINTS
  Archivo: functions/index.js:1179, 1487-1521
  Categoría: 11. Backend integration
  Descripción: Para pagos USDC, hay idempotency por txHash en processedTxs.
    Para MINTS, NO hay equivalente. Si runMintProcessing se ejecuta dos veces
    sobre el mismo doc pendingMint por algún bug (race entre 'pending' release
    y 'processing' set), podría enviar 2 txs de mintGem. La SEGUNDA reverte
    por `require(gemCodeToTokenId[gemCode] == 0)` — entonces hay protección
    on-chain. Pero atacante con la key podría re-enviar manualmente, gastando
    gas. La protección Firestore (línea 1124-1131) es atómica y debería bastar.
  Por qué importa: Defense in depth.
  Fix sugerido: Agregar processedMints/{mintId} análogo a processedTxs si
    se quiere paridad.

[MED-13] El backend `runMintProcessing` no maneja "tx dropped from mempool"
  Archivo: functions/index.js:1166
  Categoría: 11. Backend integration
  Descripción: `tx.wait()` puede quedar colgado indefinidamente si la tx fue
    dropeada del mempool antes de minarse (gas underpriced, mempool full).
    Cloud Functions tienen timeout default 60s — la function se mata.
    Status del doc queda en 'processing' indefinitely.
    runMintProcessing en su próximo run busca status==pending — el doc en
    'processing' queda olvidado para siempre.
  Por qué importa: Mints estancados. UX horrible.
  Fix sugerido:
    1) tx.wait con timeout:
       const receipt = await Promise.race([
         tx.wait(30),
         new Promise((_, rej) => setTimeout(() => rej(new Error('tx_timeout')), 120000))
       ]);
    2) En el query inicial, también recoger docs status=='processing' con
       startedAt < Date.now() - 10*60*1000 (10 min stale) para retry.
    3) Antes de retry, verificar on-chain si la tx fue minada vía
       provider.getTransactionReceipt(stuckTxHash).
```

---

### LOW

```
[LOW-1] Documentación inline en español mezclada con código
  Archivo: contracts/MTBGems.sol:2-5, 41-44, 57-59
  Categoría: code style
  Descripción: Comentarios en español ("CRIT-26: aplicamos Checks-Effects-Interactions").
    El estándar de auditorías externas espera inglés. Si planeás contratar
    auditoría externa (ConsenSys Diligence, OpenZeppelin Audits), pedirán
    re-traducir. Cost adicional.
  Por qué importa: Operacional. No security.
  Fix sugerido: Traducir comentarios a inglés antes de la auditoría profesional.

[LOW-2] No hay NatSpec docstrings
  Archivo: contracts/MTBGems.sol (entero)
  Categoría: documentation
  Descripción: Faltan /// @notice /// @param /// @return en funciones públicas.
    NatSpec se usa para generar docs y muestra en Etherscan UI.
  Por qué importa: Buyers verifican Etherscan. Sin descripciones de funciones,
    parece amateur.
  Fix sugerido: Agregar NatSpec a mintGem, pause, unpause, totalMinted, tokenURI,
    supportsInterface.

[LOW-3] No hay `IERC4906` (metadata update event) — buyers no se enteran si cambias URI
  Archivo: contracts/MTBGems.sol (ausencia)
  Categoría: 3. ERC-721 compliance
  Descripción: ERC4906 es el estándar para que marketplaces detecten cambios
    de metadata (event MetadataUpdate). No relevante hoy porque el URI es
    inmutable post-mint. Si lo hicieras mutable (CRIT-3 fix opción A con
    setCanonicalURI per tier), debería emitir BatchMetadataUpdate.
  Por qué importa: Solo si harías upgrade de metadata.
  Fix sugerido: En el redeploy con setTierURI, emitir BatchMetadataUpdate.

[LOW-4] No hay function `burn` exposed — los holders no pueden quemar su NFT
  Archivo: contracts/MTBGems.sol (ausencia)
  Categoría: 3. ERC-721 compliance
  Descripción: ERC721 base tiene `_burn` internal pero el contrato no expone una
    función pública burn. Holders no pueden quemar voluntariamente. No es
    requerido por spec, pero conventional para wallets que quieran limpiar
    NFTs que no quieren. Si el modelo es "redimís el NFT y se quema", entonces
    sí necesitás burn.
  Por qué importa: El modelo de negocio dice "canje fuera de cadena via Firestore +
    form web" — no quemás el NFT al canjear. ENTONCES el holder conserva el NFT
    "redimido" para siempre. Buyer secundario lo compra creyendo que es
    canjeable → ya no lo es → fraud claim posible.
  Fix sugerido: AL CANJEAR, el contrato debe quemar el NFT (o marcarlo como
    "redeemed" on-chain con flag inmutable). Implementar:
      mapping(uint256 => bool) public redeemed;
      event GemRedeemed(uint256 indexed tokenId, address indexed redeemer);
      function markRedeemed(uint256 tokenId) external onlyOwner whenNotPaused {
          require(!redeemed[tokenId], "Already redeemed");
          redeemed[tokenId] = true;
          emit GemRedeemed(tokenId, ownerOf(tokenId));
      }
    Cuando el admin procesa el cash claim off-chain, llama markRedeemed.
    Marketplaces lo muestran via attribute custom o queryable.
    Alternativa más limpia: contract burn-on-redeem que requiere approve.

[LOW-5] `pragma solidity ^0.8.20` permite versiones futuras potencialmente breaking
  Archivo: contracts/MTBGems.sol:6
  Categoría: 14. Upgradability / immutability
  Descripción: Caret `^` permite 0.8.20 hasta 0.8.99 (semver minor). Cambios
    de compiler entre minors pueden afectar bytecode si se recompila. Para
    reproducibilidad estricta, pinear versión exacta.
  Por qué importa: Reproducible builds. Cuando el contrato se verifica en
    PolygonScan, debes saber EXACTAMENTE qué compiler version.
  Fix sugerido: `pragma solidity 0.8.27;` (o la versión exacta usada).

[LOW-6] No hay safeguard contra `to == address(this)`
  Archivo: contracts/MTBGems.sol:34
  Categoría: 3. ERC-721 compliance
  Descripción: Solo se valida `to != address(0)`. Si el owner accidentalmente
    pasa `to = address(this)`, el NFT se mintea al contrato. ERC721 lo permite,
    el contrato no implementa onERC721Received → revert por safeMint check.
    PERO: si en el futuro alguien agrega ERC721Holder herencia, queda
    accesible. Bug-trap.
  Por qué importa: Edge case raro.
  Fix sugerido: `require(to != address(this), "Cannot mint to contract self");`

[LOW-7] No hay tests del contrato — 0 cobertura
  Archivo: ausencia de tests Solidity
  Categoría: 15. Testing
  Descripción: No hay tests Hardhat/Foundry para el contrato. Los únicos tests
    en el repo son JS (helpers, rules). Pre-launch sin tests del contrato es
    operacional risk alto: cualquier futuro cambio no tiene safety net.
  Por qué importa: Refactor risk. Compliance con buenas prácticas.
  Fix sugerido: Mínimo viable: Foundry o Hardhat con tests para:
      • Mint flow: OK con onlyOwner, revert con random caller
      • Re-mint mismo gemCode revierte
      • Tier 0 / Tier 10 revierten
      • Empty gemCode revierte
      • Mint to address(0) revierte
      • Pause bloquea mint, unpause libera
      • Renounce revierte
      • Reentrancy: MaliciousReceiver intenta re-entrar, falla
      • tokenURI return correcto post-mint
      • supportsInterface(0x80ac58cd) = true (IERC721)
      • supportsInterface(0x5b5e139f) = true (IERC721Metadata)

[LOW-8] No hay constantes para gemTier bounds (1-9 hardcoded)
  Archivo: contracts/MTBGems.sol:35
  Categoría: code style
  Descripción: `require(gemTier >= 1 && gemTier <= 9, "Invalid tier");`
    Magic number. Mejor:
      uint8 public constant MIN_TIER = 1;
      uint8 public constant MAX_TIER = 9;
  Por qué importa: Maintainability.
  Fix sugerido: Constantes públicas.

[LOW-9] `tokenTier` mapping leakage — public getter expone tier de cualquier tokenId
  Archivo: contracts/MTBGems.sol:18
  Categoría: 13. Privacy / metadata leakage
  Descripción: `mapping(uint256 => uint8) public tokenTier` con visibilidad public
    genera getter automático. Cualquiera puede leer el tier de cualquier tokenId.
    Esto está en el evento de cualquier modo, y en metadata, así que no es
    privacy leak — solo redundante.
  Por qué importa: Cosmetic.
  Fix sugerido: Mantener public para usabilidad. No issue.

[LOW-10] El nombre del contrato emite metadata privada — display name "Mining The Blocks Gems"
  Archivo: contracts/MTBGems.sol:24
  Categoría: 13. Privacy / metadata leakage
  Descripción: El nombre + símbolo se eligen permanentes. "MTBG" tiene riesgo
    de colisión con otros símbolos populares. Verificar OpenSea collection
    search antes de lanzar.
  Por qué importa: Discoverability.
  Fix sugerido: Buscar "MTBG" en CoinGecko/CMC; si colisiona, considerar
    "MTBGEM" o similar. Si se cambia, requiere redeploy.

[LOW-11] Mapping `gemCodeToTokenId` no se limpia al burn — DoS de gemCode reuse
  Archivo: contracts/MTBGems.sol (sin burn, aplica solo si se agrega)
  Categoría: 6. Storage / state
  Descripción: Si se agrega burn público (LOW-4), `gemCodeToTokenId[oldCode]`
    sigue apuntando al tokenId quemado. Re-mintear el mismo gemCode revierte.
    Esto puede ser intencional (gemCodes son únicos forever — anti-replay) o
    bug, depende del modelo.
  Por qué importa: Para el modelo actual (gemCodes random, no reusables) está
    bien. Si quisieras re-mintear post-burn, requiere limpiar.

[LOW-12] No hay event de configuración (e.g., ContractDeployed)
  Archivo: contracts/MTBGems.sol:23-26 constructor
  Categoría: 8. Logging
  Descripción: Constructor no emite event. Marketplaces tienen que escanear todos
    los bloques para encontrar el deploy. Hoy no es problema (CMC, Etherscan
    detectan), pero es buena práctica:
      event ContractDeployed(address owner, string name, string symbol);
  Por qué importa: Mínimo.
  Fix sugerido: Emitir event en constructor.

[LOW-13] `nonReentrant` redundante si _safeMint es el único external call
  Archivo: contracts/MTBGems.sol:33
  Categoría: 1. Reentrancy
  Descripción: Defense in depth — el comentario explica bien por qué. Con CEI
    correcto, nonReentrant es redundante. Pero el cost ~2400 gas extra por
    mint vs el costo de un bug latente: vale la pena.
  Por qué importa: N/A — está bien tenerlo.
  Fix sugerido: Dejar como está.

[LOW-14] No hay limite máximo de gemCode length
  Archivo: contracts/MTBGems.sol:36
  Categoría: 4. Integer / 6. Storage
  Descripción: `require(bytes(gemCode).length > 0, "Empty gemCode")` solo check
    lower bound. Un atacante con la key (= owner) podría mintear con gemCode
    de 100kb, gastando gas absurdo. Defense-in-depth: cap en 50 bytes.
  Por qué importa: Theoretical — solo si owner es malicioso.
  Fix sugerido: `require(bytes(gemCode).length > 0 && bytes(gemCode).length <= 50, "Invalid gemCode length");`

[LOW-15] `tokenURI_` no tiene length check
  Archivo: contracts/MTBGems.sol:32
  Categoría: 4. Integer / 6. Storage
  Descripción: Mismo issue. URI de 100kb posible. ipfs:// + CIDv1 ~ 65 chars max.
  Por qué importa: Theoretical.
  Fix sugerido: `require(bytes(tokenURI_).length > 0 && bytes(tokenURI_).length <= 200, "Invalid URI length");`
```

---

### INFO

```
[INFO-1] El `external_url` en metadata apunta a "miningtheblocks.com" — verificar control del dominio
  Archivo: docs/gems/metadata/*.json + assets/gems/metadata/*.json
  Descripción: Si el dominio expira o se transfiere, los NFTs apuntan a un
    sitio que el atacante controla. Pattern de scam clásico.
  Fix sugerido: Configurar auto-renewal en Cloudflare Registrar (ya está,
    según el comentario en generate-nft-metadata.js:58). Confirmar.

[INFO-2] Polygon PoS está siendo migrado a Polygon zkEVM — verificar continuidad
  Descripción: Polygon Labs ha hablado de "Polygon 2.0" donde PoS chain se vuelve
    una zkEVM L2 de Polygon. Los contratos deberían seguir funcionando, pero
    verificar comms oficiales antes del launch.
  Fix sugerido: No-action urgente. Trackear https://polygon.technology/blog.

[INFO-3] El contrato heredado tiene 5 niveles de herencia
  Descripción: ERC721 → ERC721URIStorage + ERC721Pausable + Ownable + ReentrancyGuard.
    Diamond inheritance correctly resuelto con explicit overrides. OK.

[INFO-4] El `gemCode` se usa como business key, no como cryptographic identifier
  Archivo: functions/helpers.js:136 (generateGemCode)
  Descripción: Generated con randomBytes — unguessable y unique. Bien.

[INFO-5] El comentario CRIT-26 admite "el contrato deployado en mainnet sigue siendo el viejo"
  Archivo: contracts/MTBGems.sol:3
  Descripción: CONFIRMA que la versión deployada NO tiene los fixes recientes.
    Mientras 0 NFTs minteados, redeploy es trivial. Si se mintea aunque sea 1
    NFT en el contrato viejo, hay friction de migración (debate community + soporte).
  Fix sugerido: REDEPLOY HOY antes de cualquier mint productivo.

[INFO-6] El repo tiene `audit_2026_06_14_round2/01_backend_cloud_functions.md` — audit anterior
  Descripción: Hay audit history extensa. Esta audit complementa, no reemplaza.

[INFO-7] OpenZeppelin v5 cambió varias APIs (Ownable constructor, _update, _increaseBalance).
   El contrato las usa correctamente para v5.
```

---

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| **CRITICAL** | 6 |
| **HIGH** | 10 |
| **MEDIUM** | 13 |
| **LOW** | 15 |
| **INFO** | 7 |
| **TOTAL** | **51** |

## Top 5 críticos (orden de prioridad de fix)

1. **CRIT-1** — Owner EOA único, sin multisig. Si la key se filtra, mint infinito de NFTs tier-1 ($100k declarados). **DEBE resolverse antes del primer mint productivo.** Redeploy con AccessControl + Gnosis Safe 2-of-3.

2. **CRIT-5** — Pinning IPFS en un solo proveedor (Pinata). Cuenta caduca / cierra / DMCA → todos los NFTs sin imagen. **DEBE pinearse en 3+ servicios redundantes antes del primer mint.**

3. **CRIT-2** — No hay supply cap on-chain. La escasez declarada en metadata (1 tier-1, 1 tier-2, ..., 10000 tier-9) NO está enforced por el contrato. Owner malicioso o key comprometida → dilución infinita + fraud claim. Agregar `tierMinted[t] < TIER_CAP[t]` en mintGem.

4. **CRIT-6** — `tx.wait()` sin confirmations explícitas. Vulnerable a reorgs de Polygon (hasta 100 bloques históricamente). Cambiar a `tx.wait(30)` igual que el flow de pagos USDC.

5. **CRIT-4** — Race condition de nonce entre `processPendingMints` (onCall manual) y `mintProcessorScheduled`. Implementar lock distribuido o gestión explícita de nonce.

## Patrones positivos (NO cambiar)

1. **CEI + nonReentrant correctos** en mintGem — el patrón aplicado en CRIT-26 está bien implementado.
2. **renounceOwnership disabled con revert + onlyOwner** — previene bricking accidental.
3. **`++_nextTokenId` pre-increment** — garantiza tokenIds comienzan en 1, evita ambigüedad con default 0 en mapping.
4. **`ERC721Pausable` con override correcto de `_update`** — patrón canónico de OZ v5.
5. **Eventos custom `GemMinted` con tier indexed** — useful para indexers off-chain.
6. **Backend: `processedTxs` para pagos USDC** + idempotency atómica en Firestore TX. Modelo a replicar para mints.
7. **HMAC-SHA256 con SERVER_SEED** en helpers.js — buena defensa contra brute-force de gem placement.
8. **Validación robusta de input en runMintProcessing** (líneas 1140-1157) — defense in depth.
9. **Cooldown 24h en setUserWallet** — protección útil aunque parcialmente bypaseable (HIGH-6).
10. **`bafkrei` CIDv1 con raw codec** — formato moderno correcto para JSON files.

## Multisig migration plan (concreto, 0 NFTs minteados ahora)

**Ventana de oportunidad:** El contrato actual tiene 0 mints. Redeployar es trivial. ESTE ES EL MOMENTO.

### Fase 1 — Preparación (1-2 días)

1. **Crear Gnosis Safe en Polygon** (https://app.safe.global)
   - 2-of-3 signers: founder + cofounder + cold wallet (hardware)
   - Probar firma + ejecución de tx test antes de usar productivamente
   - Documentar las 3 seed phrases en bóveda física separada

2. **Refactor del contrato** — nueva versión `MTBGems.sol`:
   - Reemplazar `Ownable` por `AccessControl`
   - Definir `DEFAULT_ADMIN_ROLE` (Safe) y `MINTER_ROLE` (backend EOA)
   - Definir `PAUSER_ROLE` (Safe, separado)
   - Agregar `tierMinted[tier] < TIER_CAP[tier]` (CRIT-2)
   - Agregar `bytes32 gemCodeHash` para storage compacto (MED-6)
   - Agregar `mapping(uint8 => string) public tierURI` (MED-5), eliminar `ERC721URIStorage`
   - Agregar `batchMintGem(...)` con cap 50 (HIGH-4)
   - Agregar `markRedeemed(uint256)` con `mapping redeemed` (LOW-4)
   - Agregar `ERC2981` royalties 5% al Safe (HIGH-2)
   - NatSpec docstrings (LOW-2)
   - pragma `0.8.27` exacto (LOW-5)
   - Constants `MIN_TIER`/`MAX_TIER` (LOW-8)
   - require length caps (LOW-14, LOW-15, LOW-6)

3. **Tests Foundry**:
   - Mínimo 20 tests cubriendo todos los caminos (LOW-7)
   - Cobertura coverage >= 95% líneas
   - Test adversarial: MaliciousReceiver, account takeover, supply cap exhaustion

4. **Auditoría externa opcional**:
   - Si presupuesto permite: ConsenSys Diligence ($15-30k) o OpenZeppelin Audits ($20-50k)
   - Alternativa: code4rena contest (~$5-10k, comunidad audita)
   - Alternativa free: post-fixes en este reporte + auditoría peer del founder de un proyecto crypto que conozcas

### Fase 2 — Deploy (1 día)

1. **Setup Hardhat** en el repo:
   ```
   contracts/
   ├── MTBGems.sol
   ├── interfaces/
   └── test/
       └── MTBGems.t.sol
   hardhat.config.ts
   scripts/
   ├── deploy.ts
   └── verify.ts
   ```

2. **Deploy a Polygon mainnet**:
   - `npx hardhat run scripts/deploy.ts --network polygon`
   - Initial admin = Gnosis Safe address
   - El deployer (EOA temporal) llama `grantRole(MINTER_ROLE, BACKEND_EOA)` y luego `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`
   - Resultado: Safe = único admin, Backend EOA = único minter

3. **Verify** en PolygonScan:
   - `npx hardhat verify --network polygon <ADDRESS> <CONSTRUCTOR_ARGS>`
   - Confirmar "Contract Source Code Verified" en explorer

4. **Setear `tierURI` para los 9 tiers** desde Safe:
   - Para cada tier, propose tx `setTierURI(tier, "ipfs://...")` en Safe
   - Ejecutar con 2-of-3 firmas
   - Verificar `tokenURI(N)` retorna URI esperada (mintear NFT test primero)

5. **Mint de prueba**: Backend EOA llama `mintGem(deployer, 9, "TEST-001", "ipfs://...")` — verificar:
   - Tx exitosa
   - Receipt status = 1
   - Event GemMinted emitido
   - OpenSea muestra el NFT con metadata correcta

6. **Burn / markRedeemed el NFT test** para no contaminar la colección.

### Fase 3 — Cutover (1 hora)

1. **Update `functions/constants.js`**:
   ```js
   const MTBGEMS_CONTRACT = '0x<NEW_ADDRESS>';
   ```

2. **Update ABI** en `functions/index.js:1051-1053` si cambiaron firmas (batchMint, etc.).

3. **Deploy functions**:
   ```bash
   cd functions && firebase deploy --only functions
   ```

4. **Smoke test**: registrar test gem en Firestore manual, triggear `processPendingMints` — verificar mint exitoso en new contract.

5. **Abandonar el contrato viejo**: pause + documentar en repo "DEPRECATED" en un README en `contracts/legacy/`.

### Fase 4 — Post-deploy hardening (1 semana)

1. Implementar lock distribuido `meta/mintLock` (CRIT-4).
2. RPC fallback chain (HIGH-7).
3. Gas price strategy con escalación en retries (HIGH-9).
4. Post-tx verification on-chain (HIGH-10).
5. Test integridad IPFS en CI (MED-11).
6. Pin metadata + imágenes a 3 servicios (Pinata + Filebase + web3.storage).
7. Documentar runbook ops en `OPS_RUNBOOK.md`.

---

## Pre-launch checklist OBLIGATORIO antes del primer mint productivo

- [ ] **Redeploy contrato** con AccessControl + Gnosis Safe (CRIT-1, CRIT-2)
- [ ] **Gnosis Safe 2-of-3** creado, 3 seeds en bóveda física separada
- [ ] **Tests Foundry** con coverage >= 95%, todos pasando
- [ ] **PolygonScan verified** — Contract Source Code Verified visible
- [ ] **Metadata IPFS pineada** en ≥3 servicios (Pinata + Filebase + web3.storage)
- [ ] **tx.wait(30)** en runMintProcessing (CRIT-6)
- [ ] **Lock distribuido** o maxInstances:1 en mintProcessorScheduled (CRIT-4)
- [ ] **walletAddress forced server-side** en claimGemNFT (HIGH-6)
- [ ] **RPC fallback** con al menos 2 providers (HIGH-7)
- [ ] **Gas price strategy** con escalation (HIGH-9)
- [ ] **Post-tx ownership verification** vía `ownerOf` (HIGH-10)
- [ ] **Supply cap on-chain** verificado con test que mintea TIER_CAP[t]+1 y revierte (CRIT-2)
- [ ] **renounceOwnership** disabled probado en test
- [ ] **Pause / unpause** probado end-to-end con role del Safe
- [ ] **Mint de prueba** completado, NFT visible en OpenSea, burn-ed después
- [ ] **Backend EOA key rotation runbook** documentado y testeado en testnet (grantRole + revokeRole)
- [ ] **Dominio miningtheblocks.com** con auto-renewal y registrar lock activado
- [ ] **SECURITY.md** con email para bug bounty (ya existe — confirmar funcional)
- [ ] **Incident response runbook**: pasos para invocar pause + comms public en caso de exploit

## Conclusión

El contrato actual es **funcionalmente correcto pero estructuralmente frágil**:

- ✅ Sin vulnerabilidades clásicas de reentrancy / integer / acceso público a funciones admin.
- ✅ Patterns OZ v5 implementados correctamente.
- ✅ CEI ordering aplicado.
- ✅ Backend con validación robusta de inputs y atomicidad Firestore.

Sin embargo:

- ❌ **Single point of failure crítico**: EOA owner sin multisig.
- ❌ **Sin supply cap on-chain**: la escasez declarada en marketing NO está enforced.
- ❌ **Pinning IPFS centralizado**: una cuenta Pinata = punto único de takedown.
- ❌ **Race conditions de nonce backend** no resueltas.
- ❌ **Reorg handling de Polygon** ausente en mints.
- ❌ **0 tests del contrato**.

**Recomendación firm**: NO mintear el primer NFT productivo hasta resolver CRIT-1 (multisig) y CRIT-2 (supply cap). El redeploy es trivial (0 mints actuales) y previene problemas catastróficos post-launch. Costo estimado: 1-2 semanas de dev work + ~$10 de gas Polygon. Beneficio: evitar pérdida total del proyecto.

El estado actual es "deployed but not yet committed to" — aprovechá la ventana antes del primer mint para hacer las correcciones estructurales. Después del primer mint, cualquier cambio requiere debate de migración con holders.

**Archivos relevantes mencionados:**
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/contracts/MTBGems.sol`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/index.js` (líneas 608-657, 1051-1257, 1297-1330, 1425-1521)
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/constants.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/helpers.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/scripts/generate-nft-metadata.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/scripts/upload-to-ipfs.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/scripts/upload-metadata-to-ipfs.js`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/firestore.rules`
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/ACCIONES_MANUALES.md` (#11)
- `/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/audit_2026_06_14_round2/01_backend_cloud_functions.md` (MED-9, MED-11)