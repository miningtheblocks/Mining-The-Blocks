# MTB v1.2.1 — Release Notes

**Fecha:** 2026-06-24
**versionCode:** 7
**Tamaño APK:** ~54 MB
**Compatibilidad:** Android 7.0+ (minSdkVersion 24)

---

## 🎉 Novedades para usuarios

### Sistema de canje (mejorado)
- **Swap flow 2-step**: cuando recibís un premio NFT, te lo intercambiamos por el equivalente en USDC. Ahora el flow tiene validación on-chain del envío del NFT.
- **Ventana de canje 90 días** desde el fin del episodio. Después de eso la gema expira.
- **Countdown de expiración** en "Mis Gemas": ves cuántos días quedan para canjear cada premio.
- **Buscador + filtros** en el historial de la cadena: encontrá eventos por tipo (⛏ minado / 🏆 premio / 💸 canje).

### Pagos
- **$15.00 redondo** si tenés tu wallet linkeada en tu cuenta (antes era $15.XX random como anti-spoofing).
- **Wallet auto-link** opcional en tu primer pago: ahora hay un checkbox para guardar tu wallet en tu cuenta (no es automático, vos elegís).

### UI / UX
- **Modales con estética MTB** para:
  - Permisos de notificaciones (explicación clara antes del prompt nativo).
  - Capa bloqueada (con barra de progreso + botón compartir).
  - Premio ganador.
- **Indicadores de bloqueo de capa** (🔓/🔒) en la lista de servers.
- **Idioma**: pluralización en es/en + más strings traducidos.

### Transparencia
- **Episode_redeemed** event público en el historial: cuando alguien canjea un premio, queda registrado on-chain.

---

## 🔐 Seguridad — Auditoría Round 2 cerrada

Esta versión incluye el cierre del segundo round de auditoría externa: **51 CRITs + 121 HIGHs** técnicos resueltos.

### Highlights
- **Smart Contract V2** (MTBGemsV2) deployed + verified en Polygon: `0x2933Ff14AdeC0a4D74aD8380E5c491321bBd3195`
- **Gnosis Safe 2-of-3 multisig** como admin del contrato (en vez de EOA única).
- **Wallet hot-swap protection**: cooldown 24h + validación server-side.
- **Password reset hardening**: revoca todos los tokens + notifica al user.
- **effectiveSeed = HMAC(SERVER_SEED, serverId)**: leak no es retroactivo.
- **App Check** + verificación on-chain del NFT envío.
- **Backup validation + restore procedure** documentado.
- **Sentry integrado** para error tracking en producción.
- **Multi-channel push notifications** (FCM + Expo Push API).
- **IPFS multi-pin** (Pinata + Filebase) para los metadatos NFT.
- **SBOM CycloneDX** en CI para tracking de dependencias.

### Compliance
- **Cookie consent banner** GDPR/LGPD/CCPA en `miningtheblocks.com`.
- **Privacy policy** actualizada con sub-procesadores (Firebase, Cloudflare, Pinata).
- **Self-serve account deletion** (in-app, conforme Play Store policy desde mayo 2024).
- **Logout everywhere** disponible en Config.

---

## ⚡ Performance

- **Sprint gráfico**: 3 bugs + 3 optimizaciones (face detection reset, minedRewardsStore clear, audio warmup, shared geometries, low-power renderer, texture cache eviction).
- **Migración expo-three → THREE.WebGLRenderer nativo**: fix de "cuelgues al volver".
- **Migración expo-av → expo-audio**: prep para SDK 55.
- **Image optimization**: `docs/icon.png` 1.14MB → 8.5KB WebP.
- **Dead code removal**: ~1225 LOC + 2 deps innecesarias eliminadas.

---

## 🛠 Operacional (no visible al usuario)

- **OPERATIONS_PLAYBOOK.md**: protocolo de revisiones periódicas (diario/semanal/mensual/trimestral/anual).
- **BACKLOG.md**: 155 items pendientes organizados en 16 lotes semanales.
- **RUNBOOK.md**: 12 escenarios de disaster recovery + procedure detallado de restore Firestore.
- **CI client-bundle job**: verifica que el cliente RN bundlea sin errores (antes solo testeaba backend).
- **CI npm audit estricto**: bloquea high/critical en deps de prod.
- **Pre-commit hooks** con detección de secrets + ETH addresses + tx hashes excluidos.

---

## 📥 Cómo actualizar

### Si ya tenés v1.2.0 (o anterior) instalado
La app detecta updates automáticamente al abrir. Te va a mostrar un modal con el botón "Descargar v1.2.1".

### Sideload manual
1. Descargar `MTB-v1.2.1.apk` desde [GitHub Releases](https://github.com/miningtheblocks/Mining-The-Blocks/releases/tag/v1.2.1).
2. Verificar SHA-256 (publicado abajo y en el sitio).
3. Instalar el APK (Settings → Apps → Install unknown sources).

### Verificación de integridad
```bash
sha256sum MTB-v1.2.1.apk
# Debe coincidir con el SHA publicado en docs/MTB-v1.2.1.apk.sha256
```

---

## ⚠️ Breaking changes

**Ninguno para usuarios.** Esta versión es retrocompatible con v1.2.0.

### Para devs (autocontenido)
- `app.json`: `version` 1.2.0 → 1.2.1, `versionCode` 6 → 7.
- Smart Contract V1 (`0x54c2...3f29E6`) deprecated. Todos los mints nuevos usan V2.
- Variables EAS production: `SENTRY_AUTH_TOKEN` ahora requerida en env.

---

## 📊 Stats del release

- **Commits desde v1.1.0**: 96
- **Files changed**: ~120
- **Insertions**: ~22000
- **Deletions**: ~5000
- **Audit findings cerrados (Round 2)**: 51 CRITs + 121 HIGHs + 6 MEDs críticos
- **Tests**: 38/38 passing (helpers) + rules unit tests

---

## 🤝 Créditos

Auditoría Round 2: 12 agentes especializados (1-12).
Implementación: ñ + Claude.

---

**Próximo release esperado:** v1.2.2 cuando se cierren los primeros 2-3 lotes del backlog (~2 semanas).
