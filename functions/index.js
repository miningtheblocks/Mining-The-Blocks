/* eslint-disable max-len */
/* eslint-disable quotes */
/* eslint-disable object-curly-spacing */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const { ethers } = require("ethers");
const admin = require("firebase-admin");
// firebase-admin v14: namespace default ya no expone .firestore/.auth/.messaging
// como métodos. Hay que usar imports modulares.
const {getFirestore, FieldValue, Timestamp, FieldPath} = require("firebase-admin/firestore");
const {getAuth} = require("firebase-admin/auth");
const {getMessaging} = require("firebase-admin/messaging");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

// OPS-8: reducir CPU por función para entrar en el quota de Cloud Run.
// Con 31 funciones × 1 vCPU = 31 vCPUs reservados, agotaba el quota default.
// 0.5 vCPU es suficiente para nuestras funciones (poco compute, mayormente I/O
// a Firestore). Si alguna requiere más, podemos overridearla individualmente.
setGlobalOptions({ cpu: 0.5, memory: "256MiB", maxInstances: 10 });

// SEC: secrets declarados al inicio del archivo para evitar TDZ —
// se referencian en `exports.xxx = onCall({ secrets: [...] }, ...)` que se
// evalúan al cargar el módulo.
const companyWalletKey = defineSecret("COMPANY_WALLET_KEY");
const gmailAppPassword = defineSecret("GMAIL_APP_PASSWORD");
const serverSeed = defineSecret("SERVER_SEED");

try {
  admin.initializeApp();
} catch (_e) {/* already initialized */}

const db = getFirestore();

// ─── Constantes y helpers extraídos ─────────────────────────────────────────

const {
  MAX_EPISODES,
  STARTING_LAYER,
  GEM_PRICES,
  MAX_MEMBERS_PER_SERVER,
  GEM_TOKEN_URIS,
  MTBGEMS_CONTRACT,
  DAY_MS,
  PAYMENT_WALLET,
  USDC_CONTRACTS,
  USDC_ABI,
  CREDIT_PRICE_USD,
  PAYMENT_WINDOW_MS,
  GEM_NAMES_ES,
  NOTIFY_EMAIL,
} = require("./constants");

const {
  shellTotalCubes,
  cubeNumberToFaceGridForK,
  getRewardForCube,
  getGemForCube,
  generateReferralCode,
  generateGemCode,
  toMillis,
  buildStatus,
  esc,
  setCorsHeaders,
  setRestrictedCorsHeaders,
} = require("./helpers");

// BAJO-H18: validar formato + tamaño de IDs (serverId, chainId, gemId, etc.).
// Antes el código solo verificaba !id (truthy) — un id de 1500 bytes pasaba
// y forzaba lookups Firestore costosos sin valor real.
const FIRESTORE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function assertValidId(id, label) {
  if (typeof id !== "string" || !FIRESTORE_ID_RE.test(id)) {
    throw new HttpsError("invalid-argument", `${label}_invalid`);
  }
}

// CRIT (Round 2 Agente #6): whitelist explícito de providers. Antes era
// blacklist ("rechazar anonymous"); si Firebase habilita un nuevo provider
// (Anonymous Auth desde Console, OIDC custom, Identity Platform blocking
// function que devuelve cualquier provider), el flow lo aceptaba por default.
// Con whitelist, default-deny: si un provider desconocido aparece, se rechaza
// la operación con un código identificable para audit.
//
// Si en el futuro suman Google/Apple Sign-In real (todavía solo
// signInWithEmailAndPassword en Login.js), agregar acá.
const ALLOWED_PROVIDERS = new Set(["password", "google.com", "apple.com"]);
function requireRegistered(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Login required");
  const provider = request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new HttpsError("permission-denied", `provider_not_allowed:${provider || "unknown"}`);
  }
  // ALTO-30: exigir email verificado en operaciones de juego (mining, payments,
  // gem claim). Providers OAuth (google.com, apple.com) ya verifican email
  // upstream, se aceptan sin recheck. Solo email/password necesita el flag.
  if (provider === "password" && request.auth.token && request.auth.token.email_verified === false) {
    throw new HttpsError("permission-denied", "email_not_verified");
  }
}

// MEDIO-H15: generateReferralCode con check de unicidad. Espacio = 31^8 ≈ 8.5e11
// y birthday-paradox a 1M users ≈ 0.06%. No crítico pero defensivo. 5 retries
// y si fallan, fallback al código generado (improbable colisión real).
async function generateUniqueReferralCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    try {
      const exists = await db.collection("users").where("referralCode", "==", code).limit(1).get();
      if (exists.empty) return code;
    } catch (_) {
      return code; // fallback si la query falla
    }
  }
  return generateReferralCode();
}

// ALTO-31: verificación de admin con freshness real. El custom claim `admin`
// dura ~1h en el ID token aunque se revoque server-side. Para operaciones
// destructivas leemos los claims FRESCOS via Admin SDK.
async function requireAdminFresh(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Login required");
  try {
    const user = await getAuth().getUser(request.auth.uid);
    if (!user.customClaims || !user.customClaims.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("requireAdminFresh error:", e && e.message);
    throw new HttpsError("internal", "admin_check_failed");
  }
}

// CRIT (Round 2 Agente #6): checkRevoked en operaciones financieras críticas.
// El runtime de Firebase Functions decodea el JWT pero NO chequea si los
// tokens del user fueron revocados (revokeRefreshTokens). Sin esto, un token
// robado o una sesión post-password-reset sigue válido hasta el TTL JWT
// (~60min) — ventana completa de account takeover para submitGemClaim,
// claimGemNFT, createCryptoPayment.
//
// Patrón: comparar `auth_time` del JWT decodeado contra `tokensValidAfterTime`
// del user. Equivalente funcional a `verifyIdToken(token, true)` pero sin
// tener que extraer el raw token de `rawRequest.headers.authorization` (que
// en onCall existe pero es frágil ante cambios del runtime). Bonus: también
// chequea `disabled` (ban via Firebase Console). Costo: ~1 Auth Admin call
// extra por invocación, requireAdminFresh tiene el mismo patrón.
//
// NO aplicado a mineCube (hot path, costo amortizado prohibitivo a ~100 calls
// por sesión); el daño de un mineCube con token revocado está acotado por
// picks remanentes del user.
async function assertFreshToken(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Login required");
  }
  const uid = request.auth.uid;
  const authTimeSec = request.auth.token && request.auth.token.auth_time;
  if (!authTimeSec) {
    throw new HttpsError("unauthenticated", "invalid_auth_time");
  }
  const authTimeMs = authTimeSec * 1000;
  let user;
  try {
    user = await getAuth().getUser(uid);
  } catch (e) {
    console.error("assertFreshToken getUser error:", e && e.message);
    throw new HttpsError("internal", "user_lookup_failed");
  }
  if (user.disabled) {
    throw new HttpsError("permission-denied", "account_disabled");
  }
  const validAfterMs = user.tokensValidAfterTime ? new Date(user.tokensValidAfterTime).getTime() : 0;
  if (validAfterMs > 0 && authTimeMs < validAfterMs) {
    throw new HttpsError("unauthenticated", "token_revoked");
  }
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

  // SEC-N-004: idempotency key. Si dos workers entran al closeEpisode del mismo
  // episodio (race en mineCube), el segundo va a fallar al setear el guard.
  // Esto previene servidores duplicados y entradas history fantasma.
  const guardRef = chainRef.collection("meta").doc(`closing_${episodeNumber}`);
  let acquired = false;
  try {
    await db.runTransaction(async (tx) => {
      const g = await tx.get(guardRef);
      if (g.exists) throw new Error("ALREADY_CLOSING");
      tx.set(guardRef, { startedAt: Date.now(), winnerUid: winnerUid || null });
      acquired = true;
    });
  } catch (e) {
    if (e.message === "ALREADY_CLOSING") {
      console.log(`closeEpisode: episode ${episodeNumber} ya está cerrando, skip duplicado`);
      return { isLastEpisode: false, nextEpisode: episodeNumber + 1 };
    }
    throw e;
  }
  if (!acquired) return { isLastEpisode: false, nextEpisode: episodeNumber + 1 };

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

  // SEC-A1: history.episode_complete antes lo escribía el cliente, lo que permitía
  // a cualquier miembro hacerse pasar por ganador. Ahora lo escribimos en backend
  // con el winnerUid auténtico y un seq atómico desde meta/counter.
  try {
    const counterRef = chainRef.collection("meta").doc("counter");
    const winnerSnap = winnerUid ? await db.collection("users").doc(winnerUid).get() : null;
    const winnerName = winnerSnap && winnerSnap.exists ?
      (winnerSnap.data().displayName || winnerSnap.data().profile && winnerSnap.data().profile.displayName || null) : null;
    await db.runTransaction(async (tx) => {
      const cs = await tx.get(counterRef);
      const seq = ((cs.exists && cs.data().seq) || 0) + 1;
      const histRef = chainRef.collection("history").doc();
      tx.set(histRef, {
        type: "episode_complete",
        seq,
        ts: Date.now(),
        uid: winnerUid || null,
        displayName: winnerName,
        episodeNumber,
        serverId: serverRef.id,
        chainId,
        totalMined: totalMinedFinal,
      });
      tx.set(counterRef, { seq }, { merge: true });
    });
  } catch (e) {
    console.warn("closeEpisode: history entry failed:", e.message);
  }

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
  // ALTO-31: verificar admin FRESH (no del token cacheado).
  await requireAdminFresh(request);
  const uid = request.auth.uid;

  const targetUid = String((request.data && request.data.uid) || '');
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required");
  const amount = Math.max(1, Math.min(100, Math.floor(Number((request.data && request.data.amount) || 1))));

  const userRef = db.collection("users").doc(targetUid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const current = (snap.exists ? snap.data().serverCredits : 0) || 0;
    tx.set(userRef, { serverCredits: current + amount }, { merge: true });
  });

  // SEC-M3: audit log de operación admin. Si una cuenta admin se compromete,
  // queremos saber qué se hizo, cuándo y a quién.
  try {
    await db.collection("adminActions").add({
      action: "addServerCredit",
      adminUid: uid,
      targetUid,
      amount,
      ts: Date.now(),
      reason: String((request.data && request.data.reason) || "").slice(0, 200),
    });
  } catch (logErr) {
    console.warn("audit log addServerCredit failed:", logErr.message);
  }

  return { ok: true, added: amount };
});

// Crear servidor (crea también el chain si no existe)
exports.createServer = onCall(async (request) => {
  requireRegistered(request);
  const uid = request.auth.uid;

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
    tx.set(userRef, { picks: FieldValue.increment(5) }, { merge: true });
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
  requireRegistered(request);
  const uid = request.auth.uid;

  const serverId = String((request.data && request.data.serverId) || '');
  assertValidId(serverId, "serverId");

  const serverRef = db.collection("servers").doc(serverId);
  const userRef = db.collection("users").doc(uid);

  // Track whether this was an actual new (paid) join vs already-had-access
  let wasNewPaidJoin = false;

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

    const episodeNumber = serverData.episodeNumber || 1;

    // Servers legacy (sin chainId) son de acceso libre
    if (!serverChainId) {
      tx.set(accessRef, { serverId, chainId: null, episodeNumber, joinedAt: Date.now(), role: 'member' });
      return;
    }

    // Episodio final (10) es gratis para quien jugó los 9 anteriores de la misma cadena.
    // FIX-P1: contar episodios DISTINTOS (no cantidad de docs), por defensa en profundidad
    // contra accesos duplicados si en el futuro el flow de chain se rompe.
    if (episodeNumber >= MAX_EPISODES) {
      const chainAccessSnaps = await tx.get(
          userRef.collection("serverAccess").where("chainId", "==", serverChainId),
      );
      const distinctEpisodes = new Set();
      chainAccessSnaps.forEach((d) => {
        const ep = d.data().episodeNumber;
        if (Number.isInteger(ep) && ep >= 1 && ep < MAX_EPISODES) distinctEpisodes.add(ep);
      });
      if (distinctEpisodes.size >= MAX_EPISODES - 1) {
        tx.set(accessRef, { serverId, chainId: serverChainId, episodeNumber, joinedAt: Date.now(), role: 'member', freeEpisode: true });
        tx.set(serverRef, { memberCount: (serverData.memberCount || 0) + 1 }, { merge: true });
        return;
      }
    }

    // Verificar y descontar crédito
    await consumeServerCredit(uid, tx);

    // Registrar acceso
    tx.set(accessRef, { serverId, chainId: serverChainId, episodeNumber, joinedAt: Date.now(), role: 'member' });

    // Bienvenida: 5 picos al pagar la entrada
    tx.set(userRef, { picks: FieldValue.increment(5) }, { merge: true });

    // Incrementar memberCount
    tx.set(serverRef, { memberCount: (serverData.memberCount || 0) + 1 }, { merge: true });

    wasNewPaidJoin = true;
  });

  // If user already had access, just let them in — no welcome picks, no bonus
  if (!wasNewPaidJoin) {
    return { ok: true, serverId };
  }

  // Ensure referralCode exists (SEC-008: random, no derivado de uid)
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? (userSnap.data() || {}) : {};
  if (!userData.referralCode) {
    await db.collection("users").doc(uid).set({ referralCode: await generateUniqueReferralCode() }, { merge: true });
  }

  // SEC-M1: referral bonus con check DENTRO de la TX (anteriormente se leía
  // referralBonusPaid afuera y dos joins concurrentes podían duplicar el bonus).
  const referredBy = userData.referredBy || null;
  if (referredBy) {
    try {
      let bonusGranted = false;
      await db.runTransaction(async (tx) => {
        const uRef = db.collection("users").doc(uid);
        const rRef = db.collection("users").doc(referredBy);
        const freshU = await tx.get(uRef);
        if (!freshU.exists) return;
        const fud = freshU.data();
        if (fud.referralBonusPaid) return; // ya pagado
        tx.set(uRef, { picks: FieldValue.increment(5), referralBonusPaid: true }, { merge: true });
        tx.set(rRef, { picks: FieldValue.increment(5) }, { merge: true });
        bonusGranted = true;
      });
      if (bonusGranted) {
        await Promise.all([
          db.collection("users").doc(uid).collection("notifications").add({
            type: "referral_bonus_self", picks: 5, createdAt: Date.now(),
          }),
          db.collection("users").doc(referredBy).collection("notifications").add({
            type: "referral_bonus", picks: 5, createdAt: Date.now(),
          }),
        ]);
      }
    } catch (refErr) {
      console.warn("Referral bonus error in joinServer:", refErr.message);
    }
  }

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
  assertValidId(serverId, "serverId");

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

  // SEC-M5: whitelist explícito de campos públicos. Antes devolvíamos `...d.data()`
  // exponiendo `createdBy` (uid del creador) y cualquier campo interno futuro.
  const PUBLIC_FIELDS = [
    "name", "createdAt", "status", "currentLayer", "totalMined",
    "memberCount", "chainId", "episodeNumber", "winner", "completedAt", "prevServerId",
  ];
  const servers = snap.docs.map((d) => {
    const data = d.data() || {};
    const out = { id: d.id };
    // eslint-disable-next-line security/detect-object-injection -- k de whitelist constante PUBLIC_FIELDS
    for (const k of PUBLIC_FIELDS) if (k in data) out[k] = data[k];
    return out;
  });
  return { servers };
});

