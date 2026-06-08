/* eslint-disable no-console */
/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
/* eslint-disable quotes */
/* eslint-disable object-curly-spacing */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const functionsV1 = require("firebase-functions");
const { ethers } = require("ethers");
const admin = require("firebase-admin");

try {
  admin.initializeApp();
} catch (e) {/* already initialized */}

const db = admin.firestore();

// ─── Constantes ──────────────────────────────────────────────────────────────

const MAX_EPISODES = 10; // Eslabones por cadena
const STARTING_LAYER = 100; // Capa de inicio de cada episodio

// Precio fijo por tier (USD) — tier 1 = más raro = más caro
const GEM_PRICES = [100000, 50000, 10000, 1000, 500, 100, 50, 25, 15];

// Máximo de jugadores por servidor/eslabon
const MAX_MEMBERS_PER_SERVER = 100000;

// Usuarios mínimos para desbloquear cada tier de gema.
// Fórmula: suma acumulada de (cantidad × precio) de ese tier y todos los más baratos, dividido $15.
// Garantiza que la recaudación cubre 100% el pool de premios antes de que aparezca el tier.
// Indexed by tier (1-9): GEM_UNLOCK_THRESHOLDS[tier - 1]
// +25% de margen sobre el mínimo de break-even para cada tier
const GEM_UNLOCK_THRESHOLDS = [
  54167, // tier 1: $100k  — break-even 43.333 × 1.25
  45834, // tier 2: $50k   — break-even 36.667 × 1.25
  41667, // tier 3: $10k   — break-even 33.333 × 1.25
  37500, // tier 4: $1k    — break-even 30.000 × 1.25
  33334, // tier 5: $500   — break-even 26.667 × 1.25
  29167, // tier 6: $100   — break-even 23.333 × 1.25
  25000, // tier 7: $50    — break-even 20.000 × 1.25
  20834, // tier 8: $25    — break-even 16.667 × 1.25
  12500, // tier 9: $15    — break-even 10.000 × 1.25
];

// TokenURIs IPFS para cada tier de gema (metadata ERC-721 en IPFS)
const GEM_TOKEN_URIS = [
  'ipfs://bafkreiazqr5ll6frb27jxl6n6pp7c7jrfy2stcezwl7r3hr4iyyqxctl5m', // tier 1
  'ipfs://bafkreiggojefjwtthfjpxg454euhzf3zajjadlw3q6nv3tttorvu3frndq', // tier 2
  'ipfs://bafkreif4ysa3pwnrpuqqmtk4647a26vfwyfp3tbpe5ypcivjytptr3b7he', // tier 3
  'ipfs://bafkreicc4vvma5xb3u65poxnncqj63z3jke5q3zo53s2vfc3vzjcxpefaa', // tier 4
  'ipfs://bafkreiggrq4ipierqj2eyfzg7qm4gfuyl5ve6hhpknqvjnqzy7vg6ijpdm', // tier 5
  'ipfs://bafkreigxc6uqc7co6qcu4mzaq2tnkqwcsngfet63eczmmgwfzbyhmmpogq', // tier 6
  'ipfs://bafkreidex4rj7rofevpe45u2sdvvnq5hkovxulqjtpjjj2xjakxvuzpbi4', // tier 7
  'ipfs://bafkreiaujynahu64ui75bihvggjh5thoesn7ewgjqgqgafjf24osdb4lci', // tier 8
  'ipfs://bafkreiabkbvz5g3b3alkh3omymgg2urw47bgtal3sd7kudxtebohk2pzta', // tier 9
];

// Dirección del contrato MTBGems en Polygon (deployado 2026-06-03)
const MTBGEMS_CONTRACT = process.env.MTBGEMS_CONTRACT || '0x54c2859411afCb51fcfE42054aDcA3484B3f29E6';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// FNV-1a hash — usado para recompensas deterministas
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// Deterministic reward for a cube — no pre-population needed
// Returns 0 (no reward) or 1-5 (picks won)
function getRewardForCube(serverId, K, cubeNumber) {
  const norm = fnv1a(`${serverId}|${K}|${cubeNumber}`) / 0xffffffff;
  const winRate = K >= 90 ? 0.50 : K >= 70 ? 0.40 : K >= 50 ? 0.30 : K >= 20 ? 0.20 : 0.15;
  if (norm >= winRate) return 0;
  const r = norm / winRate;
  if (r < 0.40) return 1;
  if (r < 0.70) return 2;
  if (r < 0.90) return 3;
  if (r < 0.95) return 4;
  return 5;
}

// Deterministic gem reward — independent hash from picks
// Returns null (no gem) or 1-9 (gem tier, 1=rarest, 9=most common)
// Tiers más raros solo se desbloquean en capas más profundas Y cuando hay suficientes jugadores
// para que la recaudación cubra 100% el pool de premios de ese tier.
function getGemForCube(serverId, K, cubeNumber, memberCount) {
  if (K >= 98) return null; // capas 1-3: solo picos, sin gemas
  const norm = fnv1a(`GEM|${serverId}|${K}|${cubeNumber}`) / 0xffffffff;
  const GEM_WIN_RATE = 0.002;
  if (norm >= GEM_WIN_RATE) return null;
  const r = norm / GEM_WIN_RATE;
  const members = memberCount || 0;
  const tierUnlocked = (tier) => members >= GEM_UNLOCK_THRESHOLDS[tier - 1];

  // Zonas exclusivas para los 3 premios mayores (capa_usuario = 101 - K)
  // Cada zona es única: en capa 96 solo puede aparecer $100K, no $50K ni $10K
  if (K <= 6) {
    // $100,000 — capas 95-101 (K 0-6)
    if (r < 0.000065) return tierUnlocked(1) ? 1 : null;
  } else if (K <= 16) {
    // $50,000 — capas 85-95 (K 7-16)
    if (r < 0.000130) return tierUnlocked(2) ? 2 : null;
  } else if (K <= 26) {
    // $10,000 — capas 75-85 (K 17-26)
    if (r < 0.000452) return tierUnlocked(3) ? 3 : null;
  }

  // $1,000 y $500 — capas 55-101 (K <= 46), disponibles en todas las zonas anteriores también
  if (K <= 46) {
    if (r < 0.003667) return tierUnlocked(4) ? 4 : null;
    if (r < 0.010115) return tierUnlocked(5) ? 5 : null;
  }

  // $100 y $50 — capas 20-101 (K <= 81)
  if (K <= 81) {
    if (r < 0.043098) return tierUnlocked(6) ? 6 : null;
    if (r < 0.107027) return tierUnlocked(7) ? 7 : null;
  }

  // $25 y $15 — todas las capas (4-101)
  if (r < 0.362717) return tierUnlocked(8) ? 8 : null;
  return tierUnlocked(9) ? 9 : null;
}

