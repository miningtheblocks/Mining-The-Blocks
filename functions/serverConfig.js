/* eslint-disable max-len */
// Cambio 3 (Fase 4): servers a medida (jugadores + precio configurables).
// TODO ESTE MÓDULO SE ENTREGA COMPLETO PERO INACTIVO — ver createServerCustom
// en index.js, gateado por config/app.paramServerCreationEnabled (default
// false). No se expone en el formulario de creación estándar hasta que se
// active el flag manualmente y se pruebe en LAN (pedido explícito del
// usuario). Ver decisiones D2/D7/D8 del plan aprobado.
//
// ─── El modelo matemático (verificado contra los datos reales de hoy) ─────
//
// Cubo de referencia: L_ref=100, N_ref=100.000, P_ref=$15,
// PrizePool_ref=$650.000, Ratio R = 650.000/1.500.000 = 43,33%.
//
// El usuario elige SOLO 2 inputs: N (jugadores) y P (precio). Todo lo demás
// se deriva en una sola pasada:
//
//   Recaudación = N × P
//   Premio total = R × Recaudación                    (R fijo, IDENTIDAD ALGEBRAICA — el
//                                                        ratio no puede romperse pase lo que pase)
//   S (factor de escala) = Recaudación / 1.500.000
//   cantidad_tier[i] = round(S × cantidad_referencia[i])   (precios NO cambian)
//   umbral_tier[i]   = ceil(1,25 × N × CumPool_ref(tier) / 100.000)  (el precio P se cancela algebraicamente)
//   CubosObjetivo    = 82,422 × N
//   L                = capas que dan ese total de cubos (búsqueda local sobre la fórmula cúbica)
//   Kboundary[i]     = round(fracción_i × L)  (mismas 6 fracciones que helpers.js DEFAULT_TIER_TABLE)
//
// D7/D8: el usuario puede además redistribuir manualmente el Premio Total
// entre los 9 tiers (en vez de la escala automática), siempre que la suma
// cierre exacto y ningún tier con precio > Premio Total tenga cantidad > 0.

const {GEM_PRICES} = require("./constants");
const {zoneSizeFor, expectedTotalPicks, E_REWARD_GIVEN_WIN} = require("./helpers");

// ─── Constantes de referencia ───────────────────────────────────────────────

const N_REF = 100000;
const P_REF = 15;
const L_REF = 100;
const REVENUE_REF = N_REF * P_REF; // 1.500.000
const QTY_REF = [1, 1, 5, 50, 100, 500, 1000, 4000, 10000]; // índice tier-1
const PRIZE_POOL_REF = QTY_REF.reduce((sum, q, i) => sum + q * GEM_PRICES[i], 0); // 650.000
const RATIO = PRIZE_POOL_REF / REVENUE_REF; // 0,4333...

// Cubos totales del cubo de referencia (L=100, K=0..100 inclusive) / N_REF.
function totalCubesForL(L) {
  // cumSum(L+1) = 8(L+1)^3 - 2(L+1) -- misma fórmula que helpers.js#cumSum,
  // reescrita acá para no depender de un L+1 intermedio en cada llamada.
  const n = L + 1;
  return 8 * Math.pow(n, 3) - 2 * n;
}
const CUBES_PER_PLAYER_REF = totalCubesForL(L_REF) / N_REF; // 82,42206

// Fracciones de K descubiertas en Fase 0 (idénticas a las de DEFAULT_TIER_TABLE
// y DEFAULT_REWARD_BRACKETS en helpers.js — única fuente de verdad conceptual,
// repetida acá como literales porque helpers.js no las expone por separado).
const TIER_BOUNDARY_FRACTIONS = {t1: 0.06, t2: 0.16, t3: 0.26, t45: 0.46, t67: 0.81, t89: 0.97};
const REWARD_BOUNDARY_FRACTIONS = [
  {frac: 0.90, rate: 0.50},
  {frac: 0.70, rate: 0.40},
  {frac: 0.50, rate: 0.30},
  {frac: 0.20, rate: 0.20},
];