// Obtener info de una cadena (chain) con todos sus episodios
exports.getChain = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const chainId = String((request.data && request.data.chainId) || '');
  assertValidId(chainId, "chainId");

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

// redeemGem eliminado: cash redemption ahora va por submitGemClaim (web).
// La función estaba orphan (sin caller en el cliente) y representaba superficie de ataque extra.

// Vincular wallet para recibir el NFT (marca la gema como "minting")
exports.claimGemNFT = onCall(async (request) => {
  requireRegistered(request);
  // CRIT (Round 2 Agente #6): checkRevoked + disabled check.
  await assertFreshToken(request);
  const uid = request.auth.uid;

  const gemId = String((request.data && request.data.gemId) || '');
  assertValidId(gemId, "gemId");

  // CRIT (Round 2 Agentes #1 HIGH-4 + #6 + #8): walletAddress del user doc,
  // NO del body. Aceptar wallet del body bypasea el cooldown de 24h de
  // setUserWallet — durante una ventana de account takeover, el atacante
  // podía claimear NFTs a su propia wallet aunque setUserWallet siga bloqueado.
  // Ahora la única vía de setear/cambiar wallet pasa por setUserWallet
  // (que tiene cooldown + valida formato). El parámetro request.data.walletAddress
  // se ignora silenciosamente por backwards-compat con clientes viejos pre
  // Round 2 Commit B.
  const userSnap = await db.collection("users").doc(uid).get();
  const walletAddress = userSnap.exists ? (userSnap.data().walletAddress || null) : null;
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new HttpsError("failed-precondition", "wallet_not_set");
  }

  const gemRef = db.collection("users").doc(uid).collection("gems").doc(gemId);

  // ALTO-32: idempotency. Antes había una ventana entre TX (gem→minting) y
  // pendingMints.add donde si el .add fallaba, la gema quedaba atascada en
  // "minting" para siempre sin poder re-claimar. Ahora: usar docId
  // determinístico = `${uid}_${gemId}` para que el .add sea idempotente y la
  // creación del pendingMint ocurra DENTRO de la misma TX.
  const pendingMintRef = db.collection("pendingMints").doc(`${uid}_${gemId}`);

  let gemTier;
  let gemCode;
  await db.runTransaction(async (tx) => {
    const gemSnap = await tx.get(gemRef);
    if (!gemSnap.exists) throw new HttpsError("not-found", "Gem not found");
    const gem = gemSnap.data();
    if (gem.status !== "unclaimed") {
      throw new HttpsError("failed-precondition",
        gem.status === "redeemed" ? "Gem already redeemed for cash" : "NFT already claimed");
    }
    gemTier = gem.gemTier;
    gemCode = gem.code;
    tx.set(gemRef, { status: "minting", walletAddress, claimedAt: Date.now() }, { merge: true });
    // Crear el pendingMint en la misma TX — atómico con el cambio de status.
    tx.set(pendingMintRef, {
      uid,
      gemId,
      gemTier,
      gemCode,
      tokenURI: GEM_TOKEN_URIS[(gemTier - 1)] || null,
      walletAddress,
      priceUSD: GEM_PRICES[(gemTier - 1)] || 0,
      createdAt: Date.now(),
      status: "pending",
    });
  });

  return { ok: true, walletAddress };
});

// ─── Mining ──────────────────────────────────────────────────────────────────

exports.mineCube = onCall({ secrets: [serverSeed] }, async (request) => {
  requireRegistered(request);
  const uid = request.auth.uid;

  // SEC-003: Canonicalizar cubeNumber a entero antes de usar como docId.
  // String("1"), "1.0", "01", " 1" coercionan al mismo N pero crean docs diferentes
  // — bypaseaba el check `minedSnap.exists` permitiendo doble-mineo del mismo cubo.
  const nRaw = (request.data && request.data.cubeNumber);
  const n = Math.floor(Number(nRaw));
  if (!Number.isInteger(n) || n < 1) throw new HttpsError("invalid-argument", "cubeNumber required");
  const cubeNumber = String(n); // forma canónica para docId

  const serverId = String((request.data && request.data.serverId) || '');
  assertValidId(serverId, "serverId");

  const serverRef = db.collection("servers").doc(serverId);
  const userRef = db.collection("users").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const serverSnap = await tx.get(serverRef);
    if (!serverSnap.exists) throw new HttpsError("not-found", "Server not found");
    const serverData = serverSnap.data();
    // Allow legacy servers that were created before the status field was added
    if (serverData.status && serverData.status !== 'active') throw new HttpsError("failed-precondition", "Server not active");

    const K = serverData.currentLayer;
    // FIX-FINAL-4: validar K range para evitar NaN propagation y data corruption
    if (!Number.isInteger(K) || K < 0 || K > 100) {
      throw new HttpsError("failed-precondition", "Invalid layer state");
    }
    const TOTAL_CUBES_K = shellTotalCubes(K);
    if (n > TOTAL_CUBES_K) throw new HttpsError("invalid-argument", "Cube out of range for current layer");

    const minedRef = serverRef.collection("mined").doc(cubeNumber);
    const layerRef = serverRef.collection("layers").doc(String(K));
    const accessRef = userRef.collection("serverAccess").doc(serverId);

    const [minedSnap, userSnap, layerSnap, accessSnap] = await Promise.all([
      tx.get(minedRef), tx.get(userRef), tx.get(layerRef), tx.get(accessRef),
    ]);

    // Enforce payment — user must have joined (paid) this server
    if (!accessSnap.exists) throw new HttpsError("permission-denied", "No server access. Join the server first.");

    // SEC-009: Rate limit ANTES del check alreadyMined. Sin esto, un atacante
    // que ya tenga serverAccess podría sondear cubos sin costo (oracle).
    // Rate limit: máximo 1 mine cada 2s por usuario — previene bots.
    if (userSnap.exists) {
      const lastMineAt = userSnap.data().lastMineAt || 0;
      if (Date.now() - lastMineAt < 2000) {
        const waitSec = Math.ceil((2000 - (Date.now() - lastMineAt)) / 1000);
        throw new HttpsError("resource-exhausted", `rate_limited:${waitSec}`);
      }
    }

    if (minedSnap.exists) {
      // ALTO-36: actualizar lastMineAt aunque ya esté minado para que el
      // rate-limit aplique al ganador del race. Antes el perdedor podía
      // minar otro cubo inmediatamente porque no se actualizaba.
      tx.set(userRef, { lastMineAt: Date.now() }, { merge: true });
      return { ok: true, alreadyMined: true };
    }

    let picks = userSnap.exists ? (Number(userSnap.data().picks) || 0) : 0;
    if (!userSnap.exists) {
      tx.set(userRef, { picks: 0, createdAt: Date.now(), referralCode: generateReferralCode() }, { merge: true });
    }

    // Reset lazy de picos: si el servidor inició un nuevo episodio y el usuario no fue reseteado aún
    const episodeStartAt = serverData.episodeStartAt || 0;
    const picksLastResetAt = userSnap.exists ? (userSnap.data().picksLastResetAt || 0) : 0;
    const needsPicksReset = episodeStartAt > 0 && picksLastResetAt < episodeStartAt;
    if (needsPicksReset) picks = 5;

    if (picks <= 0) throw new HttpsError("failed-precondition", "No picks");

    const currentMined = layerSnap.exists ? (layerSnap.data().stats && layerSnap.data().stats.mined) || 0 : 0;
    const cubesRemaining = TOTAL_CUBES_K - currentMined;

    // Episodio termina cuando se completa la capa central (K=0)
    // Flujo: K=100 (exterior) → K=99 → ... → K=0 (centro) → episodio completo
    // K=0 es un cubo único de 6 caras — la primera cara minada destruye el cubo y termina el episodio
    const layerComplete = (currentMined + 1) >= TOTAL_CUBES_K;
    const episodeComplete = K === 0;

    // SEC-B-1: pasar SERVER_SEED a las funciones de cálculo de premios.
    // CRIT (Round 2 Agentes #1 HIGH-12 + #11 CRIT-11-05): además del seed
    // crudo, pasamos episodeNumber para que helpers derive effectiveSeed
    // per (serverId, episode) — limita blast radius de un seed leak.
    const seed = serverSeed.value();
    const episodeNumberForSeed = serverData.episodeNumber || 1;
    const reward = getRewardForCube(serverId, K, cubeNumber, seed, episodeNumberForSeed);
    const gem = getGemForCube(serverId, K, cubeNumber, serverData.memberCount || 0, seed, episodeNumberForSeed);

    const userUpdate = { lastMineAt: Date.now() };
    if (needsPicksReset) {
      userUpdate.picks = 4 + reward;
      userUpdate.picksLastResetAt = episodeStartAt;
    } else {
      userUpdate.picks = FieldValue.increment(-1 + reward);
    }
    tx.set(userRef, userUpdate, { merge: true });

    const mapped = cubeNumberToFaceGridForK(n, K) || {};
    // CRIT (Round 2 Agentes #2 + #5): schema canónico `minedAt`. Antes se
    // escribía `ts` pero el index (firestore.indexes.json: mined[K, minedAt DESC])
    // y el listener realtime de DynamicCube201 ordenan por `minedAt`. Resultado
    // pre-fix: el feed multiplayer recibía snapshot vacío y sólo aparentaba
    // funcionar por el optimistic local update del que minó. Fix: renombrar
    // a `minedAt` (queda alineado con el resto de campos timestamp del proyecto).
    tx.set(minedRef, { by: uid, minedAt: Date.now(), K, rewardPicks: reward, gem: gem || 0, ...mapped });
    tx.set(layerRef, { K, totalCubes: TOTAL_CUBES_K, stats: { mined: FieldValue.increment(1) } }, { merge: true });

    const serverUpdate = { totalMined: FieldValue.increment(1) };

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
      const rawWallet = userSnap.exists ? (userSnap.data().walletAddress || null) : null;
      const userWallet = (rawWallet && /^0x[a-fA-F0-9]{40}$/.test(rawWallet)) ? rawWallet : null;
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

exports.getPeaksStatus = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const nowMs = Date.now();
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({ picks: 0, createdAt: nowMs, referralCode: generateReferralCode() }, { merge: true });
    return buildStatus({ picks: 0, createdAt: nowMs }, nowMs);
  }
  const data = snap.data() || {};
  if (!data.referralCode) {
    await userRef.set({ referralCode: generateReferralCode() }, { merge: true });
  }
  return buildStatus(data, nowMs);
});

exports.claimDailyPick = onCall(async (request) => {
  requireRegistered(request);
  const uid = request.auth.uid;
  const nowMs = Date.now();
  const userRef = db.collection("users").doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? (snap.data() || {}) : { picks: 0, createdAt: nowMs };
    if (!snap.exists) tx.set(userRef, data, { merge: true });
    const status = buildStatus(data, nowMs);
    if (nowMs < status.nextDailyAt) throw new HttpsError("failed-precondition", "Daily not ready");
    tx.set(userRef, { picks: FieldValue.increment(1), lastDailyAt: nowMs }, { merge: true });
    const updated = Object.assign({}, data, { picks: (data.picks || 0) + 1, lastDailyAt: nowMs });
    return buildStatus(updated, nowMs);
  });
  return result;
});

// claimAdPick removed — ad picks are now issued exclusively through the
// createAdSession → web timer page → claimAdSession flow.

// ─── Ad timer page (web interstitial) ────────────────────────────────────────
// Crea una sesión para la página de anuncios web (timer de 45s).
// La página llama a claimAdSession vía HTTP para acreditar el pick.
exports.createAdSession = onCall(async (request) => {
  requireRegistered(request);
  const uid = request.auth.uid;
  const index = Number(request.data && request.data.index);
  if (index !== 1 && index !== 2) throw new HttpsError("invalid-argument", "index must be 1 or 2");

  // Verificar límite diario antes de crear la sesión
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    const data = userSnap.data() || {};
    const lastKey = index === 1 ? "lastAd1At" : "lastAd2At";
    // eslint-disable-next-line security/detect-object-injection -- lastKey de literal whitelist
    const lastVal = toMillis(data[lastKey]) || 0;
    if (Date.now() < lastVal + DAY_MS) throw new HttpsError("failed-precondition", `Ad ${index} not ready`);
  }

  const token = crypto.randomBytes(24).toString("hex");
  const sessionId = crypto.randomBytes(16).toString("hex");
  // OPS-7: expiresAt para TTL — sesiones se borran 1 día después de crear.
  // El user tiene 30 min reales para ver el ad; después la session sigue
  // existiendo pero ya no sirve. TTL la limpia para no acumular.
  const now = Date.now();
  await db.collection("adSessions").doc(sessionId).set({
    uid, index, token, createdAt: now, used: false,
    expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),
  });
  return { sessionId, token };
});

