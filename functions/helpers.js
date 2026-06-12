/* eslint-disable max-len */
/* eslint-disable quotes */
/* eslint-disable require-jsdoc */
/* eslint-disable no-invalid-this */
/* eslint-disable object-curly-spacing */

const crypto = require("crypto");
const { GEM_UNLOCK_THRESHOLDS, DAY_MS } = require("./constants");

// ─── Geometría del cubo ────────────────────────────────────────────────────

function getLayerGridSize(K) {
  return 2 * K + 1;
}

function shellTotalCubes(K) {
  const g = getLayerGridSize(K);
  return g * g * 6;
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
function getRewardForCube(serverId, K, cubeNumber, serverSeed) {
  const norm = seededHash(serverSeed, `${serverId}|${K}|${cubeNumber}`) / 0xffffffff;
  const winRate = K >= 90 ? 0.50 : K >= 70 ? 0.40 : K >= 50 ? 0.30 : K >= 20 ? 0.20 : 0.15;
  if (norm >= winRate) return 0;
  const r = norm / winRate;
  if (r < 0.40) return 1;
  if (r < 0.70) return 2;
  if (r < 0.90) return 3;
  if (r < 0.95) return 4;
  return 5;
}

function getGemForCube(serverId, K, cubeNumber, memberCount, serverSeed) {
  if (K >= 98) return null;

  const members = memberCount || 0;
  const tierUnlocked = (tier) => members >= GEM_UNLOCK_THRESHOLDS[tier - 1];

  function cumSum(n) {
    return 2 * n * (2 * n - 1) * (2 * n + 1);
  }

  function offsetInZone(minK) {
    return cumSum(K) - cumSum(minK) + (cubeNumber - 1);
  }

  function hasPrize(tier, count, minK, zoneSize) {
    if (!tierUnlocked(tier)) return false;
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
    return within === seededHash(serverSeed, `PRIZE|${serverId}|${tier}|${bucket}`) % bSize;
  }

  if (K <= 6) {
    if (hasPrize(1, 1, 0, 2730)) return 1;
  } else if (K <= 16) {
    if (hasPrize(2, 1, 7, 36540)) return 2;
  } else if (K <= 26) {
    if (hasPrize(3, 5, 17, 118140)) return 3;
  }

  if (K <= 46 && hasPrize(4, 50, 0, 830490)) return 4;
  if (K <= 46 && hasPrize(5, 100, 0, 830490)) return 5;
  if (K <= 81 && hasPrize(6, 500, 0, 4410780)) return 6;
  if (K <= 81 && hasPrize(7, 1000, 0, 4410780)) return 7;
  if (hasPrize(8, 4000, 0, 7529340)) return 8;
  if (hasPrize(9, 10000, 0, 7529340)) return 9;

  return null;
}

// ─── Códigos (referidos / canje) ───────────────────────────────────────────

// SEC-008: crypto.randomBytes en lugar de hash derivado del uid.
function generateReferralCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function generateGemCode(serverId, K, cubeNumber, gemTier, uid) {
  // FIX-P1: randomBytes en lugar de fnv1a(uid-derived).
  // El código no debería ser predecible aun conociendo todos los inputs.
  const hashHex = crypto.randomBytes(4).toString('hex').toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const saltBytes = crypto.randomBytes(6);
  let salt = '';
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

function buildStatus(userData, nowMs) {
  userData = userData || {};
  const picks = Number(userData.picks || 0);
  const createdAt = toMillis(userData.createdAt) || nowMs;
  const lastDailyAt = toMillis(userData.lastDailyAt) || 0;
  const lastAd1At = toMillis(userData.lastAd1At) || 0;
  const lastAd2At = toMillis(userData.lastAd2At) || 0;
  const anchorDaily = lastDailyAt || createdAt;
  return {
    picks,
    serverNow: nowMs,
    nextDailyAt: anchorDaily + DAY_MS,
    ad1NextAt: (lastAd1At || 0) + DAY_MS,
    ad2NextAt: (lastAd2At || 0) + DAY_MS,
  };
}

// ─── HTTP utils ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function setRestrictedCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "https://miningtheblocks.github.io");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = {
  getLayerGridSize,
  shellTotalCubes,
  cubeNumberToFaceGridForK,
  fnv1a,
  seededHash,
  getRewardForCube,
  getGemForCube,
  generateReferralCode,
  generateGemCode,
  toMillis,
  buildStatus,
  esc,
  setCorsHeaders,
  setRestrictedCorsHeaders,
};
