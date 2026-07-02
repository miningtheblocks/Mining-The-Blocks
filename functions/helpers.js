/* eslint-disable max-len */
/* eslint-disable quotes */
/* eslint-disable object-curly-spacing */

const crypto = require("crypto");
const { GEM_UNLOCK_THRESHOLDS, GEM_PRICES, DAY_MS } = require("./constants");

// ─── Geometría del cubo ────────────────────────────────────────────────────

function getLayerGridSize(K) {
  return 2 * K + 1;
}

function shellTotalCubes(K) {
  const g = getLayerGridSize(K);
  return g * g * 6;
}

// Suma acumulada de shellTotalCubes(0..n-1) — cantidad total de cubos en las
// capas 0 a n-1 inclusive. Usada tanto para ubicar premios (offsetInZone)
// como para derivar el tamaño de cada "zona" de tier (zoneSizeFor).
function cumSum(n) {
  return 2 * n * (2 * n - 1) * (2 * n + 1);
}

// Cantidad total de cubos en el rango de capas [minK, maxK] inclusive.
function zoneSizeFor(minK, maxK) {
  return cumSum(maxK + 1) - cumSum(minK);
}

function cubeNumberToFaceGridForK(n, K) {
  const gridSize = getLayerGridSize(K);
  const cubesPerFace = gridSize * gridSize;
  const totalCubes = cubesPerFace * 6;
  n = Number(n);
  if (!Number.isFinite(n) || n < 1 || n > totalCubes) return null;
  const zero = n - 1;
  const faceIndex = Math.floor(zero / cubesPerFace);
  const idx = zero % cubesPerFace;
  const gridY = Math.floor(idx / gridSize);
  const gridX = idx % gridSize;
  return { faceIndex, gridX, gridY };
}

// ─── Hash y recompensas deterministas ──────────────────────────────────────

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// SEC-B-1 / FIX-P0-8: HMAC-SHA256 con SERVER_SEED. Reemplaza fnv1a (32 bits,
// brute-forceable con ~100 observaciones) por un MAC criptográfico. Devuelve
// un u32 (primeros 4 bytes del digest) para mantener la misma interfaz.
function seededHash(seed, str) {
  return crypto.createHmac('sha256', String(seed || ''))
      .update(String(str))
      .digest()
      .readUInt32BE(0);
}

// SEC-B-1: SERVER_SEED es un secret server-side que se mezcla en los hashes
// para que un atacante NO pueda predecir qué cubos contienen premios.
// SERVER_SEED se inyecta desde Cloud Functions via defineSecret("SERVER_SEED").
//
// CRIT (Round 2 Agentes #1 HIGH-12 + #11 CRIT-11-05): derivar effectiveSeed
// per (serverId, episodeNumber) para limitar blast radius si SERVER_SEED se
// filtra. Sin esto, un leak compromete TODA la historia + futuro del juego.
// Con esto, las posiciones de premios de cada (server, episodio) son
// independientes — y permite un plan de rotación futura:
//
//   1) Crear SERVER_SEED_v2 en Secret Manager.
//   2) Cambiar el prefix `mtb-seed-v1|` a `mtb-seed-v2|` (o cambiar la
//      lógica para leer la versión desde un Firestore doc per-server).
//   3) Servers nuevos usan v2; in-flight siguen con v1 (determinismo).
//
// Si episodeNumber se omite, devolvemos el rootSeed crudo (backwards-compat
// con tests y callers viejos — el hash de seededHash sigue siendo el mismo).
function getEffectiveSeed(rootSeed, serverId, episodeNumber) {
  if (episodeNumber == null) return rootSeed;
  return crypto.createHmac('sha256', String(rootSeed || ''))
      .update(`mtb-seed-v1|${serverId}|ep:${episodeNumber}`)
      .digest('hex');
}

// ─── Motor genérico de premios (Fase 0 — parametrizable por server) ────────
//
// Round 3 (server Free + servers a medida): getGemForCube/getRewardForCube/
// getLayerUnlockThreshold aceptaban solo las 9 gemas hardcodeadas de
// constants.js. Se generalizan para aceptar un `config` explícito (tierTable
// + rewardBrackets) mientras que sin ese argumento se comportan IDÉNTICO a
// como lo hacían hasta ahora (DEFAULT_CONFIG = mismos 9 tiers/6 boundaries
// de siempre). Todo server ya creado sin `config` propio sigue usando
// DEFAULT_CONFIG automáticamente — cero cambio de comportamiento para ellos.
//
// Descubrimiento clave: getLayerUnlockThreshold(K) siempre fue, en realidad,
// "el unlockAt MÁXIMO entre los tiers cuya zona (maxK) alcanza esa capa K" —
// verificado contra las 6 bandas hardcodeadas que existían antes. Por eso acá
// se deriva directamente de la misma tierTable que usa getGemForCube, en vez
// de mantener una segunda tabla hardcodeada en paralelo (fuente de bugs si
// alguna vez se desincronizaban).

