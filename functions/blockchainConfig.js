
// Cambio 6 (modo Chain, 2026-07-03), mecánica actualizada en Cambio 9
// (2026-07-05): config del modo "Chain" nuevo -- un cubo ÚNICO (no
// episodios/eslabones), mecánica de minado IDÉNTICA a servers/Free (arranca
// completo en BLOCKCHAIN_LAYER_COUNT, se mina hacia el centro). La versión
// original (Cambio 6) hacía crecer el cubo desde 1 cubo hacia afuera -- se
// descartó por la complejidad/bugs de render 3D para capas chicas, sin
// beneficio real sobre reusar el mecanismo ya probado de servers.
//
// Economía: NO hay premios en gemas fijos. En cambio, cada cubo minado
// suma una tarifa en USD (según la racha de días consecutivos del que lo
// coloca) a un pool compartido ("MTB coin"). Al cerrar el modo (llegar a
// BLOCKCHAIN_LAYER_COUNT), el pool se reparte proporcional a cuánto $
// contribuyó cada jugador -- NO proporcional a cantidad de cubos, así la
// racha de uno no le saca % a los demás (ver PLAN, decisión del usuario
// 2026-07-03): un cubo con racha vale más y por lo tanto APORTA más al
// pool Y le da más crédito a quien lo colocó, sin diluir a nadie más.

const {shellSizeDedup} = require("./helpers");

// Cantidad de capas del cubo. NO está calibrado todavía contra proyección
// real de ingresos publicitarios (a diferencia de Free, que sí lo está vía
// AD_VIEW_VALUE_USD) -- valor de partida sugerido por el usuario, ajustable
// una vez que haya datos reales de cuánto tarda en llenarse una capa.
const BLOCKCHAIN_LAYER_COUNT = 250;

// Nombre de la instancia actual de la cadena (una sola cadena activa a la
// vez, ver decisión del usuario 2026-07-04). Cuando esta cadena cierra
// (llega a BLOCKCHAIN_LAYER_COUNT y se reparte el pool), se archiva al
// historial y arranca una nueva con su propio nombre -- no son "episodios"
// de la misma cadena, son instancias nuevas e independientes.
const BLOCKCHAIN_CHAIN_NAME = "B1551-Cl377A";

// Tabla de tarifas por racha de días consecutivos colocando AL MENOS un
// cubo por día (reclamar el pico sin minar NO cuenta para la racha, ver
// placeCube/claimChainPick). minStreakDays es el umbral de días
// consecutivos para alcanzar ese tier; ratePerCube es lo que aporta cada
// cubo colocado estando en ese tier (al pool Y al crédito propio del
// usuario, ver nota arriba). Tras 1 año, se mantiene en el tier 4 mientras
// no se corte la racha.
const BLOCKCHAIN_RATE_TIERS = [
  {tier: 0, label: "base", minStreakDays: 0, ratePerCube: 0.0025},
  {tier: 1, label: "weekly", minStreakDays: 7, ratePerCube: 0.0030},
  {tier: 2, label: "monthly", minStreakDays: 30, ratePerCube: 0.0035},
  {tier: 3, label: "6months", minStreakDays: 182, ratePerCube: 0.0040},
  {tier: 4, label: "1year", minStreakDays: 365, ratePerCube: 0.0045},
];

// Dado un streak de N días consecutivos, devuelve la tarifa por cubo
// vigente (el tier más alto cuyo umbral ya se alcanzó).
function rateForStreakDays(streakDays) {
  const n = Number(streakDays) || 0;
  let rate = BLOCKCHAIN_RATE_TIERS[0].ratePerCube;
  for (const t of BLOCKCHAIN_RATE_TIERS) {
    if (n >= t.minStreakDays) rate = t.ratePerCube;
  }
  return rate;
}

// Total de cubos únicos del cubo completo (capas 0..BLOCKCHAIN_LAYER_COUNT).
const BLOCKCHAIN_TOTAL_CUBES = (() => {
  let total = 0;
  for (let k = 0; k <= BLOCKCHAIN_LAYER_COUNT; k++) total += shellSizeDedup(k);
  return total;
})();

const BLOCKCHAIN_CONFIG = {
  name: BLOCKCHAIN_CHAIN_NAME,
  layerCount: BLOCKCHAIN_LAYER_COUNT,
  totalCubes: BLOCKCHAIN_TOTAL_CUBES,
  rateTiers: BLOCKCHAIN_RATE_TIERS,
  // Slots de pico diario incondicional (mismo patrón que claimAdSlotPick),
  // pero ESTE modo exige captcha verificado server-side antes de acreditar
  // (ver claimChainPick) -- anti-bot, no relacionado a compliance de ads.
  dailyPickSlots: 1,
};

module.exports = {
  BLOCKCHAIN_LAYER_COUNT,
  BLOCKCHAIN_CHAIN_NAME,
  BLOCKCHAIN_RATE_TIERS,
  BLOCKCHAIN_TOTAL_CUBES,
  BLOCKCHAIN_CONFIG,
  rateForStreakDays,
};