// Endpoint HTTP llamado desde la página web después del timer.
// No requiere auth de Firebase — la seguridad la da el token de un solo uso.
exports.claimAdSession = onRequest(async (req, res) => {
  setRestrictedCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const { sessionId, token } = req.body || {};
  if (!sessionId || !token) {
    res.status(400).json({ error: "missing_params" });
    return;
  }

  const sessionRef = db.collection("adSessions").doc(String(sessionId));
  const nowMs = Date.now();

  try {
    await db.runTransaction(async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) throw new Error("not_found");
      const session = sessionSnap.data();
      // BAJO (ESLint security/detect-possible-timing-attacks): comparación
      // constant-time del token. `!==` short-circuita y leakea info via
      // timing analysis (no práctico para 192-bit tokens vía internet, pero
      // defense-in-depth). timingSafeEqual exige Buffers del mismo length.
      const a = Buffer.from(String(session.token || ''), 'utf8');
      const b = Buffer.from(String(token || ''), 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error("invalid_token");
      }
      if (session.used) throw new Error("already_used");
      if (nowMs - session.createdAt > 12 * 60 * 1000) throw new Error("expired"); // 12 min

      const uid = session.uid;
      const index = session.index;
      const userRef = db.collection("users").doc(uid);
      const userSnap = await tx.get(userRef);
      const data = userSnap.exists ? (userSnap.data() || {}) : { picks: 0 };
      const lastKey = index === 1 ? "lastAd1At" : "lastAd2At";
      // eslint-disable-next-line security/detect-object-injection -- lastKey de literal whitelist
      const lastVal = toMillis(data[lastKey]) || 0;
      if (nowMs < lastVal + DAY_MS) throw new Error("not_ready");

      tx.set(sessionRef, { used: true, claimedAt: nowMs }, { merge: true });
      tx.set(userRef, { picks: FieldValue.increment(1), [lastKey]: nowMs }, { merge: true });
    });
    res.json({ ok: true });
  } catch (e) {
    // INF-001: NO devolver e.message al cliente — eso permite enumerar estados
    // internos (invalid_token, already_used, expired, not_ready, ALREADY_CLOSING).
    // Mapeamos a un set chico de códigos públicos.
    const KNOWN_PUBLIC = new Set(["invalid_token", "already_used", "expired", "not_ready", "not_found"]);
    const code = KNOWN_PUBLIC.has(e && e.message) ? e.message : "bad_request";
    if (!KNOWN_PUBLIC.has(code)) {
      console.error("claimAdSession internal error:", e && e.message);
    }
    res.status(400).json({ error: code });
  }
});

// ─── Admin helpers ───────────────────────────────────────────────────────────
// OPS-8: grantPicksDev / resetAllMinedCubes / sendTestPush / initLayerRewards
// removidas para liberar CPU del quota. Si necesitás admin actions:
//   - reset: scripts/reset_server.js (Admin SDK directo)
//   - dev picks: actualizar Firestore manualmente desde Firebase Console
//   - test push: usar la app del usuario
//   - layer rewards: ya son deterministas (no-op)

// ─── Worker: procesa pendingMints y mintea NFTs en Polygon ───────────────────

const MTBGEMS_ABI = [
  "function mintGem(address to, uint8 gemTier, string calldata gemCode, string calldata tokenURI_) external returns (uint256)",
];

// titles/bodies can be plain strings or {en, es} objects for bilingual support
// Round 2 Agente #10:
//   - CRIT-10-02: respetar settings.notify* del user (toggles de Config) — los
//     toggles eran cosméticos pre-fix; backend nunca los leía.
//   - CRIT-10-03: limpiar pushTokens inválidos cuando FCM responde
//     "token-not-registered" — sin esto, cross-user leakage en device
//     compartido + cost amplification de queries.
//   - HIGH-10-09: data payload para deep-linking al tap del push.
// Signature: sendPushToUser(uid, titles, bodies, opts?)
// opts.notifyKey: e.g. 'notifyRewards' — skip si user tiene ese setting false.
// opts.data: objeto custom serializable (FCM exige string values).
async function sendPushToUser(uid, titles, bodies, opts) {
  try {
    const notifyKey = opts && opts.notifyKey;
    const data = (opts && opts.data) || null;
    // Round 2 Agente #10 HIGH-10-10: channelId per push para mute granular
    // en Android. Default a 'default' channel si el caller no especifica.
    // Valores válidos: 'mint', 'payment', 'referral', 'marketing', 'default'.
    const channelId = (opts && opts.channelId) || 'default';
    const snap = await db.collection("users").doc(uid).get();
    const userData = snap.exists ? snap.data() : {};
    const token = userData.pushToken || null;
    const tokenType = userData.pushTokenType || 'expo';
    if (!token) return;
    // CRIT-10-02: respetar preferencia (default opt-in si undefined).
    // eslint-disable-next-line security/detect-object-injection -- notifyKey controlado por callers internos
    if (notifyKey && userData.settings && userData.settings[notifyKey] === false) return;
    const lang = (userData.settings && userData.settings.language) === 'es' ? 'es' : 'en';
    // eslint-disable-next-line security/detect-object-injection -- lang validado a 'es'|'en' arriba
    const title = typeof titles === 'object' ? (titles[lang] || titles.en) : titles;
    // eslint-disable-next-line security/detect-object-injection -- lang validado a 'es'|'en' arriba
    const body = typeof bodies === 'object' ? (bodies[lang] || bodies.en) : bodies;
    if (tokenType === 'fcm') {
      try {
        await getMessaging().send({
          token,
          notification: { title, body },
          // FCM exige que todos los values en data sean strings.
          ...(data ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) } : {}),
          android: { priority: "high", notification: { sound: "default", channelId } },
        });
      } catch (e) {
        const code = e && e.code;
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token" ||
            code === "messaging/mismatched-credential") {
          // CRIT-10-03: cleanup de token inválido.
          try {
            await db.collection("users").doc(uid).set({
              pushToken: FieldValue.delete(),
              pushTokenType: FieldValue.delete(),
            }, { merge: true });
            console.log(`sendPushToUser: cleaned invalid token for uid=${uid}`);
          } catch (cleanErr) {
            console.warn("sendPushToUser cleanup error:", cleanErr.message);
          }
        } else {
          throw e;
        }
      }
    } else {
      // Expo Push API (legacy). Tokens FCM nativos NO funcionan acá — esa es
      // exactamente la causa de CRIT-10-01 en notifyAllUsers. Mantener por
      // compat con users pre-V1.1.0 que todavía tengan pushTokenType='expo'.
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: token, title, body, sound: "default", data: data || undefined }),
      });
    }
  } catch (e) {
    console.error("sendPushToUser error:", e.message);
  }
}

// CRIT (Round 2 Agentes #3 + #8): lock distribuido para el mint processor.
// Sin esto, `processPendingMints` (admin manual) y `mintProcessorScheduled`
// (cron 5min) pueden correr concurrentes y ambos envían la mintGem() tx con
// el MISMO nonce de la company wallet → una falla con "nonce too low" o
// "replacement transaction underpriced", MATIC quemado en fees, race en el
// doc pendingMints.status=processing, y backlog atascado.
//
// La lock vive en runtime/mintProcessor con expiresAt. Si el worker crashea
// antes del finally, la lock auto-expira en LOCK_TTL_MS y el próximo run la
// toma. No previene el caso patológico de "nonce stuck por RPC", pero sí el
// escenario más común (cron vs manual concurrente, o dos crons solapados si
// uno tardó >5min).
//
// Patrón: read snapshot dentro de TX, evaluar expiry, escribir si libre.
// Las rules ya son default-deny para /runtime/*, por lo que el cliente no
// puede tocarlo.
const MINT_LOCK_TTL_MS = 10 * 60 * 1000;
async function withMintProcessorLock(fn) {
  const lockRef = db.collection("runtime").doc("mintProcessor");
  let acquired = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const now = Date.now();
      if (snap.exists && (snap.data().expiresAt || 0) > now) {
        return; // otra invocación tiene la lock viva → acquired queda false
      }
      tx.set(lockRef, { acquiredAt: now, expiresAt: now + MINT_LOCK_TTL_MS });
      acquired = true;
    });
  } catch (e) {
    console.error("mintProcessor lock acquire error:", e.message);
    return { ok: false, processed: 0, failed: 0, skipped: true, reason: "lock_error" };
  }
  if (!acquired) {
    return { ok: true, processed: 0, failed: 0, skipped: true, reason: "lock_held" };
  }
  try {
    return await fn();
  } finally {
    try {
      await lockRef.delete();
    } catch (_) {/* TTL backup garantiza limpieza */}
  }
}

// Lógica de minteo compartida entre onCall y onSchedule
async function runMintProcessing() {
  const privateKey = companyWalletKey.value();
  if (!privateKey) {
    console.error("COMPANY_WALLET_KEY no configurada");
    return { ok: false, processed: 0, failed: 0 };
  }
  // MEDIO-002: validar formato antes de pasarlo a ethers para que un secret
  // corrupto/mal-pegado falle fast con un error legible en logs, en vez de
  // dar el error críptico de ethers ("invalid private key").
  // Formato esperado: 0x + 64 hex chars (32 bytes).
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error("COMPANY_WALLET_KEY tiene formato inválido (esperado 0x + 64 hex)");
    return { ok: false, processed: 0, failed: 0, error: "invalid_key_format" };
  }

  const snap = await db.collection("pendingMints")
      .where("status", "==", "pending")
      .limit(10)
      .get();

  if (snap.empty) return { ok: true, processed: 0, failed: 0 };

  const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
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

    // ALTO-34: validar bounds del doc ANTES de pasar al contrato. Defense in
    // depth: aunque las rules bloquean writes directos a pendingMints, un bug
    // futuro o un admin compromised podría crear docs malformados.
    if (!Number.isInteger(data.gemTier) || data.gemTier < 1 || data.gemTier > 9) {
      console.error("Invalid gemTier in pendingMint:", { mintId, tier: data.gemTier });
      await mintRef.set({ status: 'failed', error: 'invalid_tier', failedAt: Date.now() }, { merge: true });
      failed++;
      continue;
    }
    if (typeof data.walletAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(data.walletAddress)) {
      console.error("Invalid walletAddress in pendingMint:", { mintId });
      await mintRef.set({ status: 'failed', error: 'invalid_wallet', failedAt: Date.now() }, { merge: true });
      failed++;
      continue;
    }
    if (typeof data.gemCode !== 'string' || data.gemCode.length === 0 || data.gemCode.length > 50) {
      console.error("Invalid gemCode in pendingMint:", { mintId });
      await mintRef.set({ status: 'failed', error: 'invalid_code', failedAt: Date.now() }, { merge: true });
      failed++;
      continue;
    }

    try {
      const tx = await contract.mintGem(
          data.walletAddress,
          data.gemTier,
          data.gemCode,
          data.tokenURI || GEM_TOKEN_URIS[(data.gemTier - 1)],
      );
      // CRIT (Round 2 Agentes #3 + #8): tx.wait() sin confirmaciones es
      // vulnerable a reorgs Polygon (PoS Heimdall confirma "checkpoints" cada
      // ~30 min; reorgs hasta 100 bloques se han observado históricamente).
      // Sin esperar SAFE_CONFIRMATIONS, podemos marcar status:completed para
      // un NFT que después desaparece on-chain → user sin NFT y sin recourse.
      // 30 bloques @ ~2.2s/block ≈ 66s de espera adicional por mint. Aceptable
      // para un cron 5min con queue chica.
      const SAFE_CONFIRMATIONS = 30;
      const receipt = await tx.wait(SAFE_CONFIRMATIONS);

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

      // SEC: no loguear walletAddress en plaintext (info pública on-chain pero
      // ruido en logs y útil para análisis de fraude si se cruza con otras fuentes).
      console.log(`NFT minteado: tokenId=${tokenId} mintId=${mintId}`);
      if (data.uid) {
        await sendPushToUser(
            data.uid,
            { en: "Your NFT arrived! 💎", es: "¡Tu NFT llegó! 💎" },
            { en: `Your gem was minted on Polygon. Token #${tokenId || ''}`, es: `Tu gema fue minteada en Polygon. Token #${tokenId || ''}` },
            // Round 2 #10: respetar settings.notifyRewards + deep-link a MyGems + channel 'mint'.
            { notifyKey: "notifyRewards", channelId: "mint", data: { url: "exp+miningtheblocks://gems", type: "mint_complete" } },
        );
      }
      processed++;
    } catch (e) {
      console.error(`Error minteando ${mintId}:`, e.message);
      // SEC-M2: retry hasta 5 veces antes de marcar failed. Si llega a 5,
      // alertamos al admin para revisión manual (gas insuficiente, RPC caído, etc.)
      const attemptCount = ((data && data.attemptCount) || 0) + 1;
      if (attemptCount < 5) {
        await mintRef.set({
          status: 'pending',
          attemptCount,
          lastError: e.message,
          lastFailedAt: Date.now(),
        }, { merge: true });
      } else {
        await mintRef.set({
          status: 'failed',
          attemptCount,
          error: e.message,
          failedAt: Date.now(),
        }, { merge: true });
        try {
          const appPassword = gmailAppPassword.value();
          if (appPassword) {
            const transporter = nodemailer.createTransport({
              service: "gmail",
              auth: { user: NOTIFY_EMAIL, pass: appPassword },
            });
            await transporter.sendMail({
              from: `"MTB Mint Alert" <${NOTIFY_EMAIL}>`,
              to: NOTIFY_EMAIL,
              subject: `[MTB] Mint failed after 5 attempts: ${mintId}`,
              text: `Mint ${mintId} failed.\nuid: ${data && data.uid}\nwallet: ${data && data.walletAddress}\ntier: ${data && data.gemTier}\nerror: ${e.message}`,
            });
          }
        } catch (mailErr) {
          console.warn("mint alert email failed:", mailErr.message);
        }
      }
      failed++;
    }
  }

  return { ok: true, processed, failed };
}

// Llamable manualmente (solo admin)
exports.processPendingMints = onCall({ secrets: [companyWalletKey, gmailAppPassword] }, async (request) => {
  // ALTO-31: check admin fresco (Admin SDK), no token cacheado.
  await requireAdminFresh(request);
  // CRIT (Round 2 Agentes #3 + #8): lock distribuido. Si el cron está corriendo
  // ahora, este onCall retorna skipped:lock_held en vez de competir por nonce.
  return withMintProcessorLock(() => runMintProcessing());
});

