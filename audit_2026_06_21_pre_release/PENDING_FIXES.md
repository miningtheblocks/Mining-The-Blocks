# MTB v1.1.x — Estado final post auditoría Round 2

Última actualización: **2026-06-23** — sesión completa de cierre.

---

## 🚀 ESTADO RESUMIDO

**Listo para release.** Todas las findings críticos y HIGHs técnicos cerrados. Lo único que queda es:
- 1 HIGH legal externo (consulta abogado — opcional)
- Testing on-device pre-release
- Build EAS + GitHub Release

### Totales

| Categoría | Cerrados | Aceptados / N/A | Pendientes |
|---|---|---|---|
| **CRITs smart contract** | 5/5 | 0 | 0 |
| **CRITs web** | 3/3 | 0 | 0 |
| **HIGHs técnicos** | 31 | 0 | 0 |
| **HIGHs legales/decisiones** | 0 | 2 (geo-blocking + países) | 1 (MICA + Howey) |
| **MEDs** | 6 (los críticos) | varios | ~50 (no bloqueantes) |
| **LOWs** | 0 abordados | — | 38 (cosméticos) |

---

## ✅ Cambios aplicados — 10 commits

| # | Commit | Tema |
|---|---|---|
| 1 | `a5cb3aa` | Smart Contract V2 deploy + verify + test mint + 23 HIGHs |
| 2 | `573c9e9` | Sentry source maps pipeline (sentry.properties + EAS env var) |
| 3 | `b50d47e` | Keystore backups offline + test recovery |
| 4 | `f8ab785` | Reemplazar expo-three por THREE.WebGLRenderer nativo |
| 5 | `b7cf807` | docs/icon.png 1.1MB → 8.5KB WebP |
| 6 | `e742c6e` | TOS §4: lista 13 países eliminada |
| 7 | `77f137b` | Claim flow 2-step con verificación on-chain del NFT |
| 8 | `e4ee3f6` | Cookie consent banner (GDPR/LGPD/CCPA) |
| 9 | `4deedb9` | Keystore password rotation (PKCS12) |
| 10 | `7b1042f` | Migrar expo-av → expo-audio (SDK 55 prep) |

---

## 🔐 Smart Contract V2 — DEPLOYED & ACTIVE

| Aspecto | Valor |
|---|---|
| **Address** | `0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195` |
| **Network** | Polygon mainnet |
| **Deploy tx** | `0x4d7813a702d96bc42bd6549da8c016d34cdcac8ce27f463ee462d2ec037742cb` |
| **Verified Polygonscan** | ✅ Source code público |
| **Test mint** | ✅ Token #1 a `pagosmtb` exitoso |
| **Roles** | Safe = ADMIN+PAUSER, nftv2 EOA = MINTER (separation OK) |

### Addresses (referencia)

| Rol | Address | Notas |
|---|---|---|
| Contrato V2 (activo) | `0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195` | Polygon mainnet |
| Contrato V1 (deprecated) | `0x54c2859411afCb51fcfE42054aDcA3484B3f29E6` | 0 mints reales, no migrar |
| Safe multisig (ADMIN) | `0x83a3F5Bd15302F17B7f2e430900F1d2A40F86aCD` | Gnosis Safe 2-of-3 |
| Safe signer 1 | `0xaca6ab64239238358B85B053A7f0E85d5380C1FF` | Bitwarden "safe1" |
| Safe signer 2 | `0x53E5B70ff9B121190B89454A453d1532b0A15525` | Bitwarden "safe2" |
| Safe signer 3 | `0xAabd35645F5C9D3D28cAc7387e14960a7755A4E1` | Bitwarden "safe3" (reemplazó nftv2 del Safe) |
| Backend MINTER | `0x0a285CA8BaE2FbA3808bd260f936bCa22F06941e` | Bitwarden "nftv2", `COMPANY_WALLET_KEY` |
| Payment + NFT receiver | `0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f` | Bitwarden "pagosmtb" |

---

## 🌐 Infraestructura — TODA DEPLOYED

- ✅ Firebase Functions: 33/33 funciones actualizadas (incluyendo el swap flow `submitGemClaim` + `confirmGemNftSent` + `markGemRedeemed`)
- ✅ Firebase Hosting: `verify.html` + assets actualizados
- ✅ GitHub Pages: `docs/` con cookie consent, OG meta, robots, sitemap, frame-buster, etc.
- ✅ HTTPS forzado en GitHub Pages (301 redirect)
- ✅ DNS records: SPF + DMARC + CAA propagados en Cloudflare
- ✅ Sentry: source maps pipeline configurado, `SENTRY_AUTH_TOKEN` en EAS environment production

---

## 🔒 Keystore — Rotated + 3 Backups + Test Recovery

| Aspecto | Valor |
|---|---|
| File path | `/home/code/Escritorio/claveminingtheblcoks/mtb-release-v2.keystore` |
| Format | PKCS12 (store=key password unified) |
| Alias | `mtb-release-v2` |
| File SHA-256 (post-rotation 2026-06-23) | `bc0f6b20...62a1333d2` |
| Cert SHA-256 (inmutable) | `BF:8F:25:AC:C3:CC:CF:9B:DA:F7:63:53:FC:E5:DE:B2:25:11:89:16:9E:1C:32:20:6E:75:52:55:4D:AB:7D:C1` |
| Password actual (Bitwarden) | "MTB release keystore — store password v2 (rotated 2026-06-23)" |
| Password viejo (Bitwarden) | "MTB release keystore — v2 (2026-06-17) — DEPRECATED" |
| GPG passphrase (Bitwarden) | Misma entry vieja (no se rotó el GPG, solo el keystore password) |