const DEFAULT_REWARD_BRACKETS = [
  { minK: 90, rate: 0.50 },
  { minK: 70, rate: 0.40 },
  { minK: 50, rate: 0.30 },
  { minK: 20, rate: 0.20 },
  { minK: 0, rate: 0.15 },
];

const DEFAULT_TIER_TABLE = [
  { tier: 1, price: GEM_PRICES[0], count: 1, minK: 0, maxK: 6 },
  { tier: 2, price: GEM_PRICES[1], count: 1, minK: 7, maxK: 16 },
  { tier: 3, price: GEM_PRICES[2], count: 5, minK: 17, maxK: 26 },
  { tier: 4, price: GEM_PRICES[3], count: 50, minK: 0, maxK: 46 },
  { tier: 5, price: GEM_PRICES[4], count: 100, minK: 0, maxK: 46 },
  { tier: 6, price: GEM_PRICES[5], count: 500, minK: 0, maxK: 81 },
  { tier: 7, price: GEM_PRICES[6], count: 1000, minK: 0, maxK: 81 },
  { tier: 8, price: GEM_PRICES[7], count: 4000, minK: 0, maxK: 97 },
  { tier: 9, price: GEM_PRICES[8], count: 10000, minK: 0, maxK: 97 },
].map((t, i) => Object.assign({}, t, {
  // eslint-disable-next-line security/detect-object-injection -- i acotado por .map() sobre array fijo de 9
  unlockAt: GEM_UNLOCK_THRESHOLDS[i],
  zoneSize: zoneSizeFor(t.minK, t.maxK),
}));

const DEFAULT_CONFIG = {
  tierTable: DEFAULT_TIER_TABLE,
  rewardBrackets: DEFAULT_REWARD_BRACKETS,
};

function winRateFor(K, rewardBrackets) {
  for (const b of rewardBrackets) {
    if (K >= b.minK) return b.rate;
  }
  return rewardBrackets[rewardBrackets.length - 1].rate;
}

function getRewardForCube(serverId, K, cubeNumber, serverSeed, episodeNumber, config) {
  const rewardBrackets = (config && config.rewardBrackets) || DEFAULT_REWARD_BRACKETS;
  const effectiveSeed = getEffectiveSeed(serverSeed, serverId, episodeNumber);
  const norm = seededHash(effectiveSeed, `${serverId}|${K}|${cubeNumber}`) / 0xffffffff;
  const winRate = winRateFor(K, rewardBrackets);
  if (norm >= winRate) return 0;
  const r = norm / winRate;
  if (r < 0.40) return 1;
  if (r < 0.70) return 2;
  if (r < 0.90) return 3;
  if (r < 0.95) return 4;
  return 5;
}

// Valor esperado de picos otorgados CONDICIONAL a ganar (misma distribución
// 40/30/20/5/5% de 1/2/3/4/5 picos que usa getRewardForCube arriba) = 2.05.
// Única fuente de verdad -- freeServerConfig.js (D4) y serverConfig.js
// (Fase 4, "picos de regalo" mostrados en el preview) comparten esta constante
// en vez de cada uno hardcodear su propia copia de 2.05.
const E_REWARD_GIVEN_WIN = 0.40 * 1 + 0.30 * 2 + 0.20 * 3 + 0.05 * 4 + 0.05 * 5;

// Total ESPERADO de picos que un server (o cadena) va a repartir a lo largo
// de toda su vida, integrando winRate(K) × E_REWARD_GIVEN_WIN sobre cada
// bracket de rewardBrackets y la cantidad real de cubos en su rango de capas
// (zoneSizeFor). Usado por serverConfig.js para mostrar "picos de regalo"
// en el preview de servers a medida -- es un valor esperado (no un pozo fijo:
// el sistema es probabilístico y sin tope, ver getRewardForCube), pero sirve
// como estimación fiel de la magnitud real para esa configuración.
function expectedTotalPicks(layerCount, rewardBrackets) {
  const sorted = (rewardBrackets || []).slice().sort((a, b) => b.minK - a.minK);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const minK = sorted[i].minK;
    const maxK = i === 0 ? layerCount : sorted[i - 1].minK - 1;
    if (maxK < minK) continue;
    total += zoneSizeFor(minK, maxK) * sorted[i].rate * E_REWARD_GIVEN_WIN;
  }
  return total;
}