// ─── Picos de regalo (calibrados por cantidad de cubos, no tasas planas) ───
// Decisión del usuario (sesión 2026-07-02): el cubo de referencia (L_REF=100,
// el que ya está en producción) reparte 200.000 picos en la zona externa
// (las primeras 3 capas exactas, K=98..100 a L=100 → 3% de L) + 200.000 en
// el resto de las capas (K=0..97) = 400.000 totales — misma proporción
// 50/50 externa/interior que el Free (D4), pensada igual: picos esporádicos
// en el interior, incentivo de tráfico fuerte en el exterior. Cualquier
// server a medida escala estos 400.000 PROPORCIONAL a su cantidad real de
// cubos respecto al de referencia (no a N ni a la recaudación), manteniendo
// siempre el mismo 3% de ancho de zona externa y el mismo split 50/50.
//
// ANTES de esta decisión, buildRewardBrackets reusaba directamente las tasas
// planas de DEFAULT_REWARD_BRACKETS (0,50/0,40/0,30/0,20/0,15 — código
// preexistente de la economía estándar, sin tocar) reposicionadas por
// fracción de L. Eso daba ~6,48M picos esperados para L=100 -- 16× más que
// el modelo de referencia que el usuario confirmó como correcto. El estándar
// que ya está en producción NO se toca (sigue usando DEFAULT_REWARD_BRACKETS
// tal cual, vía el fallback de getRewardForCube en helpers.js); este cambio
// es solo para servers a medida NUEVOS (deriveServerConfig).
const PICKS_OUTER_FRACTION = 0.03; // 3% de L = zona externa (3 capas exactas a L_REF=100)
const PICKS_REF_TOTAL = 400000; // 200.000 externa + 200.000 interior, igual que el Free
const PICKS_REF_CUBES = totalCubesForL(L_REF);

// CumPool_ref(tier) = costo acumulado ($) de todos los tiers ya desbloqueados
// hasta ese tier INCLUSIVE, en el orden real de desbloqueo (tier 9 primero,
// tier 1 último — verificado exacto contra GEM_UNLOCK_THRESHOLDS existentes).
const CUM_POOL_REF = (() => {
  const order = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  let cum = 0;
  const out = {};
  for (const tier of order) {
    cum += GEM_PRICES[tier - 1] * QTY_REF[tier - 1];
    out[tier] = cum;
  }
  return out;
})();

// ─── Rangos de parámetros ───────────────────────────────────────────────────

const P_MIN = 0.10;
const P_MAX = 100;
const N_MIN = 100;
const N_MAX = 100000;
const L_MIN = 30;
const L_MAX = 150;
// Cap de negocio recomendado (no confirmado explícitamente por el usuario en
// la sesión de diseño) — sin esto, N=100.000 × P=$100 permite un pool de
// hasta $4,33M (6,7× el máximo actual de $650k). Revisar antes de activar
// el flag en producción.
const REVENUE_CAP = REVENUE_REF; // $1.500.000

// ─── Validación de rangos (Etapa A, antes de derivar nada) ─────────────────

function validateServerConfig(N, P) {
  const errors = [];
  if (!Number.isFinite(N) || N < N_MIN || N > N_MAX) {
    errors.push(`players_out_of_range:${N_MIN}-${N_MAX}`);
  }
  if (!Number.isFinite(P) || P < P_MIN || P > P_MAX) {
    errors.push(`price_out_of_range:${P_MIN}-${P_MAX}`);
  }
  if (Number.isFinite(N) && Number.isFinite(P) && N * P > REVENUE_CAP) {
    errors.push(`revenue_cap_exceeded:${REVENUE_CAP}`);
  }
  return errors;
}

// ─── Derivación de capas (L) a partir de N ──────────────────────────────────

