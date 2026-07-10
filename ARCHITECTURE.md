# Mining The Blocks — Architecture

Visión técnica del sistema. Complementa `RUNBOOK.md` (ops + incident response)
y los reportes de `audit_2026_06_14_round2/` (security review por dominio).

---

## Stack

| Capa | Tech |
|---|---|
| Cliente | React Native 0.81.5 + Expo SDK 54.0.35 (sideload Android, NO Play Store) |
| 3D rendering | Three.js 0.166 vía `expo-gl` + `expo-three` |
| Navigation | `@react-navigation/{native,native-stack,drawer}` v7 |
| Estado | React hooks + Context (sin Redux); useRef para hot paths del cubo |
| Backend | Firebase Cloud Functions v2 (Node 22), 31 funciones |
| DB | Firestore (rules + indexes + TTL collections) |
| Auth | Firebase Auth (email/password; modo anónimo removido en V1.1.0) |
| Push | FCM nativo (NO Expo Push) via `getDevicePushTokenAsync` |
| Blockchain | Polygon mainnet (USDC payments + ERC-721 NFTs) |
| Smart contract | Solidity 0.8.20 + OpenZeppelin (ERC721 + URIStorage + Pausable + Ownable + ReentrancyGuard) |
| IPFS | Pinata (single pin — multi-pin pendiente operacional) |
| Email | Gmail + nodemailer + app-password compartido |
| Distribución | APK self-hosted en GitHub Releases + sitio en `miningtheblocks.com` |

---

## Componentes principales

```
┌─────────────────────────────────────────────────────────────┐
│                       CLIENTE (RN)                          │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │  App.js    │→ │  Stack/    │→ │  Screens (Login,   │    │
│  │  RootApp   │  │  Drawer    │  │   Registration,    │    │
│  │  + auth    │  │            │  │   Home=Cube3D,     │    │
│  │  + push    │  │            │  │   ServerList,      │    │
│  │            │  │            │  │   Profile, Gems…)  │    │
│  └─────┬──────┘  └────────────┘  └─────────┬──────────┘    │
│        │                                    │                │
│        │   ┌───────────────┐                │                │
│        └→  │ OverlayModals │ ←──────────────┘                │
│            │  Provider     │   Profile, Config, Peaks,       │
│            │  (lazy mount) │   BuyCredits, Gems, Report      │
│            └───────────────┘                                 │
│                                                              │
│  Singletons: AudioManager, navigationRef, i18n, serverCtx   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ Firebase Web SDK 12.3 (Auth + Firestore + Storage + Functions)
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                    FIREBASE (us-central1)                   │
│                                                              │
│  ┌─────────┐  ┌──────────────────────────────────────┐     │
│  │  Auth   │  │  Cloud Functions v2 (31 funciones)   │     │
│  │  (JWT)  │  │  cpu:0.5, mem:256MiB, maxInst:10    │     │
│  └─────────┘  │                                       │     │
│               │  - mineCube (hot path, 5R+5W TX)     │     │
│  ┌─────────┐  │  - claimGemNFT / submitGemClaim      │     │
│  │Firestore│←─│  - createCryptoPayment               │     │
│  │  Rules  │  │  - notifyAllUsers / sendPushToUser   │     │
│  └─────────┘  │  - 3 schedulers (mint, payments,     │     │
│               │    matic check, backups)             │     │
│  ┌─────────┐  │  - delete/revoke account self-serve  │     │
│  │ Storage │  │  - 3 weekly digests (Round 2 G)      │     │
│  └─────────┘  └──────────────────────────────────────┘     │
└────────────────┬────────────────────────────┬───────────────┘
                 │                            │
                 │ ethers.js                  │ nodemailer
                 ↓                            ↓
┌───────────────────────────────┐  ┌──────────────────────┐
│   POLYGON MAINNET             │  │  Gmail SMTP          │
│   - MTBGems ERC-721           │  │  app-password        │
│     0x54c285…6cd8b3df         │  │  (single SPOF — ver  │
│   - PAYMENT_WALLET USDC       │  │   RUNBOOK escenario 6)│
│   - publicnode.com RPC        │  └──────────────────────┘
│     (sin SLA, migrar a        │
│      Alchemy antes de 10k DAU)│
└───────────────────────────────┘
```

---

## Datos: modelo Firestore