// Genera un código de canje único y verificable para una gema
// Formato: MTBt-XXXXXXXX-RRRRRR  (t=tier, X=hash, R=salt aleatorio)
function generateGemCode(serverId, K, cubeNumber, gemTier, uid) {
  const hashHex = fnv1a(`CODE|${serverId}|${K}|${cubeNumber}|${gemTier}|${uid}`)
      .toString(16).padStart(8, '0').toUpperCase();
  // Salt de 6 chars alfanumérico (no predictible)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let salt = '';
  const h2 = fnv1a(`SALT|${serverId}|${cubeNumber}|${uid}|${Date.now()}`);
  for (let i = 0; i < 6; i++) {
    salt += chars[(h2 >> (i * 5)) & 31];
  }
  return `MTB${gemTier}-${hashHex}-${salt}`;
}

// ─── Activity Feed ───────────────────────────────────────────────────────────

async function writeActivity(type, data) {
  try {
    await db.collection("activityFeed").add({ type, ts: Date.now(), ...data });
  } catch (e) {
    console.warn("writeActivity failed:", e.message);
  }
}

// ─── Chain helpers ───────────────────────────────────────────────────────────

// Crea el siguiente episodio dentro de una cadena existente
async function startNextEpisode(chainRef, chainData, prevServerId) {
  const nextEpisode = chainData.currentEpisode + 1;
  const K = STARTING_LAYER;
  const totalCubes = shellTotalCubes(K);

  const serverRef = db.collection("servers").doc();
  const batch = db.batch();

  batch.set(serverRef, {
    name: chainData.name,
    createdBy: chainData.createdBy,
    createdAt: Date.now(),
    status: 'active',
    currentLayer: K,
    totalMined: 0,
    winner: null,
    completedAt: null,
    memberCount: 0,
    chainId: chainRef.id,
    episodeNumber: nextEpisode,
    prevServerId,
    episodeStartAt: Date.now(), // marca para reset lazy de picos al iniciar episodio
  });

  // Layer inicial del episodio
  batch.set(serverRef.collection("layers").doc(String(K)), {
    K,
    totalCubes,
    stats: { mined: 0 },
    winRate: 0.50,
  });

  // Actualizar el chain
  batch.set(chainRef, {
    currentEpisode: nextEpisode,
    currentServerId: serverRef.id,
  }, { merge: true });

  await batch.commit();
  return serverRef.id;
}

// Guarda el snapshot final de un episodio completo en el chain
async function closeEpisode(chainRef, serverRef, serverData, winnerUid, totalMinedFinal) {
  const episodeNumber = serverData.episodeNumber || 1;
  const chainId = chainRef.id;

  const episodeSnap = {
    serverId: serverRef.id,
    episodeNumber,
    completedAt: Date.now(),
    winner: winnerUid,
    totalMined: totalMinedFinal,
    chainId,
  };

  // Guardar episodio en subcolección
  await chainRef.collection("episodes").doc(String(episodeNumber)).set(episodeSnap);

  // Activity feed: episodio completo
  writeActivity("episode_complete", {
    chainId,
    chainName: serverData ? (serverData.name || null) : null,
    episodeNumber,
    winner: winnerUid,
    totalMined: totalMinedFinal,
  });

  const isLastEpisode = episodeNumber >= MAX_EPISODES;

  if (isLastEpisode) {
    // Cadena completa — cerrar definitivamente
    await chainRef.set({
      status: 'completed',
      completedAt: Date.now(),
      currentServerId: null,
    }, { merge: true });
  } else {
    // Iniciar siguiente episodio automáticamente
    await startNextEpisode(chainRef, (await chainRef.get()).data(), serverRef.id);
  }

  return { isLastEpisode, nextEpisode: isLastEpisode ? null : episodeNumber + 1 };
}

// ─── Helpers de créditos ─────────────────────────────────────────────────────

// Verifica y descuenta 1 crédito de acceso a server.
// Lanza error si no tiene créditos.
async function consumeServerCredit(uid, transaction) {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await transaction.get(userRef);
  const credits = (userSnap.exists ? userSnap.data().serverCredits : 0) || 0;
  if (credits < 1) throw new HttpsError("failed-precondition", "No server credits");
  transaction.set(userRef, { serverCredits: credits - 1 }, { merge: true });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// Agregar créditos de acceso a un usuario (llamado por Stripe / token / admin)
exports.addServerCredit = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  if (!request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only");
  }

  const targetUid = String((request.data && request.data.uid) || '');
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required");
  const amount = Math.max(1, Math.min(100, Math.floor(Number((request.data && request.data.amount) || 1))));

  const userRef = db.collection("users").doc(targetUid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const current = (snap.exists ? snap.data().serverCredits : 0) || 0;
    tx.set(userRef, { serverCredits: current + amount }, { merge: true });
  });

  return { ok: true, added: amount };
});

