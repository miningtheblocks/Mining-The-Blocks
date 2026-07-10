/* eslint-disable max-len */
// Cambio 2 (Fase 3): configuración del server "Free" fijo — 150 capas,
// $35.000 en premios, entrada gratis, picos solo por anuncio.
//
// Decisiones de diseño (ver plan aprobado, decisiones D1/D4/D5):
// - Los 4 premios en dinero reusan los tiers estándar 3/4/7/9, que ya
//   corresponden exactamente a $10.000/$1.000/$50/$15 (GEM_PRICES). Así todo
//   lo downstream (persistGem, generateGemCode, canje, NFT metadata,
//   src/utils/gems.js) funciona sin ningún cambio — el "tier" sigue siendo
//   el mismo identificador de siempre, solo con rangos de capa y cantidades
//   propias de este server.
// - Los picos (D4) son 400.000 fijos: 200.000 en las 25 capas externas
//   (150-126, zona "solo picos", sin premios en dinero) + 200.000 en las 125
//   capas interiores (125-0, junto con los premios en dinero). Ambos totales
//   se calibran matemáticamente acá (no son números mágicos hardcodeados) a
//   partir de la geometría real del cubo (zoneSizeFor/cumSum, las mismas
//   funciones que usa el motor genérico de Fase 0).
const {GEM_PRICES} = require("./constants");
const {zoneSizeFor} = require("./helpers");

const FREE_LAYER_COUNT = 150;
const FREE_OUTER_MIN_K = 126; // capas 150..126 = 25 capas externas "solo picos"
const FREE_INNER_MAX_K = FREE_OUTER_MIN_K - 1; // 125
const FREE_PICKS_TARGET_OUTER = 200000;
const FREE_PICKS_TARGET_INNER = 200000;

// Valor esperado de picos otorgados CONDICIONAL a ganar (misma distribución
// 40/30/20/5/5% de 1/2/3/4/5 picos que usa getRewardForCube) = 2.05.
const E_REWARD_GIVEN_WIN = 0.40 * 1 + 0.30 * 2 + 0.20 * 3 + 0.05 * 4 + 0.05 * 5;

// ─── Tabla de premios en dinero (D1, D5) ───────────────────────────────────
// D5: de los 5 premios de $1.000 (tier 4), 4 se reparten al azar en K 40-70
// y el 5to queda RESERVADO para el cubo que cierra el episodio (K=0) — eso
// se maneja como caso especial en mineCube, no en esta tabla (por eso acá
// tier 4 tiene count=4, no 5).
// El Free no cobra entrada, así que no hay recaudación que la fórmula
// estándar (1,25×costo acumulado / recaudación_ref, ver serverConfig.js)
// pueda proteger -- acá el "costo cubierto" se mide en claims de picos de la
// cadena (serverChains/{chainId}.totalAdViews, incrementado en
// claimAdSlotPick) en vez de plata. AD_VIEW_VALUE_USD es una estimación
// conservadora de eCPM real de banner pasivo (Social Bar, piso ~$6 CPM,
// 2026-07-03 -- bajado de $0,01/$10CPM porque el modelo viejo, condicionado
// a "ver" el anuncio, viola los términos de las redes -- ver postmortem);
// unlockAt queda en UNIDADES DE CLAIMS (no jugadores), mismo campo
// `unlockAt` que ya usa getGemForCubeGeneric/isLayerUnlocked --
// mineCube/getServers pasan totalAdViews en vez de memberCount cuando
// isFreeServer (ver index.js).
const AD_VIEW_VALUE_USD = 0.006;

const FREE_PRIZE_TABLE_BASE = [
  {tier: 3, price: GEM_PRICES[2], count: 1, minK: 2, maxK: 30}, // $10.000 x1
  {tier: 4, price: GEM_PRICES[3], count: 4, minK: 40, maxK: 70}, // $1.000 x4 (+1 fijo en K=0)
  {tier: 7, price: GEM_PRICES[6], count: 100, minK: 70, maxK: 100}, // $50 x100
  {tier: 9, price: GEM_PRICES[8], count: 1000, minK: 2, maxK: 125}, // $15 x1000
];

// Costo acumulado en orden de liberación tier más barato -> más caro (mismo
// orden que CUM_POOL_REF en serverConfig.js: 9,8,7,6,5,4,3,2,1). Tiers que
// el Free no usa (1,2,5,6,8) cuentan como $0 y no alteran el acumulado.
const FREE_CUM_POOL = (() => {
  const priceByTier = {};
  FREE_PRIZE_TABLE_BASE.forEach((t) => {
    priceByTier[t.tier] = t.price * t.count;
  });
  const order = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  let cum = 0;
  const out = {};
  for (const tier of order) {
    cum += priceByTier[tier] || 0;
    out[tier] = cum;
  }
  return out;
})();

