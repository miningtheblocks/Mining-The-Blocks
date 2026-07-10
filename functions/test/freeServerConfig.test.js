// Cambio 2 (Fase 3): verifica que la calibración de picos del server Free
// (functions/freeServerConfig.js) efectivamente reparte los 400.000 picos
// fijos (D4) pedidos -- 200.000 en la zona externa + 200.000 en la interior
// -- y que el total de premios en dinero da $35.000 (D1).

const { shellTotalCubes } = require('../helpers');
const {
  FREE_LAYER_COUNT,
  FREE_OUTER_MIN_K,
  FREE_PRIZE_TABLE,
  FREE_REWARD_BRACKETS,
  FREE_TOTAL_PRIZE_POOL_USD,
} = require('../freeServerConfig');

const E_REWARD_GIVEN_WIN = 0.40 * 1 + 0.30 * 2 + 0.20 * 3 + 0.05 * 4 + 0.05 * 5; // 2.05

function winRateForK(K) {
  for (const b of FREE_REWARD_BRACKETS) {
    if (K >= b.minK) return b.rate;
  }
  return FREE_REWARD_BRACKETS[FREE_REWARD_BRACKETS.length - 1].rate;
}

describe('freeServerConfig — calibración de picos (D4)', () => {
  test('zona externa (K 126-150) suma exactamente 200.000 picos esperados', () => {
    let total = 0;
    for (let K = FREE_OUTER_MIN_K; K <= FREE_LAYER_COUNT; K++) {
      total += shellTotalCubes(K) * winRateForK(K) * E_REWARD_GIVEN_WIN;
    }
    expect(total).toBeCloseTo(200000, 0); // tolerancia de redondeo, no de diseño
  });

  test('zona interior (K 0-125) suma exactamente 200.000 picos esperados', () => {
    let total = 0;
    for (let K = 0; K < FREE_OUTER_MIN_K; K++) {
      total += shellTotalCubes(K) * winRateForK(K) * E_REWARD_GIVEN_WIN;
    }
    expect(total).toBeCloseTo(200000, 0);
  });

  test('las 5 franjas de winRate son probabilidades válidas (0 < rate <= 1)', () => {
    for (const b of FREE_REWARD_BRACKETS) {
      expect(b.rate).toBeGreaterThan(0);
      expect(b.rate).toBeLessThanOrEqual(1);
    }
  });

  test('franjas ordenadas descendente por minK (requerido por winRateFor)', () => {
    for (let i = 1; i < FREE_REWARD_BRACKETS.length; i++) {
      expect(FREE_REWARD_BRACKETS[i].minK).toBeLessThan(FREE_REWARD_BRACKETS[i - 1].minK);
    }
  });
});

describe('freeServerConfig — tabla de premios en dinero (D1/D5)', () => {
  test('total de premios (incluyendo el 5to $1.000 fijo de K=0) es $35.000', () => {
    const tableSum = FREE_PRIZE_TABLE.reduce((s, t) => s + t.price * t.count, 0);
    const withFixedK0 = tableSum + 1000; // el 5to $1.000, otorgado en mineCube al cerrar episodio
    expect(withFixedK0).toBe(35000);
  });

  test('tier 4 (K=0, fijo) queda fuera del rango normal de la tabla', () => {
    const tier4 = FREE_PRIZE_TABLE.find((t) => t.tier === 4);
    expect(tier4.minK).toBeGreaterThan(0); // K=0 no está en [minK,maxK] -> se maneja aparte en mineCube
    expect(tier4.count).toBe(4); // los otros 4, no 5
  });

  test('zoneSize de cada tier alcanza para su cantidad prometida (bug de auditoría de hasPrize)', () => {
    for (const t of FREE_PRIZE_TABLE) {
      expect(t.zoneSize).toBeGreaterThanOrEqual(t.count);
    }
  });
});