// Motor genérico: recibe una tierTable explícita (no necesariamente los 9
// tiers estándar) — reusado tanto por getGemForCube (servers estándar/a
// medida) como por el futuro getFreeGemForCube (server Free, Fase 3).
function getGemForCubeGeneric(serverId, K, cubeNumber, memberCount, serverSeed, episodeNumber, tierTable) {
  if (K < 0) return null;

  // Computar effectiveSeed UNA vez (no por iteración) para no recalcular el
  // HMAC en cada chequeo de tier.
  const effectiveSeed = getEffectiveSeed(serverSeed, serverId, episodeNumber);
  const members = memberCount || 0;

  function offsetInZone(minK) {
    return cumSum(K) - cumSum(minK) + (cubeNumber - 1);
  }

  function hasPrize(tier, count, minK, zoneSize) {
    if (zoneSize <= 0 || count <= 0) return false;
    const offset = offsetInZone(minK);
    if (offset < 0 || offset >= zoneSize) return false;

    const base = Math.floor(zoneSize / count);
    const rem = zoneSize % count;
    let bucket; let within; let bSize;
    if (offset < (base + 1) * rem) {
      bucket = Math.floor(offset / (base + 1));
      within = offset % (base + 1);
      bSize = base + 1;
    } else {
      const adj = offset - rem * (base + 1);
      bucket = rem + Math.floor(adj / base);
      within = adj % base;
      bSize = base;
    }
    // SEC-B-1: HMAC-SHA256(SERVER_SEED, ...). Sin el secret, atacante no puede
    // calcular qué bucket contiene el premio (espacio 2^256, no brute-forceable).
    // Round 2: usar effectiveSeed (derivado per server-episode) en vez del seed crudo.
    return within === seededHash(effectiveSeed, `PRIZE|${serverId}|${tier}|${bucket}`) % bSize;
  }

  for (const t of tierTable) {
    if (t.unlockAt != null && members < t.unlockAt) continue;
    if (K > t.maxK) continue;
    const zoneSize = t.zoneSize != null ? t.zoneSize : zoneSizeFor(t.minK, t.maxK);
    if (hasPrize(t.tier, t.count, t.minK, zoneSize)) return t.tier;
  }
  return null;
}

function getGemForCube(serverId, K, cubeNumber, memberCount, serverSeed, episodeNumber, config) {
  const tierTable = (config && config.tierTable) || DEFAULT_TIER_TABLE;
  return getGemForCubeGeneric(serverId, K, cubeNumber, memberCount, serverSeed, episodeNumber, tierTable);
}

// ─── Layer unlock (audit Round 2 sesión 2026-06-23+) ─────────────────────────

// Threshold de miembros que el server necesita para que la capa K esté
// "desbloqueada" = el unlockAt MÁXIMO entre los tiers cuya zona alcanza esa
// capa (si memberCount no llega, algún tier no se asignaría ahí todavía).
// K más allá del maxK de todos los tiers (warmup, sin ningún tier posible)
// devuelve 0 = sin lock.
//
// SEC-review 2026-07-02: agregado el chequeo `K >= t.minK`. Antes solo se
// comparaba contra maxK -- válido para DEFAULT_TIER_TABLE (todos los tiers
// arrancan en minK:0 o particionan [0,26] contiguo, así que "K<=maxK" ya
// implicaba "tier alcanzable"), pero FREE_PRIZE_TABLE tiene tiers con
// minK>0 (ej. tier 3: minK:2, tier 9: minK:2) — sin este chequeo, K=0 y K=1
// heredaban el unlockAt de un tier que NUNCA puede premiar ahí (hasPrize ya
// excluye K<minK vía offsetInZone), bloqueando esas capas (y el cierre de
// episodio en K=0) detrás de un umbral que no correspondía a ningún premio
// real. Verificado que para DEFAULT_TIER_TABLE el resultado no cambia.
function getLayerUnlockThresholdGeneric(K, tierTable) {
  if (typeof K !== "number" || !Number.isFinite(K) || K < 0) return 0;
  let max = 0;
  for (const t of tierTable) {
    const minK = t.minK || 0; // tiers sin minK explícito (ej. legacy) asumen 0
    if (K >= minK && K <= t.maxK && t.unlockAt > max) max = t.unlockAt;
  }
  return max;
}

function getLayerUnlockThreshold(K, config) {
  const tierTable = (config && config.tierTable) || DEFAULT_TIER_TABLE;
  return getLayerUnlockThresholdGeneric(K, tierTable);
}

