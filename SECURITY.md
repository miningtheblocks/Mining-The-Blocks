# Security Policy

## Reporte de vulnerabilidades

Si encontrás una vulnerabilidad de seguridad en Mining The Blocks (cliente Android, backend Cloud Functions, smart contract MTBGems, o el sitio web), por favor reportala de forma **privada** primero.

**No abras un issue público** para vulnerabilidades — usá uno de estos canales:

1. **Email**: `miningtheblocks@gmail.com` con asunto `[SECURITY]` y descripción + PoC.
2. **GitHub Private Vulnerability Reporting**: https://github.com/miningtheblocks/Mining-The-Blocks/security/advisories/new

## Versiones soportadas

Sólo la última versión publicada (`config/app.latestVersion` en Firestore) recibe parches de seguridad. Versiones más viejas no son auditadas.

## SLA

| Severidad | Respuesta inicial | Patch target |
|---|---|---|
| Crítica (RCE, exfiltración de fondos, bypass de auth) | 24h | 7 días |
| Alta (escalada de privilegio, leak de PII de otros usuarios) | 48h | 14 días |
| Media (logic bugs, validación) | 5 días | 30 días |
| Baja (defense in depth) | 14 días | best-effort |

## Scope

**In-scope:**
- App Android (APK distribuido via miningtheblocks.github.io)
- Cloud Functions en `functions/`
- Firestore Rules + Storage Rules
- Smart contract `contracts/MTBGems.sol` (deployado en Polygon)
- Hosting: `public/*` y `docs/*`

**Out-of-scope:**
- Vulnerabilidades en dependencies de terceros (reportar al vendor)
- DoS por inundación de red (rate-limit es responsabilidad de cada layer)
- Social engineering / phishing fuera de la app
- Vulnerabilidades en versiones de Android no soportadas (<Android 8.0)

## Bug bounty

Por el momento no hay programa formal de bug bounty. Reconocemos públicamente a los reporters responsables (con su autorización) en cada release.