// Scheduler automático — corre cada 5 minutos
exports.mintProcessorScheduled = onSchedule(
    { schedule: "every 5 minutes", secrets: [companyWalletKey, gmailAppPassword] },
    async () => {
      // PERF (Round 2 Agente #12): self-throttle. El scheduler corre cada 5min
      // aunque la queue esté vacía. El get() inicial evita cargar eth provider +
      // lookup secrets + RPC calls cuando no hay nada que hacer (288 invoc/día).
      const pending = await db.collection("pendingMints")
          .where("status", "==", "pending").limit(1).get();
      if (pending.empty) {
        console.log("mintProcessorScheduled: skipped (queue empty)");
        return;
      }
      // CRIT (Round 2 Agentes #3 + #8): lock distribuido — evita race con
      // processPendingMints (admin manual). Si el admin disparó el flujo
      // hace <10min, este cron se autosaltea y reintenta al próximo tick.
      const result = await withMintProcessorLock(() => runMintProcessing());
      // SEC: solo counts, no JSON completo (puede contener uids/wallet addresses).
      if (result.skipped) {
        console.log(`mintProcessorScheduled: skipped reason=${result.reason}`);
      } else {
        console.log(`mintProcessorScheduled: processed=${result.processed || 0} failed=${result.failed || 0}`);
      }
    },
);

// ─── Referidos ────────────────────────────────────────────────────────────────

exports.checkUsername = onCall(async (request) => {
  const username = String((request.data && request.data.username) || '').trim().toLowerCase();
  if (!username || username.length < 3) return { available: false, reason: 'too_short' };
  if (username.length > 30) return { available: false, reason: 'too_long' };
  if (!/^[a-z0-9_]+$/.test(username)) return { available: false, reason: 'invalid_chars' };
  const uid = request.auth && request.auth.uid;
  const snap = await db.collection("usernames").doc(username).get();
  if (!snap.exists) return { available: true };
  // User can keep their own username
  if (uid && snap.data().uid === uid) return { available: true };
  return { available: false, reason: 'taken' };
});

// SEC-M7 + P1-7: rate-limit por uid persistido en Firestore — 10 lookups/min/uid.
exports.checkReferralCode = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const ok = await _rateLimitFirestore(`crc_${uid}`, 10, 60 * 1000);
  if (!ok) {
    throw new HttpsError("resource-exhausted", "rate_limited");
  }
  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code || code.length > 16) return { valid: false };
  const q = await db.collection("users").where("referralCode", "==", code).limit(1).get();
  return { valid: !q.empty };
});

// SEC-N-005: setear walletAddress del usuario via Cloud Function (las rules
// bloquean escritura directa). Valida formato y limpia el field si se pasa null.
//
// ALTO-35: cooldown anti-hot-swap. Si un atacante toma temporalmente control
// de la cuenta y cambia la wallet, hay un periodo en que los NFTs futuros se
// envían a su wallet. Aplicamos cooldown de 24h entre cambios. El primer set
// (cuando walletAddress es null) no tiene cooldown.
const WALLET_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

exports.setUserWallet = onCall(async (request) => {
  requireRegistered(request);
  const uid = request.auth.uid;
  const okRate = await _rateLimitFirestore(`suw_${uid}`, 5, 60 * 1000);
  if (!okRate) throw new HttpsError("resource-exhausted", "rate_limited");

  const raw = (request.data && request.data.walletAddress);
  const addr = raw === null || raw === '' ? null : String(raw || '').trim();
  if (addr !== null && !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new HttpsError("invalid-argument", "invalid_wallet");
  }

  // ALTO-35: chequear cooldown solo si ya había wallet previa Y se cambia a otra distinta.
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    const data = userSnap.data() || {};
    const prevAddr = data.walletAddress || null;
    const lastChangeAt = Number(data.walletChangedAt || 0);
    // Solo aplicar cooldown si: hay wallet previa Y la nueva es distinta (incluido cambiar a null).
    const isChange = prevAddr && addr !== prevAddr;
    if (isChange && lastChangeAt && Date.now() - lastChangeAt < WALLET_CHANGE_COOLDOWN_MS) {
      const remainHours = Math.ceil((WALLET_CHANGE_COOLDOWN_MS - (Date.now() - lastChangeAt)) / (60 * 60 * 1000));
      throw new HttpsError("resource-exhausted", `wallet_cooldown:${remainHours}`);
    }
  }

  await userRef.set({
    walletAddress: addr,
    walletChangedAt: Date.now(),
    updatedAt: Date.now(),
  }, { merge: true });
  return { ok: true, walletAddress: addr };
});

exports.applyReferral = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  // SEC-N-003: rate-limit 5/min/uid para evitar enumeration de códigos.
  const okRate = await _rateLimitFirestore(`ar_${uid}`, 5, 60 * 1000);
  if (!okRate) throw new HttpsError("resource-exhausted", "rate_limited");

  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code || code.length > 16) throw new HttpsError("invalid-argument", "Code required");

  const userRef = db.collection("users").doc(uid);

  // Buscar al referidor por código (lectura fuera de transacción — solo referencia inmutable)
  const referrerQuery = await db.collection("users").where("referralCode", "==", code).limit(1).get();
  if (referrerQuery.empty) throw new HttpsError("not-found", "Invalid code");

  const referrerDoc = referrerQuery.docs[0];
  if (referrerDoc.id === uid) throw new HttpsError("invalid-argument", "Cannot use your own code");

  // El check de referredBy va DENTRO de la transacción para evitar la condición de carrera
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(userRef);
    if (!freshSnap.exists) throw new HttpsError("not-found", "User not found");
    if (freshSnap.data().referredBy) throw new HttpsError("already-exists", "Already applied a referral");
    tx.set(userRef, { referredBy: referrerDoc.id, referralAppliedAt: Date.now() }, { merge: true });
  });

  return { ok: true };
});

// ─── Pagos crypto ─────────────────────────────────────────────────────────────

// Crea un pago pendiente con monto único para identificar al usuario.
// SEC-002: docId determinístico = "amt_${amountUnits}" + transacción atómica
// para evitar race condition donde dos uids reclaman el mismo amount y luego
// `pendingByAmount.set` sobreescribe → robo de crédito por colisión.
exports.createCryptoPayment = onCall(async (request) => {
  requireRegistered(request);
  // CRIT (Round 2 Agente #6): checkRevoked + disabled check. createCryptoPayment
  // emite slots de amount únicos — un token revocado podría agotar las 99 slots
  // del rate-limit global desde una sesión post-revoke ya invalidada.
  await assertFreshToken(request);
  const uid = request.auth.uid;
  // FIX-FINAL-5: rate-limit para evitar agotar las 99 slots de amount unique
  const okRate = await _rateLimitFirestore(`ccp_${uid}`, 3, 60 * 60 * 1000);
  if (!okRate) throw new HttpsError("resource-exhausted", "rate_limited");

  const nowMs = Date.now();

  // Si ya tiene un pago pendiente vigente, devolverlo
  const existing = await db.collection("pendingCryptoPayments")
      .where("uid", "==", uid)
      .where("status", "==", "waiting")
      .where("expiresAt", ">", nowMs)
      .limit(1).get();

  if (!existing.empty) {
    const d = existing.docs[0].data();
    return { paymentId: existing.docs[0].id, amount: d.amountDisplay, wallet: PAYMENT_WALLET, expiresAt: d.expiresAt };
  }

  // Loop: probar centavos aleatorios hasta encontrar uno libre (con docId determinístico)
  for (let attempt = 0; attempt < 30; attempt++) {
    const cents = Math.floor(Math.random() * 99) + 1;
    const amountUnits = (CREDIT_PRICE_USD * 100 + cents) * 10000; // USDC 6 decimales
    const amountDisplay = `${CREDIT_PRICE_USD}.${String(cents).padStart(2, "0")}`;
    const docId = `amt_${amountUnits}`;
    const ref = db.collection("pendingCryptoPayments").doc(docId);
    const expiresAt = Date.now() + PAYMENT_WINDOW_MS;

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        // Si existe y sigue vigente con otro uid (o el mismo), colisión → reintento
        if (snap.exists) {
          const data = snap.data() || {};
          if (data.status === "waiting" && (data.expiresAt || 0) > Date.now()) {
            throw new Error("collision");
          }
          // Si está expired/completed/cancelled, podemos sobrescribirlo
        }
        tx.set(ref, {
          uid, amountUnits, amountDisplay,
          status: "waiting",
          createdAt: Date.now(),
          expiresAt,
        });
      });
      return { paymentId: docId, amount: amountDisplay, wallet: PAYMENT_WALLET, expiresAt };
    } catch (e) {
      if (e.message !== "collision") throw e; // error real, no reintentar
      // colisión → siguiente attempt
    }
  }
  throw new HttpsError("resource-exhausted", "try_again");
});

// CRIT-01..03: hardening del flow de pagos crypto:
// - SAFE_CONFIRMATIONS: solo consumir eventos con >=30 confirmaciones para
//   evitar acreditar TXs que luego revierten por reorgs en Polygon.
// - processedTxs/{txHash}: registro idempotente para evitar doble-crédito si
//   el mismo evento aparece en runs solapados (200 bloques ≈ 7 min, vs run
//   cada 5 min) o en escenarios de reorg.
const SAFE_CONFIRMATIONS = 30;