```
users/{uid}
  ├─ Identity: displayName, email, profile.{firstName,lastName,phone,…},
  │            avatarUrl, language
  ├─ Economy:  picks, serverCredits, walletAddress, walletChangedAt
  ├─ Social:   referralCode, referredBy, referralBonusPaid
  ├─ Push:     pushToken, pushTokenType ('fcm'|'expo')
  ├─ Settings: settings.notify* (Adready/Daily/Rewards/NewLayer)
  ├─ Timestamps: lastMineAt, lastDailyAt, lastAd1At, lastAd2At, picksLastResetAt
  ├─ Soft-delete: deletedAt (Commit F)
  │
  ├─ gems/{gemId}           ── code, gemTier, status (unclaimed|minting|minted|redeemed)
  ├─ notifications/{nid}    ── referral_bonus, etc. (in-app)
  └─ serverAccess/{serverId} ── { chainId }  (paga $15 → 1 doc)

servers/{serverId}
  ├─ name, chainId, episodeNumber, currentLayer K, status, winner
  ├─ totalMined, memberCount
  ├─ mined/{K_N}            ── { by, minedAt, K, rewardPicks, gem }  ← schema canónico post Commit A
  └─ layers/{K}             ── { K, totalCubes, stats.mined, winRate }

serverChains/{chainId}      ── status, currentEpisode 1..10, currentServerId, name
  ├─ episodes/{N}           ── snapshot final
  ├─ history/{auto}         ── feed público: mine, episode_complete (seq+1 monotónico)
  └─ meta/{counter,closing_N} ── idempotency locks

activityFeed/{eventId}      ── global broadcast: gem_found, layer_complete, etc.

pendingMints/{uid_gemId}    ── { walletAddress, tokenURI, status (pending|processing|completed|failed) }
pendingCryptoPayments/{amt_N} ── docId determinístico = amt_${amountUnits}
processedTxs/{txHash}       ── idempotency USDC (TTL 30d)
gemClaims/{auto}            ── web claim form submissions
adSessions/{sessionId}      ── token de un solo uso para adpick.html
userMeta/{uid}              ── per-user rate-limit counters
rateLimits/{bucket}         ── global rate-limit counters (TTL)
errorLog/{entry}            ── client errors (TTL, scrubbed PII)
adminActions/{entry}        ── audit log de ops sensibles
config/app                  ── minVersion, latestVersion, downloadUrl
runtime/                    ── locks + checkpoints (Round 2 Commits A + C + G)
  ├─ mintProcessor          ── distributed lock (Commit A)
  ├─ cryptoPaymentCheckpoint ── { lastBlockProcessed } (Commit C)
  └─ maticBalanceAlert      ── { lastAlertAt } (Commit G)
usernames/{handle}          ── unique registry (email_verified required to create)
```

---

## Flows críticos

### 1. Mining un cubo (`mineCube`, hot path)

```
Cliente toca un cubo → optimistic local update (UI inmediata)
                    → callMineCube(cubeNumber, serverId)
                                ↓
        Cloud Function (TX Firestore: 5R + ~5W)
        ├─ requireRegistered (provider whitelist post Commit D)
        ├─ Check serverAccess (paga crédito)
        ├─ getRewardForCube(serverId, K, n, seed, episode) ← effectiveSeed (Commit C)
        ├─ getGemForCube(...)                              ← misma derivación
        ├─ tx.set(mined/{K_N}, {by, minedAt, K, rewardPicks, gem}) ← schema canónico (Commit A)
        ├─ tx.set(users/{uid}, {picks: increment(…), lastMineAt})
        ├─ tx.set(layers/{K}, {stats.mined: increment(1)})
        ├─ tx.set(servers/{id}, {totalMined: increment(1), …})
        └─ Si layer/episode completo: layerComplete/closeEpisode flow
                                ↓
        Post-TX (fuera de transaction):
        ├─ Si encontró gema → users/{uid}/gems/{gemId} + pendingMints/{uid_gemId}
        ├─ activityFeed.add({gem_found | layer_complete})
        └─ sendPushToUser (si gema y user tiene wallet linked)
```

**Garantías:**
- Idempotente por cubeNumber canónico (Commit Tier 1 fix de coercion).
- Anti-doble-mineo: `minedRef.exists` check dentro de la TX.
- Realtime: clientes con server abierto reciben snapshot via onSnapshot del subcollection `mined/`.

### 2. Crypto payment (USDC en Polygon)