### Backups offline 3-2-1

1. ✅ **Hitachi (interno otro disco)**: `/run/media/code/datos/keystore-backup-2026-06-23/` con `.gpg` + `SHA256SUMS` + `README.txt` + `INTEGRITY_CHECK.sh`
2. ✅ **USB Kingston DT 101 G2** (extraído, físicamente separado del notebook)
3. ✅ **Off-site** (enviado por email a destino off-site)

Test recovery: 2026-06-23 OK. Próximo: 2027-Q1.

---

## ⏳ Lo único pendiente

### 🟠 1 HIGH legal (opcional, post-volumen)

**#8 HIGH-7 MICA + Howey analysis**
- Tipo: consulta legal externa
- Costo: USD 500-2000 (abogado crypto Argentina) o USD 5-15k (international)
- Cuándo: si vas a expandir explícitamente a EU/US, O si revenue > USD 50k/mes
- Posición actual: el "hueco legal" del modelo (NFTs simbólicos + buyback voluntario MTB) reduce exposure pero no la elimina
- Acción: postergar hasta que aplique

### 🧪 Testing on-device pre-release (vos)

Antes de publicar la nueva versión, validar en celular real:

1. **Cube + mining** (post expo-three refactor):
   - Abrir app
   - Entrar a una chain
   - Long-press en un cubo → ver que aparece el longpress + modal
   - Confirmar mining → ver animación
   - Sin glitches visuales en distintos pixel ratios si tenés más de 1 device

2. **Audio** (post expo-audio migration):
   - Música de fondo + crescendo al entrar al juego
   - Sonidos: rotura, explosion, win, lose, mining, mining_ok
   - Pause/resume al toggle de settings (Config screen)
   - Cleanup al logout

3. **Swap flow** (cuando un gem real esté minteado):
   - Ir a `https://miningtheblocks.com/` desde el celu
   - Pegar gemCode
   - Login
   - Ver el cardNftTransfer con la wallet destino + Token ID
   - Enviar NFT desde MetaMask
   - Pegar txHash
   - Verificar recibir email
   - Marcar como redeemed via Cloud Function callable (vos como admin)
   - Verificar que el user recibe email de confirmación

### 📦 Build + Release (sigue abajo)

Ver sección "Build EAS v1.x.x" para los pasos.

---

## 🔮 Acciones futuras recomendadas (no urgentes)

| Item | Cuándo |
|---|---|
| Audit externo del contrato (Sherlock ~USD 1-3k) | Volumen mensual > USD 5k |
| Migrar a `expo-audio` ✅ HECHO | n/a (ya hicimos) |
| MICA + Howey legal review | Expansión EU/US o revenue > USD 50k/mes |
| Play App Signing | Solo si se publica en Play Store (hoy NO) |
| Dependabot PRs abiertos (#4 firebase-admin 14, #6 eslint 10) | Major bumps, revisar API breaks |
| Inmunefi bug bounty pasivo | Cuando vale la pena listar (low-cost early defense) |

---

## ⚙️ Reference técnico

### Archivos importantes

- Contrato source: `/run/media/code/datos/MTB/contracts/MTBGemsV2.sol`
- Build dir hardhat: `/run/media/code/datos/MTB/contracts_build/`
- Tests: `contracts_build/test/MTBGemsV2.test.js` (17/17 passing)
- Backend principal: `functions/index.js`
- Constants: `functions/constants.js`
- Cookie consent: `docs/js/cookie-consent.js`
- Frame buster: `docs/js/frame-buster.js`
- Sentry config: `sentry.properties` + `src/utils/sentry.js`
- Audit raw findings: `audit_2026_06_14_round2/*` + `audit_2026_06_21_pre_release/*`

### EAS env vars (production)

| Var | Value | Cómo obtener |
|---|---|---|
| `EXPO_PUBLIC_SENTRY_DSN` | `https://...@sentry.io/...` | Sentry → Settings → Client Keys (DSN) |
| `SENTRY_AUTH_TOKEN` | `sntrys_...` (en EAS env) | `eas env:list --environment production` |
| `STRIP_CONSOLE` | `1` | Hardcoded en eas.json |

### Cloud Functions Secrets (GCP Secret Manager)

| Secret | Para qué |
|---|---|
| `COMPANY_WALLET_KEY` | Private key de nftv2 (firma mintGem en backend) |
| `GMAIL_APP_PASSWORD` | SMTP password de `miningtheblocks@gmail.com` para emails |
| `SERVER_SEED` | HMAC-SHA256 seed para derivación de premios |

### Commands útiles

```bash
# Deploy completo de functions
firebase deploy --only functions --project miningtheblocks-669f6

# Deploy specific function
firebase deploy --only functions:nombreFunc --project miningtheblocks-669f6

# Deploy hosting
firebase deploy --only hosting --project miningtheblocks-669f6

# EAS env list
eas env:list --environment production

# Lint + tests backend
cd functions && npm run lint && npm test

# Verificar integridad del backup keystore
cd /run/media/code/datos/keystore-backup-2026-06-23/ && bash INTEGRITY_CHECK.sh
```