// Escanea Polygon cada 5 min buscando transferencias USDC al wallet de pagos
async function runCryptoPaymentProcessing() {
  const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
  const currentBlock = await provider.getBlockNumber();
  // CRIT-02: solo considerar bloques con SAFE_CONFIRMATIONS confirmaciones.
  const safeBlock = currentBlock - SAFE_CONFIRMATIONS;

  // CRIT (Round 2 Agente #8): usar checkpoint persistido en lugar de ventana
  // fija de 200 bloques. Sin checkpoint, si el scheduler se atrasa >6.6 min
  // (publicnode.com outage, cold start lento, function timeout retry...),
  // los pagos USDC legítimos caen fuera de la ventana → perdidos silencio-
  // samente (el doc pendingCryptoPayments queda waiting hasta expirar a
  // los 30min y el user no recibe sus créditos).
  //
  // Con checkpoint: cada run procesa desde lastBlockProcessed+1 hasta
  // safeBlock. Si una query RPC falla, NO se avanza el checkpoint → el
  // próximo run reintenta. processedTxs/{txHash} previene doble-crédito.
  const checkpointRef = db.collection("runtime").doc("cryptoPaymentCheckpoint");
  const checkpointSnap = await checkpointRef.get();
  const lastProcessed = checkpointSnap.exists ? (checkpointSnap.data().lastBlockProcessed || 0) : 0;

  let fromBlock;
  if (lastProcessed > 0 && lastProcessed < safeBlock) {
    fromBlock = lastProcessed + 1;
    // Defensive cap: si el backlog es absurdo (sistema offline días), evitar
    // un query gigante a publicnode.com. 5000 bloques ≈ 3h de Polygon.
    // Si llegamos a esto, hay pagos potencialmente perdidos en el gap —
    // queda en logs para investigación post-mortem.
    const MAX_BACKLOG = 5000;
    if (safeBlock - fromBlock > MAX_BACKLOG) {
      console.warn(`cryptoPaymentProcessor: gap=${safeBlock - fromBlock} bloques, capando a ${MAX_BACKLOG}. Posibles pagos perdidos en el gap.`);
      fromBlock = safeBlock - MAX_BACKLOG;
    }
  } else {
    // Primer run (sin checkpoint) o checkpoint adelantado: ventana corta para
    // no escanear historia gratuitamente.
    fromBlock = safeBlock - 200;
  }
  fromBlock = Math.max(fromBlock, 0);

  // Cargar pagos pendientes vigentes
  const pendingSnap = await db.collection("pendingCryptoPayments")
      .where("status", "==", "waiting")
      .where("expiresAt", ">", Date.now())
      .get();
  if (pendingSnap.empty) {
    // Avanzar checkpoint igual: si no hay pagos pendientes, no necesitamos
    // re-escanear estos bloques en runs futuros.
    if (lastProcessed < safeBlock) {
      await checkpointRef.set({ lastBlockProcessed: safeBlock, updatedAt: Date.now() }, { merge: true });
    }
    return { processed: 0 };
  }

  // SEC-002 defense-in-depth: array por amount (no sobreescribir).
  // Con docId determinístico nuevo, no debería haber colisiones, pero data legacy
  // de createCryptoPayment con random IDs puede tener duplicados.
  const pendingByAmount = new Map();
  pendingSnap.docs.forEach((doc) => {
    const amt = doc.data().amountUnits;
    if (!pendingByAmount.has(amt)) pendingByAmount.set(amt, []);
    pendingByAmount.get(amt).push(doc);
  });

  let processed = 0;
  // Round 2 Agente #8: track si TODAS las queries RPC tuvieron éxito. Si
  // alguna falló, NO avanzamos el checkpoint para reintentar el rango en
  // el próximo run (processedTxs previene doble-crédito).
  let rpcQueriesSucceeded = true;
  for (const usdcAddress of USDC_CONTRACTS) {
    const contract = new ethers.Contract(usdcAddress, USDC_ABI, provider);
    let events;
    try {
      const mkFilter = contract.filters["Transfer"];
      const transferFilter = mkFilter(null, PAYMENT_WALLET);
      // CRIT-02: cerrar la query en safeBlock (no currentBlock) para evitar
      // procesar eventos en bloques no confirmados.
      events = await contract.queryFilter(
          transferFilter,
          fromBlock, safeBlock,
      );
    } catch (e) {
      console.warn("Error querying USDC transfers:", e.message);
      rpcQueriesSucceeded = false;
      continue;
    }

    for (const event of events) {
      const amount = Number(event.args.value);
      const docs = pendingByAmount.get(amount);
      if (!docs || docs.length === 0) continue;
      // FCFS: tomar el más antiguo (createdAt asc) para resolver colisiones legacy
      docs.sort((a, b) => (a.data().createdAt || 0) - (b.data().createdAt || 0));
      const paymentDoc = docs.shift();
      const { uid } = paymentDoc.data();
      const txHash = event.transactionHash;

      try {
        let alreadyProcessed = false;
        await db.runTransaction(async (tx) => {
          // CRIT-03: idempotency global por txHash. Si ya procesamos este
          // hash (en este o pasado run), saltamos. Crear y leer en la misma
          // TX garantiza atomicidad incluso bajo concurrencia.
          const processedTxRef = db.collection("processedTxs").doc(txHash);
          const processedSnap = await tx.get(processedTxRef);
          if (processedSnap.exists) {
            alreadyProcessed = true;
            return;
          }
          const freshPayment = await tx.get(paymentDoc.ref);
          if (!freshPayment.exists || freshPayment.data().status !== "waiting") {
            alreadyProcessed = true;
            return;
          }
          const userRef = db.collection("users").doc(uid);
          tx.set(userRef, { serverCredits: FieldValue.increment(1) }, { merge: true });
          tx.set(paymentDoc.ref, {
            status: "completed",
            txHash: txHash,
            completedAt: Date.now(),
          }, { merge: true });
          // Marcar tx como consumida con TTL ~30 días (cleanup por TTL policy).
          // expiresAt DEBE ser Timestamp (no int64) para que Firestore TTL la
          // purgue automáticamente.
          tx.set(processedTxRef, {
            uid,
            amount,
            paymentId: paymentDoc.id,
            processedAt: Date.now(),
            expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
          });
        });
        if (alreadyProcessed) continue;

        // Bonus de referido: 5 picos para el referidor Y 5 picos para el referido al primer crédito
        try {
          let bonusReferredBy = null;
          await db.runTransaction(async (tx) => {
            const userRef = db.collection("users").doc(uid);
            const userSnap = await tx.get(userRef);
            const userData = userSnap.exists ? (userSnap.data() || {}) : {};
            const referredBy = userData.referredBy || null;
            const referralBonusPaid = userData.referralBonusPaid || false;
            if (referredBy && !referralBonusPaid) {
              bonusReferredBy = referredBy;
              const referrerRef = db.collection("users").doc(referredBy);
              tx.set(referrerRef, { picks: FieldValue.increment(5) }, { merge: true });
              tx.set(userRef, {
                picks: FieldValue.increment(5),
                referralBonusPaid: true,
              }, { merge: true });
            }
          });
          if (bonusReferredBy) {
            await sendPushToUser(
                bonusReferredBy,
                { en: "Your referral bought a credit! 🎉", es: "¡Tu referido compró un crédito! 🎉" },
                { en: "You both received 5 picks! Keep inviting friends!", es: "¡Ambos recibieron 5 picos! ¡Seguí invitando amigos!" },
                // Round 2 #10: respetar settings.notifyRewards + deep-link a Profile + channel 'referral'.
                { notifyKey: "notifyRewards", channelId: "referral", data: { url: "exp+miningtheblocks://profile", type: "referral_bonus" } },
            );
            // In-app notification for the referrer
            await db.collection("users").doc(bonusReferredBy).collection("notifications").add({
              type: "referral_bonus",
              picks: 5,
              createdAt: Date.now(),
            });
            // In-app notification for the buyer (referred user)
            await db.collection("users").doc(uid).collection("notifications").add({
              type: "referral_bonus_self",
              picks: 5,
              createdAt: Date.now(),
            });
          }
        } catch (refErr) {
          console.warn("Referral bonus error:", refErr.message);
        }

        // Push notification al comprador
        try {
          await sendPushToUser(
              uid,
              {en: "Payment received! 💰", es: "¡Pago recibido! 💰"},
              {en: "Your credit was added. You can now join a chain!", es: "Tu crédito fue acreditado. ¡Ya podés unirte a una cadena!"},
              // Round 2 #10: respetar settings.notifyRewards + deep-link a ServerList + channel 'payment'.
              { notifyKey: "notifyRewards", channelId: "payment", data: { url: "exp+miningtheblocks://servers", type: "payment_received" } },
          );
        } catch (pushErr) {
          console.warn("Push notification failed:", pushErr.message);
        }

        // Si todavía hay docs legacy con este amount, no borrar el Map entry —
        // ya hicimos shift(). Si quedó vacío el array, limpiar.
        if (docs.length === 0) pendingByAmount.delete(amount);
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

  // Round 2 Agente #8: avanzar checkpoint solo si las queries RPC fueron
  // exitosas en TODOS los contratos USDC. Si alguna falló, el próximo run
  // reintenta el mismo rango (los processedTxs previenen doble-crédito).
  if (rpcQueriesSucceeded && safeBlock > lastProcessed) {
    try {
      await checkpointRef.set({
        lastBlockProcessed: safeBlock,
        updatedAt: Date.now(),
      }, { merge: true });
    } catch (e) {
      // No es fatal: si falla, el próximo run vuelve a escanear desde donde
      // estaba antes — los processedTxs hacen idempotente el procesamiento.
      console.warn("cryptoPaymentProcessor checkpoint update failed:", e.message);
    }
  }

  return { processed };
}

// Envía push notification a todos los usuarios que tengan token registrado (solo admin)
exports.notifyAllUsers = onCall(async (request) => {
  // ALTO-31: check admin fresco (Admin SDK).
  await requireAdminFresh(request);

  // SEC-M4 + P2-12: rate-limit 1 broadcast/hora por admin para evitar abuso si la
  // cuenta admin se compromete (spam a toda la base) o uso accidental.
  const adminUid = request.auth.uid;
  const ok = await _rateLimitFirestore(`nau_${adminUid}`, 1, 60 * 60 * 1000);
  if (!ok) {
    throw new HttpsError("resource-exhausted", "rate_limited: 1 broadcast/hour");
  }

  const title = String((request.data && request.data.title) || '').trim().slice(0, 100);
  const body = String((request.data && request.data.body) || '').trim().slice(0, 500);
  if (!title || !body) throw new HttpsError("invalid-argument", "title and body required");

  // CRIT (Round 2 Agente #10 CRIT-10-01): antes mandábamos TODOS los tokens
  // al endpoint Expo Push API, incluyendo los FCM nativos que el cliente
  // registra desde V1.1.0+ via getDevicePushTokenAsync(). Expo respondía
  // error sin tirar excepción → log decía "sent=N" cuando en realidad fueron
  // 0. La única broadcast feature del producto NO entregaba ningún mensaje
  // y el admin nunca se enteraba.
  //
  // Fix: ramificar por pushTokenType. FCM nativos van por
  // getMessaging().sendEachForMulticast (hasta 500 tokens/call, devuelve
  // success/error por token). Expo legacy sigue por exp.host. Token cleanup
  // automático sobre los uids con responses de "not registered".
  const BATCH = 500;
  const fcmTokens = [];
  const fcmTokenUids = []; // paralelo a fcmTokens para cleanup
  const expoTokens = [];
  let lastDoc = null;

  for (;;) {
    // MEDIO-H12: paginar con orderBy explícito para garantizar consistencia.
    let q = db.collection("users")
        .where("pushToken", "!=", null)
        .orderBy("pushToken")
        .orderBy(FieldPath.documentId())
        .limit(BATCH);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach((d) => {
      const docData = d.data();
      const token = docData.pushToken;
      const type = docData.pushTokenType || 'expo';
      if (token && typeof token === 'string' && token.length > 10) {
        if (type === 'fcm') {
          fcmTokens.push(token);
          fcmTokenUids.push(d.id);
        } else {
          expoTokens.push(token);
        }
      }
    });
    if (snap.size < BATCH) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  const total = fcmTokens.length + expoTokens.length;
  if (total === 0) return { ok: true, sent: 0, total: 0 };

  let sent = 0;
  let failed = 0;
  const invalidUids = new Set();

  // 1) FCM via sendEachForMulticast (hasta 500 tokens por call)
  const FCM_CHUNK = 500;
  for (let i = 0; i < fcmTokens.length; i += FCM_CHUNK) {
    const chunkTokens = fcmTokens.slice(i, i + FCM_CHUNK);
    const chunkUids = fcmTokenUids.slice(i, i + FCM_CHUNK);
    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens: chunkTokens,
        notification: { title, body },
        // Round 2 Agente #10 HIGH-10-10: broadcasts van al channel 'marketing'
        // (importance DEFAULT vs HIGH de los transaccionales). Permite al user
        // mute solo marketing sin perder alerts de mint/payment.
        android: { priority: "high", notification: { sound: "default", channelId: "marketing" } },
      });
      response.responses.forEach((r, idx) => {
        if (r.success) {
          sent++;
        } else {
          failed++;
          const code = r.error && r.error.code;
          if (code === "messaging/registration-token-not-registered" ||
              code === "messaging/invalid-registration-token" ||
              code === "messaging/mismatched-credential") {
            // eslint-disable-next-line security/detect-object-injection -- idx desde forEach con response.responses
            invalidUids.add(chunkUids[idx]);
          }
        }
      });
    } catch (e) {
      console.error("notifyAllUsers FCM chunk error:", e.message);
      failed += chunkTokens.length;
    }
  }

  // 2) Expo Push API (legacy) — hasta 100 por request
  const EXPO_CHUNK = 100;
  for (let i = 0; i < expoTokens.length; i += EXPO_CHUNK) {
    const chunk = expoTokens.slice(i, i + EXPO_CHUNK).map((to) => ({
      to, title, body, sound: "default",
    }));
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      sent += chunk.length;
    } catch (e) {
      console.error("notifyAllUsers Expo chunk error:", e.message);
      failed += chunk.length;
    }
  }

  // CRIT-10-03: cleanup de tokens inválidos en batch.
  if (invalidUids.size > 0) {
    try {
      const cleanupBatch = db.batch();
      invalidUids.forEach((cleanUid) => {
        cleanupBatch.set(db.collection("users").doc(cleanUid), {
          pushToken: FieldValue.delete(),
          pushTokenType: FieldValue.delete(),
        }, { merge: true });
      });
      await cleanupBatch.commit();
      console.log(`notifyAllUsers: cleaned ${invalidUids.size} invalid tokens`);
    } catch (e) {
      console.warn("notifyAllUsers cleanup error:", e.message);
    }
  }

  console.log(`notifyAllUsers: sent=${sent} failed=${failed} cleaned=${invalidUids.size} total=${total} fcm=${fcmTokens.length} expo=${expoTokens.length}`);

  // SEC-P2-12: audit log
  try {
    await db.collection("adminActions").add({
      action: "notifyAllUsers",
      adminUid,
      title: title.slice(0, 100),
      body: body.slice(0, 200),
      sent,
      failed,
      cleaned: invalidUids.size,
      total,
      fcm: fcmTokens.length,
      expo: expoTokens.length,
      ts: Date.now(),
    });
  } catch (logErr) {
    console.warn("notifyAllUsers audit log failed:", logErr.message);
  }

  return { ok: true, sent, failed, cleaned: invalidUids.size, total };
});

exports.cryptoPaymentProcessorScheduled = onSchedule("every 5 minutes", async () => {
  // PERF (Round 2 Agente #12): self-throttle. Si nadie está esperando un pago,
  // skipear el scan de USDC Transfer events sobre publicnode.com (RPC sin SLA,
  // 288 invoc/día → reduce risk de rate-limit del RPC).
  const pending = await db.collection("pendingCryptoPayments")
      .where("status", "==", "waiting").limit(1).get();
  if (pending.empty) {
    console.log("cryptoPaymentProcessorScheduled: skipped (queue empty)");
    return;
  }
  const result = await runCryptoPaymentProcessing();
  // SEC: solo count agregado, no result completo con uids/paymentIds.
  console.log(`cryptoPaymentProcessorScheduled: processed=${result && result.processed || 0}`);
});

// FIX-3: Backup diario de Firestore a Cloud Storage.
// Requiere:
//   1. Bucket: `gsutil mb -p miningtheblocks-669f6 -l us-central1 gs://miningtheblocks-669f6-backups`
//   2. Service account de la function tiene rol `roles/datastore.importExportAdmin`
//      (lo seteás una vez: `gcloud projects add-iam-policy-binding miningtheblocks-669f6 \
//        --member=serviceAccount:miningtheblocks-669f6@appspot.gserviceaccount.com \
//        --role=roles/datastore.importExportAdmin`)
//   3. Bucket lifecycle: borrar exports >30 días para no acumular costos.
// Si el bucket no existe o el rol no está, la function loguea el error y no falla la app.
exports.firestoreBackupScheduled = onSchedule("every day 03:00", async () => {
  try {
    const { v1 } = require("@google-cloud/firestore");
    const client = new v1.FirestoreAdminClient();
    const projectId = process.env.GCLOUD_PROJECT || "miningtheblocks-669f6";
    const bucket = `gs://${projectId}-backups`;
    const dateStr = new Date().toISOString().slice(0, 10);
    const [operation] = await client.exportDocuments({
      name: client.databasePath(projectId, "(default)"),
      outputUriPrefix: `${bucket}/${dateStr}`,
      collectionIds: [], // todas las colecciones
    });
    console.log(`firestoreBackupScheduled: started export to ${bucket}/${dateStr}, operation=${operation.name}`);
  } catch (e) {
    console.error(`firestoreBackupScheduled error: ${e.message}`);
    // No re-throw: backup fallido no debería tirar reportes infinitos.
  }
});