const FREE_PRIZE_TABLE = FREE_PRIZE_TABLE_BASE.map((t) => Object.assign({}, t, {
  unlockAt: Math.ceil((1.25 * FREE_CUM_POOL[t.tier]) / AD_VIEW_VALUE_USD),
  zoneSize: zoneSizeFor(t.minK, t.maxK),
}));

// Total real: 1×10.000 + 5×1.000 (4 random + 1 fijo en K=0) + 100×50 + 1000×15 = $35.000 (D1).
const FREE_TOTAL_PRIZE_POOL_USD = 10000 * 1 + 1000 * 5 + 50 * 100 + 15 * 1000;

// ─── Picos calibrados (D4) ──────────────────────────────────────────────────

// Zona externa (K 126-150): un único winRate tal que el volumen esperado
// (cubos_en_zona × winRate × E[reward|gana]) sume exactamente 200.000.
const outerZoneSize = zoneSizeFor(FREE_OUTER_MIN_K, FREE_LAYER_COUNT);
const FREE_OUTER_WIN_RATE = FREE_PICKS_TARGET_OUTER / (E_REWARD_GIVEN_WIN * outerZoneSize);

// Zona interior (K 0-125): misma FORMA relativa que las 4 franjas estándar de
// getRewardForCube (fracciones 0.20/0.50/0.70/0.90 de L), remapeadas a
// L=150 → K=30/75/105/135, con un único factor de ajuste para que la suma dé
// exactamente 200.000. La franja K≥135 nunca se activa acá porque la zona
// interior del Free termina en K=125 (0.90×150=135 cae en la zona externa).
const B1 = Math.round(0.20 * FREE_LAYER_COUNT); // 30
const B2 = Math.round(0.50 * FREE_LAYER_COUNT); // 75
const B3 = Math.round(0.70 * FREE_LAYER_COUNT); // 105

const innerShapeSum = zoneSizeFor(0, B1 - 1) * 0.15 +
  zoneSizeFor(B1, B2 - 1) * 0.20 +
  zoneSizeFor(B2, B3 - 1) * 0.30 +
  zoneSizeFor(B3, FREE_INNER_MAX_K) * 0.40;
const innerAdjust = FREE_PICKS_TARGET_INNER / (innerShapeSum * E_REWARD_GIVEN_WIN);

// Mismo formato que DEFAULT_REWARD_BRACKETS (helpers.js) — orden descendente
// por minK, 100% compatible con getRewardForCube(..., config) sin cambios.
const FREE_REWARD_BRACKETS = [
  {minK: FREE_OUTER_MIN_K, rate: FREE_OUTER_WIN_RATE}, // 126-150 (solo picos)
  {minK: B3, rate: 0.40 * innerAdjust}, // 105-125
  {minK: B2, rate: 0.30 * innerAdjust}, // 75-104
  {minK: B1, rate: 0.20 * innerAdjust}, // 30-74
  {minK: 0, rate: 0.15 * innerAdjust}, // 0-29
];

// quantityPerTier indexado tier-1 (1..9) — usado por el HUD de gemas
// restantes (Cambio 6) igual que en servers estándar.
const FREE_QUANTITY_PER_TIER = [0, 0, 1, 5, 0, 0, 100, 0, 1000];

const FREE_CONFIG = {
  isFreeServer: true,
  layerCount: FREE_LAYER_COUNT,
  maxMembers: null,
  // El Free no cobra entrada -- 1 solo pico incondicional (los servers
  // pagos mantienen 2, ver serverConfig.js), con cooldown más corto (6h
  // en vez de las 24h default) ya que no hay entry fee que compensar.
  dailyAdSlots: 1,
  adCooldownMs: 6 * 60 * 60 * 1000,
  totalPrizePoolUSD: FREE_TOTAL_PRIZE_POOL_USD,
  quantityPerTier: FREE_QUANTITY_PER_TIER,
  tierTable: FREE_PRIZE_TABLE,
  rewardBrackets: FREE_REWARD_BRACKETS,
};

module.exports = {
  FREE_LAYER_COUNT,
  FREE_OUTER_MIN_K,
  AD_VIEW_VALUE_USD,
  FREE_CUM_POOL,
  FREE_PRIZE_TABLE,
  FREE_REWARD_BRACKETS,
  FREE_TOTAL_PRIZE_POOL_USD,
  FREE_QUANTITY_PER_TIER,
  FREE_CONFIG,
};