// Crear servidor (crea también el chain si no existe)
exports.createServer = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const name = String((request.data && request.data.name) || '').trim().slice(0, 40);
  if (!name) throw new HttpsError("invalid-argument", "Server name required");

  const K = STARTING_LAYER;
  const totalCubes = shellTotalCubes(K);

  const chainRef = db.collection("serverChains").doc();
  const serverRef = db.collection("servers").doc();
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    // Verificar y descontar crédito
    await consumeServerCredit(uid, tx);

    tx.set(chainRef, {
      name,
      createdBy: uid,
      createdAt: Date.now(),
      status: 'active',
      currentEpisode: 1,
      currentServerId: serverRef.id,
      completedAt: null,
    });

    tx.set(serverRef, {
      name,
      createdBy: uid,
      createdAt: Date.now(),
      status: 'active',
      currentLayer: K,
      totalMined: 0,
      winner: null,
      completedAt: null,
      memberCount: 1,
      chainId: chainRef.id,
      episodeNumber: 1,
      prevServerId: null,
    });

    tx.set(serverRef.collection("layers").doc(String(K)), {
      K,
      totalCubes,
      stats: { mined: 0 },
      winRate: 0.50,
    });

    // Registrar acceso del creador
    tx.set(userRef.collection("serverAccess").doc(serverRef.id), {
      serverId: serverRef.id,
      chainId: chainRef.id,
      joinedAt: Date.now(),
      role: 'creator',
    });

    // Bienvenida: 5 picos al pagar la entrada
    tx.set(userRef, { picks: admin.firestore.FieldValue.increment(5) }, { merge: true });
  });

  writeActivity("player_joined", {
    chainId: chainRef.id,
    chainName: name,
    serverId: serverRef.id,
  });

  return { ok: true, serverId: serverRef.id, chainId: chainRef.id, welcomePicks: 5 };
});

// Unirse a un server existente (consume 1 crédito)
exports.joinServer = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const serverId = String((request.data && request.data.serverId) || '');
  if (!serverId) throw new HttpsError("invalid-argument", "serverId required");

  const serverRef = db.collection("servers").doc(serverId);
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const serverSnap = await tx.get(serverRef);
    if (!serverSnap.exists) throw new HttpsError("not-found", "Server not found");
    if (serverSnap.data().status === 'completed') throw new HttpsError("failed-precondition", "Server already completed");

    // Ver si ya tiene acceso (no cobrar dos veces)
    const accessRef = userRef.collection("serverAccess").doc(serverId);
    const accessSnap = await tx.get(accessRef);
    if (accessSnap.exists) return; // Ya pagó, no hacer nada

    const serverData = serverSnap.data();
    const serverChainId = serverData.chainId || null;

    // Verificar límite de jugadores por eslabon
    if ((serverData.memberCount || 0) >= MAX_MEMBERS_PER_SERVER) {
      throw new HttpsError("resource-exhausted", "server_full");
    }

    // Servers legacy (sin chainId) son de acceso libre — fueron creados antes del sistema de créditos
    if (!serverChainId) {
      tx.set(accessRef, { serverId, chainId: null, joinedAt: Date.now(), role: 'member' });
      return;
    }

    // Episodio final (10) es gratis para quien jugó los 9 anteriores de la misma cadena
    const episodeNumber = serverData.episodeNumber || 1;
    if (episodeNumber >= MAX_EPISODES) {
      const chainAccessSnaps = await tx.get(
          userRef.collection("serverAccess").where("chainId", "==", serverChainId),
      );
      if (chainAccessSnaps.size >= MAX_EPISODES - 1) {
        tx.set(accessRef, { serverId, chainId: serverChainId, joinedAt: Date.now(), role: 'member', freeEpisode: true });
        tx.set(serverRef, { memberCount: (serverData.memberCount || 0) + 1 }, { merge: true });
        return;
      }
    }

    // Verificar y descontar crédito
    await consumeServerCredit(uid, tx);

    // Registrar acceso
    tx.set(accessRef, {
      serverId,
      chainId: serverChainId,
      joinedAt: Date.now(),
      role: 'member',
    });

    // Bienvenida: 5 picos al pagar la entrada
    tx.set(userRef, { picks: admin.firestore.FieldValue.increment(5) }, { merge: true });

    // Incrementar memberCount
    tx.set(serverRef, { memberCount: (serverData.memberCount || 0) + 1 }, { merge: true });
  });

  // Activity feed: jugador unido
  const serverSnap2 = await serverRef.get();
  writeActivity("player_joined", {
    chainId: serverSnap2.exists ? (serverSnap2.data().chainId || null) : null,
    chainName: serverSnap2.exists ? (serverSnap2.data().name || null) : null,
    serverId,
  });

  return { ok: true, serverId, welcomePicks: 5 };
});

// Verificar si el usuario tiene acceso a un server (sin consumir crédito)
exports.checkServerAccess = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const serverId = String((request.data && request.data.serverId) || '');
  if (!serverId) throw new HttpsError("invalid-argument", "serverId required");

  const [accessSnap, userSnap] = await Promise.all([
    db.collection("users").doc(uid).collection("serverAccess").doc(serverId).get(),
    db.collection("users").doc(uid).get(),
  ]);

  return {
    hasAccess: accessSnap.exists,
    serverCredits: (userSnap.exists ? userSnap.data().serverCredits : 0) || 0,
  };
});

exports.getServers = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const snap = await db.collection("servers")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

  const servers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { servers };
});