```
Cliente "Comprar 1 crédito" → callCreateCryptoPayment
                            ↓
    Cloud Function:
    ├─ requireRegistered + assertFreshToken (Commit B)
    ├─ rate-limit ccp_uid 3/h
    ├─ Si tiene pendingCryptoPayments waiting + valid → return existing
    ├─ Loop hasta 30 attempts: generar cents random (1-99)
    │  ├─ docId = `amt_${amountUnits}` (determinístico, evita race)
    │  └─ TX: si existe + waiting + no expirado → collision → retry; else set
    └─ Return { paymentId, amount, wallet: PAYMENT_WALLET, expiresAt: now + 30min }

Cliente muestra wallet + amount + timer

[USER paga USDC al wallet]

                ↓
    cryptoPaymentProcessorScheduled (cron 5min, Commit C self-throttle si vacío):
    ├─ checkpoint = runtime/cryptoPaymentCheckpoint.lastBlockProcessed (Commit C)
    ├─ safeBlock = currentBlock - 30 (SAFE_CONFIRMATIONS)
    ├─ fromBlock = checkpoint+1 (con cap defensivo 5000 blocks)
    ├─ Query USDC Transfer events (2 contratos USDC: bridged + native)
    ├─ Match amount con pendingCryptoPayments waiting
    ├─ TX:
    │  ├─ Check processedTxs/{txHash} → si existe, skip (idempotency)
    │  ├─ users/{uid}.serverCredits += 1
    │  ├─ payment.status = 'completed'
    │  └─ processedTxs/{txHash} = {expiresAt: 30d}
    ├─ Referral bonus si first credit + has referredBy: 5 picks each side
    ├─ Push notif al user (channelId='payment', notifyKey='notifyRewards')
    └─ Update checkpoint solo si TODAS las RPC queries succedieron
```

### 3. NFT claim (mint a wallet del user)

```
Cliente toca "Claim NFT" en MyGems → callClaimGemNFT(gemId)
                                  ↓
    Cloud Function:
    ├─ requireRegistered + assertFreshToken (Commit B)
    ├─ wallet = users/{uid}.walletAddress ← Commit B (NO body — anti hot-swap)
    ├─ TX atómica:
    │  ├─ gemRef.status check (debe ser unclaimed)
    │  ├─ gemRef.set({status: 'minting', walletAddress, claimedAt})
    │  └─ pendingMintRef.set({uid, gemId, tier, code, tokenURI, wallet, status: 'pending'})
    │     ← docId = `${uid}_${gemId}` (idempotency en re-clicks)
    └─ Return ok

                ↓
    mintProcessorScheduled (cron 5min, Commit A self-throttle + lock):
    ├─ withMintProcessorLock (Commit A) — evita race admin manual vs cron
    ├─ Si runtime/mintProcessor lock viva → skipped: lock_held
    ├─ Else acquire lock + run:
    │  ├─ Read pendingMints where status='pending' limit 10
    │  ├─ Por cada doc:
    │  │  ├─ TX claim: status='pending' → 'processing' (race protection)
    │  │  ├─ Validate tier/wallet/code shape (defense in depth)
    │  │  ├─ contract.mintGem(wallet, tier, code, tokenURI) ← onchain TX
    │  │  ├─ tx.wait(SAFE_CONFIRMATIONS=30) ← Commit A (reorg safety)
    │  │  ├─ Parse GemMinted event → tokenId
    │  │  ├─ mintRef.set({status: 'completed', txHash, tokenId})
    │  │  ├─ users/{uid}/gems/{gemId}.set({status: 'minted', tokenId, txHash})
    │  │  └─ sendPushToUser (channelId='mint', notifyKey='notifyRewards', data.url='exp+miningtheblocks://gems')
    │  └─ Si error: retry hasta 5 veces (Round 1) o failed + admin email alert
    └─ Release lock (always finally)
```

---

## Modelo de seguridad

### Capas de defense in depth