// CRIT (Round 2 Agente #11 CRIT-11-02 + #12): MATIC balance alert.
// Sin esto, mints fallarían silenciosamente cuando el balance llega a 0.
// 5 retries × ~30s cada uno = 2-3h de holders esperando ANTES del email de
// fail. Con alert proactivo: el dev se entera cuando balance < 2 MATIC
// (umbral ~ 50 mints futuros @ Polygon gas típico).
exports.maticBalanceCheckScheduled = onSchedule(
    { schedule: "every 6 hours", secrets: [companyWalletKey, gmailAppPassword] },
    async () => {
      try {
        const privateKey = companyWalletKey.value();
        if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
          console.error("maticBalanceCheck: invalid wallet key format");
          return;
        }
        const provider = new ethers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
        const wallet = new ethers.Wallet(privateKey, provider);
        const balanceWei = await provider.getBalance(wallet.address);
        const balanceMatic = Number(ethers.formatEther(balanceWei));
        const THRESHOLD_MATIC = 2;

        if (balanceMatic >= THRESHOLD_MATIC) {
          console.log(`maticBalanceCheck: OK balance=${balanceMatic.toFixed(3)} MATIC`);
          return;
        }

        // Anti-spam: 1 alert por día como máximo (state en runtime/maticAlert).
        const alertRef = db.collection("runtime").doc("maticBalanceAlert");
        const alertSnap = await alertRef.get();
        const lastAlertAt = alertSnap.exists ? (alertSnap.data().lastAlertAt || 0) : 0;
        if (Date.now() - lastAlertAt < 24 * 60 * 60 * 1000) {
          console.log(`maticBalanceCheck: LOW ${balanceMatic.toFixed(3)} MATIC (alert deduped)`);
          return;
        }

        const appPassword = gmailAppPassword.value();
        if (!appPassword) {
          console.error("maticBalanceCheck: gmail not configured, cannot send alert");
          return;
        }
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: NOTIFY_EMAIL, pass: appPassword },
        });
        await transporter.sendMail({
          from: `"MTB Operations Alert" <${NOTIFY_EMAIL}>`,
          to: NOTIFY_EMAIL,
          subject: `⛏️ [MTB OPS] LOW MATIC: ${balanceMatic.toFixed(3)} (threshold ${THRESHOLD_MATIC})`,
          text: `Company wallet ${wallet.address} balance is below threshold.\n\nCurrent: ${balanceMatic.toFixed(6)} MATIC\nThreshold: ${THRESHOLD_MATIC} MATIC\n\nMint operations will start failing if balance reaches 0. Top up via QuickSwap (USDC → MATIC) or buy MATIC directly. ~0.04 MATIC per mint typical gas.\n\nThis alert is throttled to 1/day.`,
        });
        await alertRef.set({ lastAlertAt: Date.now(), balanceMatic }, { merge: true });
        console.warn(`maticBalanceCheck: ALERT SENT, balance=${balanceMatic.toFixed(6)}`);
      } catch (e) {
        console.error("maticBalanceCheckScheduled error:", e && e.message);
      }
    });

// HIGH (Round 2 Agente #11 HIGH-11-21): weekly errorLog digest.
// errorLog Firestore es write-only desde regla; nadie lo lee programáticamente.
// Pre-fix: el dev tenía que abrir Firebase Console manualmente cada X tiempo
// y scrollear. Con email digest semanal: top scopes por count, sample por
// scope, en HTML simple. Detección temprana de regresiones del cliente.
exports.errorLogSummaryWeekly = onSchedule(
    { schedule: "every monday 08:00", timeZone: "America/Argentina/Buenos_Aires", secrets: [gmailAppPassword] },
    async () => {
      try {
        const oneWeekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const snap = await db.collection("errorLog")
            .where("ts", ">=", oneWeekAgoMs)
            .limit(2000).get();
        if (snap.empty) {
          console.log("errorLogSummary: no errors this week");
          return;
        }
        const byScope = new Map();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          const scope = String(data.scope || "unknown").slice(0, 80);
          if (!byScope.has(scope)) byScope.set(scope, { count: 0, sample: "" });
          const entry = byScope.get(scope);
          entry.count++;
          if (!entry.sample && data.msg) entry.sample = String(data.msg).slice(0, 200);
        });
        const sorted = Array.from(byScope.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 25);

        const appPassword = gmailAppPassword.value();
        if (!appPassword) return;
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: NOTIFY_EMAIL, pass: appPassword },
        });
        const rows = sorted.map(([scope, e]) =>
          `<tr><td>${esc(scope)}</td><td style="text-align:right;font-weight:700">${e.count}</td><td style="font-family:monospace;font-size:11px;color:#888">${esc(e.sample) || "—"}</td></tr>`,
        ).join("\n");
        await transporter.sendMail({
          from: `"MTB Weekly Report" <${NOTIFY_EMAIL}>`,
          to: NOTIFY_EMAIL,
          subject: `📊 [MTB] errorLog weekly: ${snap.size} errors / ${sorted.length} scopes`,
          html: `<h2>errorLog weekly summary</h2>
<p>Last 7 days: <strong>${snap.size}</strong> errors across <strong>${sorted.length}</strong> distinct scopes.</p>
<table border="1" cellpadding="6" cellspacing="0" style="font-family:sans-serif;font-size:13px;border-collapse:collapse">
  <thead style="background:#f0f0f0"><tr><th>Scope</th><th>Count</th><th>Sample message</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="color:#888;font-size:11px;margin-top:24px">Scopes con &gt;100 errors/semana sugieren bug del cliente. Investigá los top 3.</p>`,
        });
        console.log(`errorLogSummary: sent digest, scopes=${sorted.length} total=${snap.size}`);
      } catch (e) {
        console.error("errorLogSummaryWeekly error:", e && e.message);
      }
    });

// HIGH (Round 2 Agente #11 HIGH-11-22): weekly adminActions digest +
// anomaly detection. adminActions Firestore es write-only; nadie monitorea.
// Pre-fix: si un admin se compromete y hace 50 grant_admin + addServerCredit,
// el log existe pero el operador no se entera hasta hacer auditoría manual.
// Esta function alerta si un admin tuvo >50 acciones/semana (ramp-up sospechoso).
exports.adminActionsAnomalyWeekly = onSchedule(
    { schedule: "every monday 08:30", timeZone: "America/Argentina/Buenos_Aires", secrets: [gmailAppPassword] },
    async () => {
      try {
        const oneWeekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const snap = await db.collection("adminActions")
            .where("ts", ">=", oneWeekAgoMs)
            .limit(5000).get();
        if (snap.empty) {
          console.log("adminActionsAnomaly: no actions this week");
          return;
        }
        const byAdmin = new Map();
        const byAction = new Map();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          const adminUid = String(data.adminUid || data.uid || "system").slice(0, 32);
          const action = String(data.action || "unknown").slice(0, 50);
          byAdmin.set(adminUid, (byAdmin.get(adminUid) || 0) + 1);
          byAction.set(action, (byAction.get(action) || 0) + 1);
        });
        const ANOMALY_THRESHOLD = 50;
        const anomalies = Array.from(byAdmin.entries()).filter(([_, c]) => c > ANOMALY_THRESHOLD);

        const appPassword = gmailAppPassword.value();
        if (!appPassword) return;
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: NOTIFY_EMAIL, pass: appPassword },
        });
        const adminRows = Array.from(byAdmin.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([uid, c]) => `<tr><td>${esc(uid.slice(0, 12))}…</td><td style="text-align:right;font-weight:700">${c}</td><td>${c > ANOMALY_THRESHOLD ? '<span style="color:#ff6b6b">⚠️ HIGH</span>' : ""}</td></tr>`)
            .join("\n");
        const actionRows = Array.from(byAction.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([a, c]) => `<tr><td>${esc(a)}</td><td style="text-align:right;font-weight:700">${c}</td></tr>`)
            .join("\n");
        await transporter.sendMail({
          from: `"MTB Weekly Report" <${NOTIFY_EMAIL}>`,
          to: NOTIFY_EMAIL,
          subject: anomalies.length > 0 ?
            `🚨 [MTB] adminActions ANOMALY: ${anomalies.length} admin(s) >${ANOMALY_THRESHOLD} ops/week` :
            `📊 [MTB] adminActions weekly: ${snap.size} ops, nominal`,
          html: `<h2>adminActions weekly summary</h2>
<p>Last 7 days: <strong>${snap.size}</strong> admin operations across <strong>${byAdmin.size}</strong> admin uid(s).</p>
${anomalies.length > 0 ? `<p style="background:#fff0f0;border-left:4px solid #ff6b6b;padding:10px"><strong>⚠️ ${anomalies.length} admin(s) exceeded ${ANOMALY_THRESHOLD} ops</strong>. Investigate: post-bug bash? Promo? Compromise?</p>` : ""}
<h3>By admin</h3>
<table border="1" cellpadding="6" cellspacing="0" style="font-family:sans-serif;font-size:13px;border-collapse:collapse"><thead style="background:#f0f0f0"><tr><th>adminUid</th><th>count</th><th>flag</th></tr></thead><tbody>${adminRows}</tbody></table>
<h3>By action</h3>
<table border="1" cellpadding="6" cellspacing="0" style="font-family:sans-serif;font-size:13px;border-collapse:collapse"><thead style="background:#f0f0f0"><tr><th>action</th><th>count</th></tr></thead><tbody>${actionRows}</tbody></table>`,
        });
        console.log(`adminActionsAnomaly: sent digest, anomalies=${anomalies.length} total=${snap.size}`);
      } catch (e) {
        console.error("adminActionsAnomalyWeekly error:", e && e.message);
      }
    });

// ─── Web: Verificación y claim de gemas ──────────────────────────────────────

// SEC-P1-7: rate-limit persistido en Firestore (consistente entre instancias).
// Antes era Map in-memory; un atacante podía repartir requests entre instancias
// de Cloud Functions y bypasear el límite.
//
// Implementación: doc en rateLimits/{bucket} con array de timestamps en ventana.
// La TX limpia los viejos y verifica el cap. Si el bucket no existe lo crea.
async function _rateLimitFirestore(bucket, max, windowMs) {
  const ref = db.collection("rateLimits").doc(bucket);
  let allowed = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const arr = (snap.exists ? (snap.data().ts || []) : []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      allowed = false;
      tx.set(ref, { ts: arr, expiresAt: now + windowMs * 2 }, { merge: true });
      return;
    }
    arr.push(now);
    tx.set(ref, { ts: arr, expiresAt: now + windowMs * 2 }, { merge: true });
    allowed = true;
  });
  return allowed;
}

exports.verifyGemCode = onRequest(async (req, res) => {
  // MED (Round 2 Agente #7): allowlist en lugar de wildcard `*`. Pre-fix:
  // cualquier origen podía enumerar códigos de gemas via GET (el rate-limit
  // 30/min/IP mitigaba bulk-enum pero la inconsistencia con submitGemClaim
  // — que sí usa allowlist — era reportable). Ahora solo miningtheblocks.com
  // y miningtheblocks.github.io pueden hacer el call.
  setRestrictedCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  // SEC-A10 + P1-7: rate-limit por IP persistido en Firestore — 30 lookups/min.
  const ip = req.ip || (req.headers && req.headers["x-forwarded-for"]) || "unknown";
  const ipKey = String(ip).split(",")[0].trim().replace(/[^a-zA-Z0-9._:]/g, "_").slice(0, 50);
  const ok = await _rateLimitFirestore(`vgc_${ipKey}`, 30, 60 * 1000);
  if (!ok) {
    return res.status(429).json({ error: "rate_limited" });
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
      const errKey = gem.status === "redeemed" || gem.status === "claim_submitted" ? "already_redeemed" : "already_minted";
      return res.status(400).json({ error: errKey });
    }
    // SEC-A10: no devolvemos `tier` en el endpoint público — la web sólo necesita
    // saber si el código es válido. Quien quiera ver el tier debe ir a la app
    // autenticado y consultar el doc directamente.
    return res.json({ valid: true });
  } catch (e) {
    console.error("verifyGemCode:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// gmailAppPassword movido arriba (SEC-M2) — ahora es global desde el inicio del archivo.

// Envía un email de verificación personalizado al usuario recién registrado
exports.sendVerificationEmail = onCall({ secrets: [gmailAppPassword] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  // CRIT (Round 2 Agente #6): rate-limit estricto por uid. Sin esto, un user
  // recién creado puede bombear esta función → Gmail suspende el app password
  // → outage TOTAL de emails (verify + claim + reportProblem + mint alerts).
  // 5 emails/hora/uid: legitimate users casi nunca necesitan >2/hora.
  const allowed = await _rateLimitFirestore(`sve_${uid}`, 5, 60 * 60 * 1000);
  if (!allowed) throw new HttpsError("resource-exhausted", "rate_limited");

  const user = await getAuth().getUser(uid);
  const email = user.email;
  if (!email) throw new HttpsError("failed-precondition", "No email on account");
  if (user.emailVerified) return { ok: true, alreadyVerified: true };

  const actionCodeSettings = {
    url: "https://miningtheblocks-669f6.web.app/verify",
    handleCodeInApp: false,
  };
  let verificationLink = await getAuth().generateEmailVerificationLink(email, actionCodeSettings);
  // Redirect directly to our custom page instead of Firebase's default action handler
  verificationLink = verificationLink.replace(
      /^https:\/\/[^?]+\/__\/auth\/action/,
      "https://miningtheblocks-669f6.web.app/verify",
  );
  // BAJO-001 + MEDIO-001: validar shape post-replace y escapar para HTML.
  // Si Firebase cambia el formato del link, no enviamos un email con un URL
  // arbitrario. Y aunque verificationLink es server-generated, lo escapamos
  // antes de meterlo en el template HTML (defense-in-depth).
  if (!/^https:\/\/miningtheblocks-669f6\.web\.app\/verify\?/.test(verificationLink)) {
    // MED (Round 2 Agente #11 MED-11-25): NO loguear el prefix completo, el
    // query string del link contiene oobCode (1-hr valid reset token) + email.
    // Solo loguear scheme+host para diagnóstico.
    let safePrefix = "";
    try {
      const u = new URL(verificationLink);
      safePrefix = `${u.protocol}//${u.host}`;
    } catch (_) {
      // link mal-formed → safePrefix queda ""
    }
    console.error("sendVerificationEmail: unexpected link shape", { safePrefix });
    throw new HttpsError("internal", "link_generation_failed");
  }
  const safeLink = esc(verificationLink);

  const appPassword = gmailAppPassword.value();
  if (!appPassword) throw new HttpsError("internal", "Email service not configured");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: NOTIFY_EMAIL, pass: appPassword },
  });

  const displayName = user.displayName || email.split("@")[0];

  await transporter.sendMail({
    from: `"Mining The Blocks" <${NOTIFY_EMAIL}>`,
    to: email,
    subject: "⛏ Verificá tu cuenta — Mining The Blocks",
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
          <tr><td align="center">
            <table width="100%" style="max-width:480px;background:#141414;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#1a1a1a 0%,#222 100%);padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2a2a">
                  <div style="font-size:36px;margin-bottom:8px">⛏</div>
                  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:900;letter-spacing:-0.5px">Mining The Blocks</h1>
                  <p style="margin:6px 0 0;color:#666;font-size:13px">Verificación de cuenta</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:32px">
                  <p style="margin:0 0 8px;color:#999;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Hola, ${esc(displayName)}</p>
                  <h2 style="margin:0 0 16px;color:#ffffff;font-size:20px;font-weight:800">Ya casi estás adentro</h2>
                  <p style="margin:0 0 24px;color:#aaa;font-size:15px;line-height:1.6">
                    Hacé click en el botón para verificar tu email y acceder al juego. El link es válido por <strong style="color:#fff">24 horas</strong>.
                  </p>
                  <!-- CTA Button -->
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="padding:8px 0 24px">
                        <a href="${safeLink}"
                           style="display:inline-block;background:#ffffff;color:#000000;text-decoration:none;font-weight:900;font-size:15px;padding:16px 40px;border-radius:10px;letter-spacing:0.3px">
                          ✅ Verificar mi cuenta
                        </a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:0 0 8px;color:#555;font-size:12px;text-align:center">Si el botón no funciona, copiá este link:</p>
                  <p style="margin:0;background:#1e1e1e;border-radius:8px;padding:10px 12px;word-break:break-all;font-size:11px;color:#4a9eff;font-family:monospace">
                    ${safeLink}
                  </p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="padding:16px 32px 24px;border-top:1px solid #1e1e1e;text-align:center">
                  <p style="margin:0;color:#444;font-size:11px">Si no creaste esta cuenta, ignorá este email.</p>
                  <p style="margin:6px 0 0;color:#333;font-size:11px">© 2025 Mining The Blocks</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });

  return { ok: true };
});