// Obtener info de una cadena (chain) con todos sus episodios
exports.getChain = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const chainId = String((request.data && request.data.chainId) || '');
  if (!chainId) throw new HttpsError("invalid-argument", "chainId required");

  const chainRef = db.collection("serverChains").doc(chainId);
  const [chainSnap, episodesSnap] = await Promise.all([
    chainRef.get(),
    chainRef.collection("episodes").orderBy("episodeNumber", "asc").get(),
  ]);

  if (!chainSnap.exists) throw new HttpsError("not-found", "Chain not found");

  const chain = { id: chainSnap.id, ...chainSnap.data() };
  const episodes = episodesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return { chain, episodes };
});

// Obtener gemas del usuario (wallet)
exports.getUserGems = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const snap = await db.collection("users").doc(uid)
      .collection("gems")
      .orderBy("discoveredAt", "desc")
      .limit(100)
      .get();

  const gems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { gems };
});

// Canjear código de gema por dinero (marca la gema como canjeada)
exports.redeemGem = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const gemId = String((request.data && request.data.gemId) || '');
  if (!gemId) throw new HttpsError("invalid-argument", "gemId required");

  const gemRef = db.collection("users").doc(uid).collection("gems").doc(gemId);
  const gemSnap = await gemRef.get();

  if (!gemSnap.exists) throw new HttpsError("not-found", "Gem not found");
  const gem = gemSnap.data();

  if (gem.status !== 'unclaimed') {
    throw new HttpsError("failed-precondition",
      gem.status === 'redeemed' ? "Gem already redeemed" : "Gem already minted as NFT");
  }

  const price = GEM_PRICES[gem.gemTier - 1] || 0;

  await gemRef.set({
    status: 'redeemed',
    redeemedAt: Date.now(),
    redeemedValue: price,
  }, { merge: true });

  // Registrar en cola de pagos para procesamiento manual/automático
  await db.collection("pendingPayments").add({
    uid,
    gemId,
    gemTier: gem.gemTier,
    gemCode: gem.code,
    amountUSD: price,
    createdAt: Date.now(),
    status: 'pending',
  });

  return { ok: true, amountUSD: price };
});

// Vincular wallet para recibir el NFT (marca la gema como "minting")
exports.claimGemNFT = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const gemId = String((request.data && request.data.gemId) || '');
  const walletAddress = String((request.data && request.data.walletAddress) || '').trim();

  if (!gemId) throw new HttpsError("invalid-argument", "gemId required");
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new HttpsError("invalid-argument", "Invalid Ethereum wallet address");
  }

  const gemRef = db.collection("users").doc(uid).collection("gems").doc(gemId);
  const gemSnap = await gemRef.get();

  if (!gemSnap.exists) throw new HttpsError("not-found", "Gem not found");
  const gem = gemSnap.data();

  if (gem.status !== 'unclaimed') {
    throw new HttpsError("failed-precondition",
      gem.status === 'redeemed' ? "Gem already redeemed for cash" : "NFT already claimed");
  }

  await gemRef.set({
    status: 'minting',
    walletAddress,
    claimedAt: Date.now(),
  }, { merge: true });

  // Encolar para minteo (procesado por el backend de NFT — Polygon)
  await db.collection("pendingMints").add({
    uid,
    gemId,
    gemTier: gem.gemTier,
    gemCode: gem.code,
    tokenURI: GEM_TOKEN_URIS[(gem.gemTier - 1)] || null,
    walletAddress,
    priceUSD: GEM_PRICES[(gem.gemTier - 1)] || 0,
    createdAt: Date.now(),
    status: 'pending',
  });

  return { ok: true, walletAddress };
});

// ─── Mining ──────────────────────────────────────────────────────────────────