function deriveLayerCount(N) {
  const targetCubes = CUBES_PER_PLAYER_REF * N;
  // targetCubes = 8*(L+1)^3 - 2*(L+1) -- aproximar con raíz cúbica y refinar
  // por búsqueda local (la función es estrictamente creciente en L).
  const approxLp1 = Math.max(1, Math.round(Math.cbrt(targetCubes / 8)));
  let best = approxLp1;
  let bestDiff = Infinity;
  for (let cand = Math.max(1, approxLp1 - 3); cand <= approxLp1 + 3; cand++) {
    const diff = Math.abs(totalCubesForL(cand - 1) - targetCubes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  const L = best - 1;
  // Clamp defensivo: para N muy chico/grande la fórmula puede caer fuera del
  // rango jugable (30-150) -- preferimos un config siempre válido antes que
  // preservar la proporción exacta de cubos/jugador en los extremos.
  return Math.min(L_MAX, Math.max(L_MIN, L));
}

function computeKBoundaries(L) {
  return {
    t1: Math.round(TIER_BOUNDARY_FRACTIONS.t1 * L),
    t2: Math.round(TIER_BOUNDARY_FRACTIONS.t2 * L),
    t3: Math.round(TIER_BOUNDARY_FRACTIONS.t3 * L),
    t45: Math.round(TIER_BOUNDARY_FRACTIONS.t45 * L),
    t67: Math.round(TIER_BOUNDARY_FRACTIONS.t67 * L),
    t89: Math.round(TIER_BOUNDARY_FRACTIONS.t89 * L),
  };
}

function buildRewardBrackets(L) {
  const outerWidth = Math.max(1, Math.round(PICKS_OUTER_FRACTION * L));
  const outerMinK = Math.max(0, L - outerWidth + 1);
  const innerMaxK = outerMinK - 1;

  // Picos objetivo para ESTE L, proporcional a su cantidad real de cubos
  // respecto al modelo de referencia (ver comentario arriba de las constantes).
  const picksTarget = PICKS_REF_TOTAL * (totalCubesForL(L) / PICKS_REF_CUBES);
  const outerTarget = picksTarget / 2;
  const innerTarget = picksTarget / 2;

  // Zona externa: un único winRate uniforme tal que el volumen esperado
  // (cubos_en_zona × winRate × E[reward|gana]) sume outerTarget exacto.
  const outerZoneSize = zoneSizeFor(outerMinK, L);
  const outerWinRate = outerTarget / (E_REWARD_GIVEN_WIN * outerZoneSize);

  // Zona interior: misma forma relativa (REWARD_BOUNDARY_FRACTIONS + piso
  // 0,15) que la economía estándar, pero recortada a [0, innerMaxK] -- para
  // L chico algunos boundaries pueden caer dentro de la zona externa y se
  // descartan (mismo patrón que el Free con su franja K≥135, ver
  // freeServerConfig.js). Un único factor de ajuste (innerAdjust) hace que
  // la suma dé innerTarget exacto.
  const innerBoundaries = [];
  for (const b of REWARD_BOUNDARY_FRACTIONS) {
    const minK = Math.round(b.frac * L);
    if (minK > innerMaxK) continue;
    const prev = innerBoundaries[innerBoundaries.length - 1];
    if (prev && minK >= prev.minK) continue; // evita colapso/duplicados si L es muy chico
    innerBoundaries.push({minK, rate: b.rate});
  }
  if (!innerBoundaries.length || innerBoundaries[innerBoundaries.length - 1].minK > 0) {
    innerBoundaries.push({minK: 0, rate: 0.15});
  }

  let innerShapeSum = 0;
  for (let i = 0; i < innerBoundaries.length; i++) {
    const minK = innerBoundaries[i].minK;
    const maxK = i === 0 ? innerMaxK : innerBoundaries[i - 1].minK - 1;
    if (maxK < minK) continue;
    innerShapeSum += zoneSizeFor(minK, maxK) * innerBoundaries[i].rate;
  }
  const innerAdjust = innerShapeSum > 0 ? innerTarget / (innerShapeSum * E_REWARD_GIVEN_WIN) : 0;

  const brackets = [{minK: outerMinK, rate: outerWinRate}];
  for (const b of innerBoundaries) {
    brackets.push({minK: b.minK, rate: b.rate * innerAdjust});
  }
  return brackets;
}

// ─── Escalado automático de cantidades y umbrales ──────────────────────────

// Reparto tipo "largest remainder" para que Σ(price×qty) quede lo más cerca
// posible del target exacto, con un residual acotado y chico.
//
// Redondear cada tier de forma independiente (Math.round por separado) puede
// desviar MUCHO el total: los tiers 1/2 (cantidad de referencia = 1 unidad)
// redondean 0,5→1 completo, un salto de $100.000/$50.000 de una sola vez.
// En vez de eso: 1) floor en los 9 tiers (nunca se pasa del target), 2)
// repartir el resto del presupuesto como unidades enteras empezando por el
// tier MÁS BARATO ($15) y subiendo -- así el residual final que no se puede
// asignar por granularidad de $ queda acotado por el precio del tier más
// barato usado (como mucho $14, sobre un pool de miles/millones).
function autoScaleQuantities(S) {
  const target = Math.round(S * PRIZE_POOL_REF);
  const qty = QTY_REF.map((q) => Math.floor(S * q));
  let spent = qty.reduce((s, q, i) => s + q * GEM_PRICES[i], 0);
  let remaining = target - spent;

  // Índices de GEM_PRICES ordenados de más barato a más caro (GEM_PRICES ya
  // viene ordenado descendente por precio: tier1..tier9 = caro..barato).
  const cheapestFirst = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  for (const i of cheapestFirst) {
    if (remaining <= 0) break;
    const price = GEM_PRICES[i];
    const addUnits = Math.floor(remaining / price);
    if (addUnits > 0) {
      qty[i] += addUnits;
      remaining -= addUnits * price;
      spent += addUnits * price;
    }
  }
  return qty;
}

function deriveUnlockThresholds(N) {
  const unlockAt = {};
  for (let tier = 1; tier <= 9; tier++) {
    // Derivado de: umbral_nuevo = ceil(1,25 × S × CumPool_ref(tier) / P), con
    // S = N×P/REVENUE_REF -- el precio P se cancela algebraicamente y queda
    // en función de N y REVENUE_REF únicamente (NUNCA dividir por N_REF acá,
    // sería un error de 15× -- P_REF/1 en vez de N_REF×P_REF).
    unlockAt[tier] = Math.ceil((1.25 * N * CUM_POOL_REF[tier]) / REVENUE_REF);
  }
  return unlockAt;
}

function buildTierTable(L, qty, unlockAt) {
  const kb = computeKBoundaries(L);
  const defs = [
    {tier: 1, minK: 0, maxK: kb.t1},
    {tier: 2, minK: kb.t1 + 1, maxK: kb.t2},
    {tier: 3, minK: kb.t2 + 1, maxK: kb.t3},
    {tier: 4, minK: 0, maxK: kb.t45},
    {tier: 5, minK: 0, maxK: kb.t45},
    {tier: 6, minK: 0, maxK: kb.t67},
    {tier: 7, minK: 0, maxK: kb.t67},
    {tier: 8, minK: 0, maxK: kb.t89},
    {tier: 9, minK: 0, maxK: kb.t89},
  ];
  return defs.map((d) => {
    const maxK = Math.min(d.maxK, L);
    const minK = Math.min(d.minK, maxK);
    return {
      tier: d.tier,
      price: GEM_PRICES[d.tier - 1],
      count: qty[d.tier - 1],
      minK,
      maxK,
      unlockAt: unlockAt[d.tier],
      zoneSize: zoneSizeFor(minK, maxK),
    };
  });
}

// ─── Derivación completa (Etapa A) ──────────────────────────────────────────

function deriveServerConfig(N, P) {
  const revenue = N * P;
  const S = revenue / REVENUE_REF;
  const L = deriveLayerCount(N);
  const qty = autoScaleQuantities(S);
  const unlockAt = deriveUnlockThresholds(N);
  const tierTable = buildTierTable(L, qty, unlockAt);
  const totalPrizePoolUSD = tierTable.reduce((sum, t) => sum + t.price * t.count, 0);
  const rewardBrackets = buildRewardBrackets(L);
  // "Picos de regalo" mostrados en el preview de creación -- valor ESPERADO
  // (el reparto sigue siendo probabilístico y sin tope real, ver
  // getRewardForCube en helpers.js), no un pozo fijo como el Free (D4).
  const expectedPicks = Math.round(expectedTotalPicks(L, rewardBrackets));

  return {
    isFreeServer: false,
    layerCount: L,
    maxMembers: N,
    creditPriceUSD: P,
    dailyAdSlots: 2,
    dailyFreeClaim: true,
    scaleFactor: S,
    totalPrizePoolUSD,
    expectedPicks,
    quantityPerTier: qty,
    tierTable,
    rewardBrackets,
  };
}

// Validaciones que solo se pueden chequear DESPUÉS de derivar L/tierTable
// (bug de auditoría: zoneSize < count reparte silenciosamente menos premios
// de los prometidos -- ver hasPrize en helpers.js).
function validateDerivedConfig(config) {
  const errors = [];
  const kb = computeKBoundaries(config.layerCount);
  const seq = [kb.t1, kb.t2, kb.t3, kb.t45, kb.t67, kb.t89];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] <= seq[i - 1]) errors.push("k_boundaries_collapsed");
  }
  for (const t of config.tierTable) {
    if (t.count > 0 && t.zoneSize < t.count) errors.push(`zone_too_small_tier_${t.tier}`);
  }
  // Caso límite real: con N×P muy chico, el pool objetivo (43,3% de la
  // recaudación) queda tan cerca de la granularidad del tier más barato
  // ($15) que el residual de redondeo (acotado en <$15 en términos
  // absolutos, ver autoScaleQuantities) representa una desviación GRANDE en
  // términos relativos del ratio prometido. Sin este check, un server chico
  // podría terminar con, por ej., 32% de premio en vez de 43,3% -- el ratio
  // ya no es "prácticamente exacto", rompe la garantía central del sistema.
  const revenue = config.maxMembers * config.creditPriceUSD;
  const idealPool = RATIO * revenue;
  const relativeDeviation = idealPool > 0 ? Math.abs(config.totalPrizePoolUSD - idealPool) / idealPool : 1;
  if (relativeDeviation > 0.05) {
    errors.push(`ratio_deviation_too_large:${(relativeDeviation * 100).toFixed(1)}pct`);
  }
  return errors;
}