function isLayerUnlocked(K, memberCount, config) {
  const threshold = getLayerUnlockThreshold(K, config);
  if (threshold === 0) return true; // warmup / sin restricción
  return (Number(memberCount) || 0) >= threshold;
}

// ─── Códigos (referidos / canje) ───────────────────────────────────────────

// SEC-008: crypto.randomBytes en lugar de hash derivado del uid.
function generateReferralCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  // eslint-disable-next-line security/detect-object-injection -- índice acotado por % length
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function generateGemCode(serverId, K, cubeNumber, gemTier, _uid) {
  // FIX-P1: randomBytes en lugar de fnv1a(uid-derived).
  // El código no debería ser predecible aun conociendo todos los inputs.
  const hashHex = crypto.randomBytes(4).toString('hex').toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const saltBytes = crypto.randomBytes(6);
  let salt = '';
  // eslint-disable-next-line security/detect-object-injection -- índice acotado por % length
  for (let i = 0; i < 6; i++) salt += chars[saltBytes[i] % chars.length];
  return `MTB${gemTier}-${hashHex}-${salt}`;
}

// ─── Tiempo / status diario ────────────────────────────────────────────────

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Number(ts) || 0;
}

// Cambio 1 (picos por cadena): reemplaza al viejo buildStatus() (operaba
// sobre users/{uid} global, con 2 slots de ads hardcodeados ad1NextAt/
// ad2NextAt) — ahora opera sobre un doc de
// `users/{uid}/chainAccess/{chainId}`, con cantidad de slots de ads variable
// (2 en cadenas estándar, hasta 5 en el server Free — Fase 3).
function buildChainStatus(chainData, nowMs, dailyAdSlots, dailyFreeClaim) {
  chainData = chainData || {};
  const picks = Number(chainData.picks || 0);
  const createdAt = toMillis(chainData.createdAt) || nowMs;
  const lastDailyAt = toMillis(chainData.lastDailyAt) || 0;
  const anchorDaily = lastDailyAt || createdAt;
  const ads = chainData.ads || {};
  const adNextAt = {};
  const slots = Number(dailyAdSlots) || 2;
  for (let i = 1; i <= slots; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i es un contador 1..slots (entero acotado)
    adNextAt[i] = (toMillis(ads[i]) || 0) + DAY_MS;
  }
  return {
    picks,
    serverNow: nowMs,
    nextDailyAt: anchorDaily + DAY_MS,
    adNextAt,
    dailyAdSlots: slots,
    // Cambio 2 (server Free): el frontend necesita esto para no mostrar la
    // tarjeta "Daily" ni reintentar el auto-claim contra una cadena que no
    // reparte picos diarios (dailyFreeClaim: false en su config).
    dailyFreeClaim: dailyFreeClaim !== false,
  };
}

// ─── HTTP utils ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Audit feedback 2026-06-23+: setCorsHeaders (wildcard *) REMOVIDO.
// Era código muerto — ningún caller en functions/ lo importaba (verificado
// con grep). Reducimos superficie ante un error futuro de copy-paste que
// pueda reintroducirlo. Si en el futuro necesitás CORS abierto (servicios
// públicos sin auth de origin), declararlo explícitamente con justificación.

// Allowlist de origins permitidos para endpoints HTTP restringidos.
// Se refleja el origin que matchee (en vez de hardcodear uno) para soportar
// la migración github.io → miningtheblocks.com sin romper el sitio viejo.
const ALLOWED_ORIGINS = new Set([
  "https://miningtheblocks.github.io",
  "https://miningtheblocks.com",
  "https://www.miningtheblocks.com",
]);

function setRestrictedCorsHeaders(req, res) {
  const origin = req && typeof req.get === "function" ? req.get("Origin") : null;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = {
  getLayerGridSize,
  shellTotalCubes,
  cumSum,
  zoneSizeFor,
  cubeNumberToFaceGridForK,
  fnv1a,
  seededHash,
  getEffectiveSeed,
  getRewardForCube,
  E_REWARD_GIVEN_WIN,
  expectedTotalPicks,
  getGemForCube,
  getGemForCubeGeneric,
  getLayerUnlockThreshold,
  getLayerUnlockThresholdGeneric,
  isLayerUnlocked,
  generateReferralCode,
  generateGemCode,
  toMillis,
  buildChainStatus,
  esc,
  setRestrictedCorsHeaders,
  DEFAULT_CONFIG,
  DEFAULT_TIER_TABLE,
  DEFAULT_REWARD_BRACKETS,
};