exports.mineCube = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const cubeNumber = String((request.data && request.data.cubeNumber) || '');
  const serverId = String((request.data && request.data.serverId) || '');
  if (!serverId) throw new HttpsError("invalid-argument", "serverId required");
  if (!cubeNumber || isNaN(Number(cubeNumber))) throw new HttpsError("invalid-argument", "cubeNumber required");

  const serverRef = db.collection("servers").doc(serverId);
  const userRef = db.collection("users").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const serverSnap = await tx.get(serverRef);
    if (!serverSnap.exists) throw new HttpsError("not-found", "Server not found");
    const serverData = serverSnap.data();
    // Allow legacy servers that were created before the status field was added
    if (serverData.status && serverData.status !== 'active') throw new HttpsError("failed-precondition", "Server not active");

    const K = serverData.currentLayer;
    const TOTAL_CUBES_K = shellTotalCubes(K);
    const n = Number(cubeNumber);
    if (n < 1 || n > TOTAL_CUBES_K) throw new HttpsError("invalid-argument", "Cube out of range for current layer");

    const minedRef = serverRef.collection("mined").doc(cubeNumber);
    const layerRef = serverRef.collection("layers").doc(String(K));

    const [minedSnap, userSnap, layerSnap] = await Promise.all([
      tx.get(minedRef), tx.get(userRef), tx.get(layerRef),
    ]);

    if (minedSnap.exists) return { ok: true, alreadyMined: true };

    let picks = userSnap.exists ? (Number(userSnap.data().picks) || 0) : 0;
    if (!userSnap.exists) {
      picks = 5;
      const refCode = fnv1a(uid + "REF").toString(36).toUpperCase().slice(0, 7);
      tx.set(userRef, { picks: 5, createdAt: Date.now(), referralCode: refCode }, { merge: true });
    }

    // Reset lazy de picos: si el servidor inició un nuevo episodio y el usuario no fue reseteado aún
    const episodeStartAt = serverData.episodeStartAt || 0;
    const picksLastResetAt = userSnap.exists ? (userSnap.data().picksLastResetAt || 0) : 0;
    const needsPicksReset = episodeStartAt > 0 && picksLastResetAt < episodeStartAt;
    if (needsPicksReset) picks = 5;

    if (picks <= 0) throw new HttpsError("failed-precondition", "No picks");

    const currentMined = layerSnap.exists ? (layerSnap.data().stats && layerSnap.data().stats.mined) || 0 : 0;
    const cubesRemaining = TOTAL_CUBES_K - currentMined;

    // Rate limit: máximo 1 mine cada 2s por usuario — previene bots, sin costo extra
    if (userSnap.exists) {
      const lastMineAt = userSnap.data().lastMineAt || 0;
      if (Date.now() - lastMineAt < 2000) {
        const waitSec = Math.ceil((2000 - (Date.now() - lastMineAt)) / 1000);
        throw new HttpsError("resource-exhausted", `rate_limited:${waitSec}`);
      }
    }

    // Episodio termina cuando se completa la capa central (K=0)
    // Flujo: K=100 (exterior) → K=99 → ... → K=0 (centro) → episodio completo
    // K=0 es un cubo único de 6 caras — la primera cara minada destruye el cubo y termina el episodio
    const layerComplete = (currentMined + 1) >= TOTAL_CUBES_K;
    const episodeComplete = K === 0;

    const reward = getRewardForCube(serverId, K, cubeNumber);
    const gem = getGemForCube(serverId, K, cubeNumber, serverData.memberCount || 0);

    const userUpdate = { lastMineAt: Date.now() };
    if (needsPicksReset) {
      userUpdate.picks = 4 + reward;
      userUpdate.picksLastResetAt = episodeStartAt;
    } else {
      userUpdate.picks = admin.firestore.FieldValue.increment(-1 + reward);
    }
    tx.set(userRef, userUpdate, { merge: true });

    const mapped = cubeNumberToFaceGridForK(n, K) || {};
    tx.set(minedRef, { by: uid, ts: Date.now(), K, rewardPicks: reward, gem: gem || 0, ...mapped });
    tx.set(layerRef, { K, totalCubes: TOTAL_CUBES_K, stats: { mined: admin.firestore.FieldValue.increment(1) } }, { merge: true });

    const serverUpdate = { totalMined: admin.firestore.FieldValue.increment(1) };

    if (episodeComplete) {
      serverUpdate.status = 'completed';
      serverUpdate.completedAt = Date.now();
      serverUpdate.winner = uid;
    } else if (layerComplete) {
      // Capa completa — pasar a la siguiente capa interior
      serverUpdate.currentLayer = K - 1;
    }

    tx.set(serverRef, serverUpdate, { merge: true });

    return {
      ok: true,
      reward,
      gem: gem || null,
      layerComplete,
      episodeComplete,
      currentLayer: layerComplete && !episodeComplete ? K - 1 : K,
      chainId: serverData.chainId || null,
      episodeNumber: serverData.episodeNumber || 1,
      cubesRemaining: cubesRemaining - 1,
    };
  });

  // Guardar gema en la wallet del usuario (fuera de transacción para no bloquearla)
  if (result.gem) {
    try {
      const gemCode = generateGemCode(serverId, result.currentLayer, cubeNumber, result.gem, uid);
      const serverSnap = await serverRef.get();
      const serverData = serverSnap.data() || {};

      // Verificar si el usuario tiene wallet vinculada para auto-mintear el NFT
      const userSnap = await db.collection("users").doc(uid).get();
      const userWallet = userSnap.exists ? (userSnap.data().walletAddress || null) : null;
      const gemStatus = userWallet ? 'minting' : 'unclaimed';

      const gemRef = await db.collection("users").doc(uid).collection("gems").add({
        gemTier: result.gem,
        code: gemCode,
        serverId,
        chainId: serverData.chainId || null,
        episodeNumber: serverData.episodeNumber || 1,
        cubeNumber: Number(cubeNumber),
        layerK: result.currentLayer,
        discoveredAt: Date.now(),
        status: gemStatus,
        redeemedAt: null,
        walletAddress: userWallet,
        priceUSD: GEM_PRICES[result.gem - 1] || 0,
      });

      // Si tiene wallet, crear el pendingMint automáticamente
      if (userWallet) {
        await db.collection("pendingMints").add({
          uid,
          gemId: gemRef.id,
          gemTier: result.gem,
          gemCode,
          tokenURI: GEM_TOKEN_URIS[(result.gem - 1)] || null,
          walletAddress: userWallet,
          priceUSD: GEM_PRICES[result.gem - 1] || 0,
          createdAt: Date.now(),
          status: 'pending',
        });
      }
    } catch (e) {
      console.warn("Gem save warning:", e.message);
    }
  }

  // Activity feed: gema encontrada
  if (result.gem) {
    const serverSnap2 = await serverRef.get();
    const sData = serverSnap2.data() || {};
    writeActivity("gem_found", {
      gemTier: result.gem,
      gemName: ["Diamante rojo", "Painita", "Musgravita", "Jadeíta imperial", "Alejandrita", "Rubí sangre de paloma", "Diamante azul", "Diamante rosa", "Esmeralda colombiana"][result.gem - 1] || "",
      priceUSD: GEM_PRICES[result.gem - 1] || 0,
      layerK: result.currentLayer,
      chainId: result.chainId || null,
      chainName: sData.name || null,
      serverId,
      episodeNumber: result.episodeNumber || 1,
    });
  }

  // Activity feed: capa completa
  if (result.layerComplete && !result.episodeComplete) {
    const serverSnap2 = result.gem ? null : await serverRef.get();
    const sData = serverSnap2 ? (serverSnap2.data() || {}) : {};
    writeActivity("layer_complete", {
      layerK: result.currentLayer + 1,
      nextLayerK: result.currentLayer,
      chainId: result.chainId || null,
      chainName: sData.name || null,
      serverId,
      episodeNumber: result.episodeNumber || 1,
    });
  }

  // Inicializar stats de la siguiente capa si corresponde
  if (result.layerComplete && !result.episodeComplete && result.currentLayer >= 0) {
    try {
      const nextK = result.currentLayer;
      const nextLayerRef = serverRef.collection("layers").doc(String(nextK));
      const nextSnap = await nextLayerRef.get();
      if (!nextSnap.exists) {
        await nextLayerRef.set({
          K: nextK,
          totalCubes: shellTotalCubes(nextK),
          stats: { mined: 0 },
          winRate: nextK >= 90 ? 0.50 : nextK >= 70 ? 0.40 : nextK >= 50 ? 0.30 : nextK >= 20 ? 0.20 : 0.15,
        });
      }
    } catch (e) {
      console.warn("Layer init warning:", e.message);
    }
  }

  // Si el episodio terminó, manejar la cadena
  if (result.episodeComplete && result.chainId) {
    try {
      const chainRef = db.collection("serverChains").doc(result.chainId);
      const serverSnap = await serverRef.get();
      const serverData = serverSnap.data() || {};
      const totalMinedFinal = serverData.totalMined || 0;
      await closeEpisode(chainRef, serverRef, serverData, uid, totalMinedFinal);
    } catch (e) {
      console.error("Chain close error:", e.message);
    }
  }

  return result;
});