// CRIT (Round 2 Agente #6): reemplazo del sendPasswordResetEmail directo del
// cliente. Antes el client llamaba al Firebase Auth SDK Web → email genérico
// de Firebase, SIN revoke de tokens (ventana 60min de account takeover
// post-reset) y SIN notify al user real de "se inició un reset".
//
// Esta función:
//   1. Anti-enumeration: rate-limit por email + retorno OK genérico siempre.
//      Un atacante NO puede inferir si una cuenta existe observando el reply.
//   2. revokeRefreshTokens(uid) ANTES de enviar el link → todas las sesiones
//      existentes quedan invalidadas en la próxima validación con
//      assertFreshToken (o al expirar el JWT TTL ~60min). Si el user real
//      fue quien pidió el reset, re-loguea con la nueva password → token
//      nuevo con auth_time > tokensValidAfterTime → válido. Si fue un
//      atacante con email comprometido, todas sus sesiones se cierran.
//   3. Email branded con texto explícito "tus sesiones fueron cerradas; si
//      no fuiste vos ignorá este email — tu password actual sigue OK".
exports.requestPasswordReset = onCall({ secrets: [gmailAppPassword] }, async (request) => {
  const email = ((request.data && request.data.email) || "").toString().trim().toLowerCase().slice(0, 200);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: true };
  }

  // Rate-limit por email (3/hora) — sin esto, un atacante podría enumerar
  // cuentas observando timing diferencial (existe vs no existe).
  const emailKey = email.replace(/[^a-zA-Z0-9._%+-]/g, "_").slice(0, 64);
  const okRate = await _rateLimitFirestore(`rpr_${emailKey}`, 3, 60 * 60 * 1000);
  if (!okRate) return { ok: true };

  let user;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch (_) {
    return { ok: true }; // user no existe → anti-enumeration
  }

  try {
    await getAuth().revokeRefreshTokens(user.uid);
  } catch (e) {
    console.error("requestPasswordReset revoke error:", e && e.message);
  }

  let link;
  try {
    link = await getAuth().generatePasswordResetLink(email);
  } catch (e) {
    console.error("requestPasswordReset generate link error:", e && e.message);
    return { ok: true };
  }

  const appPassword = gmailAppPassword.value();
  if (!appPassword) {
    console.error("requestPasswordReset: gmail password not configured");
    return { ok: true };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: NOTIFY_EMAIL, pass: appPassword },
  });

  const safeLink = esc(link);
  const displayName = esc(user.displayName || email.split("@")[0]);

  try {
    await transporter.sendMail({
      from: `"Mining The Blocks" <${NOTIFY_EMAIL}>`,
      to: email,
      subject: "🔐 Recuperación de contraseña — Mining The Blocks",
      html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px"><tr><td align="center">
    <table width="100%" style="max-width:480px;background:#141414;border-radius:16px;border:1px solid #2a2a2a">
      <tr><td style="background:linear-gradient(135deg,#1a1a1a 0%,#222 100%);padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2a2a">
        <div style="font-size:36px;margin-bottom:8px">🔐</div>
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:900;letter-spacing:-0.5px">Mining The Blocks</h1>
        <p style="margin:6px 0 0;color:#666;font-size:13px">Recuperación de contraseña</p>
      </td></tr>
      <tr><td style="padding:32px">
        <p style="margin:0 0 8px;color:#999;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Hola, ${displayName}</p>
        <h2 style="margin:0 0 16px;color:#fff;font-size:20px;font-weight:800">Pediste resetear tu contraseña</h2>
        <p style="margin:0 0 24px;color:#aaa;font-size:15px;line-height:1.6">
          Hacé click en el botón para elegir una nueva contraseña. El link es válido por <strong style="color:#fff">1 hora</strong>.
          Por seguridad, <strong style="color:#fff">todas tus sesiones existentes fueron cerradas</strong> y vas a tener que re-loguear en cada device.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 24px">
          <a href="${safeLink}" style="display:inline-block;background:#fff;color:#000;text-decoration:none;font-weight:900;font-size:15px;padding:16px 40px;border-radius:10px;letter-spacing:0.3px">
            🔑 Resetear contraseña
          </a>
        </td></tr></table>
        <p style="margin:0 0 8px;color:#888;font-size:12px;text-align:center">Si el botón no funciona, copiá este link:</p>
        <p style="margin:0;background:#1e1e1e;border-radius:8px;padding:10px 12px;word-break:break-all;font-size:11px;color:#4a9eff;font-family:monospace">${safeLink}</p>
      </td></tr>
      <tr><td style="padding:16px 32px 24px;border-top:1px solid #1e1e1e;text-align:center">
        <p style="margin:0;color:#aaa;font-size:11px;line-height:1.5"><strong style="color:#fff">¿No fuiste vos?</strong> Si NO solicitaste este reset, ignorá este email. Nadie pudo acceder a tu cuenta — todas las sesiones fueron cerradas como medida preventiva y tu contraseña actual sigue siendo válida. Vas a tener que re-loguear con tu password actual.</p>
        <p style="margin:6px 0 0;color:#666;font-size:11px">© 2026 Mining The Blocks</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
    });
  } catch (e) {
    console.error("requestPasswordReset mail error:", e && e.message);
  }

  return { ok: true };
});

// CRIT (Round 2 Agente #6 MED-15 + Agente #10 HIGH-10-38 + Agente #11):
// self-serve account deletion. Sin esta función, el user solo podía pedir
// borrado via email a soporte (privacy.html promete <30 días). Bloqueante
// para Play Store policy (mayo 2024 self-serve in-app obligatorio para apps
// con login) y GDPR Art. 17 ("right to erasure" con SLA escalable).
//
// Estrategia: soft-delete con anonimización.
//  - users/{uid} se preserva (no se borra) pero pierde TODO el PII:
//    email, profile, avatar, push tokens, wallet, referralCode/referredBy,
//    settings, language. Se mantiene `deletedAt` timestamp.
//  - subcoleccion notifications/ → batch delete (no retention).
//  - subcoleccion gems/ → SE PRESERVA (NFT records + 5y retention AML/KYC).
//  - usernames/{username} → released para que otros lo puedan reclamar.
//  - pendingCryptoPayments con status:waiting → cancelled.
//  - Auth user → deleteUser (revoca todas las sesiones automáticamente).
//  - Audit en adminActions.
//
// Las gems del user quedan accesibles solo via Admin SDK (Firestore rules
// requieren request.auth.uid == ownerUid). Para retention compliance.
exports.deleteMyAccount = onCall(async (request) => {
  requireRegistered(request);
  await assertFreshToken(request);
  const uid = request.auth.uid;

  // Anti-accident: max 1 intento por hora. Si falla parcial, requiere intervención manual.
  const okRate = await _rateLimitFirestore(`dma_${uid}`, 1, 60 * 60 * 1000);
  if (!okRate) throw new HttpsError("resource-exhausted", "rate_limited");

  const userRef = db.collection("users").doc(uid);

  // 1. Liberar el username (si tiene). Permite que el handle quede disponible.
  try {
    const usernamesSnap = await db.collection("usernames").where("uid", "==", uid).limit(1).get();
    if (!usernamesSnap.empty) {
      await usernamesSnap.docs[0].ref.delete();
    }
  } catch (e) {
    console.warn("deleteMyAccount: username release failed:", e && e.message);
  }

  // 2. Anonimizar el user doc (preserva refs en history/gems para retention 5y).
  try {
    await userRef.set({
      deletedAt: Date.now(),
      displayName: "[deleted]",
      email: FieldValue.delete(),
      profile: FieldValue.delete(),
      avatarUrl: FieldValue.delete(),
      photoURL: FieldValue.delete(),
      pushToken: FieldValue.delete(),
      pushTokenType: FieldValue.delete(),
      pushNotifications: FieldValue.delete(),
      walletAddress: FieldValue.delete(),
      walletChangedAt: FieldValue.delete(),
      referralCode: FieldValue.delete(),
      referredBy: FieldValue.delete(),
      settings: FieldValue.delete(),
      language: FieldValue.delete(),
      serverCredits: 0,
      picks: 0,
    }, { merge: true });
  } catch (e) {
    console.error("deleteMyAccount: anonymize failed:", e && e.message);
    throw new HttpsError("internal", "anonymize_failed");
  }

  // 3. Borrar notifications (no retention requirement).
  try {
    const notifSnap = await userRef.collection("notifications").limit(500).get();
    if (!notifSnap.empty) {
      const batch = db.batch();
      notifSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    console.warn("deleteMyAccount notifications cleanup:", e && e.message);
  }

  // 4. Cancelar pendingCryptoPayments waiting (slots de amount únicos se liberan).
  try {
    const pendingPaySnap = await db.collection("pendingCryptoPayments")
        .where("uid", "==", uid).where("status", "==", "waiting").get();
    if (!pendingPaySnap.empty) {
      const batch = db.batch();
      pendingPaySnap.docs.forEach((d) => batch.update(d.ref, {
        status: "cancelled", cancelledAt: Date.now(), reason: "account_deleted",
      }));
      await batch.commit();
    }
  } catch (e) {
    console.warn("deleteMyAccount pendingPay cleanup:", e && e.message);
  }

  // 5. Borrar el Auth user (revoca refresh tokens automáticamente +
  // las sesiones existentes quedan inválidas).
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    // Si el Auth user ya no existe (race), seguimos: el doc ya está anonimizado.
    if (e && e.code !== "auth/user-not-found") {
      console.error("deleteMyAccount: Auth delete failed:", e && e.message);
      throw new HttpsError("internal", "auth_delete_failed");
    }
  }

  // 6. Audit log.
  try {
    await db.collection("adminActions").add({
      action: "self_delete_account",
      uid,
      ts: Date.now(),
    });
  } catch (e) {
    console.warn("deleteMyAccount audit log failed:", e && e.message);
  }

  return { ok: true };
});

// CRIT (Round 2 Agente #6 MED + Agente #11 MED-11-46): self-serve "logout
// everywhere". Sin esto, ante sospecha de takeover, el user no tenía forma
// de cerrar sesiones en otros devices — dependía del admin con acceso a
// Firebase Console para llamar revokeRefreshTokens manualmente.
//
// Patrón mismo que Auth deleteUser pero sin tocar el doc / NFTs:
// revokeRefreshTokens + audit log. El user sigue logueado en este device
// hasta que su token actual expire (~5min para Firebase JWT) o el cliente
// llame signOut local. La UI hace ambos para cierre inmediato.
exports.revokeMySessions = onCall(async (request) => {
  requireRegistered(request);
  await assertFreshToken(request);
  const uid = request.auth.uid;

  const okRate = await _rateLimitFirestore(`rms_${uid}`, 5, 60 * 60 * 1000);
  if (!okRate) throw new HttpsError("resource-exhausted", "rate_limited");

  try {
    await getAuth().revokeRefreshTokens(uid);
  } catch (e) {
    console.error("revokeMySessions error:", e && e.message);
    throw new HttpsError("internal", "revoke_failed");
  }

  try {
    await db.collection("adminActions").add({
      action: "self_revoke_sessions",
      uid,
      ts: Date.now(),
    });
  } catch (_) {/* audit non-critical */}

  return { ok: true };
});