```
┌──────────────────────────────────────────────────────────┐
│ Capa 1: Cliente (no se confía — sideload, reverse-engineerable) │
│   - APK signing (keystore propio)                        │
│   - ProGuard/R8 (post Commit M más restrictivo)          │
│   - verifyAppSignature anti-tamper (bypasseable pero ↑barrera) │
│   - network_security_config: no cleartext, no user CAs   │
│   - UpdateModal allowlist (post Commit Tier 1 + K)       │
└──────────────────────────────────────────────────────────┘
                            ↓ HTTPS
┌──────────────────────────────────────────────────────────┐
│ Capa 2: Auth (Firebase + checkRevoked)                   │
│   - email_verified gating (provider=password)            │
│   - requireRegistered: provider whitelist (Commit D)     │
│   - assertFreshToken: tokensValidAfterTime + disabled    │
│     check en ops financieras (Commit B)                  │
│   - revokeRefreshTokens en password reset (Commit B)     │
│   - Self-serve account delete + logout everywhere (F)    │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│ Capa 3: Firestore Rules (whitelist, default-deny)        │
│   - users.create/update: whitelist explícito de fields   │
│   - history.create: solo type='mine', cap seq, validation│
│   - meta/counter: solo seq+1 monotónico                  │
│   - runtime/*, processedTxs/*, errorLog/*, adminActions/*: │
│     admin SDK only (regla `if false`)                    │
│   - usernames: email_verified required + regex anchored  │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│ Capa 4: Cloud Functions (rate-limit + audit + lock)      │
│   - _rateLimitFirestore: consistent entre instancias    │
│   - mintProcessor lock distribuido (Commit A)            │
│   - cryptoPayment checkpoint persistido (Commit C)       │
│   - audit log en adminActions para ops sensibles         │
│   - assertFreshToken en financial ops                   │
│   - markGemRedeemed (Commit C) → anti double-pay $100k   │
│   - 3 weekly schedulers leen logs (Commit G)             │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│ Capa 5: Onchain (Polygon)                                │
│   - mintGem onlyOwner + nonReentrant + CEI               │
│   - renounceOwnership disabled                           │
│   - pause/unpause defense                                │
│   - tx.wait(30) confirmations safety (Commit A)          │
│   - Owner EOA (irreversible si compromised — multisig    │
│     pendiente, Agente #3 CRIT-1, ver RUNBOOK)            │
└──────────────────────────────────────────────────────────┘
```

### Secrets

3 secrets en Firebase Secret Manager:

| Secret | Used by | Rotation | Blast radius si leak |
|---|---|---|---|
| `COMPANY_WALLET_KEY` | runMintProcessing | Manual + redeploy + contract.transferOwnership | $1M+ — contrato pwn |
| `GMAIL_APP_PASSWORD` | sendVerificationEmail, mint alerts, requestPasswordReset, weekly digests | Manual (RUNBOOK escenario 6) | Outage emails ~10min |
| `SERVER_SEED` | mineCube (effectiveSeed derivation) | **NO rotable por diseño**; mitigación post Commit C: `effectiveSeed = HMAC(SERVER_SEED, 'mtb-seed-v1\|serverId\|ep:N')` limita blast radius por server-episode | $50k-500k drenados via mineo informado (limitado a (server, episode) actuales post-fix) |

---

## Tradeoffs + decisiones de diseño

### Por qué sideload (NO Play Store)

- **Pros:** sin Play Store policy review delays, sin 30% cut, control total del release timeline.
- **Cons:** sin Play Integrity → APK reverse engineering trivial; users dependen del sitio para descubrir/actualizar; share fingerprint con un Expo dev app (mitigado en Commit M con `mtb://` scheme).
- **Mitigación:** keystore propio + signing fail-early en Gradle; APK SHA-256 publicado; UpdateModal con allowlist estricto.

### Por qué single-operator backend (no admin UI)

- 1 dev, 0 staff. Admin ops via `scripts/*.js` con `_confirm.js` triple gating.
- TODO operacional: Service Account dedicado (RUNBOOK) para reducir blast radius de un compromise.

### Por qué FCM nativo (no Expo Push)

- Expo Push = wrapper, agrega latencia + dependency en exp.host. FCM nativo = directo a Google.
- Post-V1.1.0: cliente registra FCM via `getDevicePushTokenAsync`. Backend ramifica (Commit D `notifyAllUsers` fix).

### Por qué soft-delete (no hard delete)

- AML/KYC retention: 5 años de gem redemption records (`terms.html`).
- Hard delete romperia trazabilidad fiscal + GDPR Art. 6.1.c (legal obligation).
- Compromiso: anonimización del user doc + delete del Auth user (Commit F).

### Por qué Polygon (no Ethereum mainnet)

- Gas: ~$0.04/mint en Polygon vs $2-50 en Ethereum L1. Para mintear gemas $15-100k, gas a escala importa.
- **Riesgo:** reorgs históricos hasta ~100 bloques. Mitigación: `tx.wait(30)` (Commit A) + `runtime/cryptoPaymentCheckpoint` (Commit C).

---

## Code layout