// ─── Peaks ───────────────────────────────────────────────────────────────────

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Number(ts) || 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

exports.getPeaksStatus = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const nowMs = Date.now();
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({ picks: 5, createdAt: nowMs }, { merge: true });
    return buildStatus({ picks: 5, createdAt: nowMs }, nowMs);
  }
  return buildStatus(snap.data() || {}, nowMs);
});

exports.claimDailyPick = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const nowMs = Date.now();
  const userRef = db.collection("users").doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? (snap.data() || {}) : { picks: 5, createdAt: nowMs };
    if (!snap.exists) tx.set(userRef, data, { merge: true });
    const status = buildStatus(data, nowMs);
    if (nowMs < status.nextDailyAt) throw new HttpsError("failed-precondition", "Daily not ready");
    tx.set(userRef, { picks: admin.firestore.FieldValue.increment(1), lastDailyAt: nowMs }, { merge: true });
    const updated = Object.assign({}, data, { picks: (data.picks || 0) + 1, lastDailyAt: nowMs });
    return buildStatus(updated, nowMs);
  });
  return result;
});

exports.claimAdPick = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const index = Number(request.data && request.data.index);
  if (index !== 1 && index !== 2) throw new HttpsError("invalid-argument", "index must be 1 or 2");
  const nowMs = Date.now();
  const userRef = db.collection("users").doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? (snap.data() || {}) : { picks: 5, createdAt: nowMs };
    if (!snap.exists) tx.set(userRef, data, { merge: true });
    const lastKey = index === 1 ? "lastAd1At" : "lastAd2At";
    const lastVal = toMillis(data[lastKey]) || 0;
    if (nowMs < lastVal + DAY_MS) throw new HttpsError("failed-precondition", `Ad ${index} not ready`);
    tx.set(userRef, { picks: admin.firestore.FieldValue.increment(1), [lastKey]: nowMs }, { merge: true });
    const updated = Object.assign({}, data, { picks: (data.picks || 0) + 1, [lastKey]: nowMs });
    return buildStatus(updated, nowMs);
  });
  return result;
});

// ─── Admin helpers ───────────────────────────────────────────────────────────

exports.grantPicksDev = onCall(async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only");
  }
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const curr = snap.exists ? (snap.data().picks || 0) : 0;
    tx.set(userRef, { picks: curr + 1 }, { merge: true });
  });
  return { ok: true };
});

exports.resetAllMinedCubes = onCall(async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only");
  }
  const serverId = String((request.data && request.data.serverId) || '');
  if (!serverId) throw new HttpsError("invalid-argument", "serverId required");

  const BATCH_LIMIT = 400;
  const deleteCollection = async (colRef) => {
    let total = 0;
    let snap = await colRef.limit(BATCH_LIMIT).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      total += snap.size;
      if (snap.size < BATCH_LIMIT) break;
      snap = await colRef.limit(BATCH_LIMIT).get();
    }
    return total;
  };

  const serverRef = db.collection("servers").doc(serverId);
  const deleted = await deleteCollection(serverRef.collection("mined"));
  const layersSnap = await serverRef.collection("layers").get();
  if (!layersSnap.empty) {
    const batch = db.batch();
    layersSnap.forEach((d) => batch.update(d.ref, { 'stats.mined': 0 }));
    await batch.commit();
  }
  await serverRef.set({
    totalMined: 0,
    currentLayer: STARTING_LAYER,
    status: 'active',
    winner: null,
    completedAt: null,
  }, { merge: true });
  return { ok: true, deletedCubes: deleted };
});

exports.sendTestPush = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  const token = snap.exists ? (snap.data().pushToken || null) : null;
  if (!token) throw new HttpsError("failed-precondition", "No push token on user");
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: token, title: "Mining The Blocks", body: "Test notification", sound: "default" }),
    });
    return { ok: true, data: await res.json() };
  } catch (e) {
    throw new HttpsError("internal", String(e && e.message || e));
  }
});

exports.initLayerRewards = onCall(async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only");
  }
  return { ok: true, note: "Rewards are now deterministic — no pre-initialization needed" };
});