exports.submitGemClaim = onRequest({ secrets: [gmailAppPassword] }, async (req, res) => {
  setRestrictedCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // SEC-B3: requerir Firebase ID token + verificar ownership de la gema.
  // Sin este check, cualquiera con el código (que se filtra por screenshots,
  // share social, etc.) podía robar el premio via curl porque CORS no protege
  // contra server-to-server.
  let authUid = null;
  try {
    const authHeader = req.get("Authorization") || "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    // CRIT (Round 2 Agente #6): checkRevoked=true. submitGemClaim opera sobre
    // gemas hasta tier-1 ($100k nominal) — un token robado o sesión post-revoke
    // sigue válido hasta el TTL JWT (~60min) sin este flag.
    const decoded = await getAuth().verifyIdToken(m[1], true);
    // Defense-in-depth: gating de email_verified para provider=password
    // (alineado con requireRegistered del lado onCall).
    const provider = decoded.firebase && decoded.firebase.sign_in_provider;
    if (provider === "password" && decoded.email_verified === false) {
      return res.status(403).json({ error: "email_not_verified" });
    }
    authUid = decoded.uid;
  } catch (authErr) {
    // ALTO-001: NO loguear authErr.message — puede contener fragmentos del
    // token o detalles internos del SDK. Solo guardamos un código corto.
    console.error("submitGemClaim auth error: invalid_token (code=" + (authErr && authErr.code ? authErr.code : "unknown") + ")");
    return res.status(401).json({ error: "invalid_token" });
  }

  const body = req.body || {};
  const code = (body.code || "").toString().trim().toUpperCase().slice(0, 30);
  const email = (body.email || "").toString().trim().toLowerCase().slice(0, 200);
  const name = (body.name || "").toString().trim().slice(0, 100);
  const phone = (body.phone || "").toString().trim().slice(0, 30);

  // CRIT (Round 2 Agentes #1 HIGH-4 + #6 + #8): wallet del user doc, NO del
  // body. Mismo razonamiento que claimGemNFT: aceptar wallet del body bypasea
  // el cooldown de setUserWallet. El web claim form sigue mostrando el campo
  // pero el backend lo descarta — el web form debería leer userSnap.walletAddress
  // como read-only en una iteración futura (TODO web).
  let wallet = "";
  try {
    const userSnap = await db.collection("users").doc(authUid).get();
    wallet = userSnap.exists ? (userSnap.data().walletAddress || "").toString().trim() : "";
  } catch (e) {
    console.error("submitGemClaim user lookup error:", e && e.message);
    return res.status(500).json({ error: "server_error" });
  }

  if (!code || !email || !name || !phone) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "wallet_not_set" });
  }
  try {
    const snap = await db.collectionGroup("gems").where("code", "==", code).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ error: "not_found" });
    }
    const gemDoc = snap.docs[0];

    // SEC-B3: la gema debe vivir en /users/{uid}/gems/{gemId}. Validamos la
    // forma exacta para evitar matches espurios via collectionGroup (otras
    // subcolecciones llamadas "gems" en paths distintos).
    const pathParts = gemDoc.ref.path.split("/");
    if (pathParts.length !== 4 || pathParts[0] !== "users" || pathParts[2] !== "gems") {
      console.warn("submitGemClaim unexpected gem path:", { path: gemDoc.ref.path, code });
      return res.status(403).json({ error: "not_owner" });
    }
    const ownerUid = pathParts[1];
    if (ownerUid !== authUid) {
      console.warn("submitGemClaim ownership mismatch:", { authUid, ownerUid, code });
      return res.status(403).json({ error: "not_owner" });
    }

    let gemTier;
    // Atomic check-and-mark: prevents double-claim race condition
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(gemDoc.ref);
      if (!freshSnap.exists) throw new Error("not_found");
      const gem = freshSnap.data();
      if (gem.status !== "unclaimed") {
        const errKey = gem.status === "redeemed" || gem.status === "claim_submitted" ? "already_redeemed" : "already_minted";
        throw new Error(errKey);
      }
      gemTier = gem.gemTier || gem.tier || null;
      tx.set(gemDoc.ref, { status: "claim_submitted", claimSubmittedAt: Date.now() }, { merge: true });
    });

    const gemName = gemTier ? (GEM_NAMES_ES[gemTier - 1] || `Tier ${gemTier}`) : "Desconocida";
    const gemPrize = gemTier ? (`$${GEM_PRICES[gemTier - 1].toLocaleString()}`) : "-";

    await db.collection("gemClaims").add({
      code,
      name,
      email,
      phone,
      wallet,
      gemTier,
      gemRef: gemDoc.ref.path,
      submittedAt: Date.now(),
      status: "pending",
    });

    // Enviar notificación al admin
    try {
      const appPassword = gmailAppPassword.value();
      if (appPassword) {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: NOTIFY_EMAIL, pass: appPassword },
        });
        const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
        await transporter.sendMail({
          from: `"Mining The Blocks" <${NOTIFY_EMAIL}>`,
          to: NOTIFY_EMAIL,
          subject: `🎉 Nuevo canje de gema — ${esc(gemName)} (${esc(gemPrize)})`,
          html: `
            <h2>Nuevo canje de gema recibido</h2>
            <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Gema</td><td style="padding:6px 12px">${esc(gemName)} — Tier ${esc(String(gemTier))}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Premio</td><td style="padding:6px 12px;font-weight:bold;color:#000">${esc(gemPrize)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Código</td><td style="padding:6px 12px;font-family:monospace">${esc(code)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Nombre</td><td style="padding:6px 12px">${esc(name)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Email</td><td style="padding:6px 12px">${esc(email)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Teléfono</td><td style="padding:6px 12px">${esc(phone)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Billetera</td><td style="padding:6px 12px;font-family:monospace;font-size:12px">${esc(wallet)}</td></tr>
              <tr><td style="padding:6px 12px;font-weight:bold;color:#555">Fecha</td><td style="padding:6px 12px">${esc(fecha)}</td></tr>
            </table>
            <p style="margin-top:16px;font-size:12px;color:#888">Mining The Blocks · Firestore: gemClaims</p>
          `,
        });
      }
    } catch (mailErr) {
      console.error("submitGemClaim email error:", mailErr.message);
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("submitGemClaim:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// P1-8: log de errores client-side. Rate-limit 100/dia/uid + 10/min/uid via
// Firestore para evitar que un bug en bucle sature la colección.
// CRIT (Round 2 Agente #8 CRIT-5): markGemRedeemed — sin esta función, el
// admin pagaba en cash manualmente y marcaba la gema a mano via Firebase
// Console. Si el admin se olvida (o el user re-submitGemClaim antes de la
// marca), el admin podría pagar 2x — pérdida hasta $100k para gemas tier-1.
//
// Esta función:
//   1. requireAdminFresh (admin claim verificado fresh).
//   2. Busca la gema por code via collectionGroup (única por construcción).
//   3. TX atómica: chequea que NO esté ya 'redeemed' (idempotency) ni
//      'minted' (no se puede canjear NFT y cash). Setea status, registra
//      adminUid + paymentRef + adminNote + redeemedAt.
//   4. Si existe gemClaims/{xxx} asociado (web claim form), lo marca también.
//   5. Audit log en adminActions con código + ownerUid + paymentRef.
exports.markGemRedeemed = onCall(async (request) => {
  await requireAdminFresh(request);
  const adminUid = request.auth.uid;

  const code = String((request.data && request.data.code) || "").trim().toUpperCase().slice(0, 50);
  const paymentRef = String((request.data && request.data.paymentRef) || "").trim().slice(0, 200);
  const adminNote = String((request.data && request.data.adminNote) || "").trim().slice(0, 500);
  if (!code) throw new HttpsError("invalid-argument", "code_required");
  if (!paymentRef) throw new HttpsError("invalid-argument", "paymentRef_required");

  // Buscar la gema por code (collectionGroup; path users/{uid}/gems/{gemId}).
  const gemQuery = await db.collectionGroup("gems").where("code", "==", code).limit(2).get();
  if (gemQuery.empty) throw new HttpsError("not-found", "gem_not_found");
  if (gemQuery.size > 1) {
    // Defense-in-depth — gemCodes deberían ser únicos (randomBytes).
    console.error("markGemRedeemed: multiple gems with same code", { code, count: gemQuery.size });
    throw new HttpsError("failed-precondition", "duplicate_code");
  }
  const gemDoc = gemQuery.docs[0];
  const pathParts = gemDoc.ref.path.split("/");
  if (pathParts.length !== 4 || pathParts[0] !== "users" || pathParts[2] !== "gems") {
    throw new HttpsError("failed-precondition", "invalid_gem_path");
  }
  const ownerUid = pathParts[1];
  const gemId = pathParts[3];

  // Idempotency: TX que verifica status antes de marcar.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(gemDoc.ref);
    if (!fresh.exists) throw new HttpsError("not-found", "gem_gone");
    const data = fresh.data();
    if (data.status === "redeemed") {
      throw new HttpsError("already-exists", "already_redeemed");
    }
    if (data.status === "minted") {
      // Gema ya minteada como NFT — no se canjea por cash adicional.
      throw new HttpsError("failed-precondition", "already_minted");
    }
    tx.set(gemDoc.ref, {
      status: "redeemed",
      redeemedAt: Date.now(),
      redeemedBy: adminUid,
      paymentRef,
      adminNote: adminNote || null,
    }, { merge: true });
  });

  // Buscar y actualizar gemClaim asociado (si el user usó la web claim form).
  try {
    const claimQuery = await db.collection("gemClaims").where("code", "==", code).limit(1).get();
    if (!claimQuery.empty) {
      await claimQuery.docs[0].ref.set({
        status: "redeemed",
        processedAt: Date.now(),
        processedBy: adminUid,
        paymentRef,
      }, { merge: true });
    }
  } catch (e) {
    console.warn("markGemRedeemed gemClaim update warning:", e && e.message);
  }

  // Audit log.
  try {
    await db.collection("adminActions").add({
      action: "markGemRedeemed",
      adminUid,
      ts: Date.now(),
      gemCode: code,
      gemId,
      ownerUid,
      paymentRef: paymentRef.slice(0, 100),
    });
  } catch (e) {
    console.warn("markGemRedeemed audit log warning:", e && e.message);
  }

  return { ok: true, ownerUid, gemId };
});

exports.logClientError = onCall(async (request) => {
  const uid = (request.auth && request.auth.uid) || null;
  // Permitimos sin auth (bootstrap errors antes del login), pero limitamos por IP.
  const bucketKey = uid ? `lce_u_${uid}` : `lce_a_${request.rawRequest && request.rawRequest.ip || "unknown"}`;
  const okMin = await _rateLimitFirestore(`${bucketKey}_min`, 10, 60 * 1000);
  if (!okMin) {
    return { ok: false, reason: "rate_limited_min" };
  }
  const okDay = await _rateLimitFirestore(`${bucketKey}_day`, 100, 24 * 60 * 60 * 1000);
  if (!okDay) {
    return { ok: false, reason: "rate_limited_day" };
  }

  const data = request.data || {};
  const scope = String(data.scope || "").slice(0, 80);
  const msg = String(data.msg || "").slice(0, 500);
  const ctx = String(data.ctx || "").slice(0, 1000);
  if (!scope || !msg) {
    return { ok: false, reason: "missing_fields" };
  }

  try {
    await db.collection("errorLog").add({
      scope, msg, ctx,
      uid: uid || null,
      ts: Date.now(),
      // TTL: borrar después de 30 días via TTL policy en Firestore Console.
      expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } catch (e) {
    console.error("logClientError write failed:", e.message);
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true };
});

exports.reportProblem = onCall({ secrets: [gmailAppPassword] }, async (request) => {
  // SEC-004: requiere auth + rate-limit (1 reporte cada 5 min por uid) para
  // prevenir spam que pueda saturar la Gmail account (causaría suspensión del
  // app-password y caída del flow de verificación + NFT notifications).
  const uid = (request.auth && request.auth.uid) || null;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");

  const data = request.data || {};
  const description = (data.description || "").toString().trim().slice(0, 5000);
  if (!description || description.length < 5) {
    throw new HttpsError("invalid-argument", "Description too short");
  }

  // Rate-limit: 1 reporte cada 5 minutos por usuario. BAJO-H27: usar transacción
  // para que el check+set sea atómico (antes dos calls simultáneos podían pasar
  // ambos el check y enviar dos emails).
  const RATE_LIMIT_MS = 5 * 60 * 1000;
  const rateRef = db.collection("userMeta").doc(uid);
  await db.runTransaction(async (tx) => {
    const rateSnap = await tx.get(rateRef);
    const lastReportAt = (rateSnap.exists ? (rateSnap.data().lastReportAt || 0) : 0);
    if (Date.now() - lastReportAt < RATE_LIMIT_MS) {
      throw new HttpsError("resource-exhausted", "rate_limited");
    }
    tx.set(rateRef, { lastReportAt: Date.now() }, { merge: true });
  });

  const userType = (data.userType || "unknown").toString().slice(0, 20);
  const reportType = (data.reportType || "bug").toString().slice(0, 20);
  // SEC-M12: validar formato de email para evitar inyección via "a@b.com,x@evil.com"
  // que se cuele al replyTo y agregue destinatarios.
  const rawEmail = (data.email || "").toString().trim().slice(0, 200);
  const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
  const reporterEmail = (rawEmail && EMAIL_RE.test(rawEmail)) ? rawEmail : null;

  const appPassword = gmailAppPassword.value();
  if (!appPassword) throw new HttpsError("internal", "Email service not configured");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: NOTIFY_EMAIL, pass: appPassword },
  });

  await transporter.sendMail({
    from: `"MTB Reports" <${NOTIFY_EMAIL}>`,
    to: NOTIFY_EMAIL,
    replyTo: (reporterEmail ? reporterEmail.replace(/[\r\n]/g, "") : null) || NOTIFY_EMAIL,
    subject: `[MTB] ${reportType.replace(/[\r\n]/g, "").toUpperCase()} · ${userType.replace(/[\r\n]/g, "")} · ${uid ? uid.slice(0, 8) : "anon"}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="background:#0a0a0a;font-family:Arial,sans-serif;padding:32px 20px">
        <table style="max-width:520px;width:100%;background:#141414;border-radius:12px;border:1px solid #2a2a2a;overflow:hidden">
          <tr>
            <td style="background:#1a1a1a;padding:20px 24px;border-bottom:1px solid #2a2a2a">
              <p style="margin:0;color:#666;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Mining The Blocks</p>
              <h2 style="margin:6px 0 0;color:#fff;font-size:18px;font-weight:900">⚠️ Reporte de problema</h2>
            </td>
          </tr>
          <tr>
            <td style="padding:24px">
              <table style="width:100%;border-collapse:collapse">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#888;font-size:13px;width:40%">Tipo de usuario</td>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#fff;font-size:13px;font-weight:700">${esc(userType)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#888;font-size:13px">Tipo de reporte</td>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#f87171;font-size:13px;font-weight:700">${esc(reportType.toUpperCase())}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#888;font-size:13px">UID</td>
                  <td style="padding:8px 0;border-bottom:1px solid #222;color:#4a9eff;font-size:12px;font-family:monospace">${esc(uid || "—")}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#888;font-size:13px">Email del usuario</td>
                  <td style="padding:8px 0;color:#22c55e;font-size:13px">${esc(reporterEmail || "—")}</td>
                </tr>
              </table>
              <div style="margin-top:20px">
                <p style="margin:0 0 8px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Descripción</p>
                <div style="background:#1a1a1a;border-radius:8px;padding:14px 16px;border:1px solid #2a2a2a">
                  <p style="margin:0;color:#ddd;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(description)}</p>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 24px;border-top:1px solid #1e1e1e;text-align:center">
              <p style="margin:0;color:#333;font-size:11px">Mining The Blocks · Reporte automático</p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  });

  return { ok: true };
});