```
/                       — root del proyecto
├── App.js              — entry point (Stack/Drawer, auth, push setup, deep links)
├── index.js            — Expo entry (importa App.js)
├── app.json            — Expo config (version, plugins, AdMob IDs)
├── eas.json            — EAS Build profiles
├── package.json        — deps (post Commit L: sin @react-three/{fiber,drei})
├── babel.config.js, metro.config.js, react-native.config.js
│
├── src/
│   ├── constants.js              — APP_VERSION, URLs, StorageKeys
│   ├── firebase/
│   │   ├── client.js             — initializeApp, auth, db, storage, ensureUser
│   │   └── functions.js          — httpsCallable wrappers (call*)
│   ├── screens/                  — Login, Registration, Home (3D),
│   │                                ServerList, Profile, Config, MyGems,
│   │                                BuyCredits, GetPeaks, HowToPlay,
│   │                                ActivityScreen, ChainHistoryScreen
│   ├── components/               — DynamicCube201 (5216 LOC, 3D renderer),
│   │                                OverlayModalsProvider, ErrorBoundary,
│   │                                UpdateModal, AppAlert, GemPixelArt, etc.
│   └── utils/                    — i18n.js (1069 LOC), gems.js (GEMS array),
│                                    audioManager, logError, navigationRef,
│                                    serverContext
│
├── functions/                    — Firebase Cloud Functions
│   ├── index.js                  — 31 funciones (2500+ LOC post Round 2)
│   ├── helpers.js                — getRewardForCube, getGemForCube,
│   │                                getEffectiveSeed, esc, setCorsHeaders
│   ├── constants.js              — GEM_PRICES, GEM_UNLOCK_THRESHOLDS,
│   │                                PAYMENT_WALLET, USDC_CONTRACTS
│   ├── eslint.config.js          — flat config v9
│   └── test/                     — 24 helpers tests + 42 rules tests
│
├── contracts/MTBGems.sol         — ERC-721 + Pausable + ReentrancyGuard
├── android/                      — Gradle build + AndroidManifest +
│                                    proguard-rules.pro + keystore (NO en git)
├── docs/                         — GitHub Pages (miningtheblocks.com)
│   ├── index.html                — landing + claim form (Firebase SDK con SRI post K)
│   ├── adpick.html               — ad viewer con token efímero
│   ├── privacy.html, terms.html  — actualizados post Commit E
│   └── archive/                  — versiones viejas
├── public/                       — Firebase Hosting (miningtheblocks-669f6.web.app)
│   ├── verify.html               — email verification redirect
│   └── privacy.html, terms.html  — duplicate de docs/ (sync post Commit E)
├── scripts/                      — admin CLI (delete_users, grant_admin, etc.)
│   └── _confirm.js               — triple-gating helper
│
├── firestore.rules, firestore.indexes.json
├── firebase.json                 — hosting headers (post K: COOP/CORP +
│                                    Cache-Control verify.html)
├── .easignore                    — incluye *.jks, *.pkcs12 post Tier 1
├── .github/
│   ├── workflows/ci.yml          — lint + tests + security-checks +
│   │                                npm audit critical (post Commit I)
│   └── dependabot.yml            — npm + github-actions + gradle (post I)
└── .husky/pre-commit             — secrets + lint check (Commit I)
```

---

## Lo que NO se documenta acá

- **Incident response detallado** → `RUNBOOK.md` (12 escenarios DR).
- **Security findings** → `audit_2026_06_14_round2/00_INFORME_CONSOLIDADO.md`.
- **Build instructions** → `README.md` + `ACCIONES_MANUALES.md` + `AUDITORIA_SIDELOAD.md`.
- **Renderer 3D internals (DynamicCube201)** → comments inline en el archivo
  (`scratch vectors`, `pool`, `throttling adaptativo`, etc.). 5216 LOC.

---

## Roadmap operacional (post Audit Round 2)

Items que requieren acción manual fuera del repo, en orden de importancia:

1. Multisig migration del smart contract (Agente #3 CRIT-1, ver RUNBOOK).
2. Service Account dedicado para scripts admin (ver RUNBOOK).
3. App Check en Firebase Console.
4. TTL policies en Firestore Console.
5. Budget alerts en GCP.
6. 3 backups offline verificados del keystore JKS.
7. Sentry/Crashlytics integration (DSN setup).
8. Status page público.

Items code-only restantes:

- `docs/index.html` `unsafe-inline` removal (refactor: extraer 7 onclicks + 250 LOC inline `<script>` a archivo externo).
- `docs/adpick.html` sandbox iframe para ad script (riesgo de romper attribution).
- Tests cliente RN (jest + RTL) — 0 actualmente.
- AdMob Unit ID → Remote Config (rotación sin redeploy).
- `miningAnimations` state cleanup en DynamicCube201.
- ServerList/ChainHistory a11y (~30 TouchableOpacity).