// ─── Worker: procesa pendingMints y mintea NFTs en Polygon ───────────────────

const MTBGEMS_ABI = [
  "function mintGem(address to, uint8 gemTier, string calldata gemCode, string calldata tokenURI_) external returns (uint256)",
];

async function sendPushToUser(uid, title, body) {
  try {
    const snap = await db.collection("users").doc(uid).get();
    const token = snap.exists ? snap.data().pushToken : null;
    if (!token) return;
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: token, title, body, sound: "default" }),
    });
  } catch (e) {
    console.error("sendPushToUser error:", e.message);
  }
}

// Lógica de minteo compartida entre onCall y onSchedule
async function runMintProcessing() {
  const privateKey = process.env.COMPANY_WALLET_KEY;
  if (!privateKey) {
    console.error("COMPANY_WALLET_KEY no configurada");
    return { ok: false, processed: 0, failed: 0 };
  }

  const snap = await db.collection("pendingMints")
      .where("status", "==", "pending")
      .limit(10)
      .get();

  if (snap.empty) return { ok: true, processed: 0, failed: 0 };

  const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(MTBGEMS_CONTRACT, MTBGEMS_ABI, wallet);
  const iface = new ethers.Interface(["event GemMinted(uint256 indexed tokenId, address indexed to, uint8 tier, string gemCode)"]);

  let processed = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const mintId = doc.id;
    const mintRef = db.collection("pendingMints").doc(mintId);

    // Reclamar atómicamente — si otro worker ya lo tomó, saltar
    let data;
    try {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(mintRef);
        if (!current.exists || current.data().status !== 'pending') {
          throw new Error('SKIP');
        }
        data = current.data();
        tx.set(mintRef, { status: 'processing', startedAt: Date.now() }, { merge: true });
      });
    } catch (e) {
      if (e.message === 'SKIP') continue;
      throw e;
    }

    try {
      const tx = await contract.mintGem(
          data.walletAddress,
          data.gemTier,
          data.gemCode,
          data.tokenURI || GEM_TOKEN_URIS[(data.gemTier - 1)],
      );
      const receipt = await tx.wait();

      let tokenId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === 'GemMinted') {
            tokenId = parsed.args.tokenId.toString();
            break;
          }
        } catch (_) {/* log no parseable */}
      }

      await mintRef.set({ status: 'completed', txHash: tx.hash, tokenId, completedAt: Date.now() }, { merge: true });

      if (data.uid && data.gemId) {
        await db.collection("users").doc(data.uid).collection("gems").doc(data.gemId).set({
          status: 'minted', tokenId, txHash: tx.hash, mintedAt: Date.now(),
        }, { merge: true });
      }

      console.log(`NFT minteado: tokenId=${tokenId} → ${data.walletAddress}`);
      if (data.uid) {
        await sendPushToUser(
            data.uid,
            "¡Tu NFT llegó! 💎",
            `Tu gema fue minteada en Polygon. Token #${tokenId || ''}`,
        );
      }
      processed++;
    } catch (e) {
      console.error(`Error minteando ${mintId}:`, e.message);
      await mintRef.set({ status: 'failed', error: e.message, failedAt: Date.now() }, { merge: true });
      failed++;
    }
  }

  return { ok: true, processed, failed };
}

// Llamable manualmente (solo admin)
exports.processPendingMints = onCall({ secrets: ["COMPANY_WALLET_KEY"] }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only");
  }
  return runMintProcessing();
});

// Scheduler automático — corre cada 5 minutos
exports.mintProcessorScheduled = onSchedule(
    { schedule: "every 5 minutes", secrets: ["COMPANY_WALLET_KEY"] },
    async () => {
      const result = await runMintProcessing();
      console.log("mintProcessorScheduled:", JSON.stringify(result));
    },
);

// ─── Referidos ────────────────────────────────────────────────────────────────

exports.applyReferral = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "Code required");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "User not found");
  if (userSnap.data().referredBy) throw new HttpsError("already-exists", "Already applied a referral");

  // Buscar al referidor por código
  const referrerQuery = await db.collection("users").where("referralCode", "==", code).limit(1).get();
  if (referrerQuery.empty) throw new HttpsError("not-found", "Invalid code");

  const referrerDoc = referrerQuery.docs[0];
  if (referrerDoc.id === uid) throw new HttpsError("invalid-argument", "Cannot use your own code");

  // Acreditar 5 picos al referidor y marcar al usuario actual
  await db.runTransaction(async (tx) => {
    tx.set(referrerDoc.ref, { picks: admin.firestore.FieldValue.increment(5) }, { merge: true });
    tx.set(userRef, { referredBy: referrerDoc.id, referralAppliedAt: Date.now() }, { merge: true });
  });

  return { ok: true, referrerPicks: 5 };
});

// ─── Pagos crypto ─────────────────────────────────────────────────────────────

const PAYMENT_WALLET = '0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f';
const USDC_CONTRACTS = [
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC bridged (PoS)
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC native
];
const USDC_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const CREDIT_PRICE_USD = 15;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000; // 30 minutos