// ─── Distribución manual de premios por tier (D7/D8, Etapa B) ──────────────
//
// D8: un tier se excluye (no puede tener cantidad > 0) si su precio unitario
// es ESTRICTAMENTE MAYOR al Premio Total. Si el precio IGUALA el Premio
// Total, queda permitido (un único premio que usa el 100% del pool).
function applyManualDistribution(baseConfig, tierQuantitiesRaw) {
  const target = Math.round(baseConfig.totalPrizePoolUSD);
  const tierQuantities = (tierQuantitiesRaw || []).map((q) => Math.max(0, Math.floor(Number(q) || 0)));
  if (tierQuantities.length !== 9) {
    return {ok: false, errors: ["tier_quantities_must_have_9_entries"]};
  }

  const errors = [];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const price = GEM_PRICES[i];
    const qty = tierQuantities[i];
    if (price > target && qty > 0) errors.push(`tier_${i + 1}_exceeds_pool`);
    sum += price * qty;
  }
  if (sum !== target) errors.push(`distribution_sum_mismatch:${sum}_vs_${target}`);
  if (errors.length) return {ok: false, errors};

  const tierTable = baseConfig.tierTable.map((t, i) => Object.assign({}, t, {count: tierQuantities[i]}));
  for (const t of tierTable) {
    if (t.count > 0 && t.zoneSize < t.count) errors.push(`zone_too_small_tier_${t.tier}`);
  }
  if (errors.length) return {ok: false, errors};

  return {
    ok: true,
    config: Object.assign({}, baseConfig, {tierTable, quantityPerTier: tierQuantities}),
  };
}

module.exports = {
  N_MIN,
  N_MAX,
  P_MIN,
  P_MAX,
  L_MIN,
  L_MAX,
  REVENUE_CAP,
  RATIO,
  PRIZE_POOL_REF,
  REVENUE_REF,
  CUBES_PER_PLAYER_REF,
  CUM_POOL_REF,
  PICKS_OUTER_FRACTION,
  PICKS_REF_TOTAL,
  PICKS_REF_CUBES,
  totalCubesForL,
  validateServerConfig,
  validateDerivedConfig,
  deriveServerConfig,
  deriveLayerCount,
  computeKBoundaries,
  buildRewardBrackets,
  autoScaleQuantities,
  deriveUnlockThresholds,
  buildTierTable,
  applyManualDistribution,
};