// Crea un pago pendiente con monto único para identificar al usuario
exports.createCryptoPayment = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  // Si ya tiene un pago pendiente vigente, devolverlo
  const existing = await db.collection("pendingCryptoPayments")
      .where("uid", "==", uid)
      .where("status", "==", "waiting")
      .where("expiresAt", ">", Date.now())
      .limit(1).get();

  if (!existing.empty) {
    const d = existing.docs[0].data();
    return { paymentId: existing.docs[0].id, amount: d.amountDisplay, wallet: PAYMENT_WALLET, expiresAt: d.expiresAt };
  }

  // Generar monto único: $15.01 – $15.99 (centavos aleatorios para identificar el pago)
  let amountUnits;
  let amountDisplay;
  let unique = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const cents = Math.floor(Math.random() * 99) + 1;
    amountUnits = (CREDIT_PRICE_USD * 100 + cents) * 10000; // USDC 6 decimales
    amountDisplay = `${CREDIT_PRICE_USD}.${String(cents).padStart(2, "0")}`;
    const conflict = await db.collection("pendingCryptoPayments")
        .where("amountUnits", "==", amountUnits)
        .where("status", "==", "waiting")
        .where("expiresAt", ">", Date.now())
        .limit(1).get();
    if (conflict.empty) {
      unique = true;
      break;
    }
  }
  if (!unique) throw new HttpsError("resource-exhausted", "try_again");

  const expiresAt = Date.now() + PAYMENT_WINDOW_MS;
  const ref = await db.collection("pendingCryptoPayments").add({
    uid, amountUnits, amountDisplay,
    status: "waiting",
    createdAt: Date.now(),
    expiresAt,
  });

  return { paymentId: ref.id, amount: amountDisplay, wallet: PAYMENT_WALLET, expiresAt };
});

// Escanea Polygon cada 5 min buscando transferencias USDC al wallet de pagos
async function runCryptoPaymentProcessing() {
  const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 200; // ~6-7 min de bloques en Polygon

  // Cargar pagos pendientes vigentes
  const pendingSnap = await db.collection("pendingCryptoPayments")
      .where("status", "==", "waiting")
      .where("expiresAt", ">", Date.now())
      .get();
  if (pendingSnap.empty) return { processed: 0 };

  const pendingByAmount = new Map();
  pendingSnap.docs.forEach((doc) => {
    pendingByAmount.set(doc.data().amountUnits, doc);
  });

  let processed = 0;
  for (const usdcAddress of USDC_CONTRACTS) {
    const contract = new ethers.Contract(usdcAddress, USDC_ABI, provider);
    let events;
    try {
      const mkFilter = contract.filters["Transfer"];
      const transferFilter = mkFilter(null, PAYMENT_WALLET);
      events = await contract.queryFilter(
          transferFilter,
          fromBlock, currentBlock,
      );
    } catch (e) {
      console.warn("Error querying USDC transfers:", e.message);
      continue;
    }

    for (const event of events) {
      const amount = Number(event.args.value);
      if (!pendingByAmount.has(amount)) continue;

      const paymentDoc = pendingByAmount.get(amount);
      const { uid } = paymentDoc.data();

      try {
        await db.runTransaction(async (tx) => {
          const userRef = db.collection("users").doc(uid);
          tx.set(userRef, { serverCredits: admin.firestore.FieldValue.increment(1) }, { merge: true });
          tx.set(paymentDoc.ref, {
            status: "completed",
            txHash: event.transactionHash,
            completedAt: Date.now(),
          }, { merge: true });
        });

        // Push notification al usuario
        try {
          const userSnap = await db.collection("users").doc(uid).get();
          const pushToken = userSnap.exists ? userSnap.data().pushToken : null;
          if (pushToken) {
            await fetch("https://exp.host/--/api/v2/push/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: pushToken,
                title: "¡Pago recibido! 💰",
                body: "Tu crédito fue acreditado. ¡Ya podés unirte a una cadena!",
              }),
            });
          }
        } catch (pushErr) {
          console.warn("Push notification failed:", pushErr.message);
        }

        pendingByAmount.delete(amount); // evitar doble procesamiento
        processed++;
      } catch (e) {
        console.error("Error procesando pago crypto:", e.message);
      }
    }
  }

  // Expirar pagos vencidos
  const expired = await db.collection("pendingCryptoPayments")
      .where("status", "==", "waiting")
      .where("expiresAt", "<", Date.now())
      .limit(50).get();
  if (!expired.empty) {
    const batch = db.batch();
    expired.docs.forEach((doc) => batch.update(doc.ref, { status: "expired" }));
    await batch.commit();
  }

  return { processed };
}

exports.cryptoPaymentProcessorScheduled = onSchedule("every 5 minutes", async () => {
  const result = await runCryptoPaymentProcessing();
  console.log("cryptoPaymentProcessorScheduled:", JSON.stringify(result));
});

// ─── Web: Verificación y claim de gemas ──────────────────────────────────────

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

exports.verifyGemCode = functionsV1.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  const code = ((req.query.code || (req.body && req.body.code)) || "").toString().trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: "missing_code" });
  }
  try {
    const snap = await db.collectionGroup("gems").where("code", "==", code).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ error: "not_found" });
    }
    const gem = snap.docs[0].data();
    if (gem.status !== "unclaimed") {
      const errKey = gem.status === "redeemed" ? "already_redeemed" : "already_minted";
      return res.status(400).json({ error: errKey });
    }
    return res.json({ valid: true, tier: gem.tier });
  } catch (e) {
    console.error("verifyGemCode:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

exports.submitGemClaim = functionsV1.https.onRequest(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = req.body || {};
  const code = (body.code || "").toString().trim().toUpperCase();
  const email = (body.email || "").toString().trim().toLowerCase();
  if (!code || !email) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  try {
    const snap = await db.collectionGroup("gems").where("code", "==", code).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ error: "not_found" });
    }
    const gemDoc = snap.docs[0];
    const gem = gemDoc.data();
    if (gem.status !== "unclaimed") {
      const errKey = gem.status === "redeemed" ? "already_redeemed" : "already_minted";
      return res.status(400).json({ error: errKey });
    }
    await db.collection("gemClaims").add({
      code,
      email,
      tier: gem.tier,
      gemRef: gemDoc.ref.path,
      submittedAt: Date.now(),
      status: "pending",
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("submitGemClaim:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});
